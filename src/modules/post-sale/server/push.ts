import "server-only";
import { pushConfiguration, validPushEndpoint, sendPush } from "../../../shared/server/push-transport.mjs";
import { z } from "zod";
import type pg from "pg";
import { runAuthorized } from "../../platform/server/service";
import { AppError } from "../../../shared/server/app-error";

export const subscribePushSchema = z.object({
  endpoint: z.string().url("URL de endpoint inválida").refine(validPushEndpoint, "Proveedor push no compatible"),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]+$/).refine((v) => Buffer.from(v, "base64url").length === 65),
    auth: z.string().regex(/^[A-Za-z0-9_-]+$/).refine((v) => Buffer.from(v, "base64url").length === 16),
  }),
  userAgent: z.string().optional(),
});

export const unsubscribePushSchema = z.object({
  endpoint: z.string().url("URL de endpoint inválida"),
});

export const testPushSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  message: z.string().min(1).max(500).optional(),
});

export interface WebPushSubscriptionRecord {
  id: string;
  tenantId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  createdAt: string;
  updatedAt: string;
}

export async function subscribePush(
  token: string | null,
  rawInput: unknown,
): Promise<{ success: boolean; subscriptionId: string }> {
  const input = subscribePushSchema.parse(rawInput);
  if (!pushConfiguration()) throw new AppError("VALIDATION_ERROR", "Push no configurado; el centro interno sigue disponible.");

  return runAuthorized(token, "notifications.read", true, async (db, scope) => {
    if (scope.platformRole === "TENANT" && scope.subscriptionMode === "READ_ONLY") throw new AppError("SUBSCRIPTION_READ_ONLY");
    if (!scope.tenantId || !scope.userId) {
      throw new AppError("FORBIDDEN", "La suscripción a push requiere un usuario autenticado de empresa.");
    }

    const insRes = await db.query<{ id: string }>(
      `insert into app.web_push_subscriptions(
         tenant_id, user_id, endpoint, p256dh, auth, user_agent, updated_at
       ) values ($1, $2, $3, $4, $5, $6, now())
       on conflict (tenant_id, user_id, endpoint)
       do update set p256dh = $4, auth = $5, user_agent = $6, updated_at = now()
       returning id`,
      [
        scope.tenantId,
        scope.userId,
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
        input.userAgent ?? null,
      ],
    );

    return {
      success: true,
      subscriptionId: insRes.rows[0]!.id,
    };
  });
}

export async function unsubscribePush(
  token: string | null,
  rawInput: unknown,
): Promise<{ success: boolean; unsubscribed: boolean }> {
  const input = unsubscribePushSchema.parse(rawInput);

  return runAuthorized(token, "notifications.read", true, async (db, scope) => {
    if (scope.platformRole === "TENANT" && scope.subscriptionMode === "READ_ONLY") throw new AppError("SUBSCRIPTION_READ_ONLY");
    if (!scope.tenantId || !scope.userId) {
      throw new AppError("FORBIDDEN");
    }

    const delRes = await db.query(
      `delete from app.web_push_subscriptions
       where tenant_id = $1 and user_id = $2 and endpoint = $3`,
      [scope.tenantId, scope.userId, input.endpoint],
    );

    return {
      success: true,
      unsubscribed: (delRes.rowCount ?? 0) > 0,
    };
  });
}

export async function getPushSubscriptionStatus(
  token: string | null,
): Promise<{
  activeSubscriptionsCount: number;
  serverConfigured: boolean; publicKey?: string;
}> {
  return runAuthorized(token, "notifications.read", false, async (db, scope) => {
    if (!scope.tenantId || !scope.userId) {
      return { activeSubscriptionsCount: 0, serverConfigured: false };
    }

    const countRes = await db.query<{ count: string }>(
      `select count(*)::text as count
       from app.web_push_subscriptions
       where tenant_id = $1 and user_id = $2`,
      [scope.tenantId, scope.userId],
    );

    return {
      activeSubscriptionsCount: parseInt(countRes.rows[0]?.count || "0", 10),
      serverConfigured: !!pushConfiguration(), publicKey: pushConfiguration()?.publicKey,
    };
  });
}

export async function sendTestPushNotification(
  token: string | null,
  rawInput: unknown,
): Promise<{
  success: boolean;
  deliveredTo: number;
  message: string;
}> {
  const input = testPushSchema.parse(rawInput ?? {});

  return runAuthorized(token, "notifications.read", true, async (db, scope) => {
    if (scope.platformRole === "TENANT" && scope.subscriptionMode === "READ_ONLY") throw new AppError("SUBSCRIPTION_READ_ONLY");
    if (!scope.tenantId || !scope.userId) {
      throw new AppError("FORBIDDEN");
    }

    const subsRes = await db.query<WebPushSubscriptionRecord>(
      `select id, tenant_id as "tenantId", user_id as "userId", endpoint, p256dh, auth,
              created_at as "createdAt", updated_at as "updatedAt"
       from app.web_push_subscriptions
       where tenant_id = $1 and user_id = $2`,
      [scope.tenantId, scope.userId],
    );

    const title = input.title ?? "Tibelio SaaS — Notificación Push Real";
    const body = input.message ?? "Alerta operativa de prueba entregada satisfactoriamente.";

    // Guardar también en el centro interno como fallback persistente (F6-02)
    await db.query(
      `insert into app.internal_notifications(
         tenant_id, event_type, title, message, reference_type, reference_id, dedup_key
       ) values ($1, 'STOCK_ALERT', $2, $3, null, null, $4)
       on conflict (tenant_id, dedup_key) do nothing`,
      [scope.tenantId, title, body, `push_test_${Date.now()}`],
    );

    const results = await Promise.all(subsRes.rows.map((s) => sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })));
    const accepted = results.filter((r) => r.accepted).length;
    return { success: accepted > 0, deliveredTo: accepted, message: `Proveedor aceptó ${accepted} envío(s). Consulta el centro interno si no recibes el aviso.` };
  });
}

/**
 * Despacha notificaciones a los dispositivos suscritos de una empresa.
 * Se invoca cuando se generan alertas críticas o novedades bloqueantes.
 */
export async function dispatchPushToTenantUsers(
  db: pg.PoolClient,
  tenantId: string,
  title: string,
  message: string,
): Promise<number> {
  void title; void message;
  const subs = await db.query<WebPushSubscriptionRecord>("select endpoint, p256dh, auth from app.web_push_subscriptions where tenant_id = $1", [tenantId]);
  const results = await Promise.all(subs.rows.map((s) => sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })));
  return results.filter((r) => r.accepted).length;
}
