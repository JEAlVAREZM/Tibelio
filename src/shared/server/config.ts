import "server-only";
import { z } from "zod";

export class ConfigurationError extends Error {
  constructor() { super("Configuración Supabase DEV ausente o inválida. Revisa .env.example."); }
}

const schema = z.object({
  APP_ENV: z.literal("development"),
  SUPABASE_DEV_PROJECT_REF: z.string().regex(/^[a-z0-9]{20}$/),
  DATABASE_URL: z.string().url(),
  DATABASE_CA_FILE: z.string().optional(),
});

export function readDevDatabaseConfig(env: Record<string, string | undefined>) {
  const result = schema.safeParse(env);
  if (!result.success) throw new ConfigurationError();
  const url = new URL(result.data.DATABASE_URL);
  const ref = result.data.SUPABASE_DEV_PROJECT_REF;
  const direct = url.hostname === `db.${ref}.supabase.co`;
  const pooled = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)
    && decodeURIComponent(url.username).endsWith(`.${ref}`);
  // No permitir opciones URI que sobreescriban TLS ni opciones de sesión arbitrarias.
  if (!(direct || pooled) || !["postgres:", "postgresql:"].includes(url.protocol)
    || (url.port !== "" && url.port !== "5432") || url.pathname !== "/postgres"
    || !url.username || !url.password || url.hash
    || [...url.searchParams].some(([key, value]) => key !== "sslmode" || value !== "verify-full")) {
    throw new ConfigurationError();
  }
  url.search = "";
  return { connectionString: url.toString(), caFile: result.data.DATABASE_CA_FILE || undefined };
}

export function readRuntimeDatabaseConfig(env: Record<string, string | undefined>) {
  if (env.APP_ENV !== "production") return readDevDatabaseConfig(env);
  const ref = env.SUPABASE_PROD_PROJECT_REF;
  if (!ref || ref === env.SUPABASE_DEV_PROJECT_REF) throw new ConfigurationError();
  const result = readDevDatabaseConfig({ ...env, APP_ENV: "development", SUPABASE_DEV_PROJECT_REF: ref });
  const user = new URL(result.connectionString).username.split(".")[0] ?? "";
  if (["postgres", "service_role", "supabase_admin"].includes(user)) throw new ConfigurationError();
  return result;
}
