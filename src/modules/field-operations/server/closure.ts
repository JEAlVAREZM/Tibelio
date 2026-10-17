import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { writeReceipt, readReceipt } from "../../../shared/server/private-receipts";
import {
  registerOperationalClosureSchema,
  type OperationalClosureDto,
  type OperationalClosurePhotoDto,
} from "../../../shared/contracts/field-operations";

export async function registerOperationalClosure(
  token: string | null,
  rawInput: unknown,
): Promise<OperationalClosureDto> {
  const input = registerOperationalClosureSchema.parse(rawInput);

  return runAuthorized(token, "field.manage", true, async (db, scope) => {
    // 1. Validar solicitud y tarea principal de instalación (OPE-005, GAR-001, AT-19)
    const reqRes = await db.query<{ id: string; status: string; code: string }>(
      "select id, status, code from app.commercial_requests where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede cerrar operativamente una solicitud cancelada.");
    }

    // Verificar si ya existe cierre operativo (idempotencia y unicidad)
    const prevCloseRes = await db.query(
      "select id from app.operational_closures where tenant_id = $1 and request_id = $2",
      [scope.tenantId, input.requestId],
    );
    if ((prevCloseRes.rowCount ?? 0) > 0) {
      throw new AppError("CONFLICT", "La solicitud ya cuenta con un cierre operativo y entrega firmada.");
    }

    const taskRes = await db.query<{ id: string; request_id: string; task_type: string; status: string }>(
      "select id, request_id, task_type, status from app.field_tasks where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, input.taskId],
    );
    if (taskRes.rowCount === 0) throw new AppError("NOT_FOUND", "Tarea de campo no encontrada.");
    const task = taskRes.rows[0]!;

    if (task.request_id !== input.requestId) {
      throw new AppError("VALIDATION_ERROR", "La tarea de campo especificada no pertenece a la solicitud comercial.");
    }

    if (task.task_type !== "INSTALLATION") {
      throw new AppError("VALIDATION_ERROR", "La tarea de campo para el cierre operativo debe ser de tipo INSTALACIÓN.");
    }

    // C-04: Exigir despacho trazable de todas las cabinas físicas antes del cierre operativo
    const cabinStockRes = await db.query<{ cabin_id: string; status: string }>(
      "select cabin_id, status from app.cabin_stock where tenant_id = $1 and request_id = $2",
      [scope.tenantId, input.requestId],
    );
    if (cabinStockRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR", "La solicitud no cuenta con cabinas físicas registradas en inventario.");
    }
    const hasUndispatched = cabinStockRes.rows.some((c) => c.status !== "DISPATCHED");
    if (hasUndispatched) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Todas las cabinas de la solicitud deben estar despachadas de bodega antes de proceder al cierre operativo.",
      );
    }

    // C-04: Exigir sesiones de instalación conjunta reales completadas y conciliadas
    const sessionsRes = await db.query<{ id: string; status: string }>(
      "select id, status from app.installation_sessions where tenant_id = $1 and request_id = $2",
      [scope.tenantId, input.requestId],
    );
    if (sessionsRes.rowCount === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "No se puede registrar el cierre operativo sin haber iniciado sesiones de instalación para la solicitud.",
      );
    }
    const uncompletedSessions = sessionsRes.rows.some((s) => s.status !== "COMPLETED");
    if (uncompletedSessions) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Todas las sesiones de instalación de la solicitud deben estar en estado 'COMPLETED' antes del cierre operativo.",
      );
    }

    const unreconciledRes = await db.query(
      `select id from app.installation_material_consumptions
       where tenant_id = $1 and request_id = $2 and reconciled = false`,
      [scope.tenantId, input.requestId],
    );
    if ((unreconciledRes.rowCount ?? 0) > 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Existen consumos de material pendientes de conciliación en las sesiones de instalación.",
      );
    }

    // C-03: Validar que si las fotos incluyen cabina, pertenezcan a la solicitud
    for (const p of input.photos) {
      if (p.cabinId) {
        const cabMatch = await db.query(
          "select id from app.request_cabins where tenant_id = $1 and request_id = $2 and id = $3",
          [scope.tenantId, input.requestId, p.cabinId],
        );
        if (cabMatch.rowCount === 0) {
          throw new AppError("VALIDATION_ERROR", `La cabina '${p.cabinId}' de la fotografía no pertenece a la solicitud.`);
        }
      }
    }

    // 2. Cotización formal aprobada (términos de garantía aplicables para Fase 5)
    const quotRes = await db.query<{
      id: string;
      version: number;
    }>(
      `select id, version from app.quotations
       where tenant_id = $1 and request_id = $2 and status = 'APPROVED'
       order by version desc limit 1`,
      [scope.tenantId, input.requestId],
    );
    if (quotRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR", "No existe cotización aprobada para asociar los términos de garantía.");
    }
    const quot = quotRes.rows[0]!;

    // Obtener términos de garantía por cabina desde la cotización (C-06: sin inventar coberturas no pactadas)
    const cabinQuotRes = await db.query<{
      cabin_id: string;
      product_name: string;
      warranty_terms: string | null;
    }>(
      `select cabin_id, product_name, warranty_terms
       from app.quotation_cabins
       where tenant_id = $1 and quotation_id = $2`,
      [scope.tenantId, quot.id],
    );

    const warrantyTermsMap: Record<string, unknown> = {
      quotationId: quot.id,
      quotationVersion: quot.version,
      capturedAt: new Date().toISOString(),
      cabins: cabinQuotRes.rows.map((c) => ({
        cabinId: c.cabin_id,
        productName: c.product_name,
        warrantyTerms: c.warranty_terms ?? null,
      })),
    };

    // 3. Procesar y guardar la firma digital del cliente en almacenamiento privado
    const signatureBuffer = Buffer.from(input.signatureBase64, "base64");
    if (signatureBuffer.length === 0) {
      throw new AppError("VALIDATION_ERROR", "El archivo de la firma del cliente está vacío o corrupto.");
    }
    const storedSignature = await writeReceipt(
      signatureBuffer,
      input.signatureMimeType,
      "operational-closures",
    );

    const signedAt = input.signedAt ? new Date(input.signedAt) : new Date();

    // 4. Crear registro principal de cierre operativo (inmutable, no DELETE)
    const closeRes = await db.query<OperationalClosureDto>(
      `insert into app.operational_closures(
         tenant_id, request_id, task_id, quotation_id, quotation_version,
         customer_signatory_name, customer_signatory_document, signed_at,
         signature_file_id, signature_byte_size, signature_sha256, signature_mime_type,
         warranty_terms_snapshot, observations, closed_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning 
         id, request_id as "requestId", task_id as "taskId",
         quotation_id as "quotationId", quotation_version as "quotationVersion",
         customer_signatory_name as "customerSignatoryName",
         customer_signatory_document as "customerSignatoryDocument",
         signed_at as "signedAt", signature_file_id as "signatureFileId",
         warranty_terms_snapshot as "warrantyTermsSnapshot", observations,
         closed_by as "closedBy", created_at as "createdAt"`,
      [
        scope.tenantId,
        input.requestId,
        input.taskId,
        quot.id,
        quot.version,
        input.customerSignatoryName,
        input.customerSignatoryDocument ?? null,
        signedAt,
        storedSignature.id,
        storedSignature.byteSize,
        storedSignature.sha256,
        storedSignature.mime,
        JSON.stringify(warrantyTermsMap),
        input.observations ?? null,
        scope.userId,
      ],
    );
    const closure = closeRes.rows[0]!;

    // 5. Procesar y guardar cada fotografía obligatoria en almacenamiento privado
    const photos: OperationalClosurePhotoDto[] = [];
    for (const p of input.photos) {
      const photoBuffer = Buffer.from(p.photoBase64, "base64");
      if (photoBuffer.length === 0) continue;

      const storedPhoto = await writeReceipt(photoBuffer, p.mimeType, "operational-closures");

      const photoRes = await db.query<OperationalClosurePhotoDto>(
        `insert into app.operational_closure_photos(
           tenant_id, closure_id, cabin_id, file_id, byte_size, sha256, mime_type, caption
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning 
           id, closure_id as "closureId", cabin_id as "cabinId",
           file_id as "fileId", byte_size as "byteSize", mime_type as "mimeType",
           caption, created_at as "createdAt"`,
        [
          scope.tenantId,
          closure.id,
          p.cabinId ?? null,
          storedPhoto.id,
          storedPhoto.byteSize,
          storedPhoto.sha256,
          storedPhoto.mime,
          p.caption ?? null,
        ],
      );
      photos.push(photoRes.rows[0]!);
    }

    closure.photos = photos;

    // 6. Actualizar tarea a COMPLETED
    await db.query(
      `update app.field_tasks
       set status = 'COMPLETED', updated_at = now(), updated_by = $3
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, input.taskId, scope.userId],
    );

    // 7. Actualizar cabinas de la solicitud con la fecha de instalación firmada
    await db.query(
      `update app.request_cabins
       set updated_at = now()
       where tenant_id = $1 and request_id = $2`,
      [scope.tenantId, input.requestId],
    );

    // 8. Actualizar ubicación física de entrega de las cabinas previamente despachadas (C-04)
    await db.query(
      `update app.cabin_stock
       set location = 'INSTALADA Y ENTREGADA', updated_at = now()
       where tenant_id = $1 and request_id = $2 and status = 'DISPATCHED'`,
      [scope.tenantId, input.requestId],
    );

    return closure;
  });
}

export async function getOperationalClosure(
  token: string | null,
  requestId: string,
): Promise<OperationalClosureDto | null> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    const res = await db.query<OperationalClosureDto>(
      `select 
         oc.id,
         oc.request_id as "requestId",
         cr.code as "requestCode",
         oc.task_id as "taskId",
         oc.quotation_id as "quotationId",
         oc.quotation_version as "quotationVersion",
         oc.customer_signatory_name as "customerSignatoryName",
         oc.customer_signatory_document as "customerSignatoryDocument",
         oc.signed_at as "signedAt",
         oc.signature_file_id as "signatureFileId",
         oc.warranty_terms_snapshot as "warrantyTermsSnapshot",
         oc.observations,
         oc.closed_by as "closedBy",
         u.display_name as "closedByName",
         oc.created_at as "createdAt"
       from app.operational_closures oc
       join app.commercial_requests cr on cr.tenant_id = oc.tenant_id and cr.id = oc.request_id
       join app.users u on u.tenant_id = oc.tenant_id and u.id = oc.closed_by
       where oc.tenant_id = $1 and oc.request_id = $2`,
      [scope.tenantId, requestId],
    );

    if (res.rowCount === 0) return null;
    const closure = res.rows[0]!;

    const pRes = await db.query<OperationalClosurePhotoDto>(
      `select 
         id, closure_id as "closureId", cabin_id as "cabinId",
         file_id as "fileId", byte_size as "byteSize", mime_type as "mimeType",
         caption, created_at as "createdAt"
       from app.operational_closure_photos
       where tenant_id = $1 and closure_id = $2
       order by created_at asc`,
      [scope.tenantId, closure.id],
    );

    closure.photos = pRes.rows;
    return closure;
  });
}

export async function downloadClosureFile(
  token: string | null,
  fileId: string,
): Promise<{ bytes: Buffer; mime: string; filename: string }> {
  z.string().uuid("ID de archivo inválido").parse(fileId);

  return runAuthorized(token, "field.read", false, async (db, scope) => {
    let mime = "application/octet-stream";
    let filename = `closure-${fileId}`;
    let byteSize = 0;
    let sha256 = "";

    const sigRes = await db.query<{ signature_mime_type: string; signature_byte_size: number; signature_sha256: string }>(
      "select signature_mime_type, signature_byte_size, signature_sha256 from app.operational_closures where tenant_id = $1 and signature_file_id = $2",
      [scope.tenantId, fileId],
    );

    if (sigRes.rowCount && sigRes.rowCount > 0) {
      mime = sigRes.rows[0]!.signature_mime_type;
      byteSize = sigRes.rows[0]!.signature_byte_size;
      sha256 = sigRes.rows[0]!.signature_sha256;
      filename = `firma-cliente-${fileId}.png`;
    } else {
      const photoRes = await db.query<{ mime_type: string; byte_size: number; sha256: string }>(
        "select mime_type, byte_size, sha256 from app.operational_closure_photos where tenant_id = $1 and file_id = $2",
        [scope.tenantId, fileId],
      );
      if (photoRes.rowCount === 0) {
        throw new AppError("NOT_FOUND", "Archivo de cierre operativo no encontrado o no pertenece a la empresa.");
      }
      mime = photoRes.rows[0]!.mime_type;
      byteSize = photoRes.rows[0]!.byte_size;
      sha256 = photoRes.rows[0]!.sha256;
      filename = `foto-entrega-${fileId}.jpg`;
    }

    const bytes = await readReceipt(fileId, byteSize, sha256, "operational-closures");
    return { bytes, mime, filename };
  });
}
