import { requirePageSession } from "../../modules/identity/server/page-session";
import { AdminWorkspace } from "../workspace";
export const dynamic = "force-dynamic";
export default async function PlatformPage() {
  await requirePageSession("SUPERADMIN");
  return <AdminWorkspace platform />;
}
