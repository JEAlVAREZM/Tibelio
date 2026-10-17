import "server-only";
import type pg from "pg";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { writeReceipt } from "../../../shared/server/private-receipts";
import {
  type OperationalIssueDto,
  createOperationalIssueSchema,
  updateOperationalIssueSchema,
} from "../../../shared/contracts/post-sale";

export async function createOperationalIssue(
  token: string | null,
  rawInput: unknown,
): Promise<OperationalIssueDto> {
  const input = createOperationalIssueSchema.parse(rawInput);

  return runAuthorized(token, "issues.manage", true, async (db, scope) => {
    // 1. Verificar existencia de la solicitud en el tenant
    const reqRes = await db.query<{ id: string; code: string }>(
      "select id, code from app.commercial_requests where tenant_id = $1 and id = $2",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    }
    const req = reqRes.rows[0]!;

    // 2. Guardar archivo de evidencia si se suministró
    let evidenceFileId: string | null = null;
    let evidenceByteSize: number | null = null;
    let evidenceSha256: string | null = null;
    let evidenceMimeType: string | null = null;

    if (input.evidenceBase64 && input.evidenceMimeType) {
      const buffer = Buffer.from(input.evidenceBase64, "base64");
      const stored = await writeReceipt(buffer, input.evidenceMimeType, "issue-evidences");
      evidenceFileId = stored.id;
      evidenceByteSize = stored.byteSize;
      evidenceSha256 = stored.sha256;
      evidenceMimeType = stored.mime;
    }

    // 3. Crear novedad operativa
    const insRes = await db.query<OperationalIssueDto>(
      `insert into app.operational_issues(
         tenant_id, request_id, stage, reference_id, title, description,
         severity, status, evidence_file_id, evidence_byte_size, evidence_sha256, evidence_mime_type,
         assigned_to, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, 'OPEN', $8, $9, $10, $11, $12, $13, $13)
       returning 
         id, request_id as "requestId", stage, reference_id as "referenceId",
         title, description, severity, status, evidence_file_id as "evidenceFileId",
         assigned_to as "assignedTo", resolved_at as "resolvedAt", resolved_by as "resolvedBy",
         resolution_notes as "resolutionNotes", created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.requestId,
        input.stage,
        input.referenceId ?? null,
        input.title,
        input.description,
        input.severity,
        evidenceFileId,
        evidenceByteSize,
        evidenceSha256,
        evidenceMimeType,
        input.assignedTo ?? null,
        scope.userId,
      ],
    );
    const row = insRes.rows[0]!;
    row.requestCode = req.code;

    // 4. Si la novedad es BLOCKING o HIGH, generar alerta interna automática
    if (["BLOCKING", "HIGH"].includes(input.severity)) {
      await db.query(
        `insert into app.internal_notifications(
           tenant_id, event_type, title, message, reference_type, reference_id, dedup_key
         ) values ($1, 'BLOCKING_ISSUE', $2, $3, 'ISSUE', $4, $5)
         on conflict (tenant_id, dedup_key) do nothing`,
        [
          scope.tenantId,
          `Novedad crítica [${input.severity}]: ${input.title}`,
          `Etapa: ${input.stage}. Solicitud ${req.code}. ${input.description.slice(0, 150)}`,
          row.id,
          `issue_${row.id}_alert`,
        ],
      );
    }

    return row;
  });
}

export async function updateOperationalIssue(
  token: string | null,
  issueId: string,
  rawInput: unknown,
): Promise<OperationalIssueDto> {
  const input = updateOperationalIssueSchema.parse(rawInput);

  return runAuthorized(token, "issues.manage", true, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    const curRes = await db.query<{ id: string; status: string }>(
      "select id, status from app.operational_issues where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, issueId],
    );
    if (curRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Novedad operativa no encontrada.");
    }
    const current = curRes.rows[0]!;

    if (current.status === "RESOLVED" || current.status === "CANCELLED") {
      throw new AppError(
        "CONFLICT",
        `La novedad ya se encuentra en estado '${current.status}' y no admite modificaciones.`,
      );
    }

    const isResolved = input.status === "RESOLVED";
    if (isResolved && (!input.resolutionNotes || input.resolutionNotes.trim().length === 0)) {
      throw new AppError("VALIDATION_ERROR", "Para resolver una novedad se requieren notas de resolución.");
    }

    await db.query(
      `update app.operational_issues
       set status = $3,
           assigned_to = coalesce($4, assigned_to),
           resolution_notes = coalesce($5, resolution_notes),
           resolved_at = case when $6 then now() else resolved_at end,
           resolved_by = case when $6 then $7::uuid else resolved_by end,
           updated_at = now(),
           updated_by = $7::uuid
       where tenant_id = $1 and id = $2`,
      [
        scope.tenantId,
        issueId,
        input.status,
        input.assignedTo ?? null,
        input.resolutionNotes ?? null,
        isResolved,
        scope.userId,
      ],
    );

    return fetchOperationalIssue(db, scope.tenantId, issueId);
  });
}

async function fetchOperationalIssue(
  db: pg.PoolClient,
  tenantId: string,
  issueId: string,
): Promise<OperationalIssueDto> {
  const res = await db.query<OperationalIssueDto>(
    `select 
       oi.id, oi.request_id as "requestId", cr.code as "requestCode",
       oi.stage, oi.reference_id as "referenceId",
       oi.title, oi.description, oi.severity, oi.status,
       oi.evidence_file_id as "evidenceFileId",
       oi.assigned_to as "assignedTo", u.display_name as "assignedToName",
       oi.resolved_at as "resolvedAt", oi.resolved_by as "resolvedBy",
       oi.resolution_notes as "resolutionNotes",
       oi.created_at as "createdAt", oi.created_by as "createdBy",
       oi.updated_at as "updatedAt", oi.updated_by as "updatedBy"
     from app.operational_issues oi
     join app.commercial_requests cr on cr.tenant_id = oi.tenant_id and cr.id = oi.request_id
     left join app.users u on u.tenant_id = oi.tenant_id and u.id = oi.assigned_to
     where oi.tenant_id = $1 and oi.id = $2`,
    [tenantId, issueId],
  );

  if (res.rowCount === 0) {
    throw new AppError("NOT_FOUND", "Novedad operativa no encontrada.");
  }

  return res.rows[0]!;
}

export async function getOperationalIssue(
  token: string | null,
  issueId: string,
): Promise<OperationalIssueDto> {
  return runAuthorized(token, "issues.read", false, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    return fetchOperationalIssue(db, scope.tenantId, issueId);
  });
}

export async function listOperationalIssues(
  token: string | null,
  options?: { requestId?: string; stage?: string; status?: string; severity?: string },
): Promise<OperationalIssueDto[]> {
  return runAuthorized(token, "issues.read", false, async (db, scope) => {
    const params: unknown[] = [scope.tenantId];
    let sql = `
      select 
        oi.id, oi.request_id as "requestId", cr.code as "requestCode",
        oi.stage, oi.reference_id as "referenceId",
        oi.title, oi.description, oi.severity, oi.status,
        oi.evidence_file_id as "evidenceFileId",
        oi.assigned_to as "assignedTo", u.display_name as "assignedToName",
        oi.resolved_at as "resolvedAt", oi.resolved_by as "resolvedBy",
        oi.resolution_notes as "resolutionNotes",
        oi.created_at as "createdAt", oi.created_by as "createdBy",
        oi.updated_at as "updatedAt", oi.updated_by as "updatedBy"
      from app.operational_issues oi
      join app.commercial_requests cr on cr.tenant_id = oi.tenant_id and cr.id = oi.request_id
      left join app.users u on u.tenant_id = oi.tenant_id and u.id = oi.assigned_to
      where oi.tenant_id = $1`;

    if (options?.requestId) {
      params.push(options.requestId);
      sql += ` and oi.request_id = $${params.length}`;
    }
    if (options?.stage) {
      params.push(options.stage);
      sql += ` and oi.stage = $${params.length}`;
    }
    if (options?.status) {
      params.push(options.status);
      sql += ` and oi.status = $${params.length}`;
    }
    if (options?.severity) {
      params.push(options.severity);
      sql += ` and oi.severity = $${params.length}`;
    }

    sql += " order by oi.created_at desc";

    const res = await db.query<OperationalIssueDto>(sql, params);
    return res.rows;
  });
}
