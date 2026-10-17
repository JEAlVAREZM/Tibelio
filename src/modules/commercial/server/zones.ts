import "server-only";
import { z } from "zod";
import { runAuthorized, pageSchema } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { canReadCosts, type ActorContext } from "../../identity/server/authorization";
import { canonicalMoneySchema } from "../../../shared/contracts/money";

const zoneName = z.string().trim().min(1).max(120);
const feeAmount = canonicalMoneySchema;
const marginRatio = z.string().regex(/^0(?:\.\d{1,6})?$/);

export const createZoneSchema = z
  .object({
    name: zoneName,
    transportFee: feeAmount.default("0.00"),
    installationFee: feeAmount.default("0.00"),
    targetMargin: marginRatio.default("0.250000"),
    minimumMargin: marginRatio.default("0.150000"),
  })
  .strict()
  .refine(
    (d) => Number(d.minimumMargin) <= Number(d.targetMargin),
    { message: "El margen mínimo no puede superar el margen objetivo." },
  );

export const updateZoneSchema = z
  .object({
    name: zoneName.optional(),
    transportFee: feeAmount.optional(),
    installationFee: feeAmount.optional(),
    targetMargin: marginRatio.optional(),
    minimumMargin: marginRatio.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debe proporcionar al menos un campo para actualizar.",
  });

function formatZone(
  row: {
    id: string;
    name: string;
    transport_fee: string;
    installation_fee: string;
    target_margin: string | null;
    minimum_margin: string | null;
    active: boolean;
    municipalities?: { id: string; name: string }[];
  },
  showCosts: boolean,
) {
  const targetMargin = showCosts ? row.target_margin : null;
  const minimumMargin = showCosts ? row.minimum_margin : null;
  return {
    id: row.id,
    name: row.name,
    transportFee: row.transport_fee,
    installationFee: row.installation_fee,
    targetMargin,
    minimumMargin,
    transport_fee: row.transport_fee,
    installation_fee: row.installation_fee,
    target_margin: targetMargin,
    minimum_margin: minimumMargin,
    active: row.active,
    municipalities: row.municipalities ?? [],
  };
}

export async function listZones(token: string | null, page = 1, search = "") {
  pageSchema.parse({ page });
  return runAuthorized(token, "clients.read", false, async (db, scope) => {
    const actor = (
      await db.query<{ actor: ActorContext | null }>(
        "select app_private.actor() actor",
      )
    ).rows[0]?.actor;
    const showCosts = canReadCosts(actor);

    const result = await db.query(
      `select z.id, z.name, z.transport_fee::text, z.installation_fee::text,
              z.target_margin::text, z.minimum_margin::text, z.active,
              coalesce(json_agg(json_build_object('id', m.id, 'name', m.name)) filter (where m.id is not null), '[]') as municipalities
       from app.pricing_zones z
       left join app.zone_municipalities zm on zm.zone_id = z.id and zm.tenant_id = z.tenant_id
       left join app.municipalities m on m.id = zm.municipality_id
       where z.tenant_id = $1 and (z.name ilike $3)
       group by z.id
       order by z.name asc
       limit 200 offset $2`,
      [scope.tenantId, (page - 1) * 200, `%${search.trim()}%`],
    );
    return result.rows.map((r) => formatZone(r, showCosts));
  });
}

export async function createZone(token: string | null, input: unknown) {
  const data = createZoneSchema.parse(input);
  return runAuthorized(token, "zones.manage", true, async (db, scope) => {
    const actor = (
      await db.query<{ actor: ActorContext | null }>(
        "select app_private.actor() actor",
      )
    ).rows[0]?.actor;
    const showCosts = canReadCosts(actor);

    const result = await db.query(
      `insert into app.pricing_zones (
         tenant_id, name, transport_fee, installation_fee, target_margin, minimum_margin, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $7)
       returning id, name, transport_fee::text, installation_fee::text, target_margin::text, minimum_margin::text, active`,
      [
        scope.tenantId,
        data.name,
        data.transportFee,
        data.installationFee,
        data.targetMargin,
        data.minimumMargin,
        scope.userId,
      ],
    );
    return formatZone(result.rows[0], showCosts);
  });
}

export async function updateZone(
  token: string | null,
  zoneId: string,
  input: unknown,
) {
  z.uuid().parse(zoneId);
  const data = updateZoneSchema.parse(input);
  return runAuthorized(token, "zones.manage", true, async (db, scope) => {
    const actor = (
      await db.query<{ actor: ActorContext | null }>(
        "select app_private.actor() actor",
      )
    ).rows[0]?.actor;
    const showCosts = canReadCosts(actor);

    const current = (
      await db.query(
        "select id, target_margin, minimum_margin from app.pricing_zones where id = $1 and tenant_id = $2 for update",
        [zoneId, scope.tenantId],
      )
    ).rows[0];
    if (!current) throw new AppError("NOT_FOUND");

    const target = data.targetMargin ?? current.target_margin;
    const min = data.minimumMargin ?? current.minimum_margin;
    if (Number(min) > Number(target)) {
      throw new AppError("VALIDATION_ERROR");
    }

    const result = await db.query(
      `update app.pricing_zones
       set name = coalesce($1, name),
           transport_fee = coalesce($2, transport_fee),
           installation_fee = coalesce($3, installation_fee),
           target_margin = coalesce($4, target_margin),
           minimum_margin = coalesce($5, minimum_margin),
           active = coalesce($6, active),
           updated_at = now(),
           updated_by = $7
       where id = $8 and tenant_id = $9
       returning id, name, transport_fee::text, installation_fee::text, target_margin::text, minimum_margin::text, active`,
      [
        data.name ?? null,
        data.transportFee ?? null,
        data.installationFee ?? null,
        data.targetMargin ?? null,
        data.minimumMargin ?? null,
        data.active ?? null,
        scope.userId,
        zoneId,
        scope.tenantId,
      ],
    );
    return formatZone(result.rows[0], showCosts);
  });
}

export async function assignMunicipality(
  token: string | null,
  zoneId: string,
  municipalityId: string,
) {
  z.uuid().parse(zoneId);
  const muni = z.string().regex(/^\d{5}$/).parse(municipalityId);
  return runAuthorized(token, "zones.manage", true, async (db, scope) => {
    const zoneExists = (
      await db.query(
        "select id from app.pricing_zones where id = $1 and tenant_id = $2",
        [zoneId, scope.tenantId],
      )
    ).rowCount;
    if (!zoneExists) throw new AppError("NOT_FOUND");

    const muniExists = (
      await db.query("select id from app.municipalities where id = $1", [muni])
    ).rowCount;
    if (!muniExists) throw new AppError("NOT_FOUND");

    await db.query(
      `insert into app.zone_municipalities (tenant_id, zone_id, municipality_id, created_by)
       values ($1, $2, $3, $4)
       on conflict (tenant_id, municipality_id)
       do update set zone_id = excluded.zone_id, created_by = excluded.created_by, created_at = now()`,
      [scope.tenantId, zoneId, muni, scope.userId],
    );
    return { assigned: true, zoneId, municipalityId: muni };
  });
}

export async function removeMunicipality(
  token: string | null,
  zoneId: string,
  municipalityId: string,
) {
  z.uuid().parse(zoneId);
  const muni = z.string().regex(/^\d{5}$/).parse(municipalityId);
  return runAuthorized(token, "zones.manage", true, async (db, scope) => {
    const deleted = (
      await db.query(
        "delete from app.zone_municipalities where tenant_id = $1 and zone_id = $2 and municipality_id = $3 returning zone_id",
        [scope.tenantId, zoneId, muni],
      )
    ).rowCount;
    if (!deleted) throw new AppError("NOT_FOUND");
    return { removed: true, zoneId, municipalityId: muni };
  });
}
