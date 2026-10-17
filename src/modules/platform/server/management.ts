import "server-only";
import { z } from "zod";
import { runAuthorized, amountSchema } from "./service";
import { AppError } from "../../../shared/server/app-error";

export async function annulSubscriptionPayment(
  token: string | null,
  paymentId: string,
  input: unknown,
) {
  z.uuid().parse(paymentId);
  const data = z
    .object({ reason: z.string().trim().min(1).max(1000) })
    .strict()
    .parse(input);
  return runAuthorized(
    token,
    "platform.subscriptions.update",
    true,
    async (db) => {
      const payment = (
        await db.query(
          "select tenant_id from app.subscription_payments where id=$1",
          [paymentId],
        )
      ).rows[0];
      if (!payment) throw new AppError("NOT_FOUND");
      // Trigger derives correction and actor from the immutable original/session.
      // A unique key arbitrates concurrent requests; no UPDATE/DELETE is granted.
      return (
        await db.query(
          "insert into app.subscription_annulments(tenant_id,payment_id,reason) values($1,$2,$3) returning id,amount::text,currency,created_at",
          [payment.tenant_id, paymentId, data.reason],
        )
      ).rows[0];
    },
  );
}
export async function updateTier(
  token: string | null,
  tierId: string,
  input: unknown,
) {
  z.uuid().parse(tierId);
  const data = z
    .object({
      monthlyPrice: amountSchema.optional(),
      active: z.boolean().optional(),
    })
    .strict()
    .refine((d) => Object.keys(d).length > 0)
    .parse(input);
  return runAuthorized(
    token,
    "platform.subscriptions.update",
    true,
    async (db, scope) => {
      await db.query("lock table app.tiers in share row exclusive mode");
      const tier = (
        await db.query(
          "select id,min_users,max_users,currency,active from app.tiers where id=$1",
          [tierId],
        )
      ).rows[0];
      if (!tier) throw new AppError("NOT_FOUND");
      if (
        (data.active ?? tier.active) &&
        (
          await db.query(
            "select id from app.tiers where active and id<>$1 and currency=$2 and min_users<=$3 and max_users>=$4",
            [tierId, tier.currency, tier.max_users, tier.min_users],
          )
        ).rowCount
      )
        throw new AppError("CONFLICT");
      return (
        await db.query(
          "update app.tiers set monthly_price=coalesce($1,monthly_price),active=coalesce($2,active),updated_by=$3,updated_at=now() where id=$4 returning id",
          [
            data.monthlyPrice ?? null,
            data.active ?? null,
            scope.userId,
            tierId,
          ],
        )
      ).rows[0];
    },
  );
}
export async function platformSummary(token: string | null) {
  return runAuthorized(token, "platform.tenants.read", false, async (db) => {
    const usage = (
      await db.query(
        "select count(*)::int companies,count(*) filter(where t.active)::int active_companies,coalesce(sum(s.seats),0)::text seats,count(*) filter(where t.active and s.expires_at>now())::int current,count(*) filter(where t.active and s.expires_at<=now() and s.expires_at+interval '7 days'>now())::int grace,count(*) filter(where t.active and s.expires_at+interval '7 days'<=now())::int read_only from app.tenants t join app.subscriptions s on s.tenant_id=t.id",
      )
    ).rows[0];
    const users = (
      await db.query(
        "select coalesce(sum(active_users),0)::text active_users from app_private.platform_usage()",
      )
    ).rows[0];
    const collections = (
      await db.query(
        "select p.currency,sum(p.amount)::text original,sum(coalesce(a.amount,0))::text corrections,sum(p.amount+coalesce(a.amount,0))::text net from app.subscription_payments p left join app.subscription_annulments a on a.payment_id=p.id group by p.currency order by p.currency",
      )
    ).rows;
    return { ...usage, ...users, collections };
  });
}
export async function companyProfile(token: string | null) {
  return runAuthorized(
    token,
    "users.read",
    false,
    async (db, scope) =>
      (
        await db.query(
          "select id,legal_name,tax_id,logo_id from app.tenants where id=$1",
          [scope.tenantId],
        )
      ).rows[0],
  );
}
