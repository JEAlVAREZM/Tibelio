import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";

export async function listAudit(token: string | null, rawQuery: unknown) {
  const query = z.object({
    page: z.coerce.number().int().min(1).max(100000).default(1), search: z.string().trim().max(160).default(""),
    entity: z.string().regex(/^[a-z_]{1,80}$/).optional(), recordId: z.string().max(200).optional(),
    from: z.iso.date().optional(), to: z.iso.date().optional(),
  }).refine(q=>!q.from || !q.to || q.from<=q.to,{message:"La fecha inicial debe ser anterior o igual a la final.",path:["to"]}).parse(rawQuery ?? {});
  return runAuthorized(token, "audit.read", false, async (db, scope) => {
    const values: unknown[] = [scope.tenantId]; const filters = ["tenant_id=$1"];
    for (const [column,value,op] of [["entity",query.entity,"="],["record_id",query.recordId,"="],["occurred_at",query.from,">="],["occurred_at",query.to,"<"]] as const) {
      if (value) { values.push(value); filters.push(column === "occurred_at" ? `${column} ${op} (($${values.length}::date${op === "<" ? " + interval '1 day'" : ""})::timestamp at time zone 'America/Bogota')` : `${column} ${op} $${values.length}`); }
    }
    if (query.search) { values.push(`%${query.search}%`); filters.push(`(record_label ilike $${values.length} or actor_label ilike $${values.length})`); }
    const where = filters.join(" and ");
    const count = await db.query(`select count(*)::int total from app.audit_events where ${where}`,values);
    values.push(25,(query.page-1)*25);
    const rows = await db.query(`select id,entity,record_id as "recordId",record_label as "recordLabel",actor_label as "actorLabel",operation,changed_fields as "changedFields",before_values as "beforeValues",after_values as "afterValues",occurred_at as "occurredAt" from app.audit_events where ${where} order by occurred_at desc,id desc limit $${values.length-1} offset $${values.length}`,values);
    return { items: rows.rows, total: count.rows[0].total, page:query.page };
  });
}
