import "server-only";
import { z } from "zod";
import type pg from "pg";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { canReadCosts, type ActorContext } from "../../identity/server/authorization";
import {
  submitProcurementReviewSchema,
  createPurchaseOrderSchema,
  receivePurchaseOrderSchema,
  type ProcurementReviewDto,
  type PurchaseOrderDto,
  type PurchaseOrderLineDto,
} from "../../../shared/contracts/operations";

// ==========================================
// REVISIÓN DE COMPRAS (3.1)
// ==========================================

export async function submitProcurementReview(
  token: string | null,
  rawInput: unknown,
): Promise<ProcurementReviewDto> {
  const input = submitProcurementReviewSchema.parse(rawInput);

  return runAuthorized(token, "procurement.review", true, async (db, scope) => {
    // 1. Verificar que la cotización exista y pertenezca al tenant y request
    const qRes = await db.query(
      `select id, version, status 
       from app.quotations 
       where tenant_id = $1 and id = $2 and request_id = $3`,
      [scope.tenantId, input.quotationId, input.requestId],
    );

    if (qRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const quot = qRes.rows[0]!;

    if (quot.status !== "APPROVED") {
      throw new AppError("VALIDATION_ERROR");
    }

    // 2. Insertar revisión de compras
    const revRes = await db.query<ProcurementReviewDto>(
      `insert into app.procurement_reviews(
         tenant_id, request_id, quotation_id, quotation_version, status,
         notes, reviewed_by, reviewed_at, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7, now(), $7)
       returning 
         id, request_id as "requestId", quotation_id as "quotationId",
         quotation_version as "quotationVersion", status, notes,
         reviewed_by as "reviewedBy", reviewed_at as "reviewedAt",
         created_at as "createdAt", created_by as "createdBy"`,
      [
        scope.tenantId,
        input.requestId,
        input.quotationId,
        quot.version,
        input.status,
        input.notes ?? null,
        scope.userId,
      ],
    );

    return revRes.rows[0]!;
  });
}

export async function getProcurementReview(
  token: string | null,
  requestId: string,
): Promise<ProcurementReviewDto | null> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);

  return runAuthorized(token, "procurement.read", false, async (db, scope) => {
    const res = await db.query<ProcurementReviewDto>(
      `select 
         id, request_id as "requestId", quotation_id as "quotationId",
         quotation_version as "quotationVersion", status, notes,
         reviewed_by as "reviewedBy", reviewed_at as "reviewedAt",
         created_at as "createdAt", created_by as "createdBy"
       from app.procurement_reviews
       where tenant_id = $1 and request_id = $2
       order by created_at desc
       limit 1`,
      [scope.tenantId, requestId],
    );

    return res.rows[0] ?? null;
  });
}

// ==========================================
// ÓRDENES DE COMPRA (3.1)
// ==========================================

export async function createPurchaseOrder(
  token: string | null,
  rawInput: unknown,
): Promise<PurchaseOrderDto> {
  const input = createPurchaseOrderSchema.parse(rawInput);

  return runAuthorized(token, "procurement.orders", true, async (db, scope) => {
    // 1. Verificar proveedor activo
    const supRes = await db.query(
      "select id, name from app.suppliers where tenant_id = $1 and id = $2 and active = true",
      [scope.tenantId, input.supplierId],
    );
    if (supRes.rowCount === 0) throw new AppError("VALIDATION_ERROR");

    // 2. Generar consecutivo
    const codeRes = await db.query<{ code: string }>(
      "select app_private.next_purchase_order_code() as code",
    );
    const code = codeRes.rows[0]!.code;

    // 3. Crear cabecera de orden de compra
    const poRes = await db.query<{ id: string }>(
      `insert into app.purchase_orders(
         tenant_id, code, supplier_id, status, notes, created_by, updated_by
       ) values ($1, $2, $3, 'ORDERED', $4, $5, $5)
       returning id`,
      [scope.tenantId, code, input.supplierId, input.notes ?? null, scope.userId],
    );
    const orderId = poRes.rows[0]!.id;

    // 4. Crear líneas
    for (const line of input.lines) {
      await db.query(
        `insert into app.purchase_order_lines(
           tenant_id, order_id, product_id, request_id, quantity, unit_cost, expected_date, notes
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          scope.tenantId,
          orderId,
          line.productId,
          line.requestId ?? null,
          line.quantity,
          line.unitCost ?? 0,
          line.expectedDate ?? null,
          line.notes ?? null,
        ],
      );
    }

    return getPurchaseOrderInternal(db, scope, orderId);
  });
}

async function getPurchaseOrderInternal(
  db: pg.PoolClient,
  scope: { tenantId: string | null; userId: string },
  orderId: string,
): Promise<PurchaseOrderDto> {
  if (!scope.tenantId) throw new AppError("FORBIDDEN");
  const actorRes = await db.query<{ actor: ActorContext | null }>(
    "select app_private.actor() actor",
  );
  const showCosts = canReadCosts(actorRes.rows[0]?.actor);

  const poRes = await db.query(
    `select 
       po.id, po.code, po.supplier_id as "supplierId", s.name as "supplierName",
       po.status, po.notes, po.ordered_at as "orderedAt",
       po.created_at as "createdAt", po.created_by as "createdBy",
       po.updated_at as "updatedAt", po.updated_by as "updatedBy"
     from app.purchase_orders po
     join app.suppliers s on s.tenant_id = po.tenant_id and s.id = po.supplier_id
     where po.tenant_id = $1 and po.id = $2`,
    [scope.tenantId, orderId],
  );

  if (poRes.rowCount === 0) throw new AppError("NOT_FOUND");
  const po = poRes.rows[0]!;

  const linesRes = await db.query(
    `select 
       pol.id, pol.order_id as "orderId", pol.product_id as "productId",
       cp.name as "productName", cp.sku as "productSku",
       pol.request_id as "requestId", pol.quantity, pol.unit_cost as "unitCost",
       pol.received_quantity as "receivedQuantity",
       (pol.quantity - pol.received_quantity) as "pendingQuantity",
       pol.expected_date as "expectedDate", pol.notes
     from app.purchase_order_lines pol
     join app.catalog_products cp on cp.tenant_id = pol.tenant_id and cp.id = pol.product_id
     where pol.tenant_id = $1 and pol.order_id = $2
     order by pol.id asc`,
    [scope.tenantId, orderId],
  );

  const lines: PurchaseOrderLineDto[] = linesRes.rows.map((row) => ({
    id: row.id,
    orderId: row.orderId,
    productId: row.productId,
    productName: row.productName,
    productSku: row.productSku,
    requestId: row.requestId,
    quantity: row.quantity,
    unitCost: showCosts ? row.unitCost : null,
    receivedQuantity: row.receivedQuantity,
    pendingQuantity: row.pendingQuantity,
    expectedDate: row.expectedDate ? String(row.expectedDate).slice(0, 10) : null,
    notes: row.notes,
  }));

  return {
    ...po,
    lines,
  };
}

export async function getPurchaseOrder(
  token: string | null,
  orderId: string,
): Promise<PurchaseOrderDto> {
  z.string().uuid("ID de orden inválido").parse(orderId);

  return runAuthorized(token, "procurement.read", false, async (db, scope) => {
    return getPurchaseOrderInternal(db, scope, orderId);
  });
}

export async function listPurchaseOrders(
  token: string | null,
  rawQuery?: unknown,
): Promise<PurchaseOrderDto[]> {
  const query = z
    .object({
      supplierId: z.string().uuid().optional(),
      status: z.enum(["DRAFT", "ORDERED", "PARTIAL_RECEIVED", "RECEIVED", "CANCELLED"]).optional(),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "procurement.read", false, async (db, scope) => {
    let sql = `
      select 
        po.id, po.code, po.supplier_id as "supplierId", s.name as "supplierName",
        po.status, po.notes, po.ordered_at as "orderedAt",
        po.created_at as "createdAt", po.created_by as "createdBy",
        po.updated_at as "updatedAt", po.updated_by as "updatedBy"
      from app.purchase_orders po
      join app.suppliers s on s.tenant_id = po.tenant_id and s.id = po.supplier_id
      where po.tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.supplierId) {
      params.push(query.supplierId);
      sql += ` and po.supplier_id = $${params.length}`;
    }
    if (query.status) {
      params.push(query.status);
      sql += ` and po.status = $${params.length}`;
    }

    sql += " order by po.created_at desc";

    const res = await db.query<PurchaseOrderDto>(sql, params);
    return res.rows;
  });
}

// ==========================================
// RECEPCIÓN DE COMPRA Y ENTRADA A BODEGA (3.1 & 3.2)
// ==========================================

export async function receivePurchaseOrder(
  token: string | null,
  orderId: string,
  rawInput: unknown,
): Promise<PurchaseOrderDto> {
  z.string().uuid("ID de orden inválido").parse(orderId);
  const input = receivePurchaseOrderSchema.parse(rawInput);

  return runAuthorized(token, "procurement.receive", true, async (db, scope) => {
    // 1. Obtener orden de compra con bloqueo
    const poRes = await db.query(
      "select id, status from app.purchase_orders where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, orderId],
    );
    if (poRes.rowCount === 0) throw new AppError("NOT_FOUND");
    if (poRes.rows[0]!.status === "CANCELLED" || poRes.rows[0]!.status === "RECEIVED") {
      throw new AppError("CONFLICT");
    }

    // 2. Crear cabecera de recepción
    const rcptRes = await db.query<{ id: string }>(
      `insert into app.procurement_receipts(
         tenant_id, order_id, notes, received_by
       ) values ($1, $2, $3, $4)
       returning id`,
      [scope.tenantId, orderId, input.notes ?? null, scope.userId],
    );
    const receiptId = rcptRes.rows[0]!.id;

    // 3. Procesar cada línea recibida
    for (const item of input.lines) {
      // Bloquear la línea de orden de compra
      const lineRes = await db.query(
        `select 
           pol.id, pol.product_id, pol.request_id, pol.quantity, pol.received_quantity,
           cp.kind as product_kind
         from app.purchase_order_lines pol
         join app.catalog_products cp on cp.tenant_id = pol.tenant_id and cp.id = pol.product_id
         where pol.tenant_id = $1 and pol.order_id = $2 and pol.id = $3
         for update`,
        [scope.tenantId, orderId, item.orderLineId],
      );

      if (lineRes.rowCount === 0) throw new AppError("VALIDATION_ERROR");
      const line = lineRes.rows[0]!;

      const currentReceived = parseFloat(line.received_quantity);
      const totalOrdered = parseFloat(line.quantity);
      const newReceived = currentReceived + item.quantityReceived;

      if (newReceived > totalOrdered) {
        throw new AppError("VALIDATION_ERROR");
      }

      // Actualizar cantidad recibida en la línea
      await db.query(
        "update app.purchase_order_lines set received_quantity = $1 where tenant_id = $2 and id = $3",
        [newReceived, scope.tenantId, item.orderLineId],
      );

      // Registrar línea de recepción
      await db.query(
        `insert into app.procurement_receipt_lines(
           tenant_id, receipt_id, order_line_id, quantity_received
         ) values ($1, $2, $3, $4)`,
        [scope.tenantId, receiptId, item.orderLineId, item.quantityReceived],
      );

      // Actualizar bodega: obtener saldo actual con FOR UPDATE
      const stockRes = await db.query(
        `select quantity from app.warehouse_stock
         where tenant_id = $1 and product_id = $2
         for update`,
        [scope.tenantId, line.product_id],
      );

      const previousBalance = stockRes.rowCount ? parseFloat(stockRes.rows[0]!.quantity) : 0;
      const newBalance = previousBalance + item.quantityReceived;

      await db.query(
        `insert into app.warehouse_stock(tenant_id, product_id, quantity, updated_at)
         values ($1, $2, $3, now())
         on conflict (tenant_id, product_id)
         do update set quantity = $3, updated_at = now()`,
        [scope.tenantId, line.product_id, newBalance],
      );

      // Movimiento inmutable de inventario (DEC-029)
      await db.query(
        `insert into app.inventory_movements(
           tenant_id, product_id, movement_type, quantity, previous_balance, new_balance,
           reference_type, reference_id, notes, created_by
         ) values ($1, $2, 'RECEPTION', $3, $4, $5, 'PURCHASE_RECEIPT', $6, $7, $8)`,
        [
          scope.tenantId,
          line.product_id,
          item.quantityReceived,
          previousBalance,
          newBalance,
          receiptId,
          `Recepcion OC ${orderId}`,
          scope.userId,
        ],
      );

      // Si el producto es CABIN y está asignado a una solicitud, registrar en cabin_stock
      if (line.product_kind === "CABIN" && line.request_id) {
        // Encontrar cabinas de la solicitud para asignar
        const reqCabins = await db.query(
          `select rc.id from app.request_cabins rc
           left join app.cabin_stock cs on cs.tenant_id = rc.tenant_id and cs.cabin_id = rc.id
           where rc.tenant_id = $1 and rc.request_id = $2 and rc.product_id = $3 and cs.cabin_id is null
           limit $4`,
          [scope.tenantId, line.request_id, line.product_id, Math.floor(item.quantityReceived)],
        );

        for (const cabin of reqCabins.rows) {
          await db.query(
            `insert into app.cabin_stock(tenant_id, cabin_id, request_id, product_id, status, location)
             values ($1, $2, $3, $4, 'IN_STOCK', 'Bodega Principal')
             on conflict (tenant_id, cabin_id) do update set status = 'IN_STOCK'`,
            [scope.tenantId, cabin.id, line.request_id, line.product_id],
          );
        }
      }
    }

    // 4. Actualizar estado de la orden de compra según totales recibidos
    const checkLines = await db.query(
      `select 
         sum(quantity) as total_qty,
         sum(received_quantity) as total_received
       from app.purchase_order_lines
       where tenant_id = $1 and order_id = $2`,
      [scope.tenantId, orderId],
    );

    const totalQty = parseFloat(checkLines.rows[0]!.total_qty || "0");
    const totalRcv = parseFloat(checkLines.rows[0]!.total_received || "0");

    const newStatus = totalRcv >= totalQty ? "RECEIVED" : "PARTIAL_RECEIVED";
    await db.query(
      "update app.purchase_orders set status = $1, updated_at = now(), updated_by = $2 where tenant_id = $3 and id = $4",
      [newStatus, scope.userId, scope.tenantId, orderId],
    );

    return getPurchaseOrderInternal(db, scope, orderId);
  });
}
