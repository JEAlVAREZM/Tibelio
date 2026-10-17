import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import type { ActorContext } from "../../identity/server/authorization";
import { AppError } from "../../../shared/server/app-error";
import { Decimal } from "../../../shared/server/money-math";
import {
  createFieldTaskSchema,
  updateFieldTaskStatusSchema,
  createFieldRouteSchema,
  recordLocationEventSchema,
  type FieldTaskDto,
  type FieldRouteDto,
  type FieldRouteStopDto,
  type FieldLocationEventDto,
} from "../../../shared/contracts/field-operations";

export async function createFieldTask(
  token: string | null,
  rawInput: unknown,
): Promise<FieldTaskDto> {
  const input = createFieldTaskSchema.parse(rawInput);

  return runAuthorized(token, "field.manage", true, async (db, scope) => {
    // 1. Validar solicitud existente y activa
    const reqRes = await db.query<{ id: string; status: string; code: string }>(
      "select id, status, code from app.commercial_requests where tenant_id = $1 and id = $2",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede programar una tarea en una solicitud cancelada.");
    }

    // Verificar si la solicitud ya cuenta con cierre operativo
    const closedRes = await db.query(
      "select id from app.operational_closures where tenant_id = $1 and request_id = $2",
      [scope.tenantId, input.requestId],
    );
    if ((closedRes.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", "La solicitud ya cuenta con un cierre operativo y entrega firmada.");
    }

    // 2. Para INSTALACIÓN o TRANSPORTE: verificar prerrequisitos operativos completos (DEC-008, COM-005, AT-11, AT-12, C-02):
    // Cotización vigente aprobada, revisión de compras completada, pagos netos y disponibilidad física en stock
    if (input.taskType === "INSTALLATION" || input.taskType === "TRANSPORT") {
      const quotRes = await db.query<{ id: string; version: number }>(
        `select id, version from app.quotations
         where tenant_id = $1 and request_id = $2 and status = 'APPROVED'
         order by version desc limit 1`,
        [scope.tenantId, input.requestId],
      );
      if (quotRes.rowCount === 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Para programar instalación o transporte debe existir una cotización formal aprobada.",
        );
      }
      const quot = quotRes.rows[0]!;

      // Revisión de compras debe coincidir con la versión exacta aprobada
      const procRes = await db.query(
        `select id from app.procurement_reviews
         where tenant_id = $1 and request_id = $2 and quotation_id = $3 and quotation_version = $4 and status = 'APPROVED'`,
        [scope.tenantId, input.requestId, quot.id, quot.version],
      );
      if (procRes.rowCount === 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          "La cotización aprobada requiere revisión de compras aprobada antes de programar la operación en campo.",
        );
      }

      // Validar cumplimiento de anticipo o pagos pactados para programación (restando devoluciones desembolsadas C-02)
      const termsRes = await db.query<{ required_amount: string }>(
        `select coalesce(sum(amount), 0) as required_amount
         from app.payment_terms
         where tenant_id = $1 and quotation_id = $2 and active = true and milestone in ('DOWN_PAYMENT', 'PRE_DISPATCH')`,
        [scope.tenantId, quot.id],
      );
      const requiredAmount = Decimal.from(termsRes.rows[0]?.required_amount || "0");

      if (requiredAmount.gt(0)) {
        const payRes = await db.query<{ validated_amount: string }>(
          `select coalesce(sum(amount), 0) as validated_amount
           from app.client_payments
           where tenant_id = $1 and request_id = $2 and status = 'VALIDATED'`,
          [scope.tenantId, input.requestId],
        );
        const refRes = await db.query<{ disbursed_amount: string }>(
          `select coalesce(sum(amount), 0) as disbursed_amount
           from app.refund_records
           where tenant_id = $1 and request_id = $2 and status = 'DISBURSED'`,
          [scope.tenantId, input.requestId],
        );
        const valPay = Decimal.from(payRes.rows[0]?.validated_amount || "0");
        const disbPay = Decimal.from(refRes.rows[0]?.disbursed_amount || "0");
        const netCollected = valPay.sub(disbPay).isNegative() ? Decimal.from(0) : valPay.sub(disbPay);

        if (netCollected.lt(requiredAmount)) {
          throw new AppError(
            "VALIDATION_ERROR",
            `Los pagos netos validados ($${netCollected.round(2)}) no cubren el anticipo pactado ($${requiredAmount.round(2)}) exigido para programar ${input.taskType.toLowerCase()}.`,
          );
        }
      }

      // Verificar disponibilidad física completa de cabinas en bodega sin reservas (C-02)
      const cabinReqs = await db.query<{ product_id: string; name: string; required_count: string }>(
        `select qc.product_id, cp.name, count(*) as required_count
         from app.quotation_cabins qc
         join app.catalog_products cp on cp.tenant_id = qc.tenant_id and cp.id = qc.product_id
         where qc.tenant_id = $1 and qc.quotation_id = $2
         group by qc.product_id, cp.name`,
        [scope.tenantId, quot.id],
      );
      for (const cr of cabinReqs.rows) {
        const stockRes = await db.query<{ available_count: string }>(
          `select count(*) as available_count
           from app.cabin_stock
           where tenant_id = $1 and request_id = $2 and product_id = $3 and status in ('IN_STOCK', 'ASSIGNED', 'DISPATCHED')`,
          [scope.tenantId, input.requestId, cr.product_id],
        );
        const available = parseInt(stockRes.rows[0]?.available_count || "0", 10);
        const required = parseInt(cr.required_count, 10);
        if (available < required) {
          throw new AppError(
            "VALIDATION_ERROR",
            `Disponibilidad física incompleta: faltan ${required - available} unidades de cabina '${cr.name}' en bodega para programar ${input.taskType.toLowerCase()}.`,
          );
        }
      }

      // Verificar disponibilidad de materiales y accesorios en almacén (C-02)
      const itemReqs = await db.query<{ product_id: string; name: string; required_qty: string }>(
        `select 
           coalesce(qi.product_id, ri.product_id) as product_id,
           cp.name,
           sum(qi.quantity) as required_qty
         from app.quotation_items qi
         left join app.request_items ri on ri.tenant_id = qi.tenant_id and ri.id = qi.request_item_id
         join app.catalog_products cp on cp.tenant_id = qi.tenant_id and cp.id = coalesce(qi.product_id, ri.product_id)
         where qi.tenant_id = $1 and qi.quotation_id = $2 and qi.item_type in ('ACCESSORY', 'MATERIAL')
           and coalesce(qi.product_id, ri.product_id) is not null
         group by coalesce(qi.product_id, ri.product_id), cp.name`,
        [scope.tenantId, quot.id],
      );
      for (const ir of itemReqs.rows) {
        const wStockRes = await db.query<{ quantity: string }>(
          "select coalesce(quantity, 0) as quantity from app.warehouse_stock where tenant_id = $1 and product_id = $2",
          [scope.tenantId, ir.product_id],
        );
        const availableDec = Decimal.from(wStockRes.rows[0]?.quantity || "0");
        const requiredDec = Decimal.from(ir.required_qty);
        if (availableDec.lt(requiredDec)) {
          throw new AppError(
            "VALIDATION_ERROR",
            `Existencias insuficientes del producto '${ir.name}' en almacén (disponible: ${availableDec.round(2)}, requerido: ${requiredDec.round(2)}).`,
          );
        }
      }
    }

    // 3. Validar responsable asignado
    const userRes = await db.query(
      "select id, display_name from app.users where tenant_id = $1 and id = $2 and active = true",
      [scope.tenantId, input.assignedTo],
    );
    if (userRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR", "El usuario responsable asignado no existe o no está activo.");
    }

    // 4. Crear tarea
    const insRes = await db.query<FieldTaskDto>(
      `insert into app.field_tasks(
         tenant_id, request_id, task_type, assigned_to, scheduled_date,
         status, title, description, stop_order, notes, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, 'SCHEDULED', $6, $7, $8, $9, $10, $10)
       returning 
         id, request_id as "requestId", task_type as "taskType", assigned_to as "assignedTo",
         to_char(scheduled_date, 'YYYY-MM-DD') as "scheduledDate", status, title, description,
         stop_order as "stopOrder", notes, created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.requestId,
        input.taskType,
        input.assignedTo,
        input.scheduledDate,
        input.title,
        input.description ?? null,
        input.stopOrder ?? 1,
        input.notes ?? null,
        scope.userId,
      ],
    );

    const task = insRes.rows[0]!;
    task.requestCode = reqRes.rows[0]!.code;
    task.assignedToName = userRes.rows[0]!.display_name;
    return task;
  });
}

export async function listFieldTasks(
  token: string | null,
  rawQuery?: unknown,
): Promise<FieldTaskDto[]> {
  const query = z
    .object({
      requestId: z.string().uuid().optional(),
      assignedTo: z.string().uuid().optional(),
      status: z.enum(["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
      taskType: z.enum(["VISIT", "TRANSPORT", "INSTALLATION", "MAINTENANCE"]).optional(),
      scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    let sql = `
      select 
        ft.id,
        ft.request_id as "requestId",
        cr.code as "requestCode",
        ft.task_type as "taskType",
        ft.assigned_to as "assignedTo",
        u.display_name as "assignedToName",
        to_char(ft.scheduled_date, 'YYYY-MM-DD') as "scheduledDate",
        ft.status,
        ft.title,
        ft.description,
        ft.stop_order as "stopOrder",
        ft.notes,
        ft.created_at as "createdAt",
        ft.created_by as "createdBy",
        ft.updated_at as "updatedAt",
        ft.updated_by as "updatedBy"
      from app.field_tasks ft
      join app.commercial_requests cr on cr.tenant_id = ft.tenant_id and cr.id = ft.request_id
      join app.users u on u.tenant_id = ft.tenant_id and u.id = ft.assigned_to
      where ft.tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.requestId) {
      params.push(query.requestId);
      sql += ` and ft.request_id = $${params.length}`;
    }
    if (query.assignedTo) {
      params.push(query.assignedTo);
      sql += ` and ft.assigned_to = $${params.length}`;
    }
    if (query.status) {
      params.push(query.status);
      sql += ` and ft.status = $${params.length}`;
    }
    if (query.taskType) {
      params.push(query.taskType);
      sql += ` and ft.task_type = $${params.length}`;
    }
    if (query.scheduledDate) {
      params.push(query.scheduledDate);
      sql += ` and ft.scheduled_date = $${params.length}`;
    }

    sql += " order by ft.scheduled_date asc, ft.stop_order asc, ft.created_at desc";

    const res = await db.query<FieldTaskDto>(sql, params);
    return res.rows;
  });
}

export async function getFieldTask(
  token: string | null,
  taskId: string,
): Promise<FieldTaskDto> {
  z.string().uuid("ID de tarea inválido").parse(taskId);

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    const res = await db.query<FieldTaskDto>(
      `select 
         ft.id,
         ft.request_id as "requestId",
         cr.code as "requestCode",
         ft.task_type as "taskType",
         ft.assigned_to as "assignedTo",
         u.display_name as "assignedToName",
         to_char(ft.scheduled_date, 'YYYY-MM-DD') as "scheduledDate",
         ft.status,
         ft.title,
         ft.description,
         ft.stop_order as "stopOrder",
         ft.notes,
         ft.created_at as "createdAt",
         ft.created_by as "createdBy",
         ft.updated_at as "updatedAt",
         ft.updated_by as "updatedBy"
       from app.field_tasks ft
       join app.commercial_requests cr on cr.tenant_id = ft.tenant_id and cr.id = ft.request_id
       join app.users u on u.tenant_id = ft.tenant_id and u.id = ft.assigned_to
       where ft.tenant_id = $1 and ft.id = $2`,
      [scope.tenantId, taskId],
    );

    if (res.rowCount === 0) throw new AppError("NOT_FOUND", "Tarea de campo no encontrada.");
    return res.rows[0]!;
  });
}

export async function updateFieldTaskStatus(
  token: string | null,
  taskId: string,
  rawInput: unknown,
): Promise<FieldTaskDto> {
  z.string().uuid("ID de tarea inválido").parse(taskId);
  const input = updateFieldTaskStatusSchema.parse(rawInput);

  return runAuthorized(token, "field.execute", true, async (db, scope) => {
    const tRes = await db.query<{ id: string; status: string; assigned_to: string }>(
      "select id, status, assigned_to from app.field_tasks where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, taskId],
    );
    if (tRes.rowCount === 0) throw new AppError("NOT_FOUND", "Tarea de campo no encontrada.");

    // C-05: El personal de campo solo modifica tareas asignadas a sí mismo a menos que tenga gestión
    const actorRes = await db.query<{ actor: ActorContext | null }>("select app_private.actor() as actor");
    const actor = actorRes.rows[0]?.actor;
    const canManage = actor && actor.platformRole === "TENANT" && (
      actor.authority === "ADMIN" ||
      (actor.rolePermissions?.includes("field.manage") && !actor.denials?.includes("field.manage")) ||
      actor.grants?.includes("field.manage")
    );

    if (!canManage && tRes.rows[0]!.assigned_to !== scope.userId) {
      throw new AppError("FORBIDDEN", "No está autorizado para modificar una tarea de campo asignada a otro técnico.");
    }

    const updRes = await db.query<FieldTaskDto>(
      `update app.field_tasks
       set status = $3,
           notes = coalesce($4, notes),
           updated_at = now(),
           updated_by = $5
       where tenant_id = $1 and id = $2
       returning 
         id, request_id as "requestId", task_type as "taskType", assigned_to as "assignedTo",
         to_char(scheduled_date, 'YYYY-MM-DD') as "scheduledDate", status, title, description,
         stop_order as "stopOrder", notes, created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [scope.tenantId, taskId, input.status, input.notes ?? null, scope.userId],
    );

    return updRes.rows[0]!;
  });
}

export async function createFieldRoute(
  token: string | null,
  rawInput: unknown,
): Promise<FieldRouteDto> {
  const input = createFieldRouteSchema.parse(rawInput);

  return runAuthorized(token, "field.manage", true, async (db, scope) => {
    // 1. Validar transportador activo
    const driverRes = await db.query(
      "select id, display_name from app.users where tenant_id = $1 and id = $2 and active = true",
      [scope.tenantId, input.driverId],
    );
    if (driverRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR", "El transportador asignado no existe o no está activo.");
    }

    // Validar pertenencia de paradas a solicitud (C-03)
    for (const stop of input.stops) {
      if (stop.taskId) {
        const stopTaskRes = await db.query<{ request_id: string }>(
          "select request_id from app.field_tasks where tenant_id = $1 and id = $2",
          [scope.tenantId, stop.taskId],
        );
        if (stopTaskRes.rowCount === 0) {
          throw new AppError("NOT_FOUND", `La tarea de campo '${stop.taskId}' de la parada no existe.`);
        }
        if (stopTaskRes.rows[0]!.request_id !== stop.requestId) {
          throw new AppError("VALIDATION_ERROR", `La tarea de campo '${stop.taskId}' no pertenece a la solicitud comercial '${stop.requestId}' de la parada.`);
        }
      }
    }

    // 2. Crear cabecera de ruta
    const routeRes = await db.query<FieldRouteDto>(
      `insert into app.field_routes(
         tenant_id, driver_id, route_date, title, status, vehicle_plate, notes, created_by, updated_by
       ) values ($1, $2, $3, $4, 'PLANNED', $5, $6, $7, $7)
       returning 
         id, driver_id as "driverId", to_char(route_date, 'YYYY-MM-DD') as "routeDate",
         title, status, vehicle_plate as "vehiclePlate", notes,
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.driverId,
        input.routeDate,
        input.title,
        input.vehiclePlate ?? null,
        input.notes ?? null,
        scope.userId,
      ],
    );
    const route = routeRes.rows[0]!;
    route.driverName = driverRes.rows[0]!.display_name;

    // 3. Insertar paradas
    const stops: FieldRouteStopDto[] = [];
    for (const stop of input.stops) {
      const stopRes = await db.query<FieldRouteStopDto>(
        `insert into app.field_route_stops(
           tenant_id, route_id, request_id, task_id, stop_order,
           address, contact_name, contact_phone, status, notes
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
         returning 
           id, route_id as "routeId", request_id as "requestId", task_id as "taskId",
           stop_order as "stopOrder", address, contact_name as "contactName",
           contact_phone as "contactPhone", status, notes, created_at as "createdAt"`,
        [
          scope.tenantId,
          route.id,
          stop.requestId,
          stop.taskId ?? null,
          stop.stopOrder,
          stop.address,
          stop.contactName ?? null,
          stop.contactPhone ?? null,
          stop.notes ?? null,
        ],
      );
      stops.push(stopRes.rows[0]!);
    }

    route.stops = stops;
    return route;
  });
}

export async function listFieldRoutes(
  token: string | null,
  rawQuery?: unknown,
): Promise<FieldRouteDto[]> {
  const query = z
    .object({
      driverId: z.string().uuid().optional(),
      routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    let sql = `
      select 
        fr.id,
        fr.driver_id as "driverId",
        u.display_name as "driverName",
        to_char(fr.route_date, 'YYYY-MM-DD') as "routeDate",
        fr.title,
        fr.status,
        fr.vehicle_plate as "vehiclePlate",
        fr.notes,
        fr.created_at as "createdAt",
        fr.created_by as "createdBy",
        fr.updated_at as "updatedAt",
        fr.updated_by as "updatedBy"
      from app.field_routes fr
      join app.users u on u.tenant_id = fr.tenant_id and u.id = fr.driver_id
      where fr.tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.driverId) {
      params.push(query.driverId);
      sql += ` and fr.driver_id = $${params.length}`;
    }
    if (query.routeDate) {
      params.push(query.routeDate);
      sql += ` and fr.route_date = $${params.length}`;
    }

    sql += " order by fr.route_date desc, fr.created_at desc";

    const res = await db.query<FieldRouteDto>(sql, params);
    return res.rows;
  });
}

export async function recordLocationEvent(
  token: string | null,
  rawInput: unknown,
): Promise<FieldLocationEventDto> {
  const input = recordLocationEventSchema.parse(rawInput);

  return runAuthorized(token, "field.execute", true, async (db, scope) => {
    // 1. Validar tarea
    const tRes = await db.query<{ id: string; status: string; assigned_to: string }>(
      "select id, status, assigned_to from app.field_tasks where tenant_id = $1 and id = $2",
      [scope.tenantId, input.taskId],
    );
    if (tRes.rowCount === 0) throw new AppError("NOT_FOUND", "Tarea de campo no encontrada.");

    // C-05: El personal de campo solo registra eventos en tareas asignadas a sí mismo a menos que tenga gestión
    const actorRes = await db.query<{ actor: ActorContext | null }>("select app_private.actor() as actor");
    const actor = actorRes.rows[0]?.actor;
    const canManage = actor && actor.platformRole === "TENANT" && (
      actor.authority === "ADMIN" ||
      (actor.rolePermissions?.includes("field.manage") && !actor.denials?.includes("field.manage")) ||
      actor.grants?.includes("field.manage")
    );

    if (!canManage && tRes.rows[0]!.assigned_to !== scope.userId) {
      throw new AppError("FORBIDDEN", "No está autorizado para registrar eventos de ubicación en una tarea asignada a otro técnico.");
    }

    // 2. Insertar evento con hora servidor inmutable (OPE-003, AT-16):
    // "Salida/llegada y GPS: eventos con hora servidor y coordenadas opcionales; permiso denegado o fallo permite marcar con advertencia."
    const insRes = await db.query<FieldLocationEventDto>(
      `insert into app.field_location_events(
         tenant_id, task_id, event_type, latitude, longitude,
         accuracy_meters, gps_status, warning_notes, server_recorded_at, recorded_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       returning 
         id, task_id as "taskId", event_type as "eventType",
         latitude::text as latitude, longitude::text as longitude,
         accuracy_meters::text as "accuracyMeters", gps_status as "gpsStatus",
         warning_notes as "warningNotes", server_recorded_at as "serverRecordedAt",
         recorded_by as "recordedBy"`,
      [
        scope.tenantId,
        input.taskId,
        input.eventType,
        input.latitude ?? null,
        input.longitude ?? null,
        input.accuracyMeters ?? null,
        input.gpsStatus,
        input.warningNotes ?? null,
        scope.userId,
      ],
    );

    return insRes.rows[0]!;
  });
}
