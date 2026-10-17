import "server-only";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import {
  type InternalNotificationDto,
  markNotificationReadSchema,
} from "../../../shared/contracts/post-sale";

import type pg from "pg";

export async function internalScanAndGenerateAlerts(
  db: pg.PoolClient,
  tenantId: string,
): Promise<number> {
  let count = 0;

  // 1. Escanear novedades bloqueantes abiertas
  const blockRes = await db.query<{ id: string; title: string; stage: string }>(
    `select id, title, stage
     from app.operational_issues
     where tenant_id = $1 and severity = 'BLOCKING' and status in ('OPEN', 'IN_PROGRESS')`,
    [tenantId],
  );
  for (const b of blockRes.rows) {
    const ins = await db.query(
      `insert into app.internal_notifications(
         tenant_id, event_type, title, message, reference_type, reference_id, dedup_key
       ) values ($1, 'BLOCKING_ISSUE', $2, $3, 'ISSUE', $4, $5)
       on conflict (tenant_id, dedup_key) do nothing`,
      [
        tenantId,
        `Alerta Operativa: ${b.title}`,
        `Novedad bloqueante activa en etapa ${b.stage}. Requiere intervención inmediata.`,
        b.id,
        `blocking_issue_${b.id}`,
      ],
    );
    if ((ins.rowCount ?? 0) > 0) count++;
  }

  // 2. Escanear garantías sin atender
  const warRes = await db.query<{ id: string; code: string; claim_type: string }>(
    `select id, code, claim_type
     from app.warranties
     where tenant_id = $1 and status = 'REGISTERED'`,
    [tenantId],
  );
  for (const w of warRes.rows) {
    const ins = await db.query(
      `insert into app.internal_notifications(
         tenant_id, event_type, title, message, reference_type, reference_id, dedup_key
       ) values ($1, 'WARRANTY_CLAIM', $2, $3, 'WARRANTY', $4, $5)
       on conflict (tenant_id, dedup_key) do nothing`,
      [
        tenantId,
        `Garantía Pendiente: ${w.code}`,
        `Reclamo de garantía ${w.code} (${w.claim_type}) pendiente de revisión y asignación.`,
        w.id,
        `warranty_unreviewed_${w.id}`,
      ],
    );
    if ((ins.rowCount ?? 0) > 0) count++;
  }

  // 3. Escanear tareas de campo atrasadas
  const taskRes = await db.query<{ id: string; title: string; scheduled_date: string }>(
    `select id, title, scheduled_date::text
     from app.field_tasks
     where tenant_id = $1 and status = 'SCHEDULED' and scheduled_date < current_date`,
    [tenantId],
  );
  for (const t of taskRes.rows) {
    const ins = await db.query(
      `insert into app.internal_notifications(
         tenant_id, event_type, title, message, reference_type, reference_id, dedup_key
       ) values ($1, 'DELAYED_OPERATION', $2, $3, 'TASK', $4, $5)
       on conflict (tenant_id, dedup_key) do nothing`,
      [
        tenantId,
        `Operación Atrasada: ${t.title}`,
        `La tarea de campo '${t.title}' estaba programada para ${t.scheduled_date} y continúa en estado PENDIENTE.`,
        t.id,
        `delayed_task_${t.id}_${t.scheduled_date}`,
      ],
    );
    if ((ins.rowCount ?? 0) > 0) count++;
  }

  return count;
}

export async function listNotifications(
  token: string | null,
  options?: { unreadOnly?: boolean },
): Promise<InternalNotificationDto[]> {
  return runAuthorized(token, "notifications.read", false, async (db, scope) => {
    const params: unknown[] = [scope.tenantId, scope.userId];
    let sql = `
      select 
        n.id,
        n.event_type as "eventType",
        n.title,
        n.message,
        n.reference_type as "referenceType",
        n.reference_id as "referenceId",
        coalesce(r.read_at, null) as "readAt",
        n.created_at as "createdAt"
      from app.internal_notifications n
      left join app.internal_notification_reads r
        on r.tenant_id = n.tenant_id
       and r.notification_id = n.id
       and r.user_id = $2
      where n.tenant_id = $1`;

    if (options?.unreadOnly) {
      sql += " and r.read_at is null";
    }

    sql += " order by n.created_at desc limit 100";

    const res = await db.query<InternalNotificationDto>(sql, params);
    return res.rows;
  });
}

export async function markNotificationAsRead(
  token: string | null,
  rawInput: unknown,
): Promise<{ success: boolean }> {
  const input = markNotificationReadSchema.parse(rawInput);

  return runAuthorized(token, "notifications.read", true, async (db, scope) => {
    // 1. Verificar si existe la notificación para este inquilino
    const exists = await db.query(
      "select id from app.internal_notifications where tenant_id = $1 and id = $2",
      [scope.tenantId, input.notificationId],
    );
    if (exists.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Notificación no encontrada.");
    }

    // 2. Registrar lectura persistente individual por usuario (R-07)
    await db.query(
      `insert into app.internal_notification_reads (
         tenant_id, notification_id, user_id, read_at
       ) values ($1, $2, $3, now())
       on conflict (tenant_id, notification_id, user_id) do update
       set read_at = excluded.read_at`,
      [scope.tenantId, input.notificationId, scope.userId],
    );

    // 3. Mantener fallback en la cabecera si es la primera lectura
    await db.query(
      `update app.internal_notifications
       set read_at = coalesce(read_at, now()),
           read_by = coalesce(read_by, $3)
       where tenant_id = $1 and id = $2 and read_at is null`,
      [scope.tenantId, input.notificationId, scope.userId],
    );

    return { success: true };
  });
}

export async function scanAndGenerateAlerts(
  token: string | null,
): Promise<{ generatedCount: number }> {
  return runAuthorized(token, "notifications.manage", true, async (db, scope) => {
    if (!scope.tenantId) {
      return { generatedCount: 0 };
    }
    const count = await internalScanAndGenerateAlerts(db, scope.tenantId);
    return { generatedCount: count };
  });
}
