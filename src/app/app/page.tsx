import {
  requirePageSession,
  pageReadOnly,
} from "../../modules/identity/server/page-session";
import { AdminWorkspace } from "../workspace";
export const dynamic = "force-dynamic";
export default async function TenantPage() {
  const actor = await requirePageSession("TENANT");
  return (
    <AdminWorkspace
      platform={false}
      administrator={
        actor.platformRole === "TENANT" && actor.authority === "ADMIN"
      }
      readOnly={pageReadOnly(actor)}
      actor={actor}
    />
  );
}
