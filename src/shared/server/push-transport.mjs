import webpush from "web-push";
import { createECDH } from "node:crypto";

export function pushConfiguration(env = process.env) {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  if (!publicKey || !privateKey || !subject) return null;
  try {
    const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.from(privateKey,"base64url"));
    if (key.getPublicKey().toString("base64url") !== publicKey) return null;
    webpush.generateRequestDetails({ endpoint: "https://fcm.googleapis.com/fcm/send/config-check", keys: { p256dh: publicKey, auth: Buffer.alloc(16).toString("base64url") } }, undefined, { vapidDetails: { publicKey, privateKey, subject } }); }
  catch { return null; }
  return { publicKey, privateKey, subject };
}

export function validPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.username && !u.password && !u.port &&
      ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(u.hostname);
  } catch { return false; }
}

/** Provider acceptance is distinct from display on a device. No business data in payloads. */
export async function sendPush(subscription, send = webpush.sendNotification.bind(webpush)) {
  const config = pushConfiguration();
  if (!config || !validPushEndpoint(subscription.endpoint)) return { accepted: false, expired: false };
  try {
    await send(subscription, JSON.stringify({ title: "Tibelio", body: "Tienes una nueva notificación. Ingresa para consultarla.", url: "/app" }),
      { vapidDetails: config, TTL: 300, timeout: 5000 });
    return { accepted: true, expired: false };
  } catch (err) { return { accepted: false, expired: err?.statusCode === 404 || err?.statusCode === 410 }; }
}
