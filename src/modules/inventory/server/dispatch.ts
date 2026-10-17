import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { Decimal } from "../../../shared/server/money-math";
import {
  executeDispatchSchema,
  type DispatchEligibilityDto,
  type DispatchRecordDto,
  type MissingStockItem,
} from "../../../shared/contracts/operations";

export async function checkDispatchEligibility(
  token: string | null,
  requestId: string,
): Promise<DispatchEligibilityDto> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);

  return runAuthorized(token, "inventory.read", false, async (db, scope) => {
    const reasons: string[] = [];

    // 1. Verificar solicitud existente y no cancelada
    const reqRes = await db.query<{ id: string; status: string; priority: string }>(
      "select id, status, priority from app.commercial_requests where tenant_id = $1 and id = $2",
      [scope.tenantId, requestId],
    );
    if (reqRes.rowCount === 0) {
      return {
        eligible: false,
        reasons: ["La solicitud comercial no existe."],
        reviewStatus: "NOT_FOUND",
        approvedQuotationVersion: null,
        missingProducts: [],
        paymentsValidated: false,
        payableAmount: "0.00",
        validatedAmount: "0.00",
      };
    }
    if (reqRes.rows[0]!.status === "CANCELLED") {
      reasons.push("La solicitud comercial se encuentra cancelada.");
    }

    // 2. Verificar cotización aprobada
    const quotRes = await db.query<{ id: string; version: number; total_amount: string }>(
      `select id, version, total_amount
       from app.quotations
       where tenant_id = $1 and request_id = $2 and status = 'APPROVED'
       order by version desc limit 1`,
      [scope.tenantId, requestId],
    );

    const quot = quotRes.rows[0];
    const approvedQuotationVersion = quot?.version ?? null;

    if (!quot) {
      reasons.push("La solicitud no cuenta con una cotización formal aprobada vigente.");
    }

    // 3. Verificar revisión de compras correspondiente a la versión aprobada
    let reviewStatus: "APPROVED" | "PENDING" | "REJECTED" | "NOT_FOUND" = "NOT_FOUND";
    if (quot) {
      const revRes = await db.query<{ status: string; quotation_version: number }>(
        `select status, quotation_version 
         from app.procurement_reviews 
         where tenant_id = $1 and request_id = $2 and quotation_id = $3 and quotation_version = $4
         order by created_at desc limit 1`,
        [scope.tenantId, requestId, quot.id, quot.version],
      );

      if ((revRes.rowCount ?? 0) > 0) {
        reviewStatus = revRes.rows[0]!.status as "APPROVED" | "PENDING" | "REJECTED";
        if (reviewStatus !== "APPROVED") {
          reasons.push(`La revisión técnica de compras para la versión v${quot.version} está en estado '${reviewStatus}'.`);
        }
      } else {
        reasons.push(`No se ha registrado revisión de compras para la versión v${quot.version} de la cotización.`);
      }
    }

    // 4. Verificar pagos exigibles según condiciones pactadas por hito (aritmética exacta)
    let totalPayable = Decimal.from(0);
    let netCollected = Decimal.from(0);
    let requiredDispatchAmount = Decimal.from(0);
    let paymentsValidated = false;

    if (quot) {
      // Base cotizada
      totalPayable = Decimal.from(quot.total_amount);

      // Ajustes efectivos aprobados
      const adjRes = await db.query<{ net_adj: string }>(
        `select coalesce(sum(case when adjustment_type = 'INCREASE' then amount else -amount end), 0) as net_adj
         from app.quotation_adjustments
         where tenant_id = $1 and quotation_id = $2 and status = 'APPROVED'`,
        [scope.tenantId, quot.id],
      );
      totalPayable = totalPayable.add(adjRes.rows[0]?.net_adj || "0");
      if (totalPayable.isNegative()) totalPayable = Decimal.from(0);

      // Pagos validados
      const payRes = await db.query<{ val_pay: string }>(
        `select coalesce(sum(amount), 0) as val_pay
         from app.client_payments
         where tenant_id = $1 and request_id = $2 and status = 'VALIDATED'`,
        [scope.tenantId, requestId],
      );
      const valPay = Decimal.from(payRes.rows[0]?.val_pay || "0");

      // Devoluciones desembolsadas
      const refRes = await db.query<{ disb_pay: string }>(
        `select coalesce(sum(amount), 0) as disb_pay
         from app.refund_records
         where tenant_id = $1 and request_id = $2 and status = 'DISBURSED'`,
        [scope.tenantId, requestId],
      );
      const disbPay = Decimal.from(refRes.rows[0]?.disb_pay || "0");

      // Recaudo neto uniforme
      const rawNet = valPay.sub(disbPay);
      netCollected = rawNet.isNegative() ? Decimal.from(0) : rawNet;

      // Verificar condiciones de pago pactadas por hito
      const termsRes = await db.query<{ milestone: string; amount: string }>(
        `select milestone, amount
         from app.payment_terms
         where tenant_id = $1 and quotation_id = $2 and active = true`,
        [scope.tenantId, quot.id],
      );

      if ((termsRes.rowCount ?? 0) > 0) {
        // Si existen hitos pactados: se exige la cobertura de hitos previos al despacho
        // ('DOWN_PAYMENT', 'MANUFACTURE', 'PRE_DISPATCH')
        for (const term of termsRes.rows) {
          if (["DOWN_PAYMENT", "MANUFACTURE", "PRE_DISPATCH"].includes(term.milestone)) {
            requiredDispatchAmount = requiredDispatchAmount.add(term.amount);
          }
        }
      } else {
        // En ausencia de hitos específicos, se exige la cobertura total del pedido
        requiredDispatchAmount = totalPayable;
      }

      if (netCollected.lt(requiredDispatchAmount)) {
        reasons.push(
          `Pagos netos validados insuficientes ($${netCollected.round(2)}) para cubrir el exigible previo al despacho ($${requiredDispatchAmount.round(2)}).`,
        );
      } else {
        paymentsValidated = true;
      }
    }

    // 5. Verificar disponibilidad física de stock (cabinas, accesorios Y materiales)
    const missingProducts: MissingStockItem[] = [];

    if (quot) {
      // Cabinas requeridas
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
           where tenant_id = $1 and request_id = $2 and product_id = $3 and status = 'IN_STOCK'`,
          [scope.tenantId, requestId, cr.product_id],
        );
        const available = parseInt(stockRes.rows[0]!.available_count, 10);
        const required = parseInt(cr.required_count, 10);

        if (available < required) {
          missingProducts.push({
            productId: cr.product_id,
            productName: cr.name,
            productKind: "CABIN",
            required,
            available,
          });
          reasons.push(
            `Faltan ${required - available} unidades de cabina física '${cr.name}' disponibles en bodega.`,
          );
        }
      }

      // Accesorios y Materiales requeridos
      const itemReqs = await db.query<{ product_id: string; name: string; kind: string; required_qty: string }>(
        `select qi.product_id, cp.name, cp.kind, sum(qi.quantity) as required_qty
         from app.quotation_items qi
         join app.catalog_products cp on cp.tenant_id = qi.tenant_id and cp.id = qi.product_id
         where qi.tenant_id = $1 and qi.quotation_id = $2 and qi.item_type in ('ACCESSORY', 'MATERIAL')
         group by qi.product_id, cp.name, cp.kind`,
        [scope.tenantId, quot.id],
      );

      for (const ir of itemReqs.rows) {
        const stockRes = await db.query<{ qty: string }>(
          "select coalesce(quantity, 0) as qty from app.warehouse_stock where tenant_id = $1 and product_id = $2",
          [scope.tenantId, ir.product_id],
        );
        const availableDec = Decimal.from(stockRes.rows[0]?.qty || "0");
        const requiredDec = Decimal.from(ir.required_qty);

        if (availableDec.lt(requiredDec)) {
          const diff = requiredDec.sub(availableDec);
          missingProducts.push({
            productId: ir.product_id,
            productName: ir.name,
            productKind: ir.kind,
            required: requiredDec.toNumber(),
            available: availableDec.toNumber(),
          });
          reasons.push(
            `Faltan ${diff.round(2)} unidades del producto '${ir.name}' (${ir.kind}) en bodega.`,
          );
        }
      }
    }

    const eligible = reasons.length === 0;

    return {
      eligible,
      reasons,
      reviewStatus,
      approvedQuotationVersion,
      missingProducts,
      paymentsValidated,
      payableAmount: requiredDispatchAmount.round(2),
      validatedAmount: netCollected.round(2),
    };
  });
}

export async function executeDispatch(
  token: string | null,
  rawInput: unknown,
): Promise<DispatchRecordDto> {
  const input = executeDispatchSchema.parse(rawInput);

  return runAuthorized(token, "inventory.dispatch", true, async (db, scope) => {
    // 1. Revalidar dentro de la transacción que la solicitud no está cancelada
    const reqRes = await db.query<{ id: string; status: string }>(
      `select id, status from app.commercial_requests
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede despachar una solicitud comercial cancelada.");
    }

    // 2. Revalidar cotización aprobada con bloqueo
    const qRes = await db.query<{ id: string; version: number; status: string; total_amount: string }>(
      `select id, version, status, total_amount
       from app.quotations 
       where tenant_id = $1 and id = $2 and request_id = $3
       for update`,
      [scope.tenantId, input.quotationId, input.requestId],
    );

    if (qRes.rowCount === 0) throw new AppError("NOT_FOUND", "Cotización no encontrada para la solicitud.");
    const quot = qRes.rows[0]!;
    if (quot.status !== "APPROVED") {
      throw new AppError("VALIDATION_ERROR", `La cotización debe estar en estado 'APPROVED' para despachar (actual: '${quot.status}').`);
    }

    // 3. Revalidar correspondencia exacta de la revisión de compras con la versión despachada
    const revRes = await db.query<{ status: string }>(
      `select status from app.procurement_reviews 
       where tenant_id = $1 and request_id = $2 and quotation_id = $3 and quotation_version = $4
       order by created_at desc limit 1`,
      [scope.tenantId, input.requestId, input.quotationId, quot.version],
    );
    if (!revRes.rowCount || revRes.rows[0]!.status !== "APPROVED") {
      throw new AppError(
        "VALIDATION_ERROR",
        `La revisión técnica de compras para la versión v${quot.version} no ha sido aprobada.`,
      );
    }

    // 4. Revalidar pagos exigibles según condiciones pactadas por hito
    let totalPayable = Decimal.from(quot.total_amount);
    const adjRes = await db.query<{ net_adj: string }>(
      `select coalesce(sum(case when adjustment_type = 'INCREASE' then amount else -amount end), 0) as net_adj
       from app.quotation_adjustments
       where tenant_id = $1 and quotation_id = $2 and status = 'APPROVED'`,
      [scope.tenantId, quot.id],
    );
    totalPayable = totalPayable.add(adjRes.rows[0]?.net_adj || "0");
    if (totalPayable.isNegative()) totalPayable = Decimal.from(0);

    const payRes = await db.query<{ val_pay: string }>(
      `select coalesce(sum(amount), 0) as val_pay
       from app.client_payments
       where tenant_id = $1 and request_id = $2 and status = 'VALIDATED'`,
      [scope.tenantId, input.requestId],
    );
    const valPay = Decimal.from(payRes.rows[0]?.val_pay || "0");

    const refRes = await db.query<{ disb_pay: string }>(
      `select coalesce(sum(amount), 0) as disb_pay
       from app.refund_records
       where tenant_id = $1 and request_id = $2 and status = 'DISBURSED'`,
      [scope.tenantId, input.requestId],
    );
    const disbPay = Decimal.from(refRes.rows[0]?.disb_pay || "0");

    const rawNet = valPay.sub(disbPay);
    const netCollected = rawNet.isNegative() ? Decimal.from(0) : rawNet;

    const termsRes = await db.query<{ milestone: string; amount: string }>(
      `select milestone, amount
       from app.payment_terms
       where tenant_id = $1 and quotation_id = $2 and active = true`,
      [scope.tenantId, quot.id],
    );

    let requiredDispatchAmount = Decimal.from(0);
    if ((termsRes.rowCount ?? 0) > 0) {
      for (const term of termsRes.rows) {
        if (["DOWN_PAYMENT", "MANUFACTURE", "PRE_DISPATCH"].includes(term.milestone)) {
          requiredDispatchAmount = requiredDispatchAmount.add(term.amount);
        }
      }
    } else {
      requiredDispatchAmount = totalPayable;
    }

    if (netCollected.lt(requiredDispatchAmount)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Pagos netos validados insuficientes ($${netCollected.round(2)}) para cubrir el exigible previo al despacho ($${requiredDispatchAmount.round(2)}).`,
      );
    }

    // 5. Crear cabecera de despacho
    const dispRes = await db.query<{ id: string }>(
      `insert into app.dispatch_records(
         tenant_id, request_id, quotation_id, status, notes,
         dispatched_at, dispatched_by, created_by
       ) values ($1, $2, $3, 'DISPATCHED', $4, now(), $5, $5)
       returning id`,
      [scope.tenantId, input.requestId, input.quotationId, input.notes ?? null, scope.userId],
    );
    const dispatchId = dispRes.rows[0]!.id;

    // 6. Descontar cabinas físicas individuales (DEC-051): cambiar estado a DISPATCHED
    const cabinsRes = await db.query<{ id: string; cabin_id: string; product_id: string }>(
      `select id, cabin_id, product_id from app.quotation_cabins
       where tenant_id = $1 and quotation_id = $2`,
      [scope.tenantId, input.quotationId],
    );

    for (const c of cabinsRes.rows) {
      const cabinStockRes = await db.query<{ cabin_id: string; status: string }>(
        `select cabin_id, status from app.cabin_stock
         where tenant_id = $1 and cabin_id = $2 and status in ('IN_STOCK', 'ASSIGNED')
         for update`,
        [scope.tenantId, c.cabin_id],
      );

      if (cabinStockRes.rowCount === 0) {
        throw new AppError(
          "CONFLICT",
          `La cabina física con ID '${c.cabin_id}' no está disponible en bodega para despacho.`,
        );
      }

      await db.query(
        `update app.cabin_stock
         set status = 'DISPATCHED', updated_at = now()
         where tenant_id = $1 and cabin_id = $2`,
        [scope.tenantId, c.cabin_id],
      );

      await db.query(
        `insert into app.dispatch_lines(tenant_id, dispatch_id, product_id, cabin_id, quantity)
         values ($1, $2, $3, $4, 1)`,
        [scope.tenantId, dispatchId, c.product_id, c.cabin_id],
      );

      await db.query(
        `insert into app.inventory_movements(
           tenant_id, product_id, cabin_id, movement_type, quantity,
           previous_balance, new_balance, reference_type, reference_id, notes, created_by
         ) values ($1, $2, $3, 'DISPATCH', -1, 1, 0, 'DISPATCH', $4, $5, $6)`,
        [
          scope.tenantId,
          c.product_id,
          c.cabin_id,
          dispatchId,
          `Despacho físico de cabina para solicitud ${input.requestId}`,
          scope.userId,
        ],
      );
    }

    // 7. Descontar accesorios y materiales requeridos de existencias en bodega
    const itemReqs = await db.query<{ product_id: string; item_type: string; quantity: string }>(
      `select ri.product_id, qi.item_type, sum(qi.quantity) as quantity
       from app.quotation_items qi
       join app.request_items ri on ri.tenant_id = qi.tenant_id and ri.id = qi.request_item_id
       where qi.tenant_id = $1 and qi.quotation_id = $2 and qi.item_type = 'ACCESSORY'
       group by ri.product_id, qi.item_type`,
      [scope.tenantId, input.quotationId],
    );

    for (const item of itemReqs.rows) {
      const reqQty = Decimal.from(item.quantity);

      const stockRes = await db.query<{ quantity: string }>(
        `select quantity from app.warehouse_stock
         where tenant_id = $1 and product_id = $2
         for update`,
        [scope.tenantId, item.product_id],
      );

      const currentQty = Decimal.from(stockRes.rows[0]?.quantity || "0");
      if (currentQty.lt(reqQty)) {
        throw new AppError(
          "CONFLICT",
          `Existencias insuficientes para despachar el producto '${item.product_id}'. Requerido: ${reqQty.round(2)}, disponible: ${currentQty.round(2)}.`,
        );
      }

      const newQty = currentQty.sub(reqQty);

      await db.query(
        `update app.warehouse_stock
         set quantity = $3, updated_at = now()
         where tenant_id = $1 and product_id = $2`,
        [scope.tenantId, item.product_id, newQty.round(2)],
      );

      await db.query(
        `insert into app.dispatch_lines(tenant_id, dispatch_id, product_id, quantity)
         values ($1, $2, $3, $4)`,
        [scope.tenantId, dispatchId, item.product_id, reqQty.round(2)],
      );

      await db.query(
        `insert into app.inventory_movements(
           tenant_id, product_id, movement_type, quantity,
           previous_balance, new_balance, reference_type, reference_id, notes, created_by
         ) values ($1, $2, 'DISPATCH', $3, $4, $5, 'DISPATCH', $6, $7, $8)`,
        [
          scope.tenantId,
          item.product_id,
          reqQty.mul(-1).round(2),
          currentQty.round(2),
          newQty.round(2),
          dispatchId,
          `Despacho de ítems para solicitud ${input.requestId}`,
          scope.userId,
        ],
      );
    }

    // 8. Consultar cabecera y líneas para respuesta DTO
    const linesRes = await db.query(
      `select dl.id, dl.product_id as "productId", cp.name as "productName",
              dl.cabin_id as "cabinId", dl.quantity
       from app.dispatch_lines dl
       join app.catalog_products cp on cp.tenant_id = dl.tenant_id and cp.id = dl.product_id
       where dl.tenant_id = $1 and dl.dispatch_id = $2`,
      [scope.tenantId, dispatchId],
    );

    return {
      id: dispatchId,
      requestId: input.requestId,
      quotationId: input.quotationId,
      status: "DISPATCHED",
      notes: input.notes ?? null,
      dispatchedAt: new Date().toISOString(),
      dispatchedBy: scope.userId,
      createdAt: new Date().toISOString(),
      createdBy: scope.userId,
      lines: linesRes.rows,
    };
  });
}
