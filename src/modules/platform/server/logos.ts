import "server-only";
import { z } from "zod";
import { runAuthorized } from "./service";
import { AppError } from "../../../shared/server/app-error";
import {
  readReceipt,
  writeReceipt,
  receiptLimit,
} from "../../../shared/server/private-receipts";
import { readBoundedBody } from "../../../shared/server/request";
export async function uploadLogo(
  token: string,
  tenantId: string,
  request: Request,
) {
  z.uuid().parse(tenantId);
  await runAuthorized(
    token,
    "platform.tenants.update",
    false,
    async () => undefined,
  );
  const bytes = await readBoundedBody(request, receiptLimit());
  const type = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!["image/png", "image/jpeg"].includes(type))
    throw new AppError("VALIDATION_ERROR");
  return runAuthorized(
    token,
    "platform.tenants.update",
    true,
    async (db, scope) => {
      if (
        !(
          await db.query("select id from app.tenants where id=$1 for update", [
            tenantId,
          ])
        ).rowCount
      )
        throw new AppError("NOT_FOUND");
      const file = await writeReceipt(bytes, type, "tenant-logos");
      await db.query(
        "insert into app.tenant_logos(id,tenant_id,mime,byte_size,sha256,created_by) values($1,$2,$3,$4,$5,$6)",
        [
          file.id,
          tenantId,
          file.mime,
          file.byteSize,
          file.sha256,
          scope.userId,
        ],
      );
      await db.query(
        "update app.tenants set logo_id=$1,updated_at=now(),updated_by=$2 where id=$3",
        [file.id, scope.userId, tenantId],
      );
      return { id: file.id };
    },
  );
}
export async function downloadLogo(
  token: string,
  tenantId: string,
  platform: boolean,
) {
  z.uuid().parse(tenantId);
  return runAuthorized(
    token,
    platform ? "platform.tenants.read" : "users.read",
    false,
    async (db, scope) => {
      if (!platform && scope.tenantId !== tenantId)
        throw new AppError("NOT_FOUND");
      const file = (
        await db.query(
          "select l.id,l.mime,l.byte_size,l.sha256 from app.tenants t join app.tenant_logos l on l.tenant_id=t.id and l.id=t.logo_id where t.id=$1",
          [tenantId],
        )
      ).rows[0];
      if (!file) throw new AppError("NOT_FOUND");
      const bytes = await readReceipt(
        file.id,
        file.byte_size,
        file.sha256,
        "tenant-logos",
      );
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="logo.${file.mime === "image/png" ? "png" : "jpg"}"`,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    },
  );
}
