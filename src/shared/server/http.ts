import "server-only";
import type { ErrorCode, OperationResult } from "../contracts/result";

const errors: Record<ErrorCode, { status: number; message: string }> = {
  UNAUTHENTICATED: { status: 401, message: "Autenticación requerida." },
  FORBIDDEN: { status: 403, message: "Acceso denegado." },
  TENANT_MISMATCH: { status: 404, message: "Recurso no encontrado." },
  SUBSCRIPTION_READ_ONLY: { status: 403, message: "Operación no permitida en modo de solo lectura." },
  INVALID_TRANSITION: { status: 409, message: "Transición no permitida." },
  CONFLICT_STOCK: { status: 409, message: "Existencias insuficientes." },
  PAYMENT_NOT_VALIDATED: { status: 409, message: "Pago pendiente de validación." },
  VALIDATION_ERROR: { status: 422, message: "Datos inválidos." },
  NOT_FOUND: { status: 404, message: "Recurso no encontrado." },
  INTERNAL_ERROR: { status: 500, message: "No se pudo completar la operación." },
  CONFLICT: { status: 409, message: "La operación entra en conflicto con el estado actual. Revisa cupos, usuarios o referencias duplicadas." },
  RATE_LIMITED: { status: 429, message: "Demasiados intentos. Intenta nuevamente en diez minutos." },
};

export function toHttpResponse<T>(result: OperationResult<T>): Response {
  const headers = { "Cache-Control": "no-store", "X-Request-Id": result.traceId };
  if (result.ok) return Response.json({ data: result.data }, { headers });
  const { status, message: defaultMessage } = errors[result.error.code];
  // No serializar excepciones, mensajes de drivers o detalles internos.
  const code = result.error.code === "TENANT_MISMATCH" ? "NOT_FOUND" : result.error.code;
  const message =
    result.error.code === "INTERNAL_ERROR"
      ? defaultMessage
      : (result.error.message ?? defaultMessage);
  const field =
    result.error.code === "VALIDATION_ERROR" && result.error.field
      ? { field: result.error.field }
      : {};
  return Response.json({ error: { code, message, ...field }, requestId: result.traceId }, { status, headers });
}
