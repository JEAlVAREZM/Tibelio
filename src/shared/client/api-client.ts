/**
 * Cliente HTTP compartido del navegador para `/api/v1`.
 *
 * Contrato real del servidor (src/shared/server/http.ts):
 *   - éxito:  HTTP 2xx  { data: T }
 *   - fallo:  HTTP 4xx/5xx { error: { code, message, field? }, requestId }
 * No existe un campo `ok` en el cuerpo: el éxito se decide por el estado HTTP.
 */

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "SUBSCRIPTION_READ_ONLY"
  | "INVALID_TRANSITION"
  | "CONFLICT_STOCK"
  | "PAYMENT_NOT_VALIDATED"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "INTERNAL_ERROR"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "INVALID_RESPONSE";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly field?: string;
  readonly requestId?: string;
  constructor(
    message: string,
    code: ApiErrorCode,
    status: number,
    field?: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.field = field;
    this.requestId = requestId;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isForbidden(value: unknown): boolean {
  return isApiError(value) && (value.code === "FORBIDDEN" || value.status === 403);
}

const FALLBACK_MESSAGE = "No se pudo completar la operación.";

type ApiOptions = { fetcher?: typeof fetch; signal?: AbortSignal };

export async function apiRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options: ApiOptions = {},
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const mutating = method !== "GET" && method !== "HEAD";
  let response: Response;
  try {
    response = await fetcher(`/api/v1/${path.replace(/^\/+/, "")}`, {
      method,
      credentials: "same-origin",
      // El servidor exige application/json en toda mutación no binaria.
      headers: mutating ? { "Content-Type": "application/json" } : {},
      body: mutating ? JSON.stringify(body ?? {}) : undefined,
      signal: options.signal,
    });
  } catch {
    throw new ApiError(
      "No hay conexión con el servidor. Revisa tu red e inténtalo de nuevo.",
      "NETWORK_ERROR",
      0,
    );
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const error =
      payload && typeof payload === "object" && "error" in payload
        ? (payload as { error?: { code?: string; message?: string; field?: string }; requestId?: string })
        : null;
    throw new ApiError(
      error?.error?.message ?? FALLBACK_MESSAGE,
      (error?.error?.code as ApiErrorCode | undefined) ??
        (response.status === 403 ? "FORBIDDEN" : "INTERNAL_ERROR"),
      response.status,
      error?.error?.field,
      error?.requestId,
    );
  }

  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    // 2xx sin envoltura {data}: no se asume éxito silencioso ni fallo de negocio.
    throw new ApiError(
      "Respuesta inesperada del servidor. Recarga antes de reintentar para evitar duplicados.",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  return (payload as { data: T }).data;
}
