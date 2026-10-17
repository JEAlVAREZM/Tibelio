#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import pg from "pg";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const getOpt = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const dbUrl =
    getOpt("--db-url") ||
    process.env.TEST_ADMIN_DATABASE_URL ||
    process.env.DATABASE_URL ||
    `postgresql://postgres:tibelio_test_only@127.0.0.1:${process.env.TEST_PORT ?? "54320"}/tibelio_test`;

  const storageDir =
    getOpt("--storage-dir") ||
    process.env.PRIVATE_STORAGE_ROOT ||
    process.env.TEST_PRIVATE_STORAGE_ROOT ||
    resolve(".local/private-storage");

  const outputBase = getOpt("--output-dir") || resolve("backups");

  return { dbUrl, storageDir, outputBase };
}

async function collectFiles(dir) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = await collectFiles(fullPath);
        results.push(...sub);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory might not exist if no files uploaded yet
  }
  return results;
}

function serializeSqlValue(val) {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "boolean" || typeof val === "number") return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'::timestamptz`;
  if (Array.isArray(val)) {
    if (val.length === 0) return "'{}'::text[]";
    const items = val.map((item) => `'${String(item).replace(/'/g, "''")}'`).join(", ");
    return `ARRAY[${items}]::text[]`;
  }
  if (Buffer.isBuffer(val)) {
    return `decode('${val.toString("hex")}', 'hex')`;
  }
  if (typeof val === "object") {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(val).replace(/'/g, "''")}'`;
}

export async function createBackup(options = {}) {
  const { dbUrl, storageDir, outputBase } = { ...parseArgs(), ...options };
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(outputBase, `backup-${timestamp}`);
  const filesBackupDir = join(backupDir, "files");

  await mkdir(backupDir, { recursive: true });
  await mkdir(filesBackupDir, { recursive: true });

  console.log(`[BACKUP] Iniciando copia de seguridad en: ${backupDir}`);
  console.log(`[BACKUP] Base de datos origen: ${dbUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`[BACKUP] Almacenamiento privado origen: ${storageDir}`);

  // 1. Conectar a PostgreSQL con aislamiento de snapshot transaccional (R-04)
  // JS Date truncates PostgreSQL microseconds. Preserve temporal SQL values verbatim.
  const client = new pg.Client({ connectionString: dbUrl, types: {
    getTypeParser(oid, format) { return [1082,1114,1184].includes(oid) ? (value) => value : pg.types.getTypeParser(oid,format); },
  } });
  await client.connect();

  const tablesDump = {};
  const sqlStatements = [];
  sqlStatements.push("-- Tibelio SaaS Database Restore Dump");
  sqlStatements.push(`-- Generado: ${new Date().toISOString()}`);
  sqlStatements.push("SET session_replication_role = 'replica';\n");

  let totalRows = 0;
  let appliedMigrations = [];

  try {
    // Iniciar transacción con nivel REPEATABLE READ para asegurar snapshot consistente frente a escrituras
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");

    // Consultar migraciones aplicadas de forma segura sin abortar la transacción (R-04)
    const migCheck = await client.query(
      "SELECT to_regclass('supabase_migrations.schema_migrations') AS rel",
    );
    if (migCheck.rows[0]?.rel) {
      const migRes = await client.query(
        "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version",
      );
      appliedMigrations = migRes.rows.map((r) => r.version);
    } else {
      try {
        const { readdir } = await import("node:fs/promises");
        const migFiles = await readdir("supabase/migrations");
        appliedMigrations = migFiles
          .filter((f) => f.endsWith(".sql"))
          .map((f) => f.split("_")[0])
          .sort();
      } catch {}
    }

    // Obtener todas las tablas del esquema app
    const tablesQuery = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'app' AND table_type = 'BASE TABLE'
       ORDER BY table_name;`,
    );
    const tableNames = tablesQuery.rows.map((r) => `app.${r.table_name}`);

    // Limpieza previa en bloque
    sqlStatements.push("-- Limpieza previa de todas las tablas");
    for (const table of [...tableNames].reverse()) {
      sqlStatements.push(`TRUNCATE TABLE ${table} CASCADE;`);
    }
    sqlStatements.push("\n-- Inserción de datos");

    for (const table of tableNames) {
      const rowsRes = await client.query(`SELECT * FROM ${table}`);
      const rows = rowsRes.rows;
      totalRows += rows.length;

      const serialized = JSON.stringify(rows);
      const tableHash = sha256(Buffer.from(serialized, "utf8"));
      tablesDump[table] = {
        rowCount: rows.length,
        sha256: tableHash,
        rows,
      };

      if (rows.length > 0) {
        const cols = Object.keys(rows[0]);
        sqlStatements.push(`-- Tabla: ${table} (${rows.length} registros)`);

        for (const row of rows) {
          const values = cols.map((col) => serializeSqlValue(row[col]));
          sqlStatements.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${values.join(", ")});`);
        }
        sqlStatements.push("");
      }
    }

    await client.query("COMMIT;");
  } catch (err) {
    await client.query("ROLLBACK;").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }

  sqlStatements.push("SET session_replication_role = 'origin';");

  // Guardar SQL y calcular su SHA-256 criptográfico (R-05)
  const sqlContent = sqlStatements.join("\n");
  const sqlHash = sha256(Buffer.from(sqlContent, "utf8"));
  await writeFile(join(backupDir, "database-restore.sql"), sqlContent, "utf8");

  // Guardar JSON y calcular su SHA-256
  const jsonContent = JSON.stringify(tablesDump, null, 2);
  const dbDumpHash = sha256(Buffer.from(jsonContent, "utf8"));
  await writeFile(join(backupDir, "database-data.json"), jsonContent, "utf8");

  // 2. Copiar archivos de almacenamiento privado y calcular hashes
  const fileManifestList = [];
  const diskFiles = await collectFiles(storageDir);
  let totalBytes = 0;

  for (const filePath of diskFiles) {
    const relPath = relative(storageDir, filePath);
    const destPath = join(filesBackupDir, relPath);
    const fileBytes = await readFile(filePath);
    const fileHash = sha256(fileBytes);
    const fileStat = await stat(filePath);

    await mkdir(resolve(destPath, ".."), { recursive: true });
    await writeFile(destPath, fileBytes);

    fileManifestList.push({
      relativePath: relPath.replace(/\\/g, "/"),
      byteSize: fileStat.size,
      sha256: fileHash,
    });
    totalBytes += fileStat.size;
  }

  // 3. Generar Manifiesto de Integridad
  const manifest = {
    version: "1.0",
    backupTimestamp: new Date().toISOString(),
    environment: process.env.APP_ENV || "development",
    database: {
      totalTables: Object.keys(tablesDump).length,
      totalRows,
      dumpSha256: dbDumpHash,
      sqlSha256: sqlHash,
      appliedMigrations,
      tables: Object.fromEntries(
        Object.entries(tablesDump).map(([k, v]) => [k, { rowCount: v.rowCount, sha256: v.sha256 }]),
      ),
    },
    storage: {
      totalFiles: fileManifestList.length,
      totalBytes,
      files: fileManifestList,
    },
  };

  const manifestStr = JSON.stringify(manifest, null, 2);
  const manifestHash = sha256(Buffer.from(manifestStr, "utf8"));
  manifest.manifestSha256 = manifestHash;

  await writeFile(join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`[BACKUP] Copia completada exitosamente.`);
  console.log(`[BACKUP] Total tablas: ${Object.keys(tablesDump).length}, Total filas: ${totalRows}`);
  console.log(`[BACKUP] Total archivos privados: ${fileManifestList.length} (${totalBytes} bytes)`);
  console.log(`[BACKUP] Hash SHA-256 SQL: ${sqlHash}`);
  console.log(`[BACKUP] Hash SHA-256 Manifiesto: ${manifestHash}`);

  return { backupDir, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  createBackup().catch((err) => {
    console.error("[BACKUP] Error fatal en backup:", err);
    process.exit(1);
  });
}
