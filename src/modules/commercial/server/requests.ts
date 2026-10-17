import "server-only";
import type pg from "pg";
import { z } from "zod";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import type { AuthorizedScope } from "../../identity/server/authorization";
import type {
  CommercialRequestDto,
  RequestCabinDto,
  RequestItemDto,
} from "../../../shared/contracts/commercial";

export const requestCabinInputSchema = z.object({
  id: z.string().uuid().optional(),
  productId: z.string().uuid("ID de producto inválido"),
  locationTag: z.string().trim().max(100).optional().nullable(),
  finish: z.string().trim().max(100).optional().nullable(),
  customWidth: z
    .number()
    .positive("El ancho debe ser positivo")
    .max(9999.99, "El ancho excede el límite permitido")
    .optional()
    .nullable(),
  customHeight: z
    .number()
    .positive("El alto debe ser positivo")
    .max(9999.99, "El alto excede el límite permitido")
    .optional()
    .nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional(),
});

export const requestItemInputSchema = z.object({
  id: z.string().uuid().optional(),
  cabinId: z.string().uuid().optional().nullable(),
  productId: z.string().uuid("ID de producto inválido"),
  quantity: z.number().int("La cantidad debe ser entera").positive("La cantidad debe ser mayor a 0"),
  notes: z.string().trim().max(500).optional().nullable(),
  active: z.boolean().optional(),
});

export const createCommercialRequestSchema = z.object({
  clientId: z.string().uuid("ID de cliente inválido"),
  clientAddressId: z.string().uuid("ID de dirección inválido"),
  notes: z.string().trim().max(2000).optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional().default("NORMAL"),
  cabins: z.array(requestCabinInputSchema).min(1, "Debe incluir al menos una cabina física"),
  items: z.array(requestItemInputSchema).optional().default([]),
});

export const updateCommercialRequestSchema = z.object({
  expectedRevision: z.number().int().min(1, "Revisión esperada obligatoria"),
  clientAddressId: z.string().uuid().optional(),
  notes: z.string().trim().max(2000).optional().nullable(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  cabins: z.array(requestCabinInputSchema).optional(),
  items: z.array(requestItemInputSchema).optional(),
});

export const listCommercialRequestsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().optional(),
  clientId: z.string().uuid().optional(),
  status: z.enum(["DRAFT", "QUOTED", "COMPLETED", "CANCELLED"]).optional(),
});

export type CreateCommercialRequestInput = z.infer<typeof createCommercialRequestSchema>;
export type UpdateCommercialRequestInput = z.infer<typeof updateCommercialRequestSchema>;
export type ListCommercialRequestsQuery = z.infer<typeof listCommercialRequestsQuerySchema>;

export async function listRequests(
  token: string | null,
  rawQuery: unknown,
): Promise<{ items: CommercialRequestDto[]; total: number; page: number; limit: number }> {
  const query = listCommercialRequestsQuerySchema.parse(rawQuery ?? {});
  return runAuthorized(token, "requests.read", false, async (db, scope) => {
    const conditions: string[] = ["r.tenant_id = $1"];
    const params: unknown[] = [scope.tenantId];

    if (query.clientId) {
      params.push(query.clientId);
      conditions.push(`r.client_id = $${params.length}`);
    }

    if (query.status) {
      params.push(query.status);
      conditions.push(`r.status = $${params.length}`);
    }

    if (query.search) {
      params.push(`%${query.search}%`);
      const pIdx = params.length;
      conditions.push(`(r.code ilike $${pIdx} or c.legal_name ilike $${pIdx} or c.tax_id ilike $${pIdx})`);
    }

    const whereClause = conditions.join(" and ");

    const countRes = await db.query<{ count: string }>(
      `select count(*)::text as count
       from app.commercial_requests r
       join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
       where ${whereClause}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? "0", 10);

    const offset = (query.page - 1) * query.limit;
    params.push(query.limit, offset);

    const listRes = await db.query(
      `select 
         r.id, r.code, r.status, r.notes, r.priority, r.revision,
         r.client_id, c.legal_name as client_legal_name,
         r.client_address_id, ca.address as client_address_text,
         ca.municipality_id, m.name as municipality_name,
         r.zone_id, pz.name as zone_name,
         r.created_by, u1.display_name as creator_name,
         r.updated_by, u2.display_name as updater_name,
         r.created_at, r.updated_at,
         (select count(*)::int from app.request_cabins rc where rc.tenant_id = r.tenant_id and rc.request_id = r.id and rc.active = true) as cabins_count
       from app.commercial_requests r
       join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
       join app.client_addresses ca on ca.tenant_id = r.tenant_id and ca.client_id = r.client_id and ca.id = r.client_address_id
       join app.municipalities m on m.id = ca.municipality_id
       left join app.pricing_zones pz on pz.tenant_id = r.tenant_id and pz.id = r.zone_id
       join app.users u1 on u1.tenant_id = r.tenant_id and u1.id = r.created_by
       join app.users u2 on u2.tenant_id = r.tenant_id and u2.id = r.updated_by
       where ${whereClause}
       order by r.created_at desc
       limit $${params.length - 1} offset $${params.length}`,
      params,
    );

    const items: CommercialRequestDto[] = listRes.rows.map((row) => ({
      id: row.id,
      code: row.code,
      status: row.status,
      clientId: row.client_id,
      clientLegalName: row.client_legal_name,
      clientAddressId: row.client_address_id,
      clientAddressText: row.client_address_text,
      municipalityId: row.municipality_id,
      municipalityName: row.municipality_name,
      zoneId: row.zone_id,
      zoneName: row.zone_name,
      notes: row.notes,
      priority: row.priority || "NORMAL",
      revision: row.revision,
      createdBy: row.created_by,
      creatorName: row.creator_name,
      updatedBy: row.updated_by,
      updaterName: row.updater_name,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      cabinsCount: row.cabins_count,
    }));

    return { items, total, page: query.page, limit: query.limit };
  });
}

async function getRequestInternal(
  db: pg.PoolClient,
  scope: AuthorizedScope,
  requestId: string,
): Promise<CommercialRequestDto> {
  const reqRes = await db.query(
    `select 
       r.id, r.code, r.status, r.notes, r.priority, r.revision,
       r.client_id, c.legal_name as client_legal_name,
       r.client_address_id, ca.address as client_address_text,
       ca.municipality_id, m.name as municipality_name,
       r.zone_id, pz.name as zone_name,
       r.created_by, coalesce(u1.display_name, 'Usuario') as creator_name,
       r.updated_by, coalesce(u2.display_name, 'Usuario') as updater_name,
       r.created_at, r.updated_at
     from app.commercial_requests r
     join app.clients c on c.tenant_id = r.tenant_id and c.id = r.client_id
     join app.client_addresses ca on ca.tenant_id = r.tenant_id and ca.client_id = r.client_id and ca.id = r.client_address_id
     join app.municipalities m on m.id = ca.municipality_id
     left join app.pricing_zones pz on pz.tenant_id = r.tenant_id and pz.id = r.zone_id
     left join app.users u1 on u1.tenant_id = r.tenant_id and u1.id = r.created_by
     left join app.users u2 on u2.tenant_id = r.tenant_id and u2.id = r.updated_by
     where r.tenant_id = $1 and r.id = $2`,
    [scope.tenantId, requestId],
  );

  if (reqRes.rowCount === 0) {
    throw new AppError("NOT_FOUND");
  }
  const r = reqRes.rows[0]!;

  const cabinsRes = await db.query(
    `select 
       rc.id, rc.request_id, rc.product_id, cp.name as product_name, cp.sku as product_sku,
       rc.location_tag, rc.finish, rc.custom_width, rc.custom_height, rc.notes, rc.active,
       rc.created_at, rc.updated_at
     from app.request_cabins rc
     join app.catalog_products cp on cp.tenant_id = rc.tenant_id and cp.id = rc.product_id
     where rc.tenant_id = $1 and rc.request_id = $2
     order by rc.created_at asc`,
    [scope.tenantId, requestId],
  );

interface DbRequestCabinRow {
  id: string;
  request_id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  location_tag: string | null;
  finish: string | null;
  custom_width: string | null;
  custom_height: string | null;
  notes: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface DbRequestItemRow {
  id: string;
  request_id: string;
  cabin_id: string | null;
  product_id: string;
  product_name: string;
  product_sku: string;
  product_kind: "ACCESSORY" | "MATERIAL";
  quantity: number;
  notes: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

  const cabins: RequestCabinDto[] = (cabinsRes.rows as DbRequestCabinRow[]).map((row) => ({
    id: row.id,
    requestId: row.request_id,
    productId: row.product_id,
    productName: row.product_name,
    productSku: row.product_sku,
    locationTag: row.location_tag,
    finish: row.finish,
    customWidth: row.custom_width ? parseFloat(row.custom_width) : null,
    customHeight: row.custom_height ? parseFloat(row.custom_height) : null,
    notes: row.notes,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));

  const itemsRes = await db.query(
    `select 
       ri.id, ri.request_id, ri.cabin_id, ri.product_id, cp.name as product_name, cp.sku as product_sku,
       ri.product_kind, ri.quantity, ri.notes, ri.active,
       ri.created_at, ri.updated_at
     from app.request_items ri
     join app.catalog_products cp on cp.tenant_id = ri.tenant_id and cp.id = ri.product_id
     where ri.tenant_id = $1 and ri.request_id = $2
     order by ri.created_at asc`,
    [scope.tenantId, requestId],
  );

  const items: RequestItemDto[] = (itemsRes.rows as DbRequestItemRow[]).map((row) => ({
    id: row.id,
    requestId: row.request_id,
    cabinId: row.cabin_id,
    productId: row.product_id,
    productName: row.product_name,
    productSku: row.product_sku,
    productKind: row.product_kind,
    quantity: row.quantity,
    notes: row.notes,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));

  return {
    id: r.id,
    code: r.code,
    status: r.status,
    clientId: r.client_id,
    clientLegalName: r.client_legal_name,
    clientAddressId: r.client_address_id,
    clientAddressText: r.client_address_text,
    municipalityId: r.municipality_id,
    municipalityName: r.municipality_name,
    zoneId: r.zone_id,
    zoneName: r.zone_name,
    notes: r.notes,
    priority: r.priority || "NORMAL",
    revision: r.revision,
    createdBy: r.created_by,
    creatorName: r.creator_name,
    updatedBy: r.updated_by,
    updaterName: r.updater_name,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    cabinsCount: cabins.filter((c) => c.active).length,
    cabins,
    items,
  };
}

export async function getRequest(
  token: string | null,
  requestId: string,
): Promise<CommercialRequestDto> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);
  return runAuthorized(token, "requests.read", false, async (db, scope) => {
    return getRequestInternal(db, scope, requestId);
  });
}

export async function createRequest(
  token: string | null,
  rawInput: unknown,
): Promise<CommercialRequestDto> {
  const input = createCommercialRequestSchema.parse(rawInput);
  return runAuthorized(token, "requests.create", true, async (db, scope) => {
    // 1. Validar que cliente y dirección pertenezcan al tenant
    const addrRes = await db.query<{ municipality_id: string }>(
      `select ca.municipality_id
       from app.client_addresses ca
       where ca.tenant_id = $1 and ca.client_id = $2 and ca.id = $3`,
      [scope.tenantId, input.clientId, input.clientAddressId],
    );

    if (addrRes.rowCount === 0) {
      throw new AppError("VALIDATION_ERROR");
    }
    const municipalityId = addrRes.rows[0]!.municipality_id;

    // 2. Derivar zona tarifaria si existe para ese municipio
    const zoneRes = await db.query<{ zone_id: string }>(
      `select zm.zone_id
       from app.zone_municipalities zm
       join app.pricing_zones pz on pz.tenant_id = zm.tenant_id and pz.id = zm.zone_id
       where zm.tenant_id = $1 and zm.municipality_id = $2 and pz.active = true
       limit 1`,
      [scope.tenantId, municipalityId],
    );
    const zoneId = zoneRes.rows[0]?.zone_id ?? null;

    // 3. Generar código transaccional
    const codeRes = await db.query<{ code: string }>(
      "select app_private.next_commercial_request_code() as code",
    );
    const code = codeRes.rows[0]!.code;

    // 4. Insertar cabecera de solicitud
    const reqRes = await db.query<{ id: string }>(
      `insert into app.commercial_requests(
         tenant_id, code, client_id, client_address_id, zone_id, status, notes, priority, revision
       ) values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, 1)
       returning id`,
      [scope.tenantId, code, input.clientId, input.clientAddressId, zoneId, input.notes ?? null, input.priority || "NORMAL"],
    );
    const requestId = reqRes.rows[0]!.id;

    // 5. Insertar cabinas físicas individuales (UUID generado en servidor)
    const cabinIdMap = new Map<number, string>();
    for (let i = 0; i < input.cabins.length; i++) {
      const cabin = input.cabins[i]!;
      // Validar producto de tipo CABIN
      const prodRes = await db.query(
        "select id from app.catalog_products where tenant_id = $1 and id = $2 and kind = 'CABIN' and active = true",
        [scope.tenantId, cabin.productId],
      );
      if (prodRes.rowCount === 0) {
        throw new AppError("VALIDATION_ERROR");
      }

      const insCabin = await db.query<{ id: string }>(
        `insert into app.request_cabins(
           tenant_id, request_id, product_id, product_kind, location_tag, finish, custom_width, custom_height, notes, active
         ) values ($1, $2, $3, 'CABIN', $4, $5, $6, $7, $8, true)
         returning id`,
        [
          scope.tenantId,
          requestId,
          cabin.productId,
          cabin.locationTag ?? null,
          cabin.finish ?? null,
          cabin.customWidth ?? null,
          cabin.customHeight ?? null,
          cabin.notes ?? null,
        ],
      );
      cabinIdMap.set(i, insCabin.rows[0]!.id);
    }

    // 6. Insertar ítems complementarios
    for (const item of input.items) {
      // Validar que sea ACCESSORY o MATERIAL
      const prodRes = await db.query<{ kind: "ACCESSORY" | "MATERIAL" }>(
        "select kind from app.catalog_products where tenant_id = $1 and id = $2 and kind in ('ACCESSORY', 'MATERIAL') and active = true",
        [scope.tenantId, item.productId],
      );
      if (prodRes.rowCount === 0) {
        throw new AppError("VALIDATION_ERROR");
      }
      const kind = prodRes.rows[0]!.kind;

      await db.query(
        `insert into app.request_items(
           tenant_id, request_id, cabin_id, product_id, product_kind, quantity, notes, active
         ) values ($1, $2, $3, $4, $5, $6, $7, true)`,
        [
          scope.tenantId,
          requestId,
          item.cabinId ?? null,
          item.productId,
          kind,
          item.quantity,
          item.notes ?? null,
        ],
      );
    }

    return getRequestInternal(db, scope, requestId);
  });
}

export async function updateRequest(
  token: string | null,
  requestId: string,
  rawInput: unknown,
): Promise<CommercialRequestDto> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);
  const input = updateCommercialRequestSchema.parse(rawInput);
  return runAuthorized(token, "requests.update", true, async (db, scope) => {
    // 1. Bloquear y verificar revisión actual (control de concurrencia optimista)
    const currentRes = await db.query<{ revision: number; client_id: string; client_address_id: string; zone_id: string | null }>(
      "select revision, client_id, client_address_id, zone_id from app.commercial_requests where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, requestId],
    );

    if (currentRes.rowCount === 0) {
      throw new AppError("NOT_FOUND");
    }

    const current = currentRes.rows[0]!;
    if (current.revision !== input.expectedRevision) {
      throw new AppError("CONFLICT");
    }

    let nextZoneId = current.zone_id;
    let nextAddressId = current.client_address_id;

    // Si se envía nueva dirección, verificar que sea del mismo cliente y derivar zona
    if (input.clientAddressId && input.clientAddressId !== current.client_address_id) {
      const addrRes = await db.query<{ municipality_id: string }>(
        `select ca.municipality_id
         from app.client_addresses ca
         where ca.tenant_id = $1 and ca.client_id = $2 and ca.id = $3`,
        [scope.tenantId, current.client_id, input.clientAddressId],
      );
      if (addrRes.rowCount === 0) {
        throw new AppError("VALIDATION_ERROR");
      }
      nextAddressId = input.clientAddressId;

      const zoneRes = await db.query<{ zone_id: string }>(
        `select zm.zone_id
         from app.zone_municipalities zm
         join app.pricing_zones pz on pz.tenant_id = zm.tenant_id and pz.id = zm.zone_id
         where zm.tenant_id = $1 and zm.municipality_id = $2 and pz.active = true
         limit 1`,
        [scope.tenantId, addrRes.rows[0]!.municipality_id],
      );
      nextZoneId = zoneRes.rows[0]?.zone_id ?? null;
    }

    // 2. Actualizar cabecera con avance de revisión monotónica
    await db.query(
      `update app.commercial_requests
       set client_address_id = $1, zone_id = $2, notes = coalesce($3, notes),
           priority = coalesce($4, priority), revision = revision + 1
       where tenant_id = $5 and id = $6`,
      [nextAddressId, nextZoneId, input.notes ?? null, input.priority ?? null, scope.tenantId, requestId],
    );

    // 3. Procesar cabinas
    if (input.cabins) {
      for (const cabin of input.cabins) {
        if (cabin.id) {
          // Edición de cabina existente: validar pertenencia estricta (tenant_id, request_id, id)
          const existRes = await db.query(
            "select id, active from app.request_cabins where tenant_id = $1 and request_id = $2 and id = $3",
            [scope.tenantId, requestId, cabin.id],
          );
          if (existRes.rowCount === 0) {
            throw new AppError("VALIDATION_ERROR");
          }

          // Solo actualiza 'active' si se envió explícitamente en el payload (no asume true por defecto)
          const nextActive = cabin.active !== undefined ? cabin.active : existRes.rows[0]!.active;

          await db.query(
            `update app.request_cabins
             set location_tag = coalesce($1, location_tag),
                 finish = coalesce($2, finish),
                 custom_width = coalesce($3, custom_width),
                 custom_height = coalesce($4, custom_height),
                 notes = coalesce($5, notes),
                 active = $6
             where tenant_id = $7 and request_id = $8 and id = $9`,
            [
              cabin.locationTag ?? null,
              cabin.finish ?? null,
              cabin.customWidth ?? null,
              cabin.customHeight ?? null,
              cabin.notes ?? null,
              nextActive,
              scope.tenantId,
              requestId,
              cabin.id,
            ],
          );
        } else {
          // Nueva cabina añadida al borrador
          const prodRes = await db.query(
            "select id from app.catalog_products where tenant_id = $1 and id = $2 and kind = 'CABIN' and active = true",
            [scope.tenantId, cabin.productId],
          );
          if (prodRes.rowCount === 0) {
            throw new AppError("VALIDATION_ERROR");
          }

          await db.query(
            `insert into app.request_cabins(
               tenant_id, request_id, product_id, product_kind, location_tag, finish, custom_width, custom_height, notes, active
             ) values ($1, $2, $3, 'CABIN', $4, $5, $6, $7, $8, true)`,
            [
              scope.tenantId,
              requestId,
              cabin.productId,
              cabin.locationTag ?? null,
              cabin.finish ?? null,
              cabin.customWidth ?? null,
              cabin.customHeight ?? null,
              cabin.notes ?? null,
            ],
          );
        }
      }
    }

    // 4. Procesar ítems
    if (input.items) {
      for (const item of input.items) {
        if (item.id) {
          const existRes = await db.query(
            "select id, active from app.request_items where tenant_id = $1 and request_id = $2 and id = $3",
            [scope.tenantId, requestId, item.id],
          );
          if (existRes.rowCount === 0) {
            throw new AppError("VALIDATION_ERROR");
          }
          const nextActive = item.active !== undefined ? item.active : existRes.rows[0]!.active;

          await db.query(
            `update app.request_items
             set quantity = coalesce($1, quantity),
                 notes = coalesce($2, notes),
                 active = $3
             where tenant_id = $4 and request_id = $5 and id = $6`,
            [item.quantity ?? null, item.notes ?? null, nextActive, scope.tenantId, requestId, item.id],
          );
        } else {
          const prodRes = await db.query<{ kind: "ACCESSORY" | "MATERIAL" }>(
            "select kind from app.catalog_products where tenant_id = $1 and id = $2 and kind in ('ACCESSORY', 'MATERIAL') and active = true",
            [scope.tenantId, item.productId],
          );
          if (prodRes.rowCount === 0) {
            throw new AppError("VALIDATION_ERROR");
          }
          const kind = prodRes.rows[0]!.kind;

          await db.query(
            `insert into app.request_items(
               tenant_id, request_id, cabin_id, product_id, product_kind, quantity, notes, active
             ) values ($1, $2, $3, $4, $5, $6, $7, true)`,
            [
              scope.tenantId,
              requestId,
              item.cabinId ?? null,
              item.productId,
              kind,
              item.quantity,
              item.notes ?? null,
            ],
          );
        }
      }
    }

    return getRequestInternal(db, scope, requestId);
  });
}

export async function updateRequestPriority(
  token: string | null,
  requestId: string,
  rawInput: unknown,
): Promise<CommercialRequestDto> {
  z.string().uuid("ID de solicitud inválido").parse(requestId);
  const input = z.object({
    priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]),
  }).parse(rawInput);

  return runAuthorized(token, "requests.update", true, async (db, scope) => {
    const reqRes = await db.query<{ id: string; status: string }>(
      "select id, status from app.commercial_requests where tenant_id = $1 and id = $2 for update",
      [scope.tenantId, requestId],
    );
    if (reqRes.rowCount === 0) throw new AppError("NOT_FOUND", "Solicitud comercial no encontrada.");
    if (reqRes.rows[0]!.status === "CANCELLED") {
      throw new AppError("VALIDATION_ERROR", "No se puede cambiar la prioridad de una solicitud cancelada.");
    }

    await db.query(
      `update app.commercial_requests
       set priority = $3,
           updated_by = $4,
           updated_at = now()
       where tenant_id = $1 and id = $2`,
      [scope.tenantId, requestId, input.priority, scope.userId],
    );

    return getRequestInternal(db, scope, requestId);
  });
}
