import "server-only";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { readRuntimeDatabaseConfig } from "./config";

let pool: pg.Pool | undefined;
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function databasePool() {
  if (pool) return pool;
  if (process.env.APP_ENV === "test") {
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
    if (
      url.hostname !== "127.0.0.1" ||
      url.pathname !== "/tibelio_test" ||
      url.username !== "tibelio_dev_app"
    )
      throw new Error("Invalid isolated test database");
    pool = new pg.Pool({
      connectionString: url.toString(),
      max: 5,
      connectionTimeoutMillis: 8000,
    });
  } else {
    const config = readRuntimeDatabaseConfig(process.env);
    pool = new pg.Pool({
      connectionString: config.connectionString,
      ssl: {
        rejectUnauthorized: true,
        ...(config.caFile ? { ca: readFileSync(config.caFile, "utf8") } : {}),
      },
      max: 5,
      connectionTimeoutMillis: 8000,
    });
  }
  pool.on("error", () => {
    /* Request failures are sanitized at the boundary. */
  });
  return pool;
}
export async function transaction<T>(
  token: string | null,
  operation: (db: pg.PoolClient) => Promise<T>,
  write = false,
): Promise<T> {
  const db = await databasePool().connect();
  try {
    await db.query(write ? "BEGIN READ WRITE" : "BEGIN READ ONLY");
    await db.query(
      "select set_config('app.session_hash',$1,true),set_config('statement_timeout','10000',true),set_config('TimeZone','UTC',true)",
      [token ? tokenHash(token) : ""],
    );
    const result = await operation(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
export async function closeDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}
