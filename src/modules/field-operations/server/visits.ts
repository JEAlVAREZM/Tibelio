import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import type { ActorContext } from "../../identity/server/authorization";
import { AppError } from "../../../shared/server/app-error";
import {
  createFieldVisitSchema,
  updateFieldVisitStatusSchema,
  recordVisitMeasuresSchema,
  type FieldVisitDto,
  type FieldVisitCabinMeasureDto,
} from "../../../shared/contracts/field-operations";

export async function createFieldVisit(
  token: string | null,
  rawInput: unknown,
): Promise<FieldVisitDto> {
  const input = createFieldVisitSchema.parse(rawInput);

  return runAuthorized(token, "field.manage", true, async (db, scope) => {
    // 1. Validar solicitud activa
    const reqRes = await db.query<{ id: string; status: string; code: string }>(
      "select id, status, code from app.commercial_requests where tenant_id = $1 and id = $2",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede programar una visita técnica en una solicitud cancelada.");
    }

    // 2. Validar técnico asignado existente y activo
    const techRes = await db.query(
      "select id, display_name from app.users where tenant_id = $1 and id = $2 and active = true",
      [scope.tenantId, input.assignedTechnicianId],
    );
    if (techRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR", "El técnico asignado no existe o se encuentra inactivo en la empresa.");
    }

    // 3. Crear visita
    const insRes = await db.query<FieldVisitDto>(
      `insert into app.field_visits(
         tenant_id, request_id, assigned_technician_id, scheduled_date,
         status, observations, created_by, updated_by
       ) values ($1, $2, $3, $4, 'SCHEDULED', $5, $6, $6)
       returning 
         id, request_id as "requestId", assigned_technician_id as "assignedTechnicianId",
         scheduled_date as "scheduledDate", status, observations,
         started_at as "startedAt", completed_at as "completedAt",
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.requestId,
        input.assignedTechnicianId,
        input.scheduledDate,
        input.observations ?? null,
        scope.userId,
      ],
    );

    const visit = insRes.rows[0]!;
    visit.requestCode = reqRes.rows[0]!.code;
    visit.assignedTechnicianName = techRes.rows[0]!.display_name;
    return visit;
  });
}

export async function listFieldVisits(
  token: string | null,
  rawQuery?: unknown,
): Promise<FieldVisitDto[]> {
  const query = z
    .object({
      requestId: z.string().uuid().optional(),
      technicianId: z.string().uuid().optional(),
      status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    let sql = `
      select 
        fv.id,
        fv.request_id as "requestId",
        cr.code as "requestCode",
        fv.assigned_technician_id as "assignedTechnicianId",
        u.display_name as "assignedTechnicianName",
        to_char(fv.scheduled_date, 'YYYY-MM-DD') as "scheduledDate",
        fv.status,
        fv.observations,
        fv.started_at as "startedAt",
        fv.completed_at as "completedAt",
        fv.created_at as "createdAt",
        fv.created_by as "createdBy",
        fv.updated_at as "updatedAt",
        fv.updated_by as "updatedBy"
      from app.field_visits fv
      join app.commercial_requests cr on cr.tenant_id = fv.tenant_id and cr.id = fv.request_id
      join app.users u on u.tenant_id = fv.tenant_id and u.id = fv.assigned_technician_id
      where fv.tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.requestId) {
      params.push(query.requestId);
      sql += ` and fv.request_id = $${params.length}`;
    }
    if (query.technicianId) {
      params.push(query.technicianId);
      sql += ` and fv.assigned_technician_id = $${params.length}`;
    }
    if (query.status) {
      params.push(query.status);
      sql += ` and fv.status = $${params.length}`;
    }
    if (query.scheduledDate) {
      params.push(query.scheduledDate);
      sql += ` and fv.scheduled_date = $${params.length}`;
    }

    sql += " order by fv.scheduled_date desc, fv.created_at desc";

    const res = await db.query<FieldVisitDto>(sql, params);
    return res.rows;
  });
}

export async function getFieldVisit(
  token: string | null,
  visitId: string,
): Promise<FieldVisitDto> {
  z.string().uuid("ID de visita inválido").parse(visitId);

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    const res = await db.query<FieldVisitDto>(
      `select 
         fv.id,
         fv.request_id as "requestId",
         cr.code as "requestCode",
         fv.assigned_technician_id as "assignedTechnicianId",
         u.display_name as "assignedTechnicianName",
         to_char(fv.scheduled_date, 'YYYY-MM-DD') as "scheduledDate",
         fv.status,
         fv.observations,
         fv.started_at as "startedAt",
         fv.completed_at as "completedAt",
         fv.created_at as "createdAt",
         fv.created_by as "createdBy",
         fv.updated_at as "updatedAt",
         fv.updated_by as "updatedBy"
       from app.field_visits fv
       join app.commercial_requests cr on cr.tenant_id = fv.tenant_id and cr.id = fv.request_id
       join app.users u on u.tenant_id = fv.tenant_id and u.id = fv.assigned_technician_id
       where fv.tenant_id = $1 and fv.id = $2`,
      [scope.tenantId, visitId],
    );

    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Visita técnica no encontrada.");
    const visit = res.rows[0]!;

    const mRes = await db.query<FieldVisitCabinMeasureDto>(
      `select 
         id, visit_id as "visitId", cabin_id as "cabinId",
         width_mm::text as "widthMm", height_mm::text as "heightMm", depth_mm::text as "depthMm",
         observations, created_at as "createdAt"
       from app.field_visit_cabin_measures
       where tenant_id = $1 and visit_id = $2
       order by created_at asc`,
      [scope.tenantId, visitId],
    );

    visit.measures = mRes.rows;
    return visit;
  });
}

export async function updateFieldVisitStatus(
  token: string | null,
  visitId: string,
  rawInput: unknown,
): Promise<FieldVisitDto> {
  z.string().uuid("ID de visita inválido").parse(visitId);
  const input = updateFieldVisitStatusSchema.parse(rawInput);

  return runAuthorized(token, "field.execute", true, async (db, scope) => {
    const vRes = await db.query<{ id: string; status: string; assigned_technician_id: string }>(
      "select id, status, assigned_technician_id from app.field_visits where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, visitId],
    );
    if (vRes.rowCount === 0) throw new AppError("NOT_FOUND", "Visita técnica no encontrada.");

    // C-05: El personal de campo solo modifica visitas asignadas a sí mismo a menos que tenga gestión
    const actorRes = await db.query<{ actor: ActorContext | null }>("select app_private.actor() as actor");
    const actor = actorRes.rows[0]?.actor;
    const canManage = actor && actor.platformRole === "TENANT" && (
      actor.authority === "ADMIN" ||
      (actor.rolePermissions?.includes("field.manage") && !actor.denials?.includes("field.manage")) ||
      actor.grants?.includes("field.manage")
    );

    if (!canManage && vRes.rows[0]!.assigned_technician_id !== scope.userId) {
      throw new AppError("FORBIDDEN", "No está autorizado para modificar una visita técnica asignada a otro técnico.");
    }

    const startedAtExpr = input.status === "IN_PROGRESS" ? "coalesce(started_at, now())" : "started_at";
    const completedAtExpr = input.status === "COMPLETED" ? "now()" : "completed_at";

    const updRes = await db.query<FieldVisitDto>(
      `update app.field_visits
       set status = $3,
           observations = coalesce($4, observations),
           started_at = ${startedAtExpr},
           completed_at = ${completedAtExpr},
           updated_at = now(),
           updated_by = $5
       where tenant_id = $1 and id = $2
       returning 
         id, request_id as "requestId", assigned_technician_id as "assignedTechnicianId",
         to_char(scheduled_date, 'YYYY-MM-DD') as "scheduledDate", status, observations,
         started_at as "startedAt", completed_at as "completedAt",
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [scope.tenantId, visitId, input.status, input.observations ?? null, scope.userId],
    );

    return updRes.rows[0]!;
  });
}

export async function recordVisitMeasures(
  token: string | null,
  rawInput: unknown,
): Promise<FieldVisitCabinMeasureDto[]> {
  const input = recordVisitMeasuresSchema.parse(rawInput);

  return runAuthorized(token, "field.execute", true, async (db, scope) => {
    // 1. Validar visita
    const vRes = await db.query<{ id: string; request_id: string; status: string; assigned_technician_id: string }>(
      "select id, request_id, status, assigned_technician_id from app.field_visits where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, input.visitId],
    );
    if (vRes.rowCount === 0) throw new AppError("NOT_FOUND", "Visita técnica no encontrada.");
    const visit = vRes.rows[0]!;

    // C-05: El personal de campo solo registra medidas en visitas asignadas a sí mismo a menos que tenga gestión
    const actorRes = await db.query<{ actor: ActorContext | null }>("select app_private.actor() as actor");
    const actor = actorRes.rows[0]?.actor;
    const canManage = actor && actor.platformRole === "TENANT" && (
      actor.authority === "ADMIN" ||
      (actor.rolePermissions?.includes("field.manage") && !actor.denials?.includes("field.manage")) ||
      actor.grants?.includes("field.manage")
    );

    if (!canManage && visit.assigned_technician_id !== scope.userId) {
      throw new AppError("FORBIDDEN", "No está autorizado para registrar medidas en una visita técnica asignada a otro técnico.");
    }

    if (visit.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se pueden registrar medidas en una visita técnica cancelada.");
    }

    // 2. Verificar si existe cotización aprobada previamente (COT-011, DEC-012):
    // "Cambio de medidas aprobadas -> nueva versión y aprobación cliente."
    const quotRes = await db.query(
      `select id, version from app.quotations
       where tenant_id = $1 and request_id = $2 and status = 'APPROVED'`,
      [scope.tenantId, visit.request_id],
    );
    const hasApprovedQuotation = (quotRes.rowCount ?? 0) > 0;

    const savedMeasures: FieldVisitCabinMeasureDto[] = [];

    for (const m of input.measures) {
      // Validar pertenencia de la cabina a la solicitud
      const cabRes = await db.query(
        "select id from app.request_cabins where tenant_id = $1 and request_id = $2 and id = $3",
        [scope.tenantId, visit.request_id, m.cabinId],
      );
      if (cabRes.rowCount === 0) {
        throw new AppError("VALIDATION_ERROR", `La cabina ${m.cabinId} no pertenece a la solicitud de esta visita.`);
      }

      // Guardar o actualizar medida de la visita
      const insRes = await db.query<FieldVisitCabinMeasureDto>(
        `insert into app.field_visit_cabin_measures(
           tenant_id, visit_id, cabin_id, width_mm, height_mm, depth_mm, observations
         ) values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, visit_id, cabin_id)
         do update set 
           width_mm = $4,
           height_mm = $5,
           depth_mm = $6,
           observations = $7
         returning 
           id, visit_id as "visitId", cabin_id as "cabinId",
           width_mm::text as "widthMm", height_mm::text as "heightMm", depth_mm::text as "depthMm",
           observations, created_at as "createdAt"`,
        [
          scope.tenantId,
          input.visitId,
          m.cabinId,
          m.widthMm,
          m.heightMm,
          m.depthMm,
          m.observations ?? null,
        ],
      );

      // Actualizar dimensiones rectificadas (cm) de la cabina física en la solicitud
      await db.query(
        `update app.request_cabins
         set custom_width = round(($3::numeric / 10.0), 2),
             custom_height = round(($4::numeric / 10.0), 2),
             updated_at = now()
         where tenant_id = $1 and id = $2`,
        [scope.tenantId, m.cabinId, m.widthMm, m.heightMm],
      );

      savedMeasures.push(insRes.rows[0]!);
    }

    // Si ya había cotización aprobada, marcamos la solicitud para requerir re-cotización/nueva versión
    if (hasApprovedQuotation) {
      await db.query(
        `update app.commercial_requests
         set status = 'QUOTED', updated_at = now(), updated_by = $3
         where tenant_id = $1 and id = $2`,
        [scope.tenantId, visit.request_id, scope.userId],
      );
    }

    return savedMeasures;
  });
}
