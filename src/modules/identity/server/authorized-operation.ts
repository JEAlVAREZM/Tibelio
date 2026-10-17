import "server-only";
import type { OperationResult } from "../../../shared/contracts/result";
import {
  authorize,
  type AccessRequest,
  type AuthorizedScope,
} from "./authorization";

/** No cache: load fresh identity/permissions for every operation. The resolver must
 * authenticate the session; never implement it by reading tenant/role headers or body.
 * Mutations must recheck persisted guards inside their database transaction.
 */
export async function executeAuthorized<T>(options: {
  loadActor: () => Promise<unknown>;
  access: AccessRequest;
  operation: (scope: AuthorizedScope) => Promise<T>;
  traceId: string;
  now?: () => Date;
}): Promise<OperationResult<T>> {
  try {
    const actor = await options.loadActor();
    const decision = authorize(
      actor,
      options.access,
      (options.now ?? (() => new Date()))(),
    );
    if (!decision.ok) return { ...decision, traceId: options.traceId };
    return {
      ok: true,
      data: await options.operation(decision.scope),
      traceId: options.traceId,
    };
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_ERROR" },
      traceId: options.traceId,
    };
  }
}
