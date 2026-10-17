import "server-only";
import type pg from "pg";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { writeReceipt } from "../../../shared/server/private-receipts";
import {
  type WarrantyDto,
  type WarrantyPhotoDto,
  registerWarrantyClaimSchema,
  updateWarrantyStatusSchema,
  addWarrantyPhotoSchema,
} from "../../../shared/contracts/post-sale";

export async function registerWarrantyClaim(
  token: string | null,
  rawInput: unknown,
): Promise<WarrantyDto> {
  const input = registerWarrantyClaimSchema.parse(rawInput);

  return runAuthorized(token, "warranties.manage", true, async (db, scope) => {
    // 1. Verificar que la cabina física exista en cabin_stock y pertenezca a la solicitud
    const cabinRes = await db.query<{
      cabin_id: string;
      product_id: string;
      product_name: string;
      status: string;
      location: string;
    }>(
      `select cs.cabin_id, cs.product_id, cp.name as product_name, cs.status, cs.location
       from app.cabin_stock cs
       join app.catalog_products cp on cp.tenant_id = cs.tenant_id and cp.id = cs.product_id
       where cs.tenant_id = $1 and cs.cabin_id = $2 and cs.request_id = $3`,
      [scope.tenantId, input.cabinId, input.requestId],
    );

    if (cabinRes.rowCount === 0) {
      throw new AppError(
        "NOT_FOUND",
        "La cabina física especificada no existe o no corresponde a la solicitud indicada.",
      );
    }
    const cabin = cabinRes.rows[0]!;

    // 2. Verificar que exista acta de cierre operativo para la solicitud (DEC-028, DEC-030, R-03)
    const closureRes = await db.query<{
      id: string;
      signed_at: string;
      warranty_terms_snapshot: unknown;
    }>(
      `select id, signed_at, warranty_terms_snapshot
       from app.operational_closures
       where tenant_id = $1 and request_id = $2`,
      [scope.tenantId, input.requestId],
    );

    if (closureRes.rowCount === 0) {
      throw new AppError(
        "CONFLICT",
        "No se puede radicar un reclamo de garantía sin acta de cierre operativo e instalación firmada por el cliente (DEC-028, DEC-030).",
      );
    }

    const closure = closureRes.rows[0]!;
    const rawSnapshot = closure.warranty_terms_snapshot as {
      quotationId?: string;
      quotationVersion?: number;
      cabins?: Array<{ cabinId: string; productName: string; warrantyTerms: string | null }>;
    } | null;

    const cabinTerms = rawSnapshot?.cabins?.find((c) => c.cabinId === input.cabinId);
    const warrantySnapshot = {
      closureId: closure.id,
      signedAt: closure.signed_at,
      quotationId: rawSnapshot?.quotationId ?? null,
      quotationVersion: rawSnapshot?.quotationVersion ?? null,
      cabinId: input.cabinId,
      productName: cabin.product_name,
      pactado: cabinTerms?.warrantyTerms ?? null,
    };

    // 3. Generar consecutivo de garantía seguro (app_private.next_warranty_code)
    const codeRes = await db.query<{ code: string }>("select app_private.next_warranty_code() as code");
    const code = codeRes.rows[0]!.code;

    // 4. Crear registro de garantía
    const insRes = await db.query<{
      id: string;
      code: string;
      status: string;
      created_at: string;
    }>(
      `insert into app.warranties(
         tenant_id, code, request_id, cabin_id, product_id, status, claim_type,
         description, warranty_terms_snapshot, assigned_to, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, 'REGISTERED', $6, $7, $8, $9, $10, $10)
       returning id, code, status, created_at as "created_at"`,
      [
        scope.tenantId,
        code,
        input.requestId,
        input.cabinId,
        cabin.product_id,
        input.claimType,
        input.description,
        warrantySnapshot ? JSON.stringify(warrantySnapshot) : null,
        input.assignedTo ?? null,
        scope.userId,
      ],
    );
    const wRow = insRes.rows[0]!;

    // 5. Si se proporcionó fotografía de evidencia inicial, guardarla de forma privada
    if (input.photoBase64 && input.photoMimeType) {
      const buffer = Buffer.from(input.photoBase64, "base64");
      const stored = await writeReceipt(buffer, input.photoMimeType, "warranty-photos");

      await db.query(
        `insert into app.warranty_photos(
           tenant_id, warranty_id, file_id, byte_size, sha256, mime_type, caption, photo_phase, created_by
         ) values ($1, $2, $3, $4, $5, $6, $7, 'REPORT', $8)`,
        [
          scope.tenantId,
          wRow.id,
          stored.id,
          stored.byteSize,
          stored.sha256,
          stored.mime,
          input.photoCaption ?? "Evidencia inicial del reclamo",
          scope.userId,
        ],
      );
    }

    // 6. Generar notificación interna persistente del reclamo registrado
    await db.query(
      `insert into app.internal_notifications(
         tenant_id, event_type, title, message, reference_type, reference_id, dedup_key
       ) values ($1, 'WARRANTY_CLAIM', $2, $3, 'WARRANTY', $4, $5)
       on conflict (tenant_id, dedup_key) do nothing`,
      [
        scope.tenantId,
        `Reclamo de Garantía: ${code}`,
        `Se ha radicado el reclamo ${code} para la cabina '${cabin.product_name}' (${input.claimType}).`,
        wRow.id,
        `warranty_${wRow.id}_registered`,
      ],
    );

    return {
      id: wRow.id,
      code: wRow.code,
      requestId: input.requestId,
      cabinId: input.cabinId,
      productId: cabin.product_id,
      productName: cabin.product_name,
      status: "REGISTERED",
      claimType: input.claimType,
      description: input.description,
      warrantyTermsSnapshot: warrantySnapshot,
      rejectionReason: null,
      isReplacement: false,
      replacementCabinId: null,
      assignedTo: input.assignedTo ?? null,
      resolvedAt: null,
      resolvedBy: null,
      resolutionNotes: null,
      createdAt: wRow.created_at,
      createdBy: scope.userId,
      updatedAt: wRow.created_at,
      updatedBy: scope.userId,
    };
  });
}

export async function updateWarrantyStatus(
  token: string | null,
  warrantyId: string,
  rawInput: unknown,
): Promise<WarrantyDto> {
  const input = updateWarrantyStatusSchema.parse(rawInput);

  return runAuthorized(token, "warranties.manage", true, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    // 1. Consultar estado actual
    const curRes = await db.query<{
      id: string;
      code: string;
      status: string;
      request_id: string;
      cabin_id: string;
      product_id: string;
    }>(
      `select id, code, status, request_id, cabin_id, product_id
       from app.warranties
       where tenant_id = $1 and id = $2
       for update`,
      [scope.tenantId, warrantyId],
    );

    if (curRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Reclamo de garantía no encontrado.");
    }
    const current = curRes.rows[0]!;

    if (current.status === "CLOSED" || current.status === "REJECTED") {
      throw new AppError(
        "CONFLICT",
        `El reclamo de garantía ${current.code} se encuentra en estado terminal '${current.status}' y no admite modificaciones.`,
      );
    }

    if (current.status === "RESOLVED" && input.status !== "CLOSED") {
      throw new AppError(
        "CONFLICT",
        `El reclamo de garantía ${current.code} ya fue resuelto y únicamente admite confirmación de cierre formal ('CLOSED').`,
      );
    }

    if (input.status === "REJECTED" && (!input.rejectionReason || input.rejectionReason.trim().length === 0)) {
      throw new AppError("VALIDATION_ERROR", "Para rechazar un reclamo se exige un motivo formal con sustento.");
    }

    if ((input.status === "RESOLVED" || input.status === "CLOSED") && (!input.resolutionNotes || input.resolutionNotes.trim().length === 0)) {
      throw new AppError("VALIDATION_ERROR", "Para resolver o cerrar un reclamo de garantía se requieren notas de resolución.");
    }

    // Comprobar que existan fotos de evidencia para resolver o cerrar (R-03)
    if (input.status === "RESOLVED" || input.status === "CLOSED") {
      const photosRes = await db.query(
        "select count(*)::int as count from app.warranty_photos where tenant_id = $1 and warranty_id = $2",
        [scope.tenantId, warrantyId],
      );
      if (photosRes.rows[0]!.count === 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          "Para resolver o cerrar un reclamo de garantía se exige al menos una fotografía de evidencia (inspección o resolución).",
        );
      }
    }

    // 2. Si es reemplazo físico, validar cabina de reemplazo en cabin_stock con decisión administrativa (R-03)
    if (input.isReplacement) {
      const userRes = await db.query<{ authority: string }>(
        "select authority from app.users where tenant_id = $1 and id = $2",
        [scope.tenantId, scope.userId],
      );
      if (userRes.rows[0]?.authority !== "ADMIN") {
        throw new AppError("FORBIDDEN", "El reemplazo físico de cabina exige autorización administrativa formal.");
      }
      if (!input.replacementCabinId) {
        throw new AppError("VALIDATION_ERROR", "Para un reemplazo físico se debe especificar la cabina de reemplazo.");
      }
      const repRes = await db.query(
        `select cabin_id from app.cabin_stock
         where tenant_id = $1 and cabin_id = $2 and status = 'IN_STOCK'`,
        [scope.tenantId, input.replacementCabinId],
      );
      if (repRes.rowCount === 0) {
        throw new AppError(
          "VALIDATION_ERROR",
          "La cabina física designada para reemplazo no está disponible con estado 'IN_STOCK' en almacén.",
        );
      }

      // Actualizar trazabilidad de cabinas en almacén
      await db.query(
        `update app.cabin_stock
         set status = 'ASSIGNED',
             location = 'GARANTIA_REEMPLAZO',
             request_id = $3,
             updated_at = now()
         where tenant_id = $1 and cabin_id = $2`,
        [scope.tenantId, input.replacementCabinId, current.request_id],
      );

      await db.query(
        `update app.cabin_stock
         set status = 'DAMAGED',
             location = 'BODEGA_DEFECTUOSA_GARANTIA',
             updated_at = now()
         where tenant_id = $1 and cabin_id = $2`,
        [scope.tenantId, current.cabin_id],
      );
    }

    const isResolved = input.status === "RESOLVED" || input.status === "CLOSED";

    await db.query(
      `update app.warranties
       set status = $3,
           rejection_reason = coalesce($4, rejection_reason),
           assigned_to = coalesce($5, assigned_to),
           is_replacement = coalesce($6, is_replacement),
           replacement_cabin_id = coalesce($7, replacement_cabin_id),
           resolution_notes = coalesce($8, resolution_notes),
           resolved_at = case when $9 then coalesce(resolved_at, now()) else resolved_at end,
           resolved_by = case when $9 then coalesce(resolved_by, $10::uuid) else resolved_by end,
           updated_at = now(),
           updated_by = $10::uuid
       where tenant_id = $1 and id = $2`,
      [
        scope.tenantId,
        warrantyId,
        input.status,
        input.rejectionReason ?? null,
        input.assignedTo ?? null,
        input.isReplacement ?? false,
        input.replacementCabinId ?? null,
        input.resolutionNotes ?? null,
        isResolved,
        scope.userId,
      ],
    );

    return fetchWarranty(db, scope.tenantId, warrantyId);
  });
}

export async function addWarrantyPhoto(
  token: string | null,
  rawInput: unknown,
): Promise<WarrantyPhotoDto> {
  const input = addWarrantyPhotoSchema.parse(rawInput);

  return runAuthorized(token, "warranties.manage", true, async (db, scope) => {
    const wRes = await db.query(
      "select id from app.warranties where tenant_id = $1 and id = $2",
      [scope.tenantId, input.warrantyId],
    );
    if (wRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Reclamo de garantía no encontrado.");
    }

    const buffer = Buffer.from(input.photoBase64, "base64");
    const stored = await writeReceipt(buffer, input.mimeType, "warranty-photos");

    const insRes = await db.query<WarrantyPhotoDto>(
      `insert into app.warranty_photos(
         tenant_id, warranty_id, file_id, byte_size, sha256, mime_type, caption, photo_phase, created_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id, warranty_id as "warrantyId", file_id as "fileId", caption,
                 photo_phase as "photoPhase", created_at as "createdAt"`,
      [
        scope.tenantId,
        input.warrantyId,
        stored.id,
        stored.byteSize,
        stored.sha256,
        stored.mime,
        input.caption ?? null,
        input.photoPhase,
        scope.userId,
      ],
    );

    return insRes.rows[0]!;
  });
}

async function fetchWarranty(
  db: pg.PoolClient,
  tenantId: string,
  warrantyId: string,
): Promise<WarrantyDto> {
  const res = await db.query<{
    id: string;
    code: string;
    request_id: string;
    request_code: string;
    cabin_id: string;
    product_id: string;
    product_name: string;
    status: WarrantyDto["status"];
    claim_type: WarrantyDto["claimType"];
    description: string;
    warranty_terms_snapshot: unknown;
    rejection_reason: string | null;
    is_replacement: boolean;
    replacement_cabin_id: string | null;
    assigned_to: string | null;
    assigned_to_name: string | null;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution_notes: string | null;
    created_at: string;
    created_by: string;
    updated_at: string;
    updated_by: string;
  }>(
    `select 
       w.id, w.code, w.request_id, cr.code as request_code,
       w.cabin_id, w.product_id, cp.name as product_name,
       w.status, w.claim_type, w.description,
       w.warranty_terms_snapshot, w.rejection_reason,
       w.is_replacement, w.replacement_cabin_id,
       w.assigned_to, u.display_name as assigned_to_name,
       w.resolved_at, w.resolved_by, w.resolution_notes,
       w.created_at, w.created_by, w.updated_at, w.updated_by
     from app.warranties w
     join app.commercial_requests cr on cr.tenant_id = w.tenant_id and cr.id = w.request_id
     join app.catalog_products cp on cp.tenant_id = w.tenant_id and cp.id = w.product_id
     left join app.users u on u.tenant_id = w.tenant_id and u.id = w.assigned_to
     where w.tenant_id = $1 and w.id = $2`,
    [tenantId, warrantyId],
  );

  if (res.rowCount === 0) {
    throw new AppError("NOT_FOUND", "Reclamo de garantía no encontrado.");
  }
  const row = res.rows[0]!;

  const photosRes = await db.query<WarrantyPhotoDto>(
    `select id, warranty_id as "warrantyId", file_id as "fileId", caption,
            photo_phase as "photoPhase", created_at as "createdAt"
     from app.warranty_photos
     where tenant_id = $1 and warranty_id = $2
     order by created_at asc`,
    [tenantId, warrantyId],
  );

  return {
    id: row.id,
    code: row.code,
    requestId: row.request_id,
    requestCode: row.request_code,
    cabinId: row.cabin_id,
    productId: row.product_id,
    productName: row.product_name,
    status: row.status,
    claimType: row.claim_type,
    description: row.description,
    warrantyTermsSnapshot: row.warranty_terms_snapshot,
    rejectionReason: row.rejection_reason,
    isReplacement: row.is_replacement,
    replacementCabinId: row.replacement_cabin_id,
    assignedTo: row.assigned_to,
    assignedToName: row.assigned_to_name ?? undefined,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNotes: row.resolution_notes,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    photos: photosRes.rows,
  };
}

export async function getWarranty(
  token: string | null,
  warrantyId: string,
): Promise<WarrantyDto> {
  return runAuthorized(token, "warranties.read", false, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    return fetchWarranty(db, scope.tenantId, warrantyId);
  });
}

export async function listWarranties(
  token: string | null,
  options?: { requestId?: string; status?: string; assignedTo?: string },
): Promise<WarrantyDto[]> {
  return runAuthorized(token, "warranties.read", false, async (db, scope) => {
    const params: unknown[] = [scope.tenantId];
    let sql = `
      select 
        w.id, w.code, w.request_id, cr.code as request_code,
        w.cabin_id, w.product_id, cp.name as product_name,
        w.status, w.claim_type, w.description,
        w.warranty_terms_snapshot, w.rejection_reason,
        w.is_replacement, w.replacement_cabin_id,
        w.assigned_to, u.display_name as assigned_to_name,
        w.resolved_at, w.resolved_by, w.resolution_notes,
        w.created_at, w.created_by, w.updated_at, w.updated_by
      from app.warranties w
      join app.commercial_requests cr on cr.tenant_id = w.tenant_id and cr.id = w.request_id
      join app.catalog_products cp on cp.tenant_id = w.tenant_id and cp.id = w.product_id
      left join app.users u on u.tenant_id = w.tenant_id and u.id = w.assigned_to
      where w.tenant_id = $1`;

    if (options?.requestId) {
      params.push(options.requestId);
      sql += ` and w.request_id = $${params.length}`;
    }
    if (options?.status) {
      params.push(options.status);
      sql += ` and w.status = $${params.length}`;
    }
    if (options?.assignedTo) {
      params.push(options.assignedTo);
      sql += ` and w.assigned_to = $${params.length}`;
    }

    sql += " order by w.created_at desc";

    const res = await db.query<{
      id: string;
      code: string;
      request_id: string;
      request_code: string;
      cabin_id: string;
      product_id: string;
      product_name: string;
      status: WarrantyDto["status"];
      claim_type: WarrantyDto["claimType"];
      description: string;
      warranty_terms_snapshot: unknown;
      rejection_reason: string | null;
      is_replacement: boolean;
      replacement_cabin_id: string | null;
      assigned_to: string | null;
      assigned_to_name: string | null;
      resolved_at: string | null;
      resolved_by: string | null;
      resolution_notes: string | null;
      created_at: string;
      created_by: string;
      updated_at: string;
      updated_by: string;
    }>(sql, params);

    return res.rows.map((row) => ({
      id: row.id,
      code: row.code,
      requestId: row.request_id,
      requestCode: row.request_code,
      cabinId: row.cabin_id,
      productId: row.product_id,
      productName: row.product_name,
      status: row.status,
      claimType: row.claim_type,
      description: row.description,
      warrantyTermsSnapshot: row.warranty_terms_snapshot,
      rejectionReason: row.rejection_reason,
      isReplacement: row.is_replacement,
      replacementCabinId: row.replacement_cabin_id,
      assignedTo: row.assigned_to,
      assignedToName: row.assigned_to_name ?? undefined,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNotes: row.resolution_notes,
      createdAt: row.created_at,
      createdBy: row.created_by,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  });
}
