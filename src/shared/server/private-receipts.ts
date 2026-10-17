import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { z } from "zod";
import { AppError } from "./app-error";

export const RECEIPT_TYPES = ["application/pdf", "image/png", "image/jpeg"];
export function receiptLimit() {
  return z.coerce
    .number()
    .int()
    .min(1024)
    .max(20 * 1024 * 1024)
    .parse(process.env.RECEIPT_MAX_BYTES ?? 5 * 1024 * 1024);
}
export function receiptMime(bytes: Buffer): string {
  if (!bytes.length || bytes.length > receiptLimit())
    throw new AppError("VALIDATION_ERROR");
  if (
    bytes.subarray(0, 5).toString() === "%PDF-" &&
    bytes.subarray(-1024).includes(Buffer.from("%%EOF"))
  )
    return "application/pdf";
  if (
    bytes.length >= 45 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.subarray(12, 16).toString() === "IHDR" &&
    bytes.subarray(-8, -4).toString() === "IEND"
  )
    return "image/png";
  if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  )
    return "image/jpeg";
  throw new AppError("VALIDATION_ERROR");
}
type FileArea = "saas-receipts" | "tenant-logos" | "quotation-docs" | "client-payments" | "operational-closures" | "warranty-photos" | "issue-evidences" | "cost-vouchers";
async function receiptDirectory(area: FileArea) {
  const base = resolve(
    process.env.APP_ENV === "test"
      ? (process.env.TEST_PRIVATE_STORAGE_ROOT ?? ".local/test-private-storage")
      : (process.env.PRIVATE_STORAGE_ROOT ?? ".local/private-storage"),
  );
  const safe = (path: string) => {
    const rel = relative(path, process.cwd());
    if (
      (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) ||
      /(^|[\\/])(public|static|\.next)([\\/]|$)/i.test(path)
    )
      throw new Error("Private storage must be outside served directories");
  };
  safe(base);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(/* turbopackIgnore: true */ base);
  safe(root);
  if (!["saas-receipts", "tenant-logos", "quotation-docs", "client-payments", "operational-closures", "warranty-photos", "issue-evidences", "cost-vouchers"].includes(area))
    throw new Error("Invalid private file area");
  const folder = join(root, area);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  if ((await realpath(/* turbopackIgnore: true */ folder)) !== folder)
    throw new Error("Receipt directory cannot be a symbolic link");
  return folder;
}
export async function writeReceipt(
  bytes: Buffer,
  declaredType: string,
  area: FileArea = "saas-receipts",
) {
  const mime = receiptMime(bytes);
  if (mime !== declaredType) throw new AppError("VALIDATION_ERROR");
  const id = randomUUID();
  // User files belong to the runtime volume, never to the deployment bundle.
  const path = join(
    /* turbopackIgnore: true */ await receiptDirectory(area),
    id,
  );
  const file = await open(/* turbopackIgnore: true */ path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return {
    id,
    mime,
    byteSize: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export async function readReceipt(
  id: string,
  byteSize: number,
  sha256: string,
  area: FileArea = "saas-receipts",
) {
  z.uuid().parse(id);
  const filePath = join(
    /* turbopackIgnore: true */ await receiptDirectory(area),
    id,
  );
  try {
    if ((await realpath(/* turbopackIgnore: true */ filePath)) !== filePath)
      throw new Error("Invalid storage link");
    const file = await open(/* turbopackIgnore: true */ filePath, "r");
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size !== byteSize ||
        stat.size > 20 * 1024 * 1024
      )
        throw new Error("Receipt size mismatch");
      const bytes = await file.readFile();
      if (createHash("sha256").update(bytes).digest("hex") !== sha256)
        throw new Error("Receipt checksum mismatch");
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      throw new AppError("NOT_FOUND");
    throw error;
  }
}
