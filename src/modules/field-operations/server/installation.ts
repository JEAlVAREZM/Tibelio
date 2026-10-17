import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import type { ActorContext } from "../../identity/server/authorization";
import { AppError } from "../../../shared/server/app-error";
import { Decimal } from "../../../shared/server/money-math";
import {
  startInstallationSessionSchema,
  updateInstallationSessionSchema,
  reconcileMaterialConsumptionSchema,
  type InstallationSessionDto,
  type InstallationMaterialConsumptionDto,
} from "../../../shared/contracts/field-operations";

export async function startInstallationSession(
  token: string | null,
  rawInput: unknown,
): Promise<InstallationSessionDto> {
  const input = startInstallationSessionSchema.parse(rawInput);

  return runAuthorized(token, "field.manage", true, async (db, scope) => {
    // 1. Validar solicitud y tarea principal de instalación (OPE-004, AT-15, C-02, C-03, C-04)
    const reqRes = await db.query<{ id: string; status: string; code: string }>(
      "select id, status, code from app.commercial_requests where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede iniciar una sesión de instalación en una solicitud cancelada.");
    }

    // Verificar si la solicitud ya fue cerrada operativamente
    const closedRes = await db.query(
      "select id from app.operational_closures where tenant_id = $1 and request_id = $2",
      [scope.tenantId, input.requestId],
    );
    if ((closedRes.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", "La solicitud ya cuenta con un cierre operativo y entrega firmada.");
    }

    const taskRes = await db.query<{ id: string; request_id: string; task_type: string; assigned_to: string }>(
      "select id, request_id, task_type, assigned_to from app.field_tasks where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, input.taskId],
    );
    if (taskRes.rowCount === 0) throw new AppError("NOT_FOUND", "Tarea de campo no encontrada.");
    const task = taskRes.rows[0]!;

    if (task.request_id !== input.requestId) {
      throw new AppError("VALIDATION_ERROR", "La tarea de campo seleccionada no pertenece a la solicitud comercial especificada.");
    }

    if (task.task_type !== "INSTALLATION") {
      throw new AppError("VALIDATION_ERROR", "La tarea seleccionada no es de tipo INSTALACIÓN.");
    }

    // Exigir despacho previo de las unidades antes de la instalación en campo (C-04)
    const cabinStockRes = await db.query<{ cabin_id: string; status: string }>(
      "select cabin_id, status from app.cabin_stock where tenant_id = $1 and request_id = $2",
      [scope.tenantId, input.requestId],
    );
    if (cabinStockRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR", "La solicitud no cuenta con cabinas físicas registradas en inventario.");
    }
    const hasUndispatched = cabinStockRes.rows.some((c) => c.status !== "DISPATCHED");
    if (hasUndispatched) {
      throw new AppError("VALIDATION_ERROR", "Todas las cabinas físicas deben estar previamente despachadas de bodega antes de iniciar la instalación en campo.");
    }

    // 2. Verificar si los materiales ya fueron descontados previamente en otra sesión de la misma solicitud
    const prevDedRes = await db.query(
      `select id from app.installation_sessions
       where tenant_id = $1 and request_id = $2 and materials_deducted = true`,
      [scope.tenantId, input.requestId],
    );
    const alreadyDeducted = (prevDedRes.rowCount ?? 0) > 0;

    // 3. Crear sesión de instalación
    const insRes = await db.query<InstallationSessionDto>(
      `insert into app.installation_sessions(
         tenant_id, request_id, task_id, session_date, technician_id,
         status, started_at, materials_deducted, notes, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, 'IN_PROGRESS', now(), $6, $7, $8, $8)
       returning 
         id, request_id as "requestId", task_id as "taskId",
         to_char(session_date, 'YYYY-MM-DD') as "sessionDate", technician_id as "technicianId",
         status, started_at as "startedAt", ended_at as "endedAt",
         materials_deducted as "materialsDeducted", notes,
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.requestId,
        input.taskId,
        input.sessionDate,
        task.assigned_to,
        alreadyDeducted,
        input.notes ?? null,
        scope.userId,
      ],
    );
    const session = insRes.rows[0]!;

    // 4. Si aún no se habían descontado los materiales, descontar transaccionalmente del almacén (DEC-029, AT-15, C-06)
    if (!alreadyDeducted) {
      // Buscar productos de catálogo de tipo MATERIAL asociados a la cotización aprobada mediante FKs estables
      const quotRes = await db.query<{ id: string }>(
        `select id from app.quotations
         where tenant_id = $1 and request_id = $2 and status = 'APPROVED'
         order by version desc limit 1`,
        [scope.tenantId, input.requestId],
      );

      let plannedMaterials: Array<{ materialId: string; quantity: number }> = [];

      if ((quotRes.rowCount ?? 0) > 0) {
        // Enlazar de manera estable a través de request_items o product_id en quotation_items
        const matRes = await db.query<{ material_id: string; quantity: number }>(
          `select 
             coalesce(qi.product_id, ri.product_id) as material_id,
             qi.quantity
           from app.quotation_items qi
           left join app.request_items ri on ri.tenant_id = qi.tenant_id and ri.id = qi.request_item_id
           where qi.tenant_id = $1 and qi.quotation_id = $2 and qi.item_type = 'MATERIAL'
             and coalesce(qi.product_id, ri.product_id) is not null`,
          [scope.tenantId, quotRes.rows[0]!.id],
        );
        plannedMaterials = matRes.rows.map((r) => ({
          materialId: r.material_id,
          quantity: Number(r.quantity),
        }));
      }

      // Descontar cada material planificado bloqueando inventario
      for (const pm of plannedMaterials) {
        const stockRes = await db.query<{ quantity: string }>(
          `select quantity from app.warehouse_stock
           where tenant_id = $1 and product_id = $2
           for update`,
          [scope.tenantId, pm.materialId],
        );

        const currentStock = Decimal.from(stockRes.rows[0]?.quantity || "0");
        const plannedDec = Decimal.from(pm.quantity);

        if (currentStock.lt(plannedDec)) {
          throw new AppError(
            "VALIDATION_ERROR",
            `Existencias insuficientes de material para iniciar instalación (disponible: ${currentStock.round(2)}, requerido: ${plannedDec.round(2)}). El stock no puede ser negativo.`,
          );
        }

        const newStock = currentStock.sub(plannedDec);

        await db.query(
          `update app.warehouse_stock
           set quantity = $3, updated_at = now()
           where tenant_id = $1 and product_id = $2`,
          [scope.tenantId, pm.materialId, newStock.round(2)],
        );

        // Movimiento inmutable de consumo
        await db.query(
          `insert into app.inventory_movements(
             tenant_id, product_id, movement_type, quantity, previous_balance, new_balance,
             reference_type, reference_id, notes, created_by
           ) values ($1, $2, 'CONSUMPTION', $3, $4, $5, 'ADJUSTMENT', $6, $7, $8)`,
          [
            scope.tenantId,
            pm.materialId,
            -plannedDec.toNumber(),
            currentStock.round(2),
            newStock.round(2),
            session.id,
            `Deducción inicial planificada de instalación para solicitud ${reqRes.rows[0]!.code}`,
            scope.userId,
          ],
        );

        // Registro de consumo de material en la sesión
        await db.query(
          `insert into app.installation_material_consumptions(
             tenant_id, session_id, request_id, material_id, planned_quantity, actual_quantity, difference, reconciled, notes
           ) values ($1, $2, $3, $4, $5, 0, 0, false, $6)`,
          [
            scope.tenantId,
            session.id,
            input.requestId,
            pm.materialId,
            plannedDec.round(2),
            "Descuento automático inicial al arrancar instalación",
          ],
        );
      }

      // Marcar sesión como deducción efectuada
      await db.query(
        "update app.installation_sessions set materials_deducted = true where tenant_id = $1 and id = $2",
        [scope.tenantId, session.id],
      );
      session.materialsDeducted = true;
    }

    // Actualizar estado de la tarea y de la solicitud a EN PROGRESO
    await db.query(
      "update app.field_tasks set status = 'IN_PROGRESS', updated_at = now(), updated_by = $3 where tenant_id = $1 and id = $2",
      [scope.tenantId, input.taskId, scope.userId],
    );

    return session;
  });
}

export async function updateInstallationSession(
  token: string | null,
  sessionId: string,
  rawInput: unknown,
): Promise<InstallationSessionDto> {
  z.string().uuid("ID de sesión inválido").parse(sessionId);
  const input = updateInstallationSessionSchema.parse(rawInput);

  return runAuthorized(token, "field.execute", true, async (db, scope) => {
    const sRes = await db.query<{ id: string; status: string; task_id: string; technician_id: string }>(
      "select id, status, task_id, technician_id from app.installation_sessions where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, sessionId],
    );
    if (sRes.rowCount === 0) throw new AppError("NOT_FOUND", "Sesión de instalación no encontrada.");
    const session = sRes.rows[0]!;

    // C-05: El personal de campo solo modifica sesiones asignadas a sí mismo a menos que tenga gestión
    const actorRes = await db.query<{ actor: ActorContext | null }>("select app_private.actor() as actor");
    const actor = actorRes.rows[0]?.actor;
    const canManage = actor && actor.platformRole === "TENANT" && (
      actor.authority === "ADMIN" ||
      (actor.rolePermissions?.includes("field.manage") && !actor.denials?.includes("field.manage")) ||
      actor.grants?.includes("field.manage")
    );

    if (!canManage && session.technician_id !== scope.userId) {
      throw new AppError("FORBIDDEN", "No está autorizado para modificar una sesión de instalación asignada a otro técnico.");
    }

    const endedAtExpr = input.status === "COMPLETED" ? "now()" : "ended_at";

    const updRes = await db.query<InstallationSessionDto>(
      `update app.installation_sessions
       set status = $3,
           notes = coalesce($4, notes),
           ended_at = ${endedAtExpr},
           updated_at = now(),
           updated_by = $5
       where tenant_id = $1 and id = $2
       returning 
         id, request_id as "requestId", task_id as "taskId",
         to_char(session_date, 'YYYY-MM-DD') as "sessionDate", technician_id as "technicianId",
         status, started_at as "startedAt", ended_at as "endedAt",
         materials_deducted as "materialsDeducted", notes,
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [scope.tenantId, sessionId, input.status, input.notes ?? null, scope.userId],
    );

    return updRes.rows[0]!;
  });
}

export async function reconcileMaterialConsumption(
  token: string | null,
  rawInput: unknown,
): Promise<InstallationMaterialConsumptionDto[]> {
  const input = reconcileMaterialConsumptionSchema.parse(rawInput);

  return runAuthorized(token, "field.execute", true, async (db, scope) => {
    const sRes = await db.query<{ id: string; request_id: string; status: string; technician_id: string }>(
      "select id, request_id, status, technician_id from app.installation_sessions where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, input.sessionId],
    );
    if (sRes.rowCount === 0) throw new AppError("NOT_FOUND", "Sesión de instalación no encontrada.");
    const session = sRes.rows[0]!;

    // C-05: El personal de campo solo modifica o concilia sesiones asignadas a sí mismo a menos que tenga gestión
    const actorRes = await db.query<{ actor: ActorContext | null }>("select app_private.actor() as actor");
    const actor = actorRes.rows[0]?.actor;
    const canManage = actor && actor.platformRole === "TENANT" && (
      actor.authority === "ADMIN" ||
      (actor.rolePermissions?.includes("field.manage") && !actor.denials?.includes("field.manage")) ||
      actor.grants?.includes("field.manage")
    );

    if (!canManage && session.technician_id !== scope.userId) {
      throw new AppError("FORBIDDEN", "No está autorizado para conciliar materiales en una sesión asignada a otro técnico.");
    }

    const results: InstallationMaterialConsumptionDto[] = [];

    for (const c of input.consumptions) {
      // 1. Obtener o insertar registro de consumo
      const consRes = await db.query<{
        id: string;
        planned_quantity: string;
        actual_quantity: string;
        reconciled: boolean;
      }>(
        `select id, planned_quantity, actual_quantity, reconciled
         from app.installation_material_consumptions
         where tenant_id = $1 and session_id = $2 and material_id = $3
         for update`,
        [scope.tenantId, input.sessionId, c.materialId],
      );

      const planned = consRes.rowCount
        ? Decimal.from(consRes.rows[0]!.planned_quantity)
        : Decimal.from(0);
      const isAlreadyReconciled = (consRes.rowCount ?? 0) > 0 && Boolean(consRes.rows[0]!.reconciled);
      const previouslyDeducted = isAlreadyReconciled
        ? Decimal.from(consRes.rows[0]!.actual_quantity)
        : planned;
      const newActual = Decimal.from(c.actualQuantity);

      // C-01: Delta a ajustar en bodega frente a lo efectivamente deducido hasta ahora
      const delta = newActual.sub(previouslyDeducted);

      // Bloquear stock en almacén para conciliación
      const stockRes = await db.query<{ quantity: string }>(
        `select quantity from app.warehouse_stock
         where tenant_id = $1 and product_id = $2
         for update`,
        [scope.tenantId, c.materialId],
      );
      const currentStock = Decimal.from(stockRes.rows[0]?.quantity || "0");

      if (delta.gt(0)) {
        // Se consumió MÁS de lo planificado -> descontar diferencia de bodega
        if (currentStock.lt(delta)) {
          throw new AppError(
            "VALIDATION_ERROR",
            `Existencias insuficientes para conciliar exceso de consumo (disponible: ${currentStock.round(2)}, exceso requerido: ${delta.round(2)}).`,
          );
        }
        const newStock = currentStock.sub(delta);

        await db.query(
          `update app.warehouse_stock set quantity = $3, updated_at = now() where tenant_id = $1 and product_id = $2`,
          [scope.tenantId, c.materialId, newStock.round(2)],
        );

        await db.query(
          `insert into app.inventory_movements(
             tenant_id, product_id, movement_type, quantity, previous_balance, new_balance,
             reference_type, reference_id, notes, created_by
           ) values ($1, $2, 'CONSUMPTION', $3, $4, $5, 'ADJUSTMENT', $6, $7, $8)`,
          [
            scope.tenantId,
            c.materialId,
            -delta.toNumber(),
            currentStock.round(2),
            newStock.round(2),
            session.id,
            `Ajuste por mayor consumo real en instalación: ${c.notes ?? "Conciliación de materiales"}`,
            scope.userId,
          ],
        );
      } else if (delta.lt(0)) {
        // Se consumió MENOS de lo planificado -> devolver sobrante a bodega
        const returnQty = delta.abs();
        const newStock = currentStock.add(returnQty);

        await db.query(
          `update app.warehouse_stock set quantity = $3, updated_at = now() where tenant_id = $1 and product_id = $2`,
          [scope.tenantId, c.materialId, newStock.round(2)],
        );

        await db.query(
          `insert into app.inventory_movements(
             tenant_id, product_id, movement_type, quantity, previous_balance, new_balance,
             reference_type, reference_id, notes, created_by
           ) values ($1, $2, 'RETURN', $3, $4, $5, 'ADJUSTMENT', $6, $7, $8)`,
          [
            scope.tenantId,
            c.materialId,
            returnQty.toNumber(),
            currentStock.round(2),
            newStock.round(2),
            session.id,
            `Reintegro de material sobrante en instalación: ${c.notes ?? "Conciliación de materiales"}`,
            scope.userId,
          ],
        );
      }

      const diff = newActual.sub(planned);

      // Actualizar o insertar fila de consumo
      const updRes = await db.query<InstallationMaterialConsumptionDto>(
        `insert into app.installation_material_consumptions(
           tenant_id, session_id, request_id, material_id,
           planned_quantity, actual_quantity, difference, reconciled, notes
         ) values ($1, $2, $3, $4, $5, $6, $7, true, $8)
         on conflict (tenant_id, session_id, material_id)
         do update set
           actual_quantity = $6,
           difference = $7,
           reconciled = true,
           notes = coalesce($8, app.installation_material_consumptions.notes)
         returning 
           id, session_id as "sessionId", request_id as "requestId", material_id as "materialId",
           planned_quantity::text as "plannedQuantity", actual_quantity::text as "actualQuantity",
           difference::text as difference, reconciled, notes, created_at as "createdAt"`,
        [
          scope.tenantId,
          input.sessionId,
          session.request_id,
          c.materialId,
          planned.round(2),
          newActual.round(2),
          diff.round(2),
          c.notes ?? null,
        ],
      );

      results.push(updRes.rows[0]!);
    }

    return results;
  });
}
