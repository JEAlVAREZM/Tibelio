import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { Decimal } from "../../../shared/server/money-math";
import {
  adjustStockSchema,
  updateCabinStatusSchema,
  reassignCabinStockSchema,
  type StockItemDto,
  type CabinStockDto,
  type InventoryMovementDto,
} from "../../../shared/contracts/operations";

export async function listStock(
  token: string | null,
  rawQuery?: unknown,
): Promise<StockItemDto[]> {
  const query = z
    .object({
      kind: z.enum(["CABIN", "ACCESSORY", "MATERIAL"]).optional(),
      search: z.string().trim().optional(),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "inventory.read", false, async (db, scope) => {
    let sql = `
      select 
        cp.id as "productId",
        cp.name as "productName",
        cp.sku as "productSku",
        cp.kind as "productKind",
        coalesce(ws.quantity, 0) as quantity,
        coalesce(ws.updated_at, cp.updated_at) as "updatedAt"
      from app.catalog_products cp
      left join app.warehouse_stock ws on ws.tenant_id = cp.tenant_id and ws.product_id = cp.id
      where cp.tenant_id = $1 and cp.active = true
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.kind) {
      params.push(query.kind);
      sql += ` and cp.kind = $${params.length}`;
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      sql += ` and (cp.name ilike $${params.length} or cp.sku ilike $${params.length})`;
    }

    sql += " order by cp.name asc";

    const res = await db.query<StockItemDto>(sql, params);
    return res.rows;
  });
}

export async function listCabinStock(
  token: string | null,
  rawQuery?: unknown,
): Promise<CabinStockDto[]> {
  const query = z
    .object({
      requestId: z.string().uuid().optional(),
      status: z.enum(["IN_STOCK", "DISPATCHED", "RETURNED", "DAMAGED"]).optional(),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "inventory.read", false, async (db, scope) => {
    let sql = `
      select 
        cs.cabin_id as "cabinId",
        cs.request_id as "requestId",
        cr.code as "requestCode",
        cs.product_id as "productId",
        cp.name as "productName",
        cs.status,
        cs.location,
        cs.updated_at as "updatedAt"
      from app.cabin_stock cs
      join app.commercial_requests cr on cr.tenant_id = cs.tenant_id and cr.id = cs.request_id
      join app.catalog_products cp on cp.tenant_id = cs.tenant_id and cp.id = cs.product_id
      where cs.tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.requestId) {
      params.push(query.requestId);
      sql += ` and cs.request_id = $${params.length}`;
    }
    if (query.status) {
      params.push(query.status);
      sql += ` and cs.status = $${params.length}`;
    }

    sql += " order by cs.updated_at desc";

    const res = await db.query<CabinStockDto>(sql, params);
    return res.rows;
  });
}

export async function adjustStock(
  token: string | null,
  rawInput: unknown,
): Promise<StockItemDto> {
  const input = adjustStockSchema.parse(rawInput);

  return runAuthorized(token, "inventory.manage", true, async (db, scope) => {
    // 1. Obtener producto activo
    const prodRes = await db.query(
      "select id, name, sku, kind from app.catalog_products where tenant_id = $1 and id = $2 and active = true",
      [scope.tenantId, input.productId],
    );
    if (prodRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const prod = prodRes.rows[0]!;

    // 2. Obtener saldo actual con FOR UPDATE (bloqueo pesimista)
    const stockRes = await db.query(
      "select quantity from app.warehouse_stock where tenant_id = $1 and product_id = $2 for update",
      [scope.tenantId, input.productId],
    );

    const previousBalance = Decimal.from(stockRes.rows[0]?.quantity || "0");
    const newBalance = previousBalance.add(input.quantityDelta);

    // Regla maestra: las existencias NUNCA pueden ser negativas
    if (newBalance.isNegative()) {
      throw new AppError("VALIDATION_ERROR", "Las existencias de almacén no pueden ser negativas.");
    }

    // 3. Actualizar o insertar saldo
    await db.query(
      `insert into app.warehouse_stock(tenant_id, product_id, quantity, updated_at)
       values ($1, $2, $3, now())
       on conflict (tenant_id, product_id)
       do update set quantity = $3, updated_at = now()`,
      [scope.tenantId, input.productId, newBalance.round(2)],
    );

    // 4. Registrar movimiento inmutable (DEC-029)
    await db.query(
      `insert into app.inventory_movements(
         tenant_id, product_id, movement_type, quantity, previous_balance, new_balance,
         reference_type, reference_id, notes, created_by
       ) values ($1, $2, $3, $4, $5, $6, 'ADJUSTMENT', gen_random_uuid(), $7, $8)`,
      [
        scope.tenantId,
        input.productId,
        input.movementType,
        input.quantityDelta,
        previousBalance.round(2),
        newBalance.round(2),
        input.reason,
        scope.userId,
      ],
    );

    return {
      productId: prod.id,
      productName: prod.name,
      productSku: prod.sku,
      productKind: prod.kind,
      quantity: newBalance.round(2),
      updatedAt: new Date().toISOString(),
    };
  });
}

export async function listMovements(
  token: string | null,
  rawQuery?: unknown,
): Promise<InventoryMovementDto[]> {
  const query = z
    .object({
      productId: z.string().uuid().optional(),
      movementType: z.enum(["RECEPTION", "RETURN", "DAMAGE", "ADJUSTMENT", "DISPATCH", "CONSUMPTION"]).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional().default(50),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "inventory.read", false, async (db, scope) => {
    let sql = `
      select 
        im.id,
        im.product_id as "productId",
        cp.name as "productName",
        im.cabin_id as "cabinId",
        im.movement_type as "movementType",
        im.quantity,
        im.previous_balance as "previousBalance",
        im.new_balance as "newBalance",
        im.reference_type as "referenceType",
        im.reference_id as "referenceId",
        im.notes,
        im.created_at as "createdAt",
        im.created_by as "createdBy"
      from app.inventory_movements im
      join app.catalog_products cp on cp.tenant_id = im.tenant_id and cp.id = im.product_id
      where im.tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.productId) {
      params.push(query.productId);
      sql += ` and im.product_id = $${params.length}`;
    }
    if (query.movementType) {
      params.push(query.movementType);
      sql += ` and im.movement_type = $${params.length}`;
    }

    params.push(query.limit);
    sql += ` order by im.created_at desc limit $${params.length}`;

    const res = await db.query<InventoryMovementDto>(sql, params);
    return res.rows;
  });
}

export async function updateCabinStockStatus(
  token: string | null,
  cabinId: string,
  rawInput: unknown,
): Promise<CabinStockDto> {
  z.string().uuid("ID de cabina inválido").parse(cabinId);
  const input = updateCabinStatusSchema.parse(rawInput);

  return runAuthorized(token, "inventory.manage", true, async (db, scope) => {
    const cabRes = await db.query<{
      cabin_id: string;
      request_id: string;
      product_id: string;
      status: string;
    }>(
      `select cabin_id, request_id, product_id, status
       from app.cabin_stock
       where tenant_id = $1 and cabin_id = $2
       for update`,
      [scope.tenantId, cabinId],
    );

    if (cabRes.rowCount === 0) throw new AppError("NOT_FOUND", "Cabina física no encontrada en existencias.");
    const row = cabRes.rows[0]!;

    const updRes = await db.query<CabinStockDto>(
      `update app.cabin_stock
       set status = $3,
           location = coalesce($4, location),
           notes = coalesce($5, notes),
           updated_at = now()
       where tenant_id = $1 and cabin_id = $2
       returning 
         cabin_id as "cabinId", request_id as "requestId", product_id as "productId",
         status, location, notes, updated_at as "updatedAt"`,
      [scope.tenantId, cabinId, input.status, input.location ?? null, input.notes ?? null],
    );

    const movType = input.status === "DAMAGED" ? "DAMAGE" : input.status === "RETURNED" ? "RETURN" : "ADJUSTMENT";
    await db.query(
      `insert into app.inventory_movements(
         tenant_id, product_id, cabin_id, movement_type, quantity,
         previous_balance, new_balance, reference_type, reference_id, notes, created_by
       ) values ($1, $2, $3, $4, 0, 1, 1, 'DAMAGE_REPORT', $3, $5, $6)`,
      [
        scope.tenantId,
        row.product_id,
        cabinId,
        movType,
        input.notes ?? `Cambio de estado físico de cabina a ${input.status}`,
        scope.userId,
      ],
    );

    return updRes.rows[0]!;
  });
}

export async function reassignCabinStock(
  token: string | null,
  rawInput: unknown,
): Promise<CabinStockDto> {
  const input = reassignCabinStockSchema.parse(rawInput);

  return runAuthorized(token, "inventory.manage", true, async (db, scope) => {
    // 1. Obtener y bloquear cabina física (DEC-012, DEC-051)
    const cabRes = await db.query<{
      cabin_id: string;
      request_id: string;
      product_id: string;
      status: string;
      location: string | null;
    }>(
      `select cabin_id, request_id, product_id, status, location
       from app.cabin_stock
       where tenant_id = $1 and cabin_id = $2
       for update`,
      [scope.tenantId, input.cabinId],
    );

    if (cabRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Cabina física no encontrada en existencias.");
    }
    const cabin = cabRes.rows[0]!;

    // Solo se pueden reasignar cabinas disponibles en bodega (IN_STOCK o RETURNED)
    if (cabin.status !== "IN_STOCK" && cabin.status !== "RETURNED") {
      throw new AppError(
        "CONFLICT",
        `La cabina no está disponible para reasignación en bodega (estado actual: ${cabin.status}).`,
      );
    }

    // 2. Verificar solicitud de destino activa
    const targetReqRes = await db.query<{ id: string; status: string; code: string }>(
      `select id, status, code from app.commercial_requests
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, input.targetRequestId],
    );
    if (targetReqRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Solicitud comercial de destino no encontrada.");
    }
    const targetReq = targetReqRes.rows[0]!;
    if (targetReq.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede reasignar una cabina a una solicitud cancelada.");
    }

    // 3. Verificar que la solicitud de destino requiera este modelo de cabina
    const itemRes = await db.query(
      `select id from app.request_cabins
       where tenant_id = $1 and request_id = $2 and product_id = $3`,
      [scope.tenantId, input.targetRequestId, cabin.product_id],
    );
    if ((itemRes.rowCount ?? 0) === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "La solicitud de destino no contiene cabinas compatibles con el producto asignado.",
      );
    }

    // 4. Actualizar asignación de la cabina física conservando trazabilidad
    const updRes = await db.query<CabinStockDto>(
      `update app.cabin_stock
       set request_id = $3,
           status = 'ASSIGNED',
           reassigned_at = now(),
           reassigned_by = $4,
           notes = $5,
           updated_at = now()
       where tenant_id = $1 and cabin_id = $2
       returning 
         cabin_id as "cabinId", request_id as "requestId", product_id as "productId",
         status, location, notes, released_from_request_id as "releasedFromRequestId",
         reassigned_at as "reassignedAt", reassigned_by as "reassignedBy",
         updated_at as "updatedAt"`,
      [
        scope.tenantId,
        input.cabinId,
        input.targetRequestId,
        scope.userId,
        input.reason,
      ],
    );

    // 5. Registrar movimiento inmutable de inventario (DEC-029/DEC-056)
    await db.query(
      `insert into app.inventory_movements(
         tenant_id, product_id, cabin_id, movement_type, quantity,
         previous_balance, new_balance, reference_type, reference_id, notes, created_by
       ) values ($1, $2, $3, 'ADJUSTMENT', 1, 1, 1, 'ADJUSTMENT', $4, $5, $6)`,
      [
        scope.tenantId,
        cabin.product_id,
        input.cabinId,
        input.targetRequestId,
        `Reasignación formal de cabina hacia solicitud ${targetReq.code}: ${input.reason}`,
        scope.userId,
      ],
    );

    return updRes.rows[0]!;
  });
}

