import "server-only";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import {
  createSupplierSchema,
  updateSupplierSchema,
  type SupplierDto,
} from "../../../shared/contracts/operations";

export async function createSupplier(
  token: string | null,
  rawInput: unknown,
): Promise<SupplierDto> {
  const input = createSupplierSchema.parse(rawInput);

  return runAuthorized(token, "suppliers.manage", true, async (db, scope) => {
    const res = await db.query<SupplierDto>(
      `insert into app.suppliers(
         tenant_id, name, tax_id, contact_name, email, phone, notes, active,
         created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
       returning 
         id, name, tax_id as "taxId", contact_name as "contactName",
         email, phone, notes, active,
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        scope.tenantId,
        input.name,
        input.taxId ?? null,
        input.contactName ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.notes ?? null,
        scope.userId,
      ],
    );

    return res.rows[0]!;
  });
}

export async function getSupplier(
  token: string | null,
  supplierId: string,
): Promise<SupplierDto> {
  z.string().uuid("ID de proveedor inválido").parse(supplierId);

  return runAuthorized(token, "suppliers.read", false, async (db, scope) => {
    const res = await db.query<SupplierDto>(
      `select 
         id, name, tax_id as "taxId", contact_name as "contactName",
         email, phone, notes, active,
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"
       from app.suppliers
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, supplierId],
    );

    if (res.rowCount === 0) throw new AppError("NOT_FOUND");
    return res.rows[0]!;
  });
}

export async function listSuppliers(
  token: string | null,
  rawQuery?: unknown,
): Promise<SupplierDto[]> {
  const query = z
    .object({
      activeOnly: z.preprocess((value) => value === "false" ? false : value === "true" ? true : value, z.boolean().optional().default(true)),
      search: z.string().trim().optional(),
      page: z.coerce.number().int().min(1).max(100000).default(1),
    })
    .parse(rawQuery ?? {});

  return runAuthorized(token, "suppliers.read", false, async (db, scope) => {
    let sql = `
      select 
        id, name, tax_id as "taxId", contact_name as "contactName",
        email, phone, notes, active,
        created_at as "createdAt", created_by as "createdBy",
        updated_at as "updatedAt", updated_by as "updatedBy"
      from app.suppliers
      where tenant_id = $1
    `;
    const params: unknown[] = [scope.tenantId];

    if (query.activeOnly) {
      params.push(true);
      sql += ` and active = $${params.length}`;
    }

    if (query.search) {
      params.push(`%${query.search}%`);
      sql += ` and (name ilike $${params.length} or contact_name ilike $${params.length} or tax_id ilike $${params.length} or phone ilike $${params.length})`;
    }

    params.push((query.page-1)*200);
    sql += ` order by name asc,id asc limit 200 offset $${params.length}`;

    const res = await db.query<SupplierDto>(sql, params);
    return res.rows;
  });
}

export async function updateSupplier(
  token: string | null,
  supplierId: string,
  rawInput: unknown,
): Promise<SupplierDto> {
  z.string().uuid("ID de proveedor inválido").parse(supplierId);
  const input = updateSupplierSchema.parse(rawInput);

  return runAuthorized(token, "suppliers.manage", true, async (db, scope) => {
    const current = await db.query(
      "select id from app.suppliers where tenant_id = $1 and id = $2",
      [scope.tenantId, supplierId],
    );
    if (current.rowCount === 0) throw new AppError("NOT_FOUND");

    const res = await db.query<SupplierDto>(
      `update app.suppliers
       set name = coalesce($1, name),
           tax_id = coalesce($2, tax_id),
           contact_name = coalesce($3, contact_name),
           email = coalesce($4, email),
           phone = coalesce($5, phone),
           notes = coalesce($6, notes),
           active = coalesce($7, active),
           updated_at = now(),
           updated_by = $8
       where tenant_id = $9 and id = $10
       returning 
         id, name, tax_id as "taxId", contact_name as "contactName",
         email, phone, notes, active,
         created_at as "createdAt", created_by as "createdBy",
         updated_at as "updatedAt", updated_by as "updatedBy"`,
      [
        input.name ?? null,
        input.taxId ?? null,
        input.contactName ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.notes ?? null,
        input.active ?? null,
        scope.userId,
        scope.tenantId,
        supplierId,
      ],
    );

    return res.rows[0]!;
  });
}
