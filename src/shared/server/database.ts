import "server-only";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { readDevDatabaseConfig } from "./config";

export async function checkDevDatabase(env: Record<string, string | undefined>): Promise<void> {
  const config = readDevDatabaseConfig(env);
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    ssl: { rejectUnauthorized: true, ...(config.caFile ? { ca: await readFile(config.caFile, "utf8") } : {}) },
    max: 1,
    connectionTimeoutMillis: 8000,
    statement_timeout: 8000,
    query_timeout: 10000,
    application_name: "tibelio-dev-preflight",
    options: "-c default_transaction_read_only=on",
  });
  try {
    const result = await pool.query<{ safe: boolean }>(
      "SELECT NOT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole) AS safe FROM pg_roles WHERE rolname = current_user",
    );
    if (result.rows[0]?.safe !== true) throw new Error("DB_ROLE_UNSAFE");
    await pool.query("SELECT 1");
  } finally {
    await pool.end();
  }
}
