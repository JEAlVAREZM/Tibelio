import "server-only";
import type pg from "pg";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import {
  authorize,
  canReadCosts,
  type ActorContext,
  type AuthorizedScope,
} from "../../identity/server/authorization";
import { calculateQuotation } from "../../../shared/server/money-math";
import { generateQuotationPdf, correctQuotationIssuerPdf } from "./pdf-generator";
import { writeReceipt, readReceipt } from "../../../shared/server/private-receipts";
import { canonicalMoneySchema } from "../../../shared/contracts/money";
import type {
  QuotationDto,
  QuotationCabinDto,
  QuotationItemDto,
  CommercialSettingsDto,
  QuotationAdjustmentDto,
} from "../../../shared/contracts/commercial";

const issuerSchema=z.object({tenantId:z.uuid(),legalName:z.string().min(1),taxId:z.string().min(1)});
async function quotationIssuer(db:pg.PoolClient,scope:AuthorizedScope,saved?:unknown) {
  if(saved!=null) {
    const issuer=issuerSchema.parse(saved);
    if(issuer.tenantId!==scope.tenantId) throw new AppError("FORBIDDEN");
    return issuer;
  }
  const row=(await db.query<{legal_name:string;tax_id:string}>("select legal_name,tax_id from app_private.quotation_issuer()")).rows[0];
  if(!row) throw new AppError("FORBIDDEN");
  return issuerSchema.parse({tenantId:scope.tenantId,legalName:row.legal_name,taxId:row.tax_id});
}

export const updateCommercialSettingsSchema = z.object({
  currency: z.string().trim().length(3),
  taxRate: z.number().min(0).max(1),
  taxIncluded: z.boolean(),
  defaultValidityDays: z.number().int().min(1).max(365),
  targetMargin: z.number().min(0).max(0.99),
  minMargin: z.number().min(0).max(0.99),
  defaultPaymentTerms: z.string().trim().max(255).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const createQuotationSchema = z.object({
  requestId: z.string().uuid("ID de solicitud inválido"),
  pricingMethod: z.enum(["CATALOG_PRICE", "COST_MARGIN"]).default("CATALOG_PRICE"),
  targetMargin: z.number().min(0).max(0.99).optional().nullable(),
  validityDays: z.number().int().min(1).max(180).optional(),
  warrantyTerms: z.string().trim().max(255).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
  paymentTerms: z.string().trim().max(255).optional().nullable(),
});

export const updateQuotationSchema = z.object({
  expectedRevision: z.number().int().min(1),
  pricingMethod: z.enum(["CATALOG_PRICE", "COST_MARGIN"]).optional(),
  targetMargin: z.number().min(0).max(0.99).optional().nullable(),
  validityDays: z.number().int().min(1).max(180).optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
  paymentTerms: z.string().trim().max(255).optional().nullable(),
});

export const createQuotationVersionSchema = z.object({
  notes: z.string().trim().max(1000).optional().nullable(),
  validityDays: z.number().int().min(1).max(180).optional(),
  warrantyTerms: z.string().trim().max(255).optional().nullable(),
  cabins: z.array(
    z.object({
      cabinId: z.string().uuid(),
      customWidth: z.number().positive().max(9999.99).optional().nullable(),
      customHeight: z.number().positive().max(9999.99).optional().nullable(),
      finish: z.string().trim().max(100).optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
    }),
  ).optional(),
});

export const createAdjustmentSchema = z.object({
  adjustmentType: z.enum(["INCREASE", "DECREASE"]),
  amount: canonicalMoneySchema.refine((val) => Number(val) > 0, {
    message: "El importe del ajuste debe ser mayor a 0",
  }),
  reason: z.string().trim().min(5, "El motivo debe tener al menos 5 caracteres").max(500),
});

async function getCommercialSettingsInternal(
  db: pg.PoolClient,
  tenantId: string,
): Promise<CommercialSettingsDto | null> {
  const res = await db.query(
    `select tenant_id, currency, tax_rate, tax_included, default_validity_days, target_margin, min_margin, default_payment_terms, notes, updated_at
     from app.commercial_settings
     where tenant_id = $1`,
    [tenantId],
  );

  if (res.rowCount === 0) {
    return null;
  }

  const row = res.rows[0]!;
  return {
    tenantId: row.tenant_id,
    currency: row.currency,
    taxRate: row.tax_rate,
    taxIncluded: row.tax_included,
    defaultValidityDays: row.default_validity_days,
    targetMargin: row.target_margin,
    minMargin: row.min_margin,
    defaultPaymentTerms: row.default_payment_terms,
    notes: row.notes,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
  };
}

export async function getCommercialSettings(token: string | null): Promise<CommercialSettingsDto> {
  return runAuthorized(token, "catalog.read", false, async (db, scope) => {
    const settings = await getCommercialSettingsInternal(db, scope.tenantId!);
    if (!settings) {
      throw new AppError("NOT_FOUND");
    }

    const actorRes = await db.query<{ actor: ActorContext | null }>(
      "select app_private.actor() actor",
    );
    const actor = actorRes.rows[0]?.actor;
    const hasCostsRead = canReadCosts(actor);

    return {
      ...settings,
      targetMargin: hasCostsRead ? settings.targetMargin : null,
      minMargin: hasCostsRead ? settings.minMargin : null,
    };
  });
}

export async function updateCommercialSettings(
  token: string | null,
  rawInput: unknown,
): Promise<CommercialSettingsDto> {
  const input = updateCommercialSettingsSchema.parse(rawInput);
  return runAuthorized(token, "settings.manage", true, async (db, scope) => {
    if (input.targetMargin < input.minMargin) {
      throw new AppError("VALIDATION_ERROR");
    }

    await db.query(
      `insert into app.commercial_settings(
         tenant_id, currency, tax_rate, tax_included, default_validity_days, target_margin, min_margin, default_payment_terms, notes, updated_by, updated_at
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       on conflict (tenant_id) do update set
         currency = excluded.currency,
         tax_rate = excluded.tax_rate,
         tax_included = excluded.tax_included,
         default_validity_days = excluded.default_validity_days,
         target_margin = excluded.target_margin,
         min_margin = excluded.min_margin,
         default_payment_terms = excluded.default_payment_terms,
         notes = excluded.notes,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [
        scope.tenantId,
        input.currency,
        input.taxRate,
        input.taxIncluded,
        input.defaultValidityDays,
        input.targetMargin,
        input.minMargin,
        input.defaultPaymentTerms ?? null,
        input.notes ?? null,
        scope.userId,
      ],
    );

    const updated = await getCommercialSettingsInternal(db, scope.tenantId!);
    if (!updated) {
      throw new AppError("NOT_FOUND");
    }
    return updated;
  });
}

interface DbQuotationCabinRow {
  id: string;
  quotation_id: string;
  cabin_id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  location_tag: string | null;
  finish: string | null;
  custom_width: string | null;
  custom_height: string | null;
  warranty_terms: string | null;
  base_cost: string | null;
  list_price: string | null;
  sale_price: string;
  notes: string | null;
}

interface DbQuotationItemRow {
  id: string;
  quotation_id: string;
  request_item_id: string | null;
  cabin_id: string | null;
  concept: string;
  item_type: "ACCESSORY" | "MATERIAL" | "SERVICE";
  quantity: number;
  unit_cost: string | null;
  unit_price: string;
  total_price: string;
  notes: string | null;
}

interface DbQuotationDocRow {
  id: string;
  quotation_id: string;
  document_type: "PDF" | "APPROVAL_EVIDENCE" | "ADJUSTMENT_EVIDENCE";
  filename: string;
  file_size: number;
  mime_type: string;
  sha256: string;
  created_at: Date;
}

interface DbQuotationAdjustmentRow {
  id: string;
  quotation_id: string;
  code: string;
  adjustment_type: "INCREASE" | "DECREASE";
  amount: string;
  reason: string;
  requires_client_approval: boolean;
  client_approved_at: Date | null;
  client_evidence_id: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  authorized_by: string | null;
  authorizer_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DbQuotationListRow {
  id: string;
  request_id: string;
  request_code: string;
  client_legal_name: string;
  client_tax_id: string;
  code: string;
  version: number;
  status: "DRAFT" | "SENT" | "APPROVED" | "REJECTED" | "EXPIRED";
  pricing_method: "CATALOG_PRICE" | "COST_MARGIN";
  currency: string;
  subtotal: string;
  tax_rate: string;
  tax_amount: string;
  total_amount: string;
  target_margin: string | null;
  min_margin: string | null;
  validity_days: number;
  expires_at: Date;
  sent_at: Date | null;
  approved_at: Date | null;
  approved_by: string | null;
  rejection_reason: string | null;
  revision: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

async function getQuotationInternal(
  db: pg.PoolClient,
  scope: AuthorizedScope,
  quotationId: string,
): Promise<QuotationDto> {
  if (!scope.tenantId) throw new AppError("FORBIDDEN");
  const actorRes = await db.query(
    "select app_private.actor() actor",
  );
  const actor = actorRes.rows[0]?.actor as ActorContext | null;
  const hasCostsRead = canReadCosts(actor);

  const qRes = await db.query(
    `select 
       q.id, q.request_id, r.code as request_code,
       c.legal_name as client_legal_name, c.tax_id as client_tax_id,
       q.code, q.version, q.status, q.pricing_method, q.currency,
       q.subtotal, q.tax_rate, q.tax_amount, q.total_amount,
       q.target_margin, q.min_margin, q.snapshot, q.validity_days, q.expires_at,
       q.sent_at, q.approved_at, q.approved_by, q.rejection_reason, q.revision,
       q.created_by, q.created_at, q.updated_at
     from app.quotations q
     join app.commercial_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
     join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
     where q.tenant_id = $1 and q.id = $2`,
    [scope.tenantId, quotationId],
  );

  if (qRes.rowCount === 0) {
    throw new AppError("NOT_FOUND");
  }
  const q = qRes.rows[0]!;

  // Cabinas
  const cabinsRes = await db.query(
    `select 
       id, quotation_id, cabin_id, product_id, product_name, product_sku,
       location_tag, finish, custom_width, custom_height, warranty_terms,
       base_cost, list_price, sale_price, notes
     from app.quotation_cabins
     where tenant_id = $1 and quotation_id = $2
     order by created_at asc`,
    [scope.tenantId, quotationId],
  );

  const cabins: QuotationCabinDto[] = (
    cabinsRes.rows as DbQuotationCabinRow[]
  ).map((row) => ({
    id: row.id,
    quotationId: row.quotation_id,
    cabinId: row.cabin_id,
    productId: row.product_id,
    productName: row.product_name,
    productSku: row.product_sku,
    locationTag: row.location_tag,
    finish: row.finish,
    customWidth: row.custom_width ? parseFloat(row.custom_width) : null,
    customHeight: row.custom_height ? parseFloat(row.custom_height) : null,
    warrantyTerms: row.warranty_terms,
    baseCost: hasCostsRead ? row.base_cost : null,
    listPrice: row.list_price,
    salePrice: row.sale_price,
    notes: row.notes,
  }));

  // Ítems
  const itemsRes = await db.query(
    `select 
       id, quotation_id, request_item_id, cabin_id, concept, item_type,
       quantity, unit_cost, unit_price, total_price, notes
     from app.quotation_items
     where tenant_id = $1 and quotation_id = $2
     order by created_at asc`,
    [scope.tenantId, quotationId],
  );

  const items: QuotationItemDto[] = (
    itemsRes.rows as DbQuotationItemRow[]
  ).map((row) => ({
    id: row.id,
    quotationId: row.quotation_id,
    requestItemId: row.request_item_id,
    cabinId: row.cabin_id,
    concept: row.concept,
    itemType: row.item_type,
    quantity: row.quantity,
    unitCost: hasCostsRead ? row.unit_cost : null,
    unitPrice: row.unit_price,
    totalPrice: row.total_price,
    notes: row.notes,
  }));

  // Documentos
  const docsRes = await db.query(
    `select id, quotation_id, document_type, filename, file_size, mime_type, sha256, created_at
     from app.quotation_documents
     where tenant_id = $1 and quotation_id = $2
     order by created_at desc`,
    [scope.tenantId, quotationId],
  );

  // Ajustes
  const adjRes = await db.query(
    `select 
       qa.id, qa.quotation_id, qa.code, qa.adjustment_type, qa.amount, qa.reason,
       qa.requires_client_approval, qa.client_approved_at, qa.client_evidence_id,
       qa.status, qa.authorized_by, u.display_name as authorizer_name,
       qa.created_at, qa.updated_at
     from app.quotation_adjustments qa
     left join app.users u on u.tenant_id = qa.tenant_id and u.id = qa.authorized_by
     where qa.tenant_id = $1 and qa.quotation_id = $2
     order by qa.created_at desc`,
    [scope.tenantId, quotationId],
  );

  const rawSnapshot = typeof q.snapshot === "string" ? JSON.parse(q.snapshot) : (q.snapshot ?? {});

  return {
    id: q.id,
    requestId: q.request_id,
    requestCode: q.request_code,
    clientLegalName: q.client_legal_name,
    clientTaxId: q.client_tax_id,
    code: q.code,
    version: q.version,
    status: q.status,
    pricingMethod: q.pricing_method,
    currency: q.currency,
    subtotal: q.subtotal,
    taxRate: q.tax_rate,
    taxAmount: q.tax_amount,
    totalAmount: q.total_amount,
    targetMargin: hasCostsRead ? q.target_margin : null,
    minMargin: hasCostsRead ? q.min_margin : null,
    snapshot: rawSnapshot as Record<string, unknown>,
    validityDays: q.validity_days,
    expiresAt: q.expires_at ? new Date(q.expires_at).toISOString() : new Date().toISOString(),
    sentAt: q.sent_at ? new Date(q.sent_at).toISOString() : null,
    approvedAt: q.approved_at ? new Date(q.approved_at).toISOString() : null,
    approvedBy: q.approved_by,
    rejectionReason: q.rejection_reason,
    revision: q.revision,
    createdBy: q.created_by,
    createdAt: q.created_at ? new Date(q.created_at).toISOString() : new Date().toISOString(),
    updatedAt: q.updated_at ? new Date(q.updated_at).toISOString() : new Date().toISOString(),
    cabins,
    items,
    documents: (docsRes.rows as DbQuotationDocRow[]).map((d) => ({
      id: d.id,
      quotationId: d.quotation_id,
      documentType: d.document_type,
      filename: d.filename,
      fileSize: d.file_size,
      mimeType: d.mime_type,
      sha256: d.sha256,
      createdAt: d.created_at ? new Date(d.created_at).toISOString() : new Date().toISOString(),
    })),
    adjustments: (adjRes.rows as DbQuotationAdjustmentRow[]).map((a) => ({
      id: a.id,
      quotationId: a.quotation_id,
      code: a.code,
      adjustmentType: a.adjustment_type,
      amount: a.amount,
      reason: a.reason,
      requiresClientApproval: a.requires_client_approval,
      clientApprovedAt: a.client_approved_at ? new Date(a.client_approved_at).toISOString() : null,
      clientEvidenceId: a.client_evidence_id,
      status: a.status,
      authorizedBy: a.authorized_by,
      authorizerName: a.authorizer_name,
      createdAt: a.created_at ? new Date(a.created_at).toISOString() : new Date().toISOString(),
      updatedAt: a.updated_at ? new Date(a.updated_at).toISOString() : new Date().toISOString(),
    })),
  };
}

async function createQuotationInternal(
  db: pg.PoolClient,
  scope: AuthorizedScope,
  input: z.infer<typeof createQuotationSchema>,
  options?: {
    forcedCode?: string;
    forcedVersion?: number;
  },
): Promise<string> {
  if (!scope.tenantId) throw new AppError("FORBIDDEN");

  // 1. Obtener la solicitud con cliente, dirección y zona
  const reqRes = await db.query(
    `select 
       r.id, r.code, r.client_id, c.legal_name as client_legal_name, c.tax_id as client_tax_id,
       ca.address as client_address_text, m.name as municipality_name,
       r.zone_id, pz.name as zone_name, pz.transport_fee, pz.installation_fee,
       pz.target_margin as zone_target_margin, pz.minimum_margin as zone_min_margin
     from app.commercial_requests r
     join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
     join app.client_addresses ca on ca.tenant_id = r.tenant_id and ca.client_id = r.client_id and ca.id = r.client_address_id
     join app.municipalities m on m.id = ca.municipality_id
     left join app.pricing_zones pz on pz.tenant_id = r.tenant_id and pz.id = r.zone_id
     where r.tenant_id = $1 and r.id = $2`,
    [scope.tenantId, input.requestId],
  );

  if (reqRes.rowCount === 0) {
    throw new AppError("NOT_FOUND");
  }
  const reqData = reqRes.rows[0]!;

  // 2. Obtener configuración comercial del tenant con la conexión actual
  const settings = await getCommercialSettingsInternal(db, scope.tenantId);
  if (!settings) {
    throw new AppError("VALIDATION_ERROR");
  }

  const targetMargin =
    input.targetMargin ??
    (reqData.zone_target_margin ? parseFloat(reqData.zone_target_margin) : (settings.targetMargin ? parseFloat(settings.targetMargin) : null));
  const minMargin =
    reqData.zone_min_margin ? parseFloat(reqData.zone_min_margin) : (settings.minMargin ? parseFloat(settings.minMargin) : null);

  // COT-008: Si el margen es inferior al margen mínimo institucional, exigir autorización de excepción comercial
  if (targetMargin !== null && minMargin !== null && targetMargin < minMargin) {
    const actorRes = await db.query<{ actor: ActorContext | null }>(
      "select app_private.actor() actor",
    );
    const actor = actorRes.rows[0]?.actor;
    const now = new Date();
    const canAuthorize =
      actor &&
      (authorize(actor, { action: "quotations.authorize" }, now).ok ||
        authorize(actor, { action: "adjustments.authorize" }, now).ok);
    if (!canAuthorize) {
      throw new AppError("VALIDATION_ERROR");
    }
  }

  // 3. Obtener cabinas activas de la solicitud
  const cabinsRes = await db.query(
    `select 
       rc.id, rc.product_id, cp.name as product_name, cp.sku as product_sku,
       cp.base_cost, cp.list_price,
       rc.location_tag, rc.finish, rc.custom_width, rc.custom_height, rc.notes
     from app.request_cabins rc
     join app.catalog_products cp on cp.tenant_id = rc.tenant_id and cp.id = rc.product_id
     where rc.tenant_id = $1 and rc.request_id = $2 and rc.active = true
     order by rc.created_at asc`,
    [scope.tenantId, input.requestId],
  );

  if (cabinsRes.rowCount === 0) {
    throw new AppError("VALIDATION_ERROR");
  }

  // 4. Obtener ítems activos de la solicitud
  const itemsRes = await db.query(
    `select 
       ri.id, ri.cabin_id, ri.product_id, cp.name as product_name, cp.sku as product_sku,
       cp.base_cost, cp.list_price, ri.product_kind, ri.quantity, ri.notes
     from app.request_items ri
     join app.catalog_products cp on cp.tenant_id = ri.tenant_id and cp.id = ri.product_id
     where ri.tenant_id = $1 and ri.request_id = $2 and ri.active = true
     order by ri.created_at asc`,
    [scope.tenantId, input.requestId],
  );

  // 5. Preparar ítems para el cálculo
  const calcCabins = cabinsRes.rows.map((c) => ({
    id: c.id,
    baseCost: c.base_cost,
    listPrice: c.list_price,
  }));

  const calcItems: Array<{
    unitCost?: string | null;
    unitPrice?: string | null;
    quantity: number;
    type: "ACCESSORY" | "MATERIAL" | "TRANSPORT" | "INSTALLATION" | "SERVICE";
  }> = itemsRes.rows.map((item) => ({
    unitCost: item.base_cost,
    unitPrice: item.list_price,
    quantity: item.quantity,
    type: item.product_kind as "ACCESSORY" | "MATERIAL",
  }));

  // Agregar flete e instalación de la zona si existen
  if (reqData.transport_fee && parseFloat(reqData.transport_fee) > 0) {
    calcItems.push({
      unitPrice: reqData.transport_fee,
      quantity: 1,
      type: "TRANSPORT",
    });
  }
  if (reqData.installation_fee && parseFloat(reqData.installation_fee) > 0) {
    calcItems.push({
      unitPrice: reqData.installation_fee,
      quantity: 1,
      type: "INSTALLATION",
    });
  }

  // 6. Ejecutar cálculo con motor decimal y redondeo mitad al par (DEC-059)
  const taxRate = parseFloat(settings.taxRate);
  const calcResult = calculateQuotation({
    pricingMethod: input.pricingMethod,
    targetMargin,
    cabins: calcCabins,
    items: calcItems,
    taxRate,
    taxIncluded: settings.taxIncluded,
  });

  // 7. Generar código único de cotización o reutilizar código existente para v2
  let code: string;
  let version = 1;
  if (options?.forcedCode) {
    code = options.forcedCode;
    version = options.forcedVersion ?? 1;
  } else {
    const codeRes = await db.query<{ code: string }>(
      "select app_private.next_commercial_quotation_code() as code",
    );
    code = codeRes.rows[0]!.code;
  }

  const validityDays = input.validityDays ?? settings.defaultValidityDays;
  if (!validityDays || validityDays <= 0) {
    throw new AppError("VALIDATION_ERROR");
  }
  const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

  // 8. Construir snapshot inmutable de auditoría
  const issuer=await quotationIssuer(db,scope);
  const snapshot = {
    company:issuer,
    requestCode: reqData.code,
    client: {
      legalName: reqData.client_legal_name,
      taxId: reqData.client_tax_id,
      address: reqData.client_address_text,
      municipality: reqData.municipality_name,
    },
    zone: reqData.zone_name,
    settings: {
      currency: settings.currency,
      taxRate: settings.taxRate,
      taxIncluded: settings.taxIncluded,
    },
    pricingMethod: input.pricingMethod,
    targetMargin,
    minMargin,
    cabins: cabinsRes.rows.map((c, idx) => ({
      cabinId: c.id,
      productId: c.product_id,
      name: c.product_name,
      sku: c.product_sku,
      locationTag: c.location_tag,
      finish: c.finish,
      customWidth: c.custom_width,
      customHeight: c.custom_height,
      salePrice: calcResult.cabins[idx]!.salePrice,
    })),
    items: calcResult.items.map((it, idx) => ({
      concept: idx < itemsRes.rows.length ? itemsRes.rows[idx]!.product_name : (idx === itemsRes.rows.length ? "Transporte y Flete" : "Instalacion"),
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      totalPrice: it.totalPrice,
    })),
    totals: {
      subtotal: calcResult.subtotal,
      taxAmount: calcResult.taxAmount,
      totalAmount: calcResult.totalAmount,
    },
  };

  // 9. Insertar cabecera de cotización
  const quotRes = await db.query<{ id: string }>(
    `insert into app.quotations(
       tenant_id, request_id, code, version, status, pricing_method, currency,
       subtotal, tax_rate, tax_amount, total_amount, target_margin, min_margin,
       snapshot, validity_days, expires_at, revision, created_by, updated_by
     ) values ($1, $2, $3, $4, 'DRAFT', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, $16)
     returning id`,
    [
      scope.tenantId,
      input.requestId,
      code,
      version,
      input.pricingMethod,
      settings.currency,
      calcResult.subtotal,
      settings.taxRate,
      calcResult.taxAmount,
      calcResult.totalAmount,
      targetMargin,
      minMargin,
      JSON.stringify(snapshot),
      validityDays,
      expiresAt.toISOString(),
      scope.userId,
    ],
  );
  const quotationId = quotRes.rows[0]!.id;

  // 10. Insertar líneas de cabina en app.quotation_cabins
  for (let i = 0; i < cabinsRes.rows.length; i++) {
    const c = cabinsRes.rows[i]!;
    const calculated = calcResult.cabins[i]!;

    await db.query(
      `insert into app.quotation_cabins(
         tenant_id, quotation_id, cabin_id, product_id, product_name, product_sku,
         location_tag, finish, custom_width, custom_height, warranty_terms,
         base_cost, list_price, sale_price, notes
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        scope.tenantId,
        quotationId,
        c.id,
        c.product_id,
        c.product_name,
        c.product_sku,
        c.location_tag ?? null,
        c.finish ?? null,
        c.custom_width ?? null,
        c.custom_height ?? null,
        input.warrantyTerms ?? (c.notes ? `Garantia segun notas: ${c.notes}` : null),
        c.base_cost ?? null,
        c.list_price ?? null,
        calculated.salePrice,
        c.notes ?? null,
      ],
    );
  }

  // 11. Insertar líneas de ítems en app.quotation_items
  for (let i = 0; i < itemsRes.rows.length; i++) {
    const it = itemsRes.rows[i]!;
    const calculated = calcResult.items[i]!;

    await db.query(
      `insert into app.quotation_items(
         tenant_id, quotation_id, request_item_id, cabin_id, concept, item_type,
         quantity, unit_cost, unit_price, total_price, notes
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        scope.tenantId,
        quotationId,
        it.id,
        it.cabin_id ?? null,
        it.product_name,
        it.product_kind,
        it.quantity,
        it.base_cost ?? null,
        calculated.unitPrice,
        calculated.totalPrice,
        it.notes ?? null,
      ],
    );
  }

  if (reqData.transport_fee && parseFloat(reqData.transport_fee) > 0) {
    await db.query(
      `insert into app.quotation_items(
         tenant_id, quotation_id, concept, item_type, quantity, unit_price, total_price
       ) values ($1, $2, 'Transporte y flete a obra', 'TRANSPORT', 1, $3, $3)`,
      [scope.tenantId, quotationId, reqData.transport_fee],
    );
  }
  if (reqData.installation_fee && parseFloat(reqData.installation_fee) > 0) {
    await db.query(
      `insert into app.quotation_items(
         tenant_id, quotation_id, concept, item_type, quantity, unit_price, total_price
       ) values ($1, $2, 'Servicio de instalacion certificada', 'INSTALLATION', 1, $3, $3)`,
      [scope.tenantId, quotationId, reqData.installation_fee],
    );
  }

  // 12. Generar PDF de cliente institucional (sin costos internos) y guardarlo en almacenamiento privado
  const pdfBuffer = generateQuotationPdf({
    company: issuer,
    client: {
      legalName: reqData.client_legal_name,
      taxId: reqData.client_tax_id,
      address: reqData.client_address_text,
      municipality: reqData.municipality_name,
    },
    quotation: {
      code,
      version,
      requestCode: reqData.code,
      issuedAt: new Date().toISOString().slice(0, 10),
      expiresAt: expiresAt.toISOString().slice(0, 10),
      currency: settings.currency,
      subtotal: calcResult.subtotal,
      taxRate: `${(taxRate * 100).toFixed(0)}%`,
      taxAmount: calcResult.taxAmount,
      totalAmount: calcResult.totalAmount,
      notes: input.notes,
      paymentTerms: input.paymentTerms ?? settings.defaultPaymentTerms,
    },
    cabins: cabinsRes.rows.map((c, idx) => ({
      locationTag: c.location_tag,
      model: c.product_name,
      finish: c.finish,
      dimensions: c.custom_width && c.custom_height ? `${c.custom_width} x ${c.custom_height} cm` : null,
      warranty: input.warrantyTerms ?? (c.notes ? `Garantia segun notas: ${c.notes}` : "Segun terminos pactados"),
      salePrice: calcResult.cabins[idx]!.salePrice,
    })),
    items: calcResult.items.map((it, idx) => ({
      concept: idx < itemsRes.rows.length ? itemsRes.rows[idx]!.product_name : (idx === itemsRes.rows.length ? "Transporte y flete" : "Instalacion"),
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      totalPrice: it.totalPrice,
    })),
  });

  const fileMeta = await writeReceipt(pdfBuffer, "application/pdf", "quotation-docs");

  await db.query(
    `insert into app.quotation_documents(
       id, tenant_id, quotation_id, document_type, filename, storage_path, file_size, mime_type, sha256, created_by
     ) values ($1, $2, $3, 'PDF', $4, $5, $6, 'application/pdf', $7, $8)`,
    [
      fileMeta.id,
      scope.tenantId,
      quotationId,
      `${code}-v${version}.pdf`,
      fileMeta.id,
      fileMeta.byteSize,
      fileMeta.sha256,
      scope.userId,
    ],
  );

  // 13. Actualizar estado de la solicitud a 'QUOTED'
  await db.query(
    "update app.commercial_requests set status = 'QUOTED' where tenant_id = $1 and id = $2",
    [scope.tenantId, input.requestId],
  );

  return quotationId;
}

export async function createQuotation(
  token: string | null,
  rawInput: unknown,
): Promise<QuotationDto> {
  const input = createQuotationSchema.parse(rawInput);
  return runAuthorized(token, "quotations.create", true, async (db, scope) => {
    const quotationId = await createQuotationInternal(db, scope, input);
    return getQuotationInternal(db, scope, quotationId);
  });
}

export async function getQuotation(
  token: string | null,
  quotationId: string,
): Promise<QuotationDto> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  return runAuthorized(token, "quotations.read", false, async (db, scope) => {
    return getQuotationInternal(db, scope, quotationId);
  });
}

export async function listQuotations(
  token: string | null,
  rawQuery: unknown,
): Promise<{ items: QuotationDto[]; total: number; page: number; limit: number }> {
  const query = z.object({
    page: z.coerce.number().int().positive().optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    requestId: z.string().uuid().optional(),
    search: z.string().trim().optional(),
    status: z.enum(["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED"]).optional(),
  }).parse(rawQuery ?? {});

  return runAuthorized(token, "quotations.read", false, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    const actorRes = await db.query(
      "select app_private.actor() actor",
    );
    const actor = actorRes.rows[0]?.actor as ActorContext | null;
    const hasCostsRead = canReadCosts(actor);

    const conditions: string[] = ["q.tenant_id = $1"];
    const params: unknown[] = [scope.tenantId];

    if (query.requestId) {
      params.push(query.requestId);
      conditions.push(`q.request_id = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      conditions.push(`q.status = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      const pIdx = params.length;
      conditions.push(`(q.code ilike $${pIdx} or c.legal_name ilike $${pIdx} or c.tax_id ilike $${pIdx})`);
    }

    const whereClause = conditions.join(" and ");

    const countRes = await db.query(
      `select count(*)::text as count
       from app.quotations q
       join app.commercial_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
       join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
       where ${whereClause}`,
      params,
    );
    const countRow = countRes.rows[0] as { count?: string } | undefined;
    const total = parseInt(countRow?.count ?? "0", 10);

    const offset = (query.page - 1) * query.limit;
    params.push(query.limit, offset);

    const listRes = await db.query(
      `select 
         q.id, q.request_id, r.code as request_code,
         c.legal_name as client_legal_name, c.tax_id as client_tax_id,
         q.code, q.version, q.status, q.pricing_method, q.currency,
         q.subtotal, q.tax_rate, q.tax_amount, q.total_amount,
         q.target_margin, q.min_margin, q.validity_days, q.expires_at,
         q.sent_at, q.approved_at, q.approved_by, q.rejection_reason, q.revision,
         q.created_by, q.created_at, q.updated_at
       from app.quotations q
       join app.commercial_requests r on r.tenant_id = q.tenant_id and r.id = q.request_id
       join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
       where ${whereClause}
       order by q.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );

    const items: QuotationDto[] = (
      listRes.rows as DbQuotationListRow[]
    ).map((q) => ({
      id: q.id,
      requestId: q.request_id,
      requestCode: q.request_code,
      clientLegalName: q.client_legal_name,
      clientTaxId: q.client_tax_id,
      code: q.code,
      version: q.version,
      status: q.status,
      pricingMethod: q.pricing_method,
      currency: q.currency,
      subtotal: q.subtotal,
      taxRate: q.tax_rate,
      taxAmount: q.tax_amount,
      totalAmount: q.total_amount,
      targetMargin: hasCostsRead ? q.target_margin : null,
      minMargin: hasCostsRead ? q.min_margin : null,
      snapshot: {},
      validityDays: q.validity_days,
      expiresAt: q.expires_at.toISOString(),
      sentAt: q.sent_at ? q.sent_at.toISOString() : null,
      approvedAt: q.approved_at ? q.approved_at.toISOString() : null,
      approvedBy: q.approved_by,
      rejectionReason: q.rejection_reason,
      revision: q.revision,
      createdBy: q.created_by,
      createdAt: q.created_at.toISOString(),
      updatedAt: q.updated_at.toISOString(),
    }));

    return { items, total, page: query.page, limit: query.limit };
  });
}

export async function markQuotationSent(
  token: string | null,
  quotationId: string,
): Promise<QuotationDto> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  return runAuthorized(token, "quotations.update", true, async (db, scope) => {
    const qRes = await db.query(
      "select status from app.quotations where tenant_id = $1 and id = $2",
      [scope.tenantId, quotationId],
    );
    if (qRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const status = qRes.rows[0]!.status;
    if (status !== "DRAFT" && status !== "SENT") {
      throw new AppError("CONFLICT");
    }

    await db.query(
      "update app.quotations set status = 'SENT', sent_at = now() where tenant_id = $1 and id = $2",
      [scope.tenantId, quotationId],
    );
    return getQuotationInternal(db, scope, quotationId);
  });
}

export async function downloadQuotationPdf(
  token: string | null,
  quotationId: string,
): Promise<{ bytes: Buffer; filename: string }> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  return runAuthorized(token, "quotations.read", false, async (db, scope) => {
    const docRes = await db.query(
      `select d.id,d.filename,d.file_size,d.sha256,q.snapshot->'company' as issuer
       from app.quotation_documents d join app.quotations q on q.id=d.quotation_id and q.tenant_id=d.tenant_id
       where d.tenant_id = $1 and d.quotation_id = $2 and d.document_type = 'PDF'
       order by d.created_at desc
       limit 1`,
      [scope.tenantId, quotationId],
    );

    if (docRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const doc = docRes.rows[0]!;

    const bytes = await readReceipt(doc.id, doc.file_size, doc.sha256, "quotation-docs");
    const issuer=await quotationIssuer(db,scope,doc.issuer);
    return { bytes: correctQuotationIssuerPdf(bytes,issuer), filename: doc.filename };
  });
}

export async function downloadQuotationDocument(
  token: string | null,
  documentId: string,
): Promise<{ bytes: Buffer; filename: string; mime: string }> {
  z.string().uuid("ID de documento inválido").parse(documentId);
  return runAuthorized(token, "quotations.read", false, async (db, scope) => {
    const docRes = await db.query(
      `select d.id,d.filename,d.file_size,d.sha256,d.mime_type,d.document_type,q.snapshot->'company' as issuer
       from app.quotation_documents d join app.quotations q on q.id=d.quotation_id and q.tenant_id=d.tenant_id
       where d.tenant_id = $1 and d.id = $2
       limit 1`,
      [scope.tenantId, documentId],
    );

    if (docRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const doc = docRes.rows[0]!;

    const bytes = await readReceipt(doc.id, doc.file_size, doc.sha256, "quotation-docs");
    if(doc.document_type === "PDF" && doc.mime_type === "application/pdf") {
      const issuer=await quotationIssuer(db,scope,doc.issuer);
      return {bytes:correctQuotationIssuerPdf(bytes,issuer),filename:doc.filename,mime:doc.mime_type};
    }
    return {bytes,filename:doc.filename,mime:doc.mime_type};
  });
}

export async function approveQuotation(
  token: string | null,
  quotationId: string,
  evidenceBytes: Buffer,
  evidenceDeclaredMime: string,
): Promise<QuotationDto> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  return runAuthorized(token, "quotations.approve", true, async (db, scope) => {
    const qRes = await db.query(
      "select code, version, status, expires_at from app.quotations where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, quotationId],
    );
    if (qRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const q = qRes.rows[0]!;

    if (q.status === "APPROVED") throw new AppError("CONFLICT");
    if (q.status === "REJECTED") throw new AppError("VALIDATION_ERROR");

    // Verificar vigencia
    if (new Date() > new Date(q.expires_at)) {
      await db.query(
        "update app.quotations set status = 'EXPIRED' where tenant_id = $1 and id = $2",
        [scope.tenantId, quotationId],
      );
      throw new AppError("VALIDATION_ERROR");
    }

    // Guardar archivo privado de evidencia
    const evidenceMeta = await writeReceipt(
      evidenceBytes,
      evidenceDeclaredMime,
      "quotation-docs",
    );

    const docId = evidenceMeta.id;
    await db.query(
      `insert into app.quotation_documents(
         id, tenant_id, quotation_id, document_type, filename, storage_path, file_size, mime_type, sha256, created_by
       ) values ($1, $2, $3, 'APPROVAL_EVIDENCE', $4, $5, $6, $7, $8, $9)`,
      [
        docId,
        scope.tenantId,
        quotationId,
        `aprobacion-${q.code}-v${q.version}.${evidenceMeta.mime.split("/")[1]}`,
        docId,
        evidenceMeta.byteSize,
        evidenceMeta.mime,
        evidenceMeta.sha256,
        scope.userId,
      ],
    );

    // Marcar como aprobada con usuario aprobador y fecha
    await db.query(
      `update app.quotations
       set status = 'APPROVED', approved_at = now(), approved_by = $1, updated_at = now()
       where tenant_id = $2 and id = $3`,
      [scope.userId, scope.tenantId, quotationId],
    );

    return getQuotationInternal(db, scope, quotationId);
  });
}

export async function rejectQuotation(
  token: string | null,
  quotationId: string,
  rawReason: unknown,
): Promise<QuotationDto> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  const { reason } = z.object({ reason: z.string().trim().min(3).max(500) }).parse(rawReason);

  return runAuthorized(token, "quotations.update", true, async (db, scope) => {
    const qRes = await db.query(
      "select status from app.quotations where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, quotationId],
    );
    if (qRes.rowCount === 0) throw new AppError("NOT_FOUND");
    if (qRes.rows[0]!.status === "APPROVED") throw new AppError("CONFLICT");

    await db.query(
      `update app.quotations
       set status = 'REJECTED', rejection_reason = $1, updated_at = now()
       where tenant_id = $2 and id = $3`,
      [reason, scope.tenantId, quotationId],
    );

    return getQuotationInternal(db, scope, quotationId);
  });
}

export async function createQuotationVersion(
  token: string | null,
  quotationId: string,
  rawInput: unknown,
): Promise<QuotationDto> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  const input = createQuotationVersionSchema.parse(rawInput);

  return runAuthorized(token, "quotations.create", true, async (db, scope) => {
    // 1. Obtener la cotización previa aprobada
    const prevRes = await db.query(
      `select 
         q.id, q.request_id, q.code, q.version, q.pricing_method, q.currency,
         q.target_margin, q.min_margin, q.validity_days, q.snapshot
       from app.quotations q
       where q.tenant_id = $1 and q.id = $2`,
      [scope.tenantId, quotationId],
    );

    if (prevRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const prev = prevRes.rows[0]!;

    // 2. Si se actualizaron medidas de cabinas, verificar pertenencia estricta a la solicitud y tenant (R-F2-08)
    // conservando estrictamente el UUID de la unidad física (DEC-051)
    if (input.cabins && input.cabins.length > 0) {
      const cabinIds = input.cabins.map((c) => c.cabinId);
      const verifyRes = await db.query(
        `select id from app.request_cabins
         where tenant_id = $1 and request_id = $2 and id = any($3::uuid[])`,
        [scope.tenantId, prev.request_id, cabinIds],
      );
      if (verifyRes.rowCount !== cabinIds.length) {
        throw new AppError("VALIDATION_ERROR");
      }

      for (const cabin of input.cabins) {
        const updRes = await db.query(
          `update app.request_cabins
           set custom_width = coalesce($1, custom_width),
               custom_height = coalesce($2, custom_height),
               finish = coalesce($3, finish),
               notes = coalesce($4, notes),
               updated_at = now()
           where tenant_id = $5 and request_id = $6 and id = $7`,
          [
            cabin.customWidth ?? null,
            cabin.customHeight ?? null,
            cabin.finish ?? null,
            cabin.notes ?? null,
            scope.tenantId,
            prev.request_id,
            cabin.cabinId,
          ],
        );
        if (updRes.rowCount === 0) {
          throw new AppError("VALIDATION_ERROR");
        }
      }
    }

    // 3. Crear nueva versión con número incrementado (v = prev.version + 1)
    const newVersionNum = prev.version + 1;

    // Ejecutar recálculo reutilizando la misma transacción DB
    const newQuotId = await createQuotationInternal(
      db,
      scope,
      {
        requestId: prev.request_id,
        pricingMethod: prev.pricing_method,
        targetMargin: prev.target_margin ? parseFloat(prev.target_margin) : undefined,
        validityDays: input.validityDays ?? prev.validity_days,
        warrantyTerms: input.warrantyTerms,
        notes: input.notes,
      },
      {
        forcedCode: prev.code,
        forcedVersion: newVersionNum,
      },
    );

    return getQuotationInternal(db, scope, newQuotId);
  });
}

export async function createAdjustmentNote(
  token: string | null,
  quotationId: string,
  rawInput: unknown,
): Promise<QuotationAdjustmentDto> {
  z.string().uuid("ID de cotización inválido").parse(quotationId);
  const input = createAdjustmentSchema.parse(rawInput);

  return runAuthorized(token, "adjustments.create", true, async (db, scope) => {
    // 1. Verificar que la cotización esté aprobada
    const qRes = await db.query(
      "select status from app.quotations where tenant_id = $1 and id = $2",
      [scope.tenantId, quotationId],
    );
    if (qRes.rowCount === 0) throw new AppError("NOT_FOUND");
    if (qRes.rows[0]!.status !== "APPROVED") {
      throw new AppError("VALIDATION_ERROR");
    }

    // 2. Generar código de ajuste
    const countRes = await db.query<{ count: string }>(
      "select count(*)::text as count from app.quotation_adjustments where tenant_id = $1",
      [scope.tenantId],
    );
    const count = parseInt(countRes.rows[0]?.count ?? "0", 10) + 1;
    const ym = new Date().toISOString().slice(0, 7).replace("-", "");
    const code = `ADJ-${ym}-${count.toString().padStart(4, "0")}`;

    // Obtener actor para verificar si cuenta con el permiso adjustments.authorize
    const actorRes = await db.query<{ actor: ActorContext | null }>(
      "select app_private.actor() actor",
    );
    const actor = actorRes.rows[0]?.actor;
    const canAuthorize = authorize(actor, { action: "adjustments.authorize" }, new Date()).ok;

    // DEC-044 y DEC-052:
    // Aumento: SIEMPRE requiere evidencia aprobada por el cliente (status = 'PENDING', requiresClientApproval = true, authorizedBy = null)
    // Reducción:
    //   - Si el creador tiene 'adjustments.authorize': auto-aprobada de inmediato (status = 'APPROVED', authorizedBy = scope.userId)
    //   - Si el creador NO tiene 'adjustments.authorize': queda pendiente de autorización interna (status = 'PENDING', authorizedBy = null)
    const isIncrease = input.adjustmentType === "INCREASE";
    const status = isIncrease ? "PENDING" : (canAuthorize ? "APPROVED" : "PENDING");
    const requiresClientApproval = isIncrease;
    const authorizedBy = (!isIncrease && canAuthorize) ? scope.userId : null;

    const insRes = await db.query(
      `insert into app.quotation_adjustments(
         tenant_id, quotation_id, code, adjustment_type, amount, reason,
         requires_client_approval, status, authorized_by, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       returning id, created_at, updated_at`,
      [
        scope.tenantId,
        quotationId,
        code,
        input.adjustmentType,
        input.amount,
        input.reason,
        requiresClientApproval,
        status,
        authorizedBy,
        scope.userId,
      ],
    );
    const row = insRes.rows[0]!;

    return {
      id: row.id,
      quotationId,
      code,
      adjustmentType: input.adjustmentType,
      amount: input.amount,
      reason: input.reason,
      requiresClientApproval,
      clientApprovedAt: null,
      clientEvidenceId: null,
      status,
      authorizedBy,
      authorizerName: authorizedBy ? "Administrador / Coordinador" : null,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}

export async function approveAdjustmentNote(
  token: string | null,
  adjustmentId: string,
  evidenceBytes?: Buffer | null,
  evidenceDeclaredMime?: string | null,
): Promise<QuotationAdjustmentDto> {
  z.string().uuid("ID de ajuste inválido").parse(adjustmentId);

  return runAuthorized(token, "adjustments.authorize", true, async (db, scope) => {
    const adjRes = await db.query(
      "select quotation_id, adjustment_type, status from app.quotation_adjustments where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, adjustmentId],
    );

    if (adjRes.rowCount === 0) throw new AppError("NOT_FOUND");
    const adj = adjRes.rows[0]!;

    if (adj.status === "APPROVED") throw new AppError("CONFLICT");

    let evidenceId: string | null = null;
    let approvedAt: Date | null = null;

    if (adj.adjustment_type === "INCREASE") {
      // DEC-044: Aumento exige evidencia privada del cliente aprobada
      if (!evidenceBytes || evidenceBytes.length === 0) {
        throw new AppError("VALIDATION_ERROR");
      }
      const evidenceMeta = await writeReceipt(
        evidenceBytes,
        evidenceDeclaredMime ?? "application/octet-stream",
        "quotation-docs",
      );

      await db.query(
        `insert into app.quotation_documents(
           id, tenant_id, quotation_id, document_type, filename, storage_path, file_size, mime_type, sha256, created_by
         ) values ($1, $2, $3, 'ADJUSTMENT_EVIDENCE', $4, $5, $6, $7, $8, $9)`,
        [
          evidenceMeta.id,
          scope.tenantId,
          adj.quotation_id,
          `evidencia-ajuste-${adjustmentId}.${evidenceMeta.mime.split("/")[1] ?? "bin"}`,
          evidenceMeta.id,
          evidenceMeta.byteSize,
          evidenceMeta.mime,
          evidenceMeta.sha256,
          scope.userId,
        ],
      );
      evidenceId = evidenceMeta.id;
      approvedAt = new Date();
    } else {
      // DEC-052: Reducción no exige aprobación de cliente; evidencia es opcional
      if (evidenceBytes && evidenceBytes.length > 0) {
        const evidenceMeta = await writeReceipt(
          evidenceBytes,
          evidenceDeclaredMime ?? "application/octet-stream",
          "quotation-docs",
        );
        await db.query(
          `insert into app.quotation_documents(
             id, tenant_id, quotation_id, document_type, filename, storage_path, file_size, mime_type, sha256, created_by
           ) values ($1, $2, $3, 'ADJUSTMENT_EVIDENCE', $4, $5, $6, $7, $8, $9)`,
          [
            evidenceMeta.id,
            scope.tenantId,
            adj.quotation_id,
            `evidencia-ajuste-${adjustmentId}.${evidenceMeta.mime.split("/")[1] ?? "bin"}`,
            evidenceMeta.id,
            evidenceMeta.byteSize,
            evidenceMeta.mime,
            evidenceMeta.sha256,
            scope.userId,
          ],
        );
        evidenceId = evidenceMeta.id;
        approvedAt = new Date();
      }
    }

    await db.query(
      `update app.quotation_adjustments
       set status = 'APPROVED', client_approved_at = $1, client_evidence_id = $2, authorized_by = $3, updated_by = $3, updated_at = now()
       where tenant_id = $4 and id = $5`,
      [approvedAt, evidenceId, scope.userId, scope.tenantId, adjustmentId],
    );

    const updated = await db.query(
      `select 
         qa.id, qa.quotation_id, qa.code, qa.adjustment_type, qa.amount, qa.reason,
         qa.requires_client_approval, qa.client_approved_at, qa.client_evidence_id,
         qa.status, qa.authorized_by, u.display_name as authorizer_name,
         qa.created_at, qa.updated_at
       from app.quotation_adjustments qa
       left join app.users u on u.tenant_id = qa.tenant_id and u.id = qa.authorized_by
       where qa.tenant_id = $1 and qa.id = $2`,
      [scope.tenantId, adjustmentId],
    );

    const row = updated.rows[0]!;
    return {
      id: row.id,
      quotationId: row.quotation_id,
      code: row.code,
      adjustmentType: row.adjustment_type,
      amount: row.amount,
      reason: row.reason,
      requiresClientApproval: row.requires_client_approval,
      clientApprovedAt: row.client_approved_at ? new Date(row.client_approved_at).toISOString() : null,
      clientEvidenceId: row.client_evidence_id,
      status: row.status,
      authorizedBy: row.authorized_by,
      authorizerName: row.authorizer_name,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}
