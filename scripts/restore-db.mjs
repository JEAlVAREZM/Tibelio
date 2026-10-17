#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve, join, normalize, isAbsolute, sep } from "node:path";
import pg from "pg";
import { prepareFilesRestore } from "./restore-files.mjs";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function parseArgs() {
  const args = process.argv.slice(2);
  const getOpt = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
  };

  const backupDir = getOpt("--backup-dir");
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

  const verifyOnly = args.includes("--verify-only");

  return { backupDir, dbUrl, storageDir, verifyOnly };
}

async function findLatestBackup(baseDir = resolve("backups")) {
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    const backups = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("backup-"))
      .map((e) => e.name)
      .sort()
      .reverse();
    if (backups.length > 0) return join(baseDir, backups[0]);
  } catch {
    // No backups folder
  }
  return null;
}

export async function restoreBackup(options = {}) {
  const parsed = parseArgs();
  const dbUrl = options.dbUrl || parsed.dbUrl;
  const storageDir = options.storageDir || parsed.storageDir;
  const verifyOnly = options.verifyOnly ?? parsed.verifyOnly;
  let backupDir = options.backupDir || parsed.backupDir;

  if (!backupDir) {
    backupDir = await findLatestBackup();
    if (!backupDir) {
      throw new Error("No se especificó --backup-dir y no se encontraron copias de seguridad en backups/");
    }
  }

  backupDir = resolve(backupDir);
  console.log(`[RESTORE] Restaurando desde: ${backupDir}`);
  console.log(`[RESTORE] Modo de ejecución: ${verifyOnly ? "SOLO VERIFICACIÓN DE INTEGRIDAD" : "RESTAURACIÓN COMPLETA"}`);

  // 1. Leer y verificar Manifiesto
  const manifestPath = join(backupDir, "manifest.json");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw);

  console.log(`[RESTORE] Timestamp de backup: ${manifest.backupTimestamp}`);
  console.log(`[RESTORE] Entorno de origen: ${manifest.environment}`);

  // 2. Verificar hash de volcado de datos JSON
  const dataPath = join(backupDir, "database-data.json");
  const dataBytes = await readFile(dataPath);
  const dataHash = sha256(dataBytes);
  if (dataHash !== manifest.database.dumpSha256) {
    throw new Error(
      `Fallo de integridad: El hash del volcado JSON (${dataHash}) no coincide con el manifiesto (${manifest.database.dumpSha256})`,
    );
  }
  console.log(`[RESTORE] ✓ Integridad de database-data.json verificada (SHA-256: ${dataHash.slice(0, 16)}...)`);

  // 3. Verificar hash del artefacto SQL de restauración (R-05)
  const sqlPath = join(backupDir, "database-restore.sql");
  const sqlContent = await readFile(sqlPath, "utf8");
  const sqlHash = sha256(Buffer.from(sqlContent, "utf8"));
  if (manifest.database.sqlSha256 && sqlHash !== manifest.database.sqlSha256) {
    throw new Error(
      `Fallo de integridad: El hash del script SQL (${sqlHash}) no coincide con el manifiesto (${manifest.database.sqlSha256})`,
    );
  }
  console.log(`[RESTORE] ✓ Integridad de database-restore.sql verificada (SHA-256: ${sqlHash.slice(0, 16)}...)`);

  // 4. Verificar hashes de archivos privados y contención de rutas (R-05)
  const filesDir = join(backupDir, "files");
  for (const f of manifest.storage.files) {
    // Contención de rutas para prevenir path traversal
    const normalized = normalize(f.relativePath);
    if (isAbsolute(normalized) || normalized.startsWith("..") || normalized.includes(`..${sep}`)) {
      throw new Error(`Ruta insegura en archivo de manifiesto: ${f.relativePath}`);
    }

    const filePath = join(filesDir, f.relativePath);
    const fileBytes = await readFile(filePath);
    const currentHash = sha256(fileBytes);
    if (currentHash !== f.sha256) {
      throw new Error(
        `Fallo de integridad en archivo ${f.relativePath}: hash actual (${currentHash}) no coincide con manifiesto (${f.sha256})`,
      );
    }
    if (fileBytes.length !== f.byteSize) {
      throw new Error(
        `Fallo de integridad en archivo ${f.relativePath}: tamaño actual (${fileBytes.length}) no coincide con manifiesto (${f.byteSize})`,
      );
    }
  }
  console.log(`[RESTORE] ✓ Integridad de ${manifest.storage.files.length} archivos privados verificada exitosamente.`);

  if (verifyOnly) {
    console.log("[RESTORE] Verificación de integridad completada exitosamente. Sin alteraciones en base de datos.");
    return { success: true, manifest, verifiedOnly: true };
  }

  // 5. Aplicar restauración en PostgreSQL con validación PREVIA a COMMIT (R-05)
  console.log(`[RESTORE] Conectando a base de datos destino: ${dbUrl.replace(/:[^:@]+@/, ":***@")}`);
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();

  const fileRestore = await prepareFilesRestore(backupDir, storageDir, manifest.storage.files);
  try {
    // Si el esquema app no existe (recuperación en base de datos limpia / desastre), aplicar migraciones
    const appSchemaRes = await client.query("select 1 from pg_namespace where nspname = 'app'");
    if (appSchemaRes.rowCount === 0) {
      console.log("[RESTORE] Esquema 'app' no detectado en destino limpio. Inicializando roles y aplicando migraciones...");
      for (const role of ["anon", "authenticated", "service_role"]) {
        const roleExists = (await client.query("select 1 from pg_roles where rolname = $1", [role])).rowCount > 0;
        if (!roleExists) {
          await client.query(`create role ${role} nologin`);
        }
        await client.query(`alter default privileges grant all on tables to ${role}`).catch(() => {});
        await client.query(`alter default privileges grant execute on functions to ${role}`).catch(() => {});
      }

      const migFiles = (await readdir("supabase/migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const f of migFiles) {
        const sql = await readFile(join("supabase/migrations", f), "utf8");
        await client.query(sql);
      }
      console.log(`[RESTORE] ✓ ${migFiles.length} migraciones aplicadas exitosamente en destino limpio.`);
    }

    console.log("[RESTORE] Iniciando transacción atómica de restauración...");
    await client.query("BEGIN;");
    await client.query(sqlContent);

    // Validar conteos de filas en destino DENTRO DE LA TRANSACCIÓN ANTES DE COMMIT (R-05)
    for (const [table, meta] of Object.entries(manifest.database.tables)) {
      const countRes = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      const actualCount = countRes.rows[0].count;
      if (actualCount !== meta.rowCount) {
        throw new Error(
          `Discrepancia en restauración de ${table}: esperadas ${meta.rowCount} filas, restauradas ${actualCount}`,
        );
      }
    }
    console.log(`[RESTORE] ✓ Conteos de filas validados antes de confirmar transacción.`);

    await fileRestore.activate();
    await client.query("COMMIT;");
    console.log("[RESTORE] ✓ Transacción de datos confirmada (COMMIT) en PostgreSQL.");
  } catch (err) {
    await client.query("ROLLBACK;").catch(() => {});
    await fileRestore.rollback();
    console.error("[RESTORE] Transacción revertida (ROLLBACK) debido a error:", err.message);
    throw err;
  } finally {
    await client.end();
  }

  console.log("[RESTORE] Archivos preparados y activados antes de COMMIT. Copia anterior conservada:", fileRestore.previousPath);
  return { success: true, manifest, restoredTables: Object.keys(manifest.database.tables).length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  restoreBackup().catch((err) => {
    console.error("[RESTORE] Error fatal en restauración:", err);
    process.exit(1);
  });
}
