import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { writeReceipt, readReceipt } from "../../../shared/server/private-receipts";
import { Decimal } from "../../../shared/server/money-math";
import {
  createPaymentTermsSchema,
  registerPaymentSchema,
  validatePaymentSchema,
  annulPaymentSchema,
  createRefundSchema,
  disburseRefundSchema,
  cancelRequestSchema,
  type PaymentTermDto,
  type ClientPaymentDto,
  type FinancialSummaryDto,
  type RefundRecordDto,
  type CancellationRecordDto,
} from "../../../shared/contracts/operations";

// ==========================================
// 1. CONDICIONES DE PAGO (3.4)
// ==========================================

export async function createPaymentTerms(
  token: string | null,
  rawInput: unknown,
): Promise<PaymentTermDto[]> {
  const input = createPaymentTermsSchema.parse(rawInput);

  return runAuthorized(token, "payments.create", true, async (db, scope) => {
    // 1. Verificar pertenencia de la cotización a la solicitud y al tenant
    const quotRes = await db.query<{ id: string; version: number; status: string; total_amount: string }>(
      `select id, version, status, total_amount
       from app.quotations
       where tenant_id = $1 and id = $2 and request_id = $3`,
      [scope.tenantId, input.quotationId, input.requestId],
    );

    if (quotRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "La cotización especificada no existe o no pertenece a la solicitud.");
    }

    const quot = quotRes.rows[0]!;

    // 2. Coherencia matemática de porcentajes e importes (aritmética exacta)
    let sumPercentage = Decimal.from(0);
    let sumAmount = Decimal.from(0);

    for (const term of input.terms) {
      sumPercentage = sumPercentage.add(term.percentage);
      sumAmount = sumAmount.add(term.amount);
    }

    if (!sumPercentage.eq(100)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `La suma de los porcentajes de los hitos debe ser exactamente 100% (actual: ${sumPercentage.round(2)}%).`,
      );
    }

    const expectedTotal = Decimal.from(quot.total_amount);
    if (!sumAmount.eq(expectedTotal)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `La suma de los importes ($${sumAmount.round(2)}) no coincide con el total de la cotización ($${expectedTotal.round(2)}).`,
      );
    }

    // 3. Reemplazo no destructivo con versionado e historial (DEC-029)
    const verRes = await db.query<{ max_ver: number }>(
      `select coalesce(max(version), 0) as max_ver
       from app.payment_terms
       where tenant_id = $1 and quotation_id = $2`,
      [scope.tenantId, input.quotationId],
    );
    const nextVersion = (verRes.rows[0]?.max_ver ?? 0) + 1;

    // Desactivar términos previos sin eliminarlos físicamente
    await db.query(
      `update app.payment_terms
       set active = false
       where tenant_id = $1 and quotation_id = $2 and active = true`,
      [scope.tenantId, input.quotationId],
    );

    // Insertar nuevos términos activos con la nueva versión
    const inserted: PaymentTermDto[] = [];
    for (const term of input.terms) {
      const res = await db.query<PaymentTermDto>(
        `insert into app.payment_terms(
           tenant_id, request_id, quotation_id, version, active,
           milestone, percentage, amount, due_date, notes
         ) values ($1, $2, $3, $4, true, $5, $6, $7, $8, $9)
         returning 
           id, request_id as "requestId", quotation_id as "quotationId",
           version, active, milestone, percentage, amount,
           due_date as "dueDate", notes, created_at as "createdAt"`,
        [
          scope.tenantId,
          input.requestId,
          input.quotationId,
          nextVersion,
          term.milestone,
          term.percentage,
          term.amount,
          term.dueDate ?? null,
          term.notes ?? null,
        ],
      );
      inserted.push(res.rows[0]!);
    }

    return inserted;
  });
}

export async function listPaymentTerms(
  token: string | null,
  quotationId: string,
): Promise<PaymentTermDto[]> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);

  return runAuthorized(token, "payments.read", false, async (db, scope) => {
    const res = await db.query<PaymentTermDto>(
      `select 
         id, request_id as "requestId", quotation_id as "quotationId",
         version, active, milestone, percentage, amount, due_date as "dueDate", notes, created_at as "createdAt"
       from app.payment_terms
       where tenant_id = $1 and quotation_id = $2 and active = true
       order by created_at asc`,
      [scope.tenantId, quotationId],
    );
    return res.rows;
  });
}

// ==========================================
// 2. REGISTRO, VALIDACIÓN Y ANULACIÓN DE PAGOS (3.4 & DEC-060)
// ==========================================

export async function registerPayment(
  token: string | null,
  rawInput: unknown,
  receiptBuffer?: Buffer | null,
  receiptMimeType?: string | null,
): Promise<ClientPaymentDto> {
  const input = registerPaymentSchema.parse(rawInput);

  let buffer = receiptBuffer;
  let mime = receiptMimeType;

  if (!buffer && input.receiptBase64) {
    buffer = Buffer.from(input.receiptBase64, "base64");
    mime = input.receiptMimeType ?? "application/pdf";
  }

  if (!buffer || buffer.length === 0 || !mime) {
    throw new AppError("VALIDATION_ERROR", "El comprobante de pago es estrictamente obligatorio para registrar el recaudo.");
  }

  return runAuthorized(token, "payments.create", true, async (db, scope) => {
    // 1. Verificar solicitud existente no cancelada
    const reqRes = await db.query(
      "select id, status from app.commercial_requests where tenant_id = $1 and id = $2",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se pueden registrar pagos en una solicitud comercial cancelada.");
    }

    // 2. Guardar comprobante en almacenamiento privado
    const stored = await writeReceipt(buffer, mime, "client-payments");

    // 3. Insertar pago en estado PENDING (separación estricta de validación)
    const insRes = await db.query<ClientPaymentDto>(
      `insert into app.client_payments(
         tenant_id, request_id, amount, payment_date, payment_method, reference_code,
         receipt_file_id, receipt_byte_size, receipt_sha256, receipt_mime_type,
         status, registered_by, notes
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PENDING', $11, $12)
       returning 
         id, request_id as "requestId", amount, payment_date as "paymentDate",
         payment_method as "paymentMethod", reference_code as "referenceCode",
         receipt_file_id as "receiptFileId", status, rejection_reason as "rejectionReason",
         annulment_reason as "annulmentReason",
         validated_by as "validatedBy", validated_at as "validatedAt",
         annulled_by as "annulledBy", annulled_at as "annulledAt",
         registered_by as "registeredBy", registered_at as "registeredAt", notes`,
      [
        scope.tenantId,
        input.requestId,
        input.amount,
        input.paymentDate,
        input.paymentMethod,
        input.referenceCode ?? null,
        stored.id,
        stored.byteSize,
        stored.sha256,
        stored.mime,
        scope.userId,
        input.notes ?? null,
      ],
    );

    return insRes.rows[0]!;
  });
}

export async function validatePayment(
  token: string | null,
  paymentId: string,
  rawInput: unknown,
): Promise<ClientPaymentDto> {
  z.string().uuid("ID de pago inválido").parse(paymentId);
  const input = validatePaymentSchema.parse(rawInput);

  return runAuthorized(token, "payments.validate", true, async (db, scope) => {
    // 1. Consultar el pago con bloqueo
    const payRes = await db.query<{
      id: string;
      registered_by: string;
      status: string;
      request_id: string;
    }>(
      `select id, registered_by, status, request_id
       from app.client_payments
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, paymentId],
    );

    if (payRes.rowCount === 0) throw new AppError("NOT_FOUND", "Pago no encontrado.");
    const payment = payRes.rows[0]!;

    if (payment.status !== "PENDING") {
      throw new AppError("VALIDATION_ERROR", `El pago ya fue procesado con estado '${payment.status}'.`);
    }

    // 2. Guarda DEC-060:
    // El administrador empresarial sí puede autovalidar pagos.
    // Un coordinador no puede validar un pago que él mismo registró.
    const userRes = await db.query<{ authority: string }>(
      `select authority from app.users where tenant_id = $1 and id = $2`,
      [scope.tenantId, scope.userId],
    );
    const isAdmin = userRes.rows[0]?.authority === "ADMIN";
    const isOwnPayment = payment.registered_by === scope.userId;

    if (isOwnPayment && !isAdmin) {
      throw new AppError(
        "FORBIDDEN",
        "Regla DEC-060: Un coordinador no puede validar un pago que él mismo registró. Registrar y validar son operaciones formalmente separadas.",
      );
    }

    // 3. Actualizar estado
    const updRes = await db.query<ClientPaymentDto>(
      `update app.client_payments
       set status = $3,
           rejection_reason = $4,
           validated_by = $5,
           validated_at = now()
       where tenant_id = $1 and id = $2
       returning 
         id, request_id as "requestId", amount, payment_date as "paymentDate",
         payment_method as "paymentMethod", reference_code as "referenceCode",
         receipt_file_id as "receiptFileId", status, rejection_reason as "rejectionReason",
         annulment_reason as "annulmentReason",
         validated_by as "validatedBy", validated_at as "validatedAt",
         annulled_by as "annulledBy", annulled_at as "annulledAt",
         registered_by as "registeredBy", registered_at as "registeredAt", notes`,
      [
        scope.tenantId,
        paymentId,
        input.status,
        input.status === "REJECTED" ? (input.rejectionReason ?? null) : null,
        scope.userId,
      ],
    );

    return updRes.rows[0]!;
  });
}

export async function annulPayment(
  token: string | null,
  paymentId: string,
  rawInput: unknown,
): Promise<ClientPaymentDto> {
  z.string().uuid("ID de pago inválido").parse(paymentId);
  const input = annulPaymentSchema.parse(rawInput);

  return runAuthorized(token, "payments.validate", true, async (db, scope) => {
    const payRes = await db.query<{ id: string; status: string }>(
      `select id, status from app.client_payments
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, paymentId],
    );

    if (payRes.rowCount === 0) throw new AppError("NOT_FOUND", "Pago no encontrado.");
    const row = payRes.rows[0]!;

    if (row.status === "ANNULLED") {
      throw new AppError("CONFLICT", "El pago ya se encuentra anulado.");
    }

    const updRes = await db.query<ClientPaymentDto>(
      `update app.client_payments
       set status = 'ANNULLED',
           annulled_by = $3,
           annulled_at = now(),
           annulment_reason = $4
       where tenant_id = $1 and id = $2
       returning 
         id, request_id as "requestId", amount, payment_date as "paymentDate",
         payment_method as "paymentMethod", reference_code as "referenceCode",
         receipt_file_id as "receiptFileId", status, rejection_reason as "rejectionReason",
         annulment_reason as "annulmentReason",
         validated_by as "validatedBy", validated_at as "validatedAt",
         annulled_by as "annulledBy", annulled_at as "annulledAt",
         registered_by as "registeredBy", registered_at as "registeredAt", notes`,
      [scope.tenantId, paymentId, scope.userId, input.reason],
    );

    return updRes.rows[0]!;
  });
}

export async function listPayments(
  token: string | null,
  requestId: string,
): Promise<ClientPaymentDto[]> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);

  return runAuthorized(token, "payments.read", false, async (db, scope) => {
    const res = await db.query<ClientPaymentDto>(
      `select 
         id, request_id as "requestId", amount, payment_date as "paymentDate",
         payment_method as "paymentMethod", reference_code as "referenceCode",
         receipt_file_id as "receiptFileId", status, rejection_reason as "rejectionReason",
         annulment_reason as "annulmentReason",
         validated_by as "validatedBy", validated_at as "validatedAt",
         annulled_by as "annulledBy", annulled_at as "annulledAt",
         registered_by as "registeredBy", registered_at as "registeredAt", notes
       from app.client_payments
       where tenant_id = $1 and request_id = $2
       order by registered_at desc`,
      [scope.tenantId, requestId],
    );
    return res.rows;
  });
}

export async function downloadPaymentReceipt(
  token: string | null,
  paymentId: string,
): Promise<{ bytes: Buffer; mime: string; filename: string }> {
  z.string().uuid("ID de pago inválido").parse(paymentId);

  return runAuthorized(token, "payments.read", false, async (db, scope) => {
    const payRes = await db.query(
      `select id, receipt_file_id, receipt_byte_size, receipt_sha256, receipt_mime_type
       from app.client_payments
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, paymentId],
    );
    if (payRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const row = payRes.rows[0]!;

    const bytes = await readReceipt(
      row.receipt_file_id,
      row.receipt_byte_size,
      row.receipt_sha256,
      "client-payments",
    );
    const mime = row.receipt_mime_type || "application/pdf";
    return {
      bytes,
      mime,
      filename: `comprobante-pago-${paymentId}.${mime.split("/")[1] || "bin"}`,
    };
  });
}

// ==========================================
// 3. RESUMEN FINANCIERO Y ESTADO DE CUENTA (3.4)
// ==========================================

export async function getFinancialSummary(
  token: string | null,
  requestId: string,
): Promise<FinancialSummaryDto> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);

  return runAuthorized(token, "payments.read", false, async (db, scope) => {
    // 1. Obtener cotización aprobada más reciente
    const quotRes = await db.query(
      `select id, total_amount from app.quotations
       where tenant_id = $1 and request_id = $2 and status = 'APPROVED'
       order by version desc limit 1`,
      [scope.tenantId, requestId],
    );

    const quot = quotRes.rows[0];
    const quotationTotal = quot ? Decimal.from(quot.total_amount) : Decimal.from(0);

    // 2. Ajustes efectivos aprobados
    let effectiveAdjustments = Decimal.from(0);
    if (quot) {
      const adjRes = await db.query<{ net_adj: string }>(
        `select 
           coalesce(sum(case when adjustment_type = 'INCREASE' then amount else -amount end), 0) as net_adj
         from app.quotation_adjustments
         where tenant_id = $1 and quotation_id = $2 and status = 'APPROVED'`,
        [scope.tenantId, quot.id],
      );
      effectiveAdjustments = Decimal.from(adjRes.rows[0]?.net_adj || "0");
    }

    const rawTotalPayable = quotationTotal.add(effectiveAdjustments);
    const totalPayable = rawTotalPayable.isNegative() ? Decimal.from(0) : rawTotalPayable;

    // 3. Pagos validados y pendientes (aritmética exacta)
    const payRes = await db.query<{ val_amount: string; pend_amount: string }>(
      `select 
         coalesce(sum(case when status = 'VALIDATED' then amount else 0 end), 0) as val_amount,
         coalesce(sum(case when status = 'PENDING' then amount else 0 end), 0) as pend_amount
       from app.client_payments
       where tenant_id = $1 and request_id = $2`,
      [scope.tenantId, requestId],
    );

    const validatedPayments = Decimal.from(payRes.rows[0]?.val_amount || "0");
    const pendingPayments = Decimal.from(payRes.rows[0]?.pend_amount || "0");

    // 4. Reembolsos autorizados y desembolsados
    const refRes = await db.query<{ auth_amount: string; disb_amount: string }>(
      `select 
         coalesce(sum(case when status = 'AUTHORIZED' then amount else 0 end), 0) as auth_amount,
         coalesce(sum(case when status = 'DISBURSED' then amount else 0 end), 0) as disb_amount
       from app.refund_records
       where tenant_id = $1 and request_id = $2`,
      [scope.tenantId, requestId],
    );
    const authorizedRefunds = Decimal.from(refRes.rows[0]?.auth_amount || "0");
    const disbursedRefunds = Decimal.from(refRes.rows[0]?.disb_amount || "0");
    const refundsTotal = authorizedRefunds.add(disbursedRefunds);

    // 5. Definición uniforme de recaudo neto (DEC-052, DEC-060):
    // Recaudo Neto = Pagos Validados - Reembolsos Desembolsados
    const rawNetCollected = validatedPayments.sub(disbursedRefunds);
    const netCollected = rawNetCollected.isNegative() ? Decimal.from(0) : rawNetCollected;

    // Saldo Pendiente = max(0, Total Exigible - Recaudo Neto)
    const rawOutstanding = totalPayable.sub(netCollected);
    const outstandingBalance = rawOutstanding.isNegative() ? Decimal.from(0) : rawOutstanding;

    // Saldo a favor / Crédito disponible = max(0, Recaudo Neto - Total Exigible)
    const rawCredit = netCollected.sub(totalPayable);
    const availableCredit = rawCredit.isNegative() ? Decimal.from(0) : rawCredit;

    // isFullyPaid considera el recaudo neto frente al exigible total
    const isFullyPaid = totalPayable.gt(0) && netCollected.gte(totalPayable);

    return {
      quotationTotal: quotationTotal.round(2),
      effectiveAdjustments: effectiveAdjustments.round(2),
      totalPayable: totalPayable.round(2),
      validatedPayments: validatedPayments.round(2),
      pendingPayments: pendingPayments.round(2),
      authorizedRefunds: authorizedRefunds.round(2),
      disbursedRefunds: disbursedRefunds.round(2),
      refundsTotal: refundsTotal.round(2),
      netCollected: netCollected.round(2),
      outstandingBalance: outstandingBalance.round(2),
      availableCredit: availableCredit.round(2),
      isFullyPaid,
    };
  });
}

// ==========================================
// 4. REEMBOLSOS Y CANCELACIÓN (3.5)
// ==========================================

export async function createRefund(
  token: string | null,
  rawInput: unknown,
  receiptBuffer?: Buffer | null,
  receiptMimeType?: string | null,
): Promise<RefundRecordDto> {
  const input = createRefundSchema.parse(rawInput);
  const requestedRefund = Decimal.from(input.amount);

  let buffer = receiptBuffer;
  let mime = receiptMimeType;
  if (!buffer && input.receiptBase64) {
    buffer = Buffer.from(input.receiptBase64, "base64");
    mime = input.receiptMimeType ?? "application/pdf";
  }

  return runAuthorized(token, "finance.refund", true, async (db, scope) => {
    // 1. Obtener estado de solicitud con bloqueo
    const reqRes = await db.query<{ id: string; status: string }>(
      `select id, status from app.commercial_requests
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud no encontrada.");
    const requestStatus = reqRes.rows[0]!.status;

    // 2. Obtener balance financiero con bloqueo
    const payRes = await db.query<{ total_val: string }>(
      `select coalesce(sum(amount), 0) as total_val
       from app.client_payments
       where tenant_id = $1 and request_id = $2 and status = 'VALIDATED'`,
      [scope.tenantId, input.requestId],
    );
    const totalValidated = Decimal.from(payRes.rows[0]?.total_val || "0");

    const refRes = await db.query<{ total_ref: string }>(
      `select coalesce(sum(amount), 0) as total_ref
       from app.refund_records
       where tenant_id = $1 and request_id = $2`,
      [scope.tenantId, input.requestId],
    );
    const totalExistingRefunds = Decimal.from(refRes.rows[0]?.total_ref || "0");

    let maxRefundable: Decimal;

    if (requestStatus === "CANCELLED") {
      // En solicitud cancelada: todo el recaudo neto recibido no devuelto previamente
      const rawMax = totalValidated.sub(totalExistingRefunds);
      maxRefundable = rawMax.isNegative() ? Decimal.from(0) : rawMax;
    } else {
      // En solicitud ACTIVA: el reembolso está estrictamente limitado al saldo a favor
      // por reducción comercial (DEC-052) o sobrepago accidental
      const quotRes = await db.query<{ id: string; total_amount: string }>(
        `select id, total_amount from app.quotations
         where tenant_id = $1 and request_id = $2 and status = 'APPROVED'
         order by version desc limit 1`,
        [scope.tenantId, input.requestId],
      );

      let totalPayable = Decimal.from(0);
      if ((quotRes.rowCount ?? 0) > 0) {
        const quot = quotRes.rows[0]!;
        const adjRes = await db.query<{ net_adj: string }>(
          `select coalesce(sum(case when adjustment_type = 'INCREASE' then amount else -amount end), 0) as net_adj
           from app.quotation_adjustments
           where tenant_id = $1 and quotation_id = $2 and status = 'APPROVED'`,
          [scope.tenantId, quot.id],
        );
        totalPayable = Decimal.from(quot.total_amount).add(adjRes.rows[0]?.net_adj || "0");
        if (totalPayable.isNegative()) totalPayable = Decimal.from(0);
      }

      // Crédito disponible = total recaudado - total exigible - devoluciones previas
      const rawCredit = totalValidated.sub(totalPayable).sub(totalExistingRefunds);
      maxRefundable = rawCredit.isNegative() ? Decimal.from(0) : rawCredit;
    }

    if (requestedRefund.gt(maxRefundable)) {
      throw new AppError(
        "VALIDATION_ERROR",
        requestStatus === "CANCELLED"
          ? `El importe de devolución ($${requestedRefund.round(2)}) supera el recaudo disponible para liquidar ($${maxRefundable.round(2)}).`
          : `En una solicitud activa, el reembolso está limitado al saldo a favor por reducción comercial o sobrepago ($${maxRefundable.round(2)}).`,
      );
    }

    // 3. Verificar idempotencia / duplicados
    const dupRes = await db.query(
      `select id from app.refund_records
       where tenant_id = $1 and request_id = $2 and amount = $3 and reason = $4 and status = 'AUTHORIZED'`,
      [scope.tenantId, input.requestId, input.amount, input.reason],
    );
    if ((dupRes.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", "Ya existe una obligación de reembolso idéntica pendiente de desembolso.");
    }

    // 4. Si se proporciona comprobante de egreso, registrar directamente como DISBURSED
    let receiptFileId: string | null = null;
    let byteSize = 0;
    let sha256 = "";
    let mimeType = "application/pdf";
    let isDisbursed = false;

    if (buffer && buffer.length > 0 && mime) {
      const stored = await writeReceipt(buffer, mime, "client-payments");
      receiptFileId = stored.id;
      byteSize = stored.byteSize;
      sha256 = stored.sha256;
      mimeType = stored.mime;
      isDisbursed = true;
    }

    const insRes = await db.query<RefundRecordDto>(
      `insert into app.refund_records(
         tenant_id, request_id, amount, reason, status,
         receipt_file_id, receipt_byte_size, receipt_sha256, receipt_mime_type,
         disbursed_at, disbursed_by, authorized_by, authorized_at
       ) values (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, now()
       )
       returning 
         id, request_id as "requestId", amount, reason, status,
         receipt_file_id as "receiptFileId", disbursed_at as "disbursedAt",
         disbursed_by as "disbursedBy",
         authorized_by as "authorizedBy", authorized_at as "authorizedAt"`,
      [
        scope.tenantId,
        input.requestId,
        input.amount,
        input.reason,
        isDisbursed ? "DISBURSED" : "AUTHORIZED",
        receiptFileId,
        byteSize,
        sha256,
        mimeType,
        isDisbursed ? new Date() : null,
        isDisbursed ? scope.userId : null,
        scope.userId,
      ],
    );

    return insRes.rows[0]!;
  });
}

export async function disburseRefund(
  token: string | null,
  refundId: string,
  rawInput: unknown,
  receiptBuffer?: Buffer | null,
  receiptMimeType?: string | null,
): Promise<RefundRecordDto> {
  z.string().uuid("ID de reembolso inválido").parse(refundId);
  const input = disburseRefundSchema.parse(rawInput);

  let buffer = receiptBuffer;
  let mime = receiptMimeType;
  if (!buffer && input.receiptBase64) {
    buffer = Buffer.from(input.receiptBase64, "base64");
    mime = input.receiptMimeType ?? "application/pdf";
  }

  if (!buffer || buffer.length === 0 || !mime) {
    throw new AppError("VALIDATION_ERROR", "El comprobante de desembolso es estrictamente obligatorio para confirmar el egreso.");
  }

  return runAuthorized(token, "finance.refund", true, async (db, scope) => {
    const refRes = await db.query<{ id: string; status: string; amount: string; request_id: string }>(
      `select id, status, amount, request_id from app.refund_records
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, refundId],
    );

    if (refRes.rowCount === 0) throw new AppError("NOT_FOUND", "Reembolso no encontrado.");
    const refund = refRes.rows[0]!;
    if (refund.status !== "AUTHORIZED") {
      throw new AppError("CONFLICT", `El reembolso no está pendiente de desembolso (estado: ${refund.status}).`);
    }

    // Revalidar saldo disponible al desembolsar frente a anulaciones/pagos posteriores (DEC-052, DEC-060)
    const payRes = await db.query<{ total_val: string }>(
      `select coalesce(sum(amount), 0) as total_val
       from app.client_payments
       where tenant_id = $1 and request_id = $2 and status = 'VALIDATED'`,
      [scope.tenantId, refund.request_id],
    );
    const totalValidated = Decimal.from(payRes.rows[0]?.total_val || "0");

    const disbRes = await db.query<{ total_disb: string }>(
      `select coalesce(sum(amount), 0) as total_disb
       from app.refund_records
       where tenant_id = $1 and request_id = $2 and status = 'DISBURSED' and id <> $3`,
      [scope.tenantId, refund.request_id, refundId],
    );
    const otherDisbursed = Decimal.from(disbRes.rows[0]?.total_disb || "0");
    const availableCash = totalValidated.sub(otherDisbursed);
    const refundAmount = Decimal.from(refund.amount);

    if (refundAmount.gt(availableCash)) {
      throw new AppError(
        "VALIDATION_ERROR",
        `Saldo insuficiente para desembolsar la devolución ($${refundAmount.round(2)} requeridos vs $${availableCash.round(2)} disponibles en recaudo por anulaciones o retiros).`,
      );
    }

    const stored = await writeReceipt(buffer, mime, "client-payments");

    const updRes = await db.query<RefundRecordDto>(
      `update app.refund_records
       set status = 'DISBURSED',
           disbursed_at = now(),
           disbursed_by = $3,
           receipt_file_id = $4,
           receipt_byte_size = $5,
           receipt_sha256 = $6,
           receipt_mime_type = $7
       where tenant_id = $1 and id = $2
       returning 
         id, request_id as "requestId", amount, reason, status,
         receipt_file_id as "receiptFileId", disbursed_at as "disbursedAt",
         disbursed_by as "disbursedBy",
         authorized_by as "authorizedBy", authorized_at as "authorizedAt"`,
      [
        scope.tenantId,
        refundId,
        scope.userId,
        stored.id,
        stored.byteSize,
        stored.sha256,
        stored.mime,
      ],
    );

    return updRes.rows[0]!;
  });
}

export async function listRefunds(
  token: string | null,
  requestId: string,
): Promise<RefundRecordDto[]> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);
  return runAuthorized(token, "payments.read", false, async (db, scope) => {
    const res = await db.query<RefundRecordDto>(
      `select 
         id, request_id as "requestId", amount, reason, status,
         receipt_file_id as "receiptFileId", disbursed_at as "disbursedAt",
         disbursed_by as "disbursedBy",
         authorized_by as "authorizedBy", authorized_at as "authorizedAt"
       from app.refund_records
       where tenant_id = $1 and request_id = $2
       order by authorized_at desc`,
      [scope.tenantId, requestId],
    );
    return res.rows;
  });
}

export async function cancelCommercialRequest(
  token: string | null,
  rawInput: unknown,
): Promise<CancellationRecordDto> {
  const input = cancelRequestSchema.parse(rawInput);

  return runAuthorized(token, "requests.update", true, async (db, scope) => {
    // 1. Verificar solicitud con bloqueo
    const reqRes = await db.query<{ id: string; status: string; code: string }>(
      `select id, status, code from app.commercial_requests
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("CONFLICT", "La solicitud comercial ya se encuentra cancelada.");
    }

    // 2. Calcular liquidación exacta de devolución (DEC-025, FIN-005, AT-18):
    // Devolución íntegra de anticipos/pagos recibidos menos devoluciones previas
    const payRes = await db.query<{ val_pay: string }>(
      `select coalesce(sum(amount), 0) as val_pay
       from app.client_payments
       where tenant_id = $1 and request_id = $2 and status = 'VALIDATED'`,
      [scope.tenantId, input.requestId],
    );
    const totalValidated = Decimal.from(payRes.rows[0]?.val_pay || "0");

    const refRes = await db.query<{ auth_pay: string; disb_pay: string }>(
      `select 
         coalesce(sum(case when status = 'AUTHORIZED' then amount else 0 end), 0) as auth_pay,
         coalesce(sum(case when status = 'DISBURSED' then amount else 0 end), 0) as disb_pay
       from app.refund_records
       where tenant_id = $1 and request_id = $2`,
      [scope.tenantId, input.requestId],
    );
    const authorizedRefunds = Decimal.from(refRes.rows[0]?.auth_pay || "0");
    const disbursedRefunds = Decimal.from(refRes.rows[0]?.disb_pay || "0");
    const alreadyObligated = authorizedRefunds.add(disbursedRefunds);

    const rawRefund = totalValidated.sub(alreadyObligated);
    const refundAmountDecimal = rawRefund.isNegative() ? Decimal.from(0) : rawRefund;
    const refundAmount = refundAmountDecimal.round(2);
    const internalCosts = input.internalCosts ?? "0.00";

    // 3. Crear registro de cancelación con justificación y costos asumidos
    const cancelRes = await db.query<CancellationRecordDto>(
      `insert into app.cancellation_records(
         tenant_id, request_id, reason, refund_amount, internal_costs, cancelled_by, cancelled_at
       ) values ($1, $2, $3, $4, $5, $6, now())
       returning 
         id, request_id as "requestId", reason, refund_amount as "refundAmount",
         internal_costs as "internalCosts", cancelled_by as "cancelledBy", cancelled_at as "cancelledAt"`,
      [scope.tenantId, input.requestId, input.reason, refundAmount, internalCosts, scope.userId],
    );

    // 4. Si existe importe a devolver, crear la obligación formal de devolución en refund_records
    if (refundAmountDecimal.gt(0)) {
      await db.query(
        `insert into app.refund_records(
           tenant_id, request_id, amount, reason, status, authorized_by, authorized_at
         ) values ($1, $2, $3, $4, 'AUTHORIZED', $5, now())`,
        [
          scope.tenantId,
          input.requestId,
          refundAmount,
          `Liquidación íntegra por cancelación formal: ${input.reason}`,
          scope.userId,
        ],
      );
    }

    // 5. Reversos aplicables en inventario:
    // Las cabinas físicas en stock asignadas a la solicitud quedan liberadas en bodega general
    // guardando released_from_request_id para trazabilidad
    await db.query(
      `update app.cabin_stock
       set status = 'IN_STOCK',
           location = 'BODEGA GENERAL',
           released_from_request_id = request_id,
           notes = 'Liberada formalmente por cancelación de solicitud',
           updated_at = now()
       where tenant_id = $1 and request_id = $2 and status in ('IN_STOCK', 'ASSIGNED')`,
      [scope.tenantId, input.requestId],
    );

    // 6. Actualizar solicitud a CANCELLED completando auditoría de usuario y fecha/motivo de cancelación
    await db.query(
      `update app.commercial_requests
       set status = 'CANCELLED',
           cancelled_at = now(),
           cancelled_by = $3,
           cancellation_reason = $4,
           updated_by = $3,
           updated_at = now()
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, input.requestId, scope.userId, input.reason],
    );

    return cancelRes.rows[0]!;
  });
}

export const cancelRequest = cancelCommercialRequest;
