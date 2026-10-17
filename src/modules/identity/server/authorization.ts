import "server-only";
import { z } from "zod";
import type { ErrorCode } from "../../../shared/contracts/result";

// Technical convention: expiry is an exclusive UTC instant; grace is 7 x 24h.
export const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

const identity = { userId: z.uuid(), active: z.boolean() };
const actorSchema = z.discriminatedUnion("platformRole", [
  z
    .object({
      ...identity,
      platformRole: z.literal("SUPERADMIN"),
      tenantId: z.null(),
    })
    .strict(),
  z
    .object({
      ...identity,
      platformRole: z.literal("TENANT"),
      tenantId: z.uuid(),
      tenantActive: z.boolean(),
      // Immutable authority from persisted identity, never a customizable role name.
      authority: z.enum(["ADMIN", "MEMBER"]),
      subscriptionExpiresAt: z
        .number()
        .int()
        .min(0)
        .max(8_640_000_000_000_000 - GRACE_PERIOD_MS),
      rolePermissions: z.array(z.string()),
      grants: z.array(z.string()),
      denials: z.array(z.string()),
    })
    .strict(),
]);

export type ActorContext = z.infer<typeof actorSchema>;

// The server chooses a registered action; HTTP methods/inputs cannot redefine it.
const tenantActions = {
  "audit.read": { mutation: false, adminOnly: true },
  "users.read": { mutation: false, adminOnly: true },
  "users.create": { mutation: true, adminOnly: true },
  "users.update": { mutation: true, adminOnly: true },
  "roles.manage": { mutation: true, adminOnly: true },
  "permissions.manage": { mutation: true, adminOnly: true },
  "clients.read": { mutation: false, adminOnly: false },
  "clients.create": { mutation: true, adminOnly: false },
  "clients.update": { mutation: true, adminOnly: false },
  "catalog.read": { mutation: false, adminOnly: false },
  "catalog.manage": { mutation: true, adminOnly: true },
  "zones.manage": { mutation: true, adminOnly: true },
  "costs.read": { mutation: false, adminOnly: false },
  "requests.read": { mutation: false, adminOnly: false },
  "requests.create": { mutation: true, adminOnly: false },
  "requests.update": { mutation: true, adminOnly: false },
  "quotations.read": { mutation: false, adminOnly: false },
  "quotations.create": { mutation: true, adminOnly: false },
  "quotations.update": { mutation: true, adminOnly: false },
  "quotations.approve": { mutation: true, adminOnly: false },
  "quotations.authorize": { mutation: true, adminOnly: false },
  "adjustments.create": { mutation: true, adminOnly: false },
  "adjustments.authorize": { mutation: true, adminOnly: false },
  "settings.manage": { mutation: true, adminOnly: true },
  "suppliers.read": { mutation: false, adminOnly: false },
  "suppliers.manage": { mutation: true, adminOnly: false },
  "procurement.read": { mutation: false, adminOnly: false },
  "procurement.review": { mutation: true, adminOnly: false },
  "procurement.orders": { mutation: true, adminOnly: false },
  "procurement.receive": { mutation: true, adminOnly: false },
  "inventory.read": { mutation: false, adminOnly: false },
  "inventory.manage": { mutation: true, adminOnly: false },
  "inventory.dispatch": { mutation: true, adminOnly: false },
  "payments.read": { mutation: false, adminOnly: false },
  "payments.create": { mutation: true, adminOnly: false },
  "payments.validate": { mutation: true, adminOnly: false },
  "finance.refund": { mutation: true, adminOnly: false },
  "field.read": { mutation: false, adminOnly: false },
  "field.manage": { mutation: true, adminOnly: false },
  "field.execute": { mutation: true, adminOnly: false },
  "costs.manage": { mutation: true, adminOnly: false },
  "warranties.read": { mutation: false, adminOnly: false },
  "warranties.manage": { mutation: true, adminOnly: false },
  "issues.read": { mutation: false, adminOnly: false },
  "issues.manage": { mutation: true, adminOnly: false },
  "reports.read": { mutation: false, adminOnly: false },
  "notifications.read": { mutation: false, adminOnly: false },
  "notifications.manage": { mutation: true, adminOnly: false },
} as const;

const platformActions = new Set([
  "platform.tenants.read",
  "platform.tenants.create",
  "platform.tenants.update",
  "platform.subscriptions.read",
  "platform.subscriptions.update",
  "platform.seats.change",
]);

export type AuthorizedScope = Readonly<
  | { userId: string; platformRole: "SUPERADMIN"; tenantId: null }
  | {
      userId: string;
      platformRole: "TENANT";
      tenantId: string;
      subscriptionMode: "ACTIVE" | "GRACE" | "READ_ONLY";
    }
>;
export type AuthorizationDecision =
  | { ok: true; scope: AuthorizedScope }
  | { ok: false; error: { code: ErrorCode } };

export type AccessRequest = Readonly<{
  action: string;
  resourceTenantId?: string;
}>;
const deny = (code: ErrorCode): AuthorizationDecision => ({
  ok: false,
  error: { code },
});

/** Only pass identity loaded by the server from a verified session and current DB state.
 * Schema validation is NOT authentication. resourceTenantId must come from the repository.
 */
export function authorize(
  actor: unknown,
  request: AccessRequest,
  now: Date,
): AuthorizationDecision {
  if (actor == null) return deny("UNAUTHENTICATED");
  const parsed = actorSchema.safeParse(actor);
  if (!parsed.success || !parsed.data.active) return deny("FORBIDDEN");
  const current = parsed.data;
  if (platformActions.has(request.action)) {
    if (
      current.platformRole !== "SUPERADMIN" ||
      request.resourceTenantId !== undefined
    )
      return deny("FORBIDDEN");
    return {
      ok: true,
      scope: Object.freeze({
        userId: current.userId,
        platformRole: "SUPERADMIN",
        tenantId: null,
      }),
    };
  }
  if (
    !Object.hasOwn(tenantActions, request.action) ||
    current.platformRole !== "TENANT"
  )
    return deny("FORBIDDEN");
  if (
    request.resourceTenantId !== undefined &&
    request.resourceTenantId !== current.tenantId
  )
    return deny("TENANT_MISMATCH");
  if (!current.tenantActive) return deny("FORBIDDEN");
  const instant = now.getTime();
  if (!Number.isFinite(instant) || instant < 0) return deny("FORBIDDEN");
  const mode =
    instant < current.subscriptionExpiresAt
      ? "ACTIVE"
      : instant < current.subscriptionExpiresAt + GRACE_PERIOD_MS
        ? "GRACE"
        : "READ_ONLY";
  const policy = tenantActions[request.action as keyof typeof tenantActions];
  const admin = current.authority === "ADMIN";
  if (mode === "READ_ONLY" && (!admin || policy.mutation))
    return deny("SUBSCRIPTION_READ_ONLY");
  // DEC-055 cannot be overridden by a grant or a custom role.
  if (policy.adminOnly && !admin) return deny("FORBIDDEN");
  if (current.denials.includes(request.action)) return deny("FORBIDDEN");
  if (
    !admin &&
    !current.grants.includes(request.action) &&
    !current.rolePermissions.includes(request.action)
  )
    return deny("FORBIDDEN");
  return {
    ok: true,
    scope: Object.freeze({
      userId: current.userId,
      platformRole: "TENANT",
      tenantId: current.tenantId,
      subscriptionMode: mode,
    }),
  };
}

export function canReadCosts(actor: ActorContext | null | undefined): boolean {
  if (!actor || actor.platformRole !== "TENANT") return false;
  if (actor.denials.includes("costs.read")) return false;
  return (
    actor.authority === "ADMIN" ||
    actor.grants.includes("costs.read") ||
    actor.rolePermissions.includes("costs.read")
  );
}
