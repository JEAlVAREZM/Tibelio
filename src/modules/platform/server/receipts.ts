import "server-only";
import { z } from "zod";
import { runAuthorized, pageSchema } from "./service";
import { AppError } from "../../../shared/server/app-error";
import {
  writeReceipt,
  readReceipt,
  RECEIPT_TYPES,
  receiptLimit,
} from "../../../shared/server/private-receipts";
import { readBoundedBody } from "../../../shared/server/request";

export async function attachReceipt(
  token: string,
  paymentId: string,
  request: Request,
) {
  z.uuid().parse(paymentId);
  // Authenticate before reading a potentially large body or touching the disk.
  await runAuthorized(
    token,
    "platform.subscriptions.update",
    false,
    async () => undefined,
  );
  const bytes = await readBoundedBody(request, receiptLimit());
  const declared =
    request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!RECEIPT_TYPES.includes(declared)) throw new AppError("VALIDATION_ERROR");
  return runAuthorized(
    token,
    "platform.subscriptions.update",
    true,
    async (db, scope) => {
      const payment = (
        await db.query(
          "select tenant_id from app.subscription_payments where id=$1",
          [paymentId],
        )
      ).rows[0];
      if (!payment) throw new AppError("NOT_FOUND");
      const file = await writeReceipt(bytes, declared);
      // Keep unreferenced private files on failure: a lost COMMIT acknowledgment
      // must never lead to deletion of an already committed receipt.
      await db.query(
        "insert into app.subscription_receipts(id,tenant_id,payment_id,mime,byte_size,sha256,created_by) values($1,$2,$3,$4,$5,$6,$7)",
        [
          file.id,
          payment.tenant_id,
          paymentId,
          file.mime,
          file.byteSize,
          file.sha256,
          scope.userId,
        ],
      );
      return { id: file.id };
    },
  );
}
export async function listReceipts(token: string, paymentId: string, page = 1) {
  z.uuid().parse(paymentId);
  pageSchema.parse({ page });
  return runAuthorized(
    token,
    "platform.subscriptions.read",
    false,
    async (db) => {
      if (
        !(
          await db.query(
            "select id from app.subscription_payments where id=$1",
            [paymentId],
          )
        ).rowCount
      )
        throw new AppError("NOT_FOUND");
      return (
        await db.query(
          "select id,mime,byte_size,created_at from app.subscription_receipts where payment_id=$1 order by created_at desc,id desc limit 200 offset $2",
          [paymentId, (page - 1) * 200],
        )
      ).rows;
    },
  );
}
export async function downloadReceipt(token: string, receiptId: string) {
  z.uuid().parse(receiptId);
  return runAuthorized(
    token,
    "platform.subscriptions.read",
    false,
    async (db) => {
      const record = (
        await db.query(
          "select id,mime,byte_size,sha256 from app.subscription_receipts where id=$1",
          [receiptId],
        )
      ).rows[0];
      if (!record) throw new AppError("NOT_FOUND");
      const bytes = await readReceipt(
        record.id,
        record.byte_size,
        record.sha256,
      );
      const extension =
        record.mime === "application/pdf"
          ? "pdf"
          : record.mime === "image/png"
            ? "png"
            : "jpg";
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="comprobante-${record.id}.${extension}"`,
          "Content-Length": String(bytes.length),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
        },
      });
    },
  );
}
