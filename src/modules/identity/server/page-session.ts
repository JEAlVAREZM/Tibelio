import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sessionActor, SESSION_COOKIE } from "./session";
import type { ActorContext } from "./authorization";
export const pageReadOnly = (actor: ActorContext) =>
  actor.platformRole === "TENANT" &&
  Date.now() >= actor.subscriptionExpiresAt + 604800000;
export async function requirePageSession(kind: "SUPERADMIN" | "TENANT") {
  const actor = await sessionActor(
    (await cookies()).get(SESSION_COOKIE)?.value ?? null,
  );
  if (!actor) redirect("/login");
  if (actor.platformRole !== kind)
    redirect(actor.platformRole === "SUPERADMIN" ? "/platform" : "/app");
  return actor;
}
