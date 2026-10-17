import "server-only";
import { z } from "zod";
import { runAuthorized, pageSchema } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";
import { canReadCosts, type ActorContext } from "../../identity/server/authorization";
import { canonicalMoneySchema } from "../../../shared/contracts/money";

const kindSchema = z.enum(["CABIN", "ACCESSORY", "MATERIAL"]);
const pricingMethodSchema = z.enum(["CATALOG_PRICE", "COST_MARGIN"]);
const skuSchema = z.string().trim().min(1).max(60);
const nameSchema = z.string().trim().min(1).max(160);
const descSchema = z.string().trim().max(1000).optional();
export const moneySchema = canonicalMoneySchema;
export const taxRateSchema = z.preprocess((val) => {
  if (typeof val === "number") return val.toString();
  if (typeof val === "string") return val.trim();
  return val;
}, z.string().regex(/^0(?:\.\d{1,6})?$/));

export const createProductSchema = z
  .object({
    kind: kindSchema,
    sku: skuSchema,
    name: nameSchema,
    description: descSchema,
    pricingMethod: pricingMethodSchema,
    baseCost: moneySchema.default("0.00"),
    listPrice: moneySchema.default("0.00"),
    taxRate: taxRateSchema.default("0.000000"),
  })
  .strict();

export const updateProductSchema = z
  .object({
    sku: skuSchema.optional(),
    name: nameSchema.optional(),
    description: descSchema.optional(),
    pricingMethod: pricingMethodSchema.optional(),
    baseCost: moneySchema.optional(),
    listPrice: moneySchema.optional(),
    taxRate: taxRateSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.keys(d).length > 0, {
    message: "Debe proporcionar al menos un campo para actualizar.",
  });

export { canReadCosts };

function formatProduct(
  row: {
    id: string;
    kind: "CABIN" | "ACCESSORY" | "MATERIAL";
    sku: string;
    name: string;
    description: string | null;
    pricing_method: "CATALOG_PRICE" | "COST_MARGIN";
    base_cost: string | null;
    list_price: string;
    tax_rate: string;
    active: boolean;
    created_at?: string;
  },
  showCosts: boolean,
) {
  const baseCost = showCosts ? row.base_cost : null;
  return {
    id: row.id,
    kind: row.kind,
    sku: row.sku,
    name: row.name,
    description: row.description,
    pricingMethod: row.pricing_method,
    baseCost,
    base_cost: baseCost,
    listPrice: row.list_price,
    taxRate: row.tax_rate,
    active: row.active,
    ...(row.created_at ? { createdAt: row.created_at } : {}),
  };
}

export async function listProducts(
  token: string | null,
  options: { page?: number; kind?: string; search?: string } = {},
) {
  const page = pageSchema.parse({ page: options.page }).page;
  const kind = options.kind
    ? kindSchema.parse(options.kind)
    : undefined;

  return runAuthorized(token, "catalog.read", false, async (db, scope) => {
    const actor = (
      await db.query<{ actor: ActorContext | null }>(
        "select app_private.actor() actor",
      )
    ).rows[0]?.actor;
    const showCosts = canReadCosts(actor);

    const params: unknown[] = [scope.tenantId, (page - 1) * 200];
    let query = `select id, kind, sku, name, description, pricing_method,
                        ${showCosts ? "base_cost::text" : "null as base_cost"},
                        list_price::text, tax_rate::text, active, created_at
                 from app.catalog_products
                 where tenant_id = $1`;
    if (kind) {
      params.push(kind);
      query += ` and kind = $${params.length}`;
    }
    if (options.search?.trim()) { params.push(`%${options.search.trim()}%`); query += ` and (name ilike $${params.length} or sku ilike $${params.length})`; }
    query += ` order by kind asc, name asc, id asc limit 200 offset $2`;

    const result = await db.query(query, params);
    return result.rows.map((row) => formatProduct(row, showCosts));
  });
}

export async function createProduct(token: string | null, input: unknown) {
  const data = createProductSchema.parse(input);
  return runAuthorized(token, "catalog.manage", true, async (db, scope) => {
    const actor = (
      await db.query<{ actor: ActorContext | null }>(
        "select app_private.actor() actor",
      )
    ).rows[0]?.actor;
    const showCosts = canReadCosts(actor);

    const result = await db.query(
      `insert into app.catalog_products (
         tenant_id, kind, sku, name, description, pricing_method,
         base_cost, list_price, tax_rate, created_by, updated_by
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       returning id, kind, sku, name, description, pricing_method,
                 base_cost::text, list_price::text, tax_rate::text, active, created_at`,
      [
        scope.tenantId,
        data.kind,
        data.sku,
        data.name,
        data.description ?? null,
        data.pricingMethod,
        data.baseCost,
        data.listPrice,
        data.taxRate,
        scope.userId,
      ],
    );
    return formatProduct(result.rows[0], showCosts);
  });
}

export async function updateProduct(
  token: string | null,
  productId: string,
  input: unknown,
) {
  z.uuid().parse(productId);
  const data = updateProductSchema.parse(input);
  return runAuthorized(token, "catalog.manage", true, async (db, scope) => {
    const actor = (
      await db.query<{ actor: ActorContext | null }>(
        "select app_private.actor() actor",
      )
    ).rows[0]?.actor;
    const showCosts = canReadCosts(actor);

    const result = await db.query(
      `update app.catalog_products
       set sku = coalesce($1, sku),
           name = coalesce($2, name),
           description = coalesce($3, description),
           pricing_method = coalesce($4, pricing_method),
           base_cost = coalesce($5, base_cost),
           list_price = coalesce($6, list_price),
           tax_rate = coalesce($7, tax_rate),
           active = coalesce($8, active),
           updated_at = now(),
           updated_by = $9
       where id = $10 and tenant_id = $11
       returning id, kind, sku, name, description, pricing_method,
                 base_cost::text, list_price::text, tax_rate::text, active, created_at`,
      [
        data.sku ?? null,
        data.name ?? null,
        data.description ?? null,
        data.pricingMethod ?? null,
        data.baseCost ?? null,
        data.listPrice ?? null,
        data.taxRate ?? null,
        data.active ?? null,
        scope.userId,
        productId,
        scope.tenantId,
      ],
    );
    if (!result.rowCount) throw new AppError("NOT_FOUND");
    return formatProduct(result.rows[0], showCosts);
  });
}
