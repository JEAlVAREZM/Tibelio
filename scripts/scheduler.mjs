import pg from "pg";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { runSchedulerIteration } from "../src/shared/server/worker-run.mjs";
const url = process.env.SCHEDULER_DATABASE_URL;
if (!url) throw new Error("SCHEDULER_DATABASE_URL requerida; no se usan credenciales de aplicación ni admin.");
const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 8000,
  ...(process.env.APP_ENV === "test" ? {} : { ssl: { rejectUnauthorized: true, ...(process.env.DATABASE_CA_FILE ? { ca: readFileSync(process.env.DATABASE_CA_FILE, "utf8") } : {}) } }) });
try {
  const role = await pool.query("select exists(select from pg_roles where rolname=current_user and not (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole)) and pg_has_role(current_user,'tibelio_worker','member') and not has_table_privilege(current_user,'app.tenants','select') as safe");
  if (!role.rows[0]?.safe) throw new Error();
} catch { await pool.end(); throw new Error("Worker requiere un login restringido miembro de tibelio_worker, sin lectura empresarial directa."); }
let stopping = false;
let timer;
async function stop() { stopping = true; clearTimeout(timer); await pool.end(); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
async function loop() {
  try {
    console.log(JSON.stringify({ event: "scheduler_ok", ...await runSchedulerIteration(pool) }));
    await writeFile("/tmp/tibelio-scheduler-health.json", JSON.stringify({ completedAt: new Date().toISOString() }));
  }
  catch { console.error(JSON.stringify({ event: "scheduler_failed" })); process.exitCode = 1; }
  if (process.argv.includes("--daemon") && !stopping) timer = setTimeout(loop, 60000);
  else await stop();
}
await loop();
