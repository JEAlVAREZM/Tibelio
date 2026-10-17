import "server-only";
import type { ErrorCode } from "../contracts/result";
export class AppError extends Error {
  constructor(public readonly code: ErrorCode, message?: string) {
    super(message ?? code);
  }
}
