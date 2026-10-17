import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { closeDatabase, transaction } from "../src/shared/server/store";
import { checkDevDatabase } from "../src/shared/server/database";

if (existsSync(".env.local")) loadEnvFile(".env.local");
try {
  await checkDevDatabase(process.env);
  const installed = await transaction(null, async (db) => {
    const result = await db.query<{ installed: boolean }>(
      "select to_regnamespace('app') is not null and to_regnamespace('app_private') is not null installed",
    );
    if (!result.rows[0]?.installed) return false;
    const tables = await db.query<{ total: number; secured: boolean }>(
      "select count(*)::int total,bool_and(c.relrowsecurity) secured from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('app','app_private') and c.relkind='r'",
    );
    if ((tables.rows[0]?.total ?? 0) < 13 || !tables.rows[0]?.secured)
      throw new Error("Incomplete schema");
    const users = await db.query("select id from app.users limit 1");
    const actor = await db.query<{ actor: unknown }>(
      "select app_private.actor() actor",
    );
    if (users.rowCount !== 0 || actor.rows[0]?.actor !== null)
      throw new Error("Anonymous access");
    const restricted = await db.query<{ safe: boolean }>(
      "select not has_table_privilege(current_user,'app_private.sessions','SELECT') and not has_column_privilege(current_user,'app.users','password_hash','SELECT') and not has_table_privilege(current_user,'app.subscription_payments','DELETE') and not has_table_privilege(current_user,'app.subscription_payments','UPDATE') safe",
    );
    if (!restricted.rows[0]?.safe)
      throw new Error("Unexpected runtime privileges");
    const receipts = await db.query(
      "select id from app.subscription_receipts limit 1",
    );
    const receiptAccess = await db.query<{ safe: boolean }>(
      "select has_table_privilege(current_user,'app.subscription_receipts','SELECT') and has_table_privilege(current_user,'app.subscription_receipts','INSERT') and not has_table_privilege(current_user,'app.subscription_receipts','UPDATE') and not has_table_privilege(current_user,'app.subscription_receipts','DELETE') safe",
    );
    if (receipts.rowCount !== 0 || !receiptAccess.rows[0]?.safe)
      throw new Error("Unexpected receipt access");
    for (const table of ["subscription_annulments", "tenant_logos"]) {
      const rows = await db.query(`select id from app.${table} limit 1`);
      const access = await db.query<{ safe: boolean }>(
        "select has_table_privilege(current_user,$1,'SELECT') and has_table_privilege(current_user,$1,'INSERT') and not has_table_privilege(current_user,$1,'UPDATE') and not has_table_privilege(current_user,$1,'DELETE') safe",
        [`app.${table}`],
      );
      if (rows.rowCount !== 0 || !access.rows[0]?.safe)
        throw new Error("Unexpected phase1 access");
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      const apiRole = await db.query<{ safe: boolean }>(
        "select not has_schema_privilege($1,'app','USAGE') and not has_schema_privilege($1,'app_private','USAGE') and not has_function_privilege($1,'app_private.login_candidate(text)','EXECUTE') and not has_function_privilege($1,'app_private.platform_usage()','EXECUTE') and not has_table_privilege($1,'app.subscription_annulments','SELECT') and not has_table_privilege($1,'app.tenant_logos','SELECT') and not has_table_privilege($1,'app.subscription_receipts','SELECT') safe",
        [role],
      );
      if (!apiRole.rows[0]?.safe) throw new Error("Unexpected API access");
    }
    return true;
  });
  if (!installed) {
    console.log(
      "Supabase DEV conectado. Migración Fase 1 pendiente; sin cambios remotos.",
    );
    process.exitCode = 2;
  } else
    console.log(
      "Fase 1: trece o más tablas con RLS, comprobantes/logos privados, anulaciones sin UPDATE/DELETE y privilegios runtime/Data API restringidos. Verificación solo lectura; no prueba credenciales de administrador.",
    );
} catch {
  console.error(
    "No se pudo verificar Fase 1. Revisa conexión y migración sin compartir secretos.",
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
