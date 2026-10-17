import "server-only";
import { AppError } from "./app-error";
export function assertSameOrigin(
  request: Request,
  types = ["application/json"],
) {
  const configured = process.env.APP_ORIGIN ?? "http://127.0.0.1:3000";
  if (
    request.headers.get("origin") !== new URL(configured).origin ||
    request.headers.get("sec-fetch-site") === "cross-site" ||
    !types.includes(
      request.headers.get("content-type")?.split(";")[0]?.trim() ?? "",
    )
  )
    throw new AppError("FORBIDDEN");
}
export async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse((await readBoundedBody(request, 16384)).toString("utf8"));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION_ERROR");
  }
}
export async function readBoundedBody(
  request: Request,
  maximum: number,
): Promise<Buffer> {
  if (!request.body) throw new AppError("VALIDATION_ERROR");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new AppError("VALIDATION_ERROR");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION_ERROR");
  } finally {
    reader.releaseLock();
  }
}
