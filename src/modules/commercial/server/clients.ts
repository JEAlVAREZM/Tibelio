import "server-only";
import { z } from "zod";
import { runAuthorized, pageSchema } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";

const clientName = z.string().trim().min(1).max(160);
const taxIdSchema = z.string().trim().min(1).max(60);
const phoneSchema = z.string().trim().min(7).max(30);
const emailSchema = z.string().trim().email().optional();
const addressText = z.string().trim().min(3).max(250);
const notesSchema = z.string().trim().max(1000).optional();
const coordSchema = z
  .string()
  .regex(/^-?\d{1,3}(?:\.\d{1,7})?$/)
  .optional();

export const createClientSchema = z
  .object({
    legalName: clientName,
    taxId: taxIdSchema,
    phone: phoneSchema,
    email: emailSchema,
    notes: notesSchema,
    address: z
      .object({
        municipalityId: z.string().regex(/^\d{5}$/),
        address: addressText,
        notes: z.string().trim().max(500).optional(),
        latitude: coordSchema,
        longitude: coordSchema,
      })
      .optional(),
  })
  .strict();

export const updateClientSchema = z
  .object({
    legalName: clientName.optional(),
    taxId: taxIdSchema.optional(),
    phone: phoneSchema.optional(),
    email: emailSchema.or(z.literal("")).optional(),
    notes: notesSchema.or(z.literal("")).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debe proporcionar al menos un campo para actualizar.",
  });

export const addAddressSchema = z
  .object({
    municipalityId: z.string().regex(/^\d{5}$/),
    address: addressText,
    notes: z.string().trim().max(500).optional(),
    latitude: coordSchema,
    longitude: coordSchema,
    isPrimary: z.boolean().default(false),
  })
  .strict();

export async function listClients(
  token: string | null,
  options: { page?: number; search?: string } = {},
) {
  const page = pageSchema.parse({ page: options.page }).page;
  const search = options.search?.trim();

  return runAuthorized(token, "clients.read", false, async (db, scope) => {
    const params: unknown[] = [scope.tenantId, (page - 1) * 200];
    let query = `select c.id, c.legal_name, c.tax_id, c.phone, c.email, c.notes, c.active, c.created_at,
                        coalesce(json_agg(
                          json_build_object(
                            'id', a.id,
                            'address', a.address,
                            'municipalityId', a.municipality_id,
                            'municipalityName', m.name,
                            'isPrimary', a.is_primary
                          ) order by a.is_primary desc, a.created_at asc
                        ) filter (where a.id is not null), '[]') as addresses
                 from app.clients c
                 left join app.client_addresses a on a.client_id = c.id and a.tenant_id = c.tenant_id
                 left join app.municipalities m on m.id = a.municipality_id
                 where c.tenant_id = $1`;
    if (search) {
      params.push(`%${search}%`);
      query += ` and (c.legal_name ilike $${params.length} or c.tax_id ilike $${params.length} or c.phone ilike $${params.length})`;
    }
    query += ` group by c.id order by c.legal_name asc limit 200 offset $2`;

    const result = await db.query(query, params);
    return result.rows.map((r) => ({
      id: r.id,
      legalName: r.legal_name,
      taxId: r.tax_id,
      phone: r.phone,
      email: r.email,
      notes: r.notes,
      active: r.active,
      createdAt: r.created_at,
      addresses: r.addresses,
    }));
  });
}

export async function getClient(token: string | null, clientId: string) {
  z.uuid().parse(clientId);
  return runAuthorized(token, "clients.read", false, async (db, scope) => {
    const client = (
      await db.query(
        `select id, legal_name, tax_id, phone, email, notes, active, created_at
         from app.clients
         where id = $1 and tenant_id = $2`,
        [clientId, scope.tenantId],
      )
    ).rows[0];
    if (!client) throw new AppError("NOT_FOUND");

    const addresses = (
      await db.query(
        `select a.id, a.address, a.notes, a.latitude::text, a.longitude::text,
                a.is_primary, a.municipality_id, m.name as municipality_name
         from app.client_addresses a
         join app.municipalities m on m.id = a.municipality_id
         where a.client_id = $1 and a.tenant_id = $2
         order by a.is_primary desc, a.created_at asc`,
        [clientId, scope.tenantId],
      )
    ).rows;

    return {
      id: client.id,
      legalName: client.legal_name,
      taxId: client.tax_id,
      phone: client.phone,
      email: client.email,
      notes: client.notes,
      active: client.active,
      createdAt: client.created_at,
      addresses: addresses.map((a) => ({
        id: a.id,
        address: a.address,
        notes: a.notes,
        latitude: a.latitude,
        longitude: a.longitude,
        isPrimary: a.is_primary,
        municipalityId: a.municipality_id,
        municipalityName: a.municipality_name,
      })),
    };
  });
}

export async function createClient(token: string | null, input: unknown) {
  const data = createClientSchema.parse(input);
  return runAuthorized(token, "clients.create", true, async (db, scope) => {
    const clientResult = await db.query(
      `insert into app.clients (
         tenant_id, legal_name, tax_id, phone, email, notes, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $7)
       returning id, legal_name, tax_id, phone, email, active`,
      [
        scope.tenantId,
        data.legalName,
        data.taxId,
        data.phone,
        data.email || null,
        data.notes || null,
        scope.userId,
      ],
    );
    const client = clientResult.rows[0];

    let address = null;
    if (data.address) {
      const muniExists = (
        await db.query(
          "select id from app.municipalities where id = $1",
          [data.address.municipalityId],
        )
      ).rowCount;
      if (!muniExists) throw new AppError("VALIDATION_ERROR");

      const addrResult = await db.query(
        `insert into app.client_addresses (
           tenant_id, client_id, municipality_id, address, notes,
           latitude, longitude, is_primary, created_by, updated_by
         ) values ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
         returning id, municipality_id, address, notes, latitude::text, longitude::text, is_primary`,
        [
          scope.tenantId,
          client.id,
          data.address.municipalityId,
          data.address.address,
          data.address.notes || null,
          data.address.latitude || null,
          data.address.longitude || null,
          scope.userId,
        ],
      );
      const a = addrResult.rows[0];
      address = {
        id: a.id,
        municipalityId: a.municipality_id,
        municipality_id: a.municipality_id,
        address: a.address,
        notes: a.notes,
        latitude: a.latitude,
        longitude: a.longitude,
        isPrimary: a.is_primary,
        is_primary: a.is_primary,
      };
    }

    return {
      id: client.id,
      legalName: client.legal_name,
      taxId: client.tax_id,
      phone: client.phone,
      email: client.email,
      active: client.active,
      primaryAddress: address,
    };
  });
}

export async function updateClient(
  token: string | null,
  clientId: string,
  input: unknown,
) {
  z.uuid().parse(clientId);
  const data = updateClientSchema.parse(input);
  return runAuthorized(token, "clients.update", true, async (db, scope) => {
    const emailVal = data.email === "" ? null : (data.email ?? undefined);
    const notesVal = data.notes === "" ? null : (data.notes ?? undefined);

    const result = await db.query(
      `update app.clients
       set legal_name = coalesce($1, legal_name),
           tax_id = coalesce($2, tax_id),
           phone = coalesce($3, phone),
           email = case when $4::boolean then $5 else email end,
           notes = case when $6::boolean then $7 else notes end,
           active = coalesce($8, active),
           updated_at = now(),
           updated_by = $9
       where id = $10 and tenant_id = $11
       returning id, legal_name, tax_id, phone, email, notes, active`,
      [
        data.legalName ?? null,
        data.taxId ?? null,
        data.phone ?? null,
        emailVal !== undefined,
        emailVal ?? null,
        notesVal !== undefined,
        notesVal ?? null,
        data.active ?? null,
        scope.userId,
        clientId,
        scope.tenantId,
      ],
    );
    if (!result.rowCount) throw new AppError("NOT_FOUND");
    const row = result.rows[0];
    return {
      id: row.id,
      legalName: row.legal_name,
      taxId: row.tax_id,
      phone: row.phone,
      email: row.email,
      notes: row.notes,
      active: row.active,
    };
  });
}

export async function addAddress(
  token: string | null,
  clientId: string,
  input: unknown,
) {
  z.uuid().parse(clientId);
  const data = addAddressSchema.parse(input);
  return runAuthorized(token, "clients.update", true, async (db, scope) => {
    const clientExists = (
      await db.query(
        "select id from app.clients where id = $1 and tenant_id = $2",
        [clientId, scope.tenantId],
      )
    ).rowCount;
    if (!clientExists) throw new AppError("NOT_FOUND");

    const muniExists = (
      await db.query(
        "select id from app.municipalities where id = $1",
        [data.municipalityId],
      )
    ).rowCount;
    if (!muniExists) throw new AppError("VALIDATION_ERROR");

    if (data.isPrimary) {
      await db.query(
        "update app.client_addresses set is_primary = false where client_id = $1 and tenant_id = $2",
        [clientId, scope.tenantId],
      );
    }

    const result = await db.query(
      `insert into app.client_addresses (
         tenant_id, client_id, municipality_id, address, notes,
         latitude, longitude, is_primary, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
       returning id, municipality_id, address, notes, latitude::text, longitude::text, is_primary`,
      [
        scope.tenantId,
        clientId,
        data.municipalityId,
        data.address,
        data.notes || null,
        data.latitude || null,
        data.longitude || null,
        data.isPrimary,
        scope.userId,
      ],
    );
    const a = result.rows[0];
    return {
      id: a.id,
      municipalityId: a.municipality_id,
      municipality_id: a.municipality_id,
      address: a.address,
      notes: a.notes,
      latitude: a.latitude,
      longitude: a.longitude,
      isPrimary: a.is_primary,
      is_primary: a.is_primary,
    };
  });
}

export async function deleteAddress(token: string | null, addressId: string) {
  z.uuid().parse(addressId);
  return runAuthorized(token, "clients.update", true, async (db, scope) => {
    const deleted = (
      await db.query(
        "delete from app.client_addresses where id = $1 and tenant_id = $2 returning id",
        [addressId, scope.tenantId],
      )
    ).rowCount;
    if (!deleted) throw new AppError("NOT_FOUND");
    return { id: addressId, deleted: true };
  });
}
