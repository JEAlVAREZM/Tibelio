import "server-only";
import type pg from "pg";
import { runAuthorized } from "../../platform/server/service";
import { canReadCosts, type ActorContext } from "../../identity/server/authorization";
import { AppError } from "../../../shared/server/app-error";
import { writeReceipt } from "../../../shared/server/private-receipts";
import {
  type OperationalCostDto,
  createOperationalCostSchema,
  annulOperationalCostSchema,
} from "../../../shared/contracts/post-sale";

export async function createOperationalCost(
  token: string | null,
  rawInput: unknown,
): Promise<OperationalCostDto> {
  const input = createOperationalCostSchema.parse(rawInput);

  return runAuthorized(token, "costs.manage", true, async (db, scope) => {
    // 1. Validar que la solicitud exista en la empresa
    const reqRes = await db.query<{ id: string; code: string }>(
      "select id, code from app.commercial_requests where tenant_id = $1 and id = $2",
      [scope.tenantId, input.requestId],
    );
    if (reqRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    }
    const req = reqRes.rows[0]!;

    // 2. Guardar comprobante de gasto si fue suministrado
    let voucherFileId: string | null = null;
    let voucherByteSize: number | null = null;
    let voucherSha256: string | null = null;
    let voucherMimeType: string | null = null;

    if (input.voucherBase64 && input.voucherMimeType) {
      const buffer = Buffer.from(input.voucherBase64, "base64");
      const stored = await writeReceipt(buffer, input.voucherMimeType, "cost-vouchers");
      voucherFileId = stored.id;
      voucherByteSize = stored.byteSize;
      voucherSha256 = stored.sha256;
      voucherMimeType = stored.mime;
    }

    // 3. Insertar costo operativo real
    const insRes = await db.query<OperationalCostDto>(
      `insert into app.operational_costs(
         tenant_id, request_id, category, concept, amount, reference_id,
         voucher_file_id, voucher_byte_size, voucher_sha256, voucher_mime_type, active, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, $11, $11)
       returning 
         id, request_id as "requestId", category, concept, amount::text,
         reference_id as "referenceId", voucher_file_id as "voucherFileId",
         active, annulled_at as "annulledAt", annulled_by as "annulledBy",
         annulment_reason as "annulmentReason", created_at as "createdAt",
         created_by as "createdBy", updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.requestId,
        input.category,
        input.concept,
        input.amount,
        input.referenceId ?? null,
        voucherFileId,
        voucherByteSize,
        voucherSha256,
        voucherMimeType,
        scope.userId,
      ],
    );
    const row = insRes.rows[0]!;
    row.requestCode = req.code;
    return row;
  });
}

export async function annulOperationalCost(
  token: string | null,
  costId: string,
  rawInput: unknown,
): Promise<OperationalCostDto> {
  const input = annulOperationalCostSchema.parse(rawInput);

  return runAuthorized(token, "costs.manage", true, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    const curRes = await db.query<{ id: string; active: boolean }>(
      "select id, active from app.operational_costs where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, costId],
    );
    if (curRes.rowCount === 0) {
      throw new AppError("NOT_FOUND", "Costo operativo no encontrado.");
    }
    if (!curRes.rows[0]!.active) {
      throw new AppError("CONFLICT", "El costo operativo ya ha sido anulado previamente.");
    }

    await db.query(
      `update app.operational_costs
       set active = false,
           annulled_at = now(),
           annulled_by = $3,
           annulment_reason = $4,
           updated_at = now(),
           updated_by = $3
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, costId, scope.userId, input.reason],
    );

    return fetchOperationalCost(db, scope.tenantId, costId, true);
  });
}

async function fetchOperationalCost(
  db: pg.PoolClient,
  tenantId: string,
  costId: string,
  canSee: boolean,
): Promise<OperationalCostDto> {
  const res = await db.query<OperationalCostDto>(
    `select 
       oc.id, oc.request_id as "requestId", cr.code as "requestCode",
       oc.category, oc.concept,
       case when $3 then oc.amount::text else null end as amount,
       oc.reference_id as "referenceId", oc.voucher_file_id as "voucherFileId",
       oc.active, oc.annulled_at as "annulledAt", oc.annulled_by as "annulledBy",
       oc.annulment_reason as "annulmentReason", oc.created_at as "createdAt",
       oc.created_by as "createdBy", oc.updated_at as "updatedAt", oc.updated_by as "updatedBy"
     from app.operational_costs oc
     join app.commercial_requests cr on cr.tenant_id = oc.tenant_id and cr.id = oc.request_id
     where oc.tenant_id = $1 and oc.id = $2`,
    [tenantId, costId, canSee],
  );

  if (res.rowCount === 0) {
    throw new AppError("NOT_FOUND", "Costo operativo no encontrado.");
  }

  return res.rows[0]!;
}

export async function getOperationalCost(
  token: string | null,
  costId: string,
): Promise<OperationalCostDto> {
  return runAuthorized(token, "requests.read", false, async (db, scope) => {
    if (!scope.tenantId) throw new AppError("FORBIDDEN");
    // Comprobar confidencialidad de costos para el actor
    const actorRes = await db.query<{ actor: ActorContext }>("select app_private.actor() actor");
    const actor = actorRes.rows[0]?.actor;
    const canSee = canReadCosts(actor);

    return fetchOperationalCost(db, scope.tenantId, costId, canSee);
  });
}

export async function listOperationalCosts(
  token: string | null,
  options?: { requestId?: string; category?: string; activeOnly?: boolean },
): Promise<OperationalCostDto[]> {
  return runAuthorized(token, "requests.read", false, async (db, scope) => {
    const actorRes = await db.query<{ actor: ActorContext }>("select app_private.actor() actor");
    const actor = actorRes.rows[0]?.actor;
    const canSee = canReadCosts(actor);

    const params: unknown[] = [scope.tenantId, canSee];
    let sql = `
      select 
        oc.id, oc.request_id as "requestId", cr.code as "requestCode",
        oc.category, oc.concept,
        case when $2 then oc.amount::text else null end as amount,
        oc.reference_id as "referenceId", oc.voucher_file_id as "voucherFileId",
        oc.active, oc.annulled_at as "annulledAt", oc.annulled_by as "annulledBy",
        oc.annulment_reason as "annulmentReason", oc.created_at as "createdAt",
        oc.created_by as "createdBy", oc.updated_at as "updatedAt", oc.updated_by as "updatedBy"
      from app.operational_costs oc
      join app.commercial_requests cr on cr.tenant_id = oc.tenant_id and cr.id = oc.request_id
      where oc.tenant_id = $1`;

    if (options?.requestId) {
      params.push(options.requestId);
      sql += ` and oc.request_id = $${params.length}`;
    }
    if (options?.category) {
      params.push(options.category);
      sql += ` and oc.category = $${params.length}`;
    }
    if (options?.activeOnly) {
      sql += " and oc.active = true";
    }

    sql += " order by oc.created_at desc";

    const res = await db.query<OperationalCostDto>(sql, params);
    return res.rows;
  });
}
