import "server-only";
import { runAuthorized } from "../../platform/server/service";

export type Municipality = {
  id: string;
  departmentCode: string;
  departmentName: string;
  name: string;
};

export async function listMunicipalities(token: string | null) {
  return runAuthorized(token, "clients.read", false, async (db) => {
    const result = await db.query<{
      id: string;
      department_code: string;
      department_name: string;
      name: string;
    }>(
      "select id, department_code, department_name, name from app.municipalities order by name asc",
    );
    return result.rows.map((row) => ({
      id: row.id,
      departmentCode: row.department_code,
      departmentName: row.department_name,
      name: row.name,
    }));
  });
}
