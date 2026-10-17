import { randomUUID } from "node:crypto";
import { toHttpResponse } from "@/shared/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness únicamente: no afirma conectividad DB ni preparación productiva.
export function GET() {
  return toHttpResponse({ ok: true, data: { status: "ok" }, traceId: randomUUID() });
}

