export type ErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "TENANT_MISMATCH" | "SUBSCRIPTION_READ_ONLY"
  | "INVALID_TRANSITION" | "CONFLICT_STOCK" | "PAYMENT_NOT_VALIDATED"
  | "VALIDATION_ERROR" | "NOT_FOUND" | "INTERNAL_ERROR" | "CONFLICT" | "RATE_LIMITED";

export type OperationResult<T> =
  | { ok: true; data: T; traceId: string }
  | { ok: false; error: { code: ErrorCode; message?: string; field?: string }; traceId: string };
