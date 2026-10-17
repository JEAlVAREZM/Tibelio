import "server-only";
import { z } from "zod";
import type pg from "pg";
import { transaction } from "../../../shared/server/store";
import { AppError } from "../../../shared/server/app-error";
import {
  authorize,
  type ActorContext,
  type AuthorizedScope,
} from "../../identity/server/authorization";
import {
  hashPassword,
  passwordSchema,
  usernameSchema,
} from "../../identity/server/session";

import { canonicalMoneySchema } from "../../../shared/contracts/money";

const id = z.uuid();
const text = z.string().trim().min(1).max(160);
export const amountSchema = canonicalMoneySchema;
const amount = amountSchema;
const permissions = z
  .array(
    z.enum([
      "audit.read",
      "users.read",
      "users.create",
      "users.update",
      "roles.manage",
      "permissions.manage",
      "clients.read",
      "clients.create",
      "clients.update",
      "catalog.read",
      "catalog.manage",
      "zones.manage",
      "costs.read",
      "requests.read",
      "requests.create",
      "requests.update",
      "quotations.read",
      "quotations.create",
      "quotations.update",
      "quotations.approve",
      "quotations.authorize",
      "adjustments.create",
      "adjustments.authorize",
      "settings.manage",
      "suppliers.read",
      "suppliers.manage",
      "procurement.read",
      "procurement.review",
      "procurement.orders",
      "procurement.receive",
      "inventory.read",
      "inventory.manage",
      "inventory.dispatch",
      "payments.read",
      "payments.create",
      "payments.validate",
      "finance.refund",
      "field.read",
      "field.manage",
      "field.execute",
      "costs.manage",
      "warranties.read",
      "warranties.manage",
      "issues.read",
      "issues.manage",
      "reports.read",
      "notifications.read",
      "notifications.manage",
    ]),
  )
  .max(100);
const userColumns =
  "id,username,display_name,email,authority,active,grants,denials";
export const pageSchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const pageOffset = (page: number) =>
  (pageSchema.parse({ page }).page - 1) * 200;
export async function runAuthorized<T>(
  token: string | null,
  action: string,
  write: boolean,
  operation: (db: pg.PoolClient, scope: AuthorizedScope) => Promise<T>,
) {
  return transaction(
    token,
    async (db) => {
      const actor = (
        await db.query<{ actor: ActorContext | null }>(
          "select app_private.actor() actor",
        )
      ).rows[0]?.actor;
      const initial = authorize(actor, { action }, new Date());
      if (!initial.ok) throw new AppError(initial.error.code);
      if (write && actor?.platformRole === "TENANT") {
        // Same lock as the seat and user triggers. Re-read authority after waiting.
        await db.query("select app_private.lock_tenant($1)", [actor.tenantId]);
      }
      const fresh = (
        await db.query<{ actor: ActorContext | null }>(
          "select app_private.actor() actor",
        )
      ).rows[0]?.actor;
      const decision = authorize(fresh, { action }, new Date());
      if (!decision.ok) throw new AppError(decision.error.code);
      return operation(db, decision.scope);
    },
    write,
  );
}
export async function listTenants(token: string | null, page = 1) {
  return runAuthorized(
    token,
    "platform.tenants.read",
    false,
    async (db) =>
      (
        await db.query(
          "select t.id,t.legal_name,t.tax_id,t.logo_id,t.active,s.seats,coalesce(u.active_users,0)::int active_users,s.expires_at,s.current_amount::text,s.next_amount::text,s.currency from app.tenants t join app.subscriptions s on s.tenant_id=t.id left join app_private.platform_usage() u on u.tenant_id=t.id order by t.created_at desc,t.id limit 200 offset $1",
          [pageOffset(page)],
        )
      ).rows,
  );
}
export async function listTiers(token: string | null, page = 1) {
  return runAuthorized(
    token,
    "platform.subscriptions.read",
    false,
    async (db) =>
      (
        await db.query(
          "select id,min_users,max_users,monthly_price::text,currency,active from app.tiers order by min_users,id limit 200 offset $1",
          [pageOffset(page)],
        )
      ).rows,
  );
}
export async function createTier(token: string | null, input: unknown) {
  const data = z
    .object({
      minUsers: z.number().int().positive(),
      maxUsers: z.number().int().positive(),
      monthlyPrice: amount,
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict()
    .refine((d) => d.maxUsers >= d.minUsers)
    .parse(input);
  return runAuthorized(
    token,
    "platform.subscriptions.update",
    true,
    async (db, scope) => {
      await db.query("lock table app.tiers in share row exclusive mode");
      if (
        (
          await db.query(
            "select id from app.tiers where active and currency=$1 and min_users<=$2 and max_users>=$3",
            [data.currency, data.maxUsers, data.minUsers],
          )
        ).rowCount
      )
        throw new AppError("CONFLICT");
      return (
        await db.query(
          "insert into app.tiers(min_users,max_users,monthly_price,currency,created_by) values($1,$2,$3,$4,$5) returning id",
          [
            data.minUsers,
            data.maxUsers,
            data.monthlyPrice,
            data.currency,
            scope.userId,
          ],
        )
      ).rows[0];
    },
  );
}
export async function listSubscriptionPayments(token: string | null, page = 1) {
  return runAuthorized(
    token,
    "platform.subscriptions.read",
    false,
    async (db) =>
      (
        await db.query(
          "select p.id,t.legal_name,p.amount::text,p.currency,p.reference,p.period_start,p.period_end,p.created_at,case when a.id is null then 'CONFIRMADO' else 'ANULADO' end status,coalesce(a.amount,0)::text correction_amount,(p.amount+coalesce(a.amount,0))::text net_amount,a.reason annulment_reason,a.created_at annulled_at,a.created_by annulled_by from app.subscription_payments p join app.tenants t on t.id=p.tenant_id left join app.subscription_annulments a on a.payment_id=p.id order by p.created_at desc,p.id limit 200 offset $1",
          [pageOffset(page)],
        )
      ).rows,
  );
}
export async function createTenant(token: string | null, input: unknown) {
  const data = z
    .object({
      legalName: text,
      taxId: text,
      seats: z.number().int().positive(),
      expiresAt: z.iso.datetime(),
      tierId: id,
      adminUsername: usernameSchema,
      adminName: text,
      adminPassword: passwordSchema,
    })
    .strict()
    .parse(input);
  const hash = await hashPassword(data.adminPassword);
  return runAuthorized(
    token,
    "platform.tenants.create",
    true,
    async (db) =>
      (
        await db.query(
          "select app_private.create_tenant($1,$2,$3,$4,$5,$6,$7,$8) id",
          [
            data.legalName,
            data.taxId,
            data.seats,
            data.expiresAt,
            data.tierId,
            data.adminUsername,
            data.adminName,
            hash,
          ],
        )
      ).rows[0],
  );
}
export async function updateTenant(
  token: string | null,
  tenantId: string,
  input: unknown,
) {
  id.parse(tenantId);
  const data = z
    .object({
      active: z.boolean().optional(),
      legalName: text.optional(),
      taxId: text.optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0)
    .parse(input);
  return runAuthorized(
    token,
    "platform.tenants.update",
    true,
    async (db, scope) => {
      const r = await db.query(
        "update app.tenants set active=coalesce($1,active),updated_at=now(),updated_by=$2,legal_name=coalesce($4,legal_name),tax_id=coalesce($5,tax_id) where id=$3 returning id",
        [
          data.active ?? null,
          scope.userId,
          tenantId,
          data.legalName ?? null,
          data.taxId ?? null,
        ],
      );
      if (!r.rowCount) throw new AppError("NOT_FOUND");
      return r.rows[0];
    },
  );
}
export async function changeSeats(
  token: string | null,
  tenantId: string,
  input: unknown,
) {
  id.parse(tenantId);
  const data = z
    .object({ seats: z.number().int().positive(), tierId: id })
    .strict()
    .parse(input);
  return runAuthorized(
    token,
    "platform.seats.change",
    true,
    async (db, scope) => {
      const old = (
        await db.query(
          "select seats,expires_at,currency from app.subscriptions where tenant_id=$1 for update",
          [tenantId],
        )
      ).rows[0];
      if (!old) throw new AppError("NOT_FOUND");
      const tier = (
        await db.query(
          "select monthly_price::text from app.tiers where id=$1 and active and currency=$2 and $3 between min_users and max_users",
          [data.tierId, old.currency, data.seats],
        )
      ).rows[0];
      if (!tier) throw new AppError("VALIDATION_ERROR");
      await db.query(
        "update app.subscriptions set seats=$1,next_amount=$2,updated_by=$3 where tenant_id=$4",
        [data.seats, tier.monthly_price, scope.userId, tenantId],
      );
      await db.query(
        "insert into app.seat_changes(tenant_id,old_seats,new_seats,next_amount,bill_from,created_by) values($1,$2,$3,$4,$5,$6)",
        [
          tenantId,
          old.seats,
          data.seats,
          tier.monthly_price,
          old.expires_at,
          scope.userId,
        ],
      );
      return {
        seats: data.seats,
        nextAmount: tier.monthly_price,
        billFrom: old.expires_at,
      };
    },
  );
}
export async function renewSubscription(token: string | null, input: unknown) {
  const data = z
    .object({
      tenantId: id,
      reference: text,
      amount,
      currency: z.string().regex(/^[A-Z]{3}$/),
      periodStart: z.iso.datetime(),
      periodEnd: z.iso.datetime(),
    })
    .strict()
    .refine((d) => Date.parse(d.periodEnd) > Date.parse(d.periodStart))
    .parse(input);
  return runAuthorized(
    token,
    "platform.subscriptions.update",
    true,
    async (db, scope) => {
      const sub = (
        await db.query(
          "select next_amount::text,currency,expires_at from app.subscriptions where tenant_id=$1 for update",
          [data.tenantId],
        )
      ).rows[0];
      if (!sub) throw new AppError("NOT_FOUND");
      if (
        data.currency !== sub.currency ||
        Date.parse(data.periodStart) < new Date(sub.expires_at).getTime() ||
        Date.parse(data.periodEnd) <= new Date(sub.expires_at).getTime()
      )
        throw new AppError("VALIDATION_ERROR");
      const matches = (
        await db.query("select $1::numeric=$2::numeric same", [
          data.amount,
          sub.next_amount,
        ])
      ).rows[0];
      if (!matches.same) throw new AppError("VALIDATION_ERROR");
      await db.query(
        "insert into app.subscription_payments(tenant_id,amount,currency,reference,period_start,period_end,created_by) values($1,$2,$3,$4,$5,$6,$7)",
        [
          data.tenantId,
          data.amount,
          data.currency,
          data.reference,
          data.periodStart,
          data.periodEnd,
          scope.userId,
        ],
      );
      await db.query(
        "update app.subscriptions set expires_at=$1,current_amount=next_amount,updated_by=$2 where tenant_id=$3",
        [data.periodEnd, scope.userId, data.tenantId],
      );
      return { renewed: true };
    },
  );
}
export async function listUsers(token: string | null, page = 1) {
  return runAuthorized(
    token,
    "users.read",
    false,
    async (db, scope) =>
      (
        await db.query(
          `select ${userColumns} from app.users where tenant_id=$1 order by username limit 200 offset $2`,
          [scope.tenantId, pageOffset(page)],
        )
      ).rows,
  );
}
export async function createUser(token: string | null, input: unknown) {
  const data = z
    .object({
      username: usernameSchema,
      displayName: text,
      email: z.email().optional(),
      password: passwordSchema,
      authority: z.enum(["ADMIN", "MEMBER"]),
    })
    .strict()
    .parse(input);
  const hash = await hashPassword(data.password);
  return runAuthorized(
    token,
    "users.create",
    true,
    async (db, scope) =>
      (
        await db.query(
          "insert into app.users(tenant_id,username,display_name,email,password_hash,platform_role,authority,created_by) values($1,$2,$3,$4,$5,'TENANT',$6,$7) returning id",
          [
            scope.tenantId,
            data.username,
            data.displayName,
            data.email ?? null,
            hash,
            data.authority,
            scope.userId,
          ],
        )
      ).rows[0],
  );
}
export async function updateUser(
  token: string | null,
  userId: string,
  input: unknown,
) {
  id.parse(userId);
  const data = z
    .object({
      active: z.boolean().optional(),
      displayName: text.optional(),
      authority: z.enum(["ADMIN", "MEMBER"]).optional(),
      password: passwordSchema.optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0)
    .parse(input);
  const hash = data.password ? await hashPassword(data.password) : null;
  return runAuthorized(token, "users.update", true, async (db, scope) => {
    const values: unknown[] = [
      data.active ?? null,
      data.displayName ?? null,
      data.authority ?? null,
      scope.userId,
      userId,
      scope.tenantId,
    ];
    if (hash) values.push(hash);
    const r = await db.query(
      `update app.users set active=coalesce($1,active),display_name=coalesce($2,display_name),authority=coalesce($3,authority),updated_by=$4${hash ? ",password_hash=$7" : ""} where id=$5 and tenant_id=$6 returning id`,
      values,
    );
    if (!r.rowCount) throw new AppError("NOT_FOUND");
    return r.rows[0];
  });
}
export async function listRoles(token: string | null, page = 1) {
  return runAuthorized(
    token,
    "users.read",
    false,
    async (db, scope) =>
      (
        await db.query(
          "select id,name,permissions from app.roles where tenant_id=$1 order by name,id limit 200 offset $2",
          [scope.tenantId, pageOffset(page)],
        )
      ).rows,
  );
}
export async function saveRole(token: string | null, input: unknown) {
  const data = z
    .object({ id: id.optional(), name: text, permissions })
    .strict()
    .parse(input);
  return runAuthorized(token, "roles.manage", true, async (db, scope) => {
    const r = data.id
      ? await db.query(
          "update app.roles set name=$1,permissions=$2,updated_at=now(),updated_by=$3 where id=$4 and tenant_id=$5 returning id",
          [data.name, data.permissions, scope.userId, data.id, scope.tenantId],
        )
      : await db.query(
          "insert into app.roles(tenant_id,name,permissions,created_by) values($1,$2,$3,$4) returning id",
          [scope.tenantId, data.name, data.permissions, scope.userId],
        );
    if (!r.rowCount) throw new AppError("NOT_FOUND");
    return r.rows[0];
  });
}
export async function setPermissions(
  token: string | null,
  userId: string,
  input: unknown,
) {
  id.parse(userId);
  const data = z
    .object({
      grants: permissions,
      denials: permissions,
      roleIds: z.array(id).max(20),
    })
    .strict()
    .parse(input);
  return runAuthorized(token, "permissions.manage", true, async (db, scope) => {
    const found = await db.query(
      "select id from app.users where id=$1 and tenant_id=$2",
      [userId, scope.tenantId],
    );
    if (!found.rowCount) throw new AppError("NOT_FOUND");
    await db.query(
      "delete from app.user_roles where user_id=$1 and tenant_id=$2",
      [userId, scope.tenantId],
    );
    for (const roleId of new Set(data.roleIds))
      await db.query(
        "insert into app.user_roles(tenant_id,user_id,role_id) values($1,$2,$3)",
        [scope.tenantId, userId, roleId],
      );
    await db.query(
      "update app.users set grants=$1,denials=$2,updated_by=$3 where id=$4 and tenant_id=$5",
      [data.grants, data.denials, scope.userId, userId, scope.tenantId],
    );
    return { updated: true };
  });
}
