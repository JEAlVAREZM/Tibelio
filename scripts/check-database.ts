import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { checkDevDatabase } from "../src/shared/server/database";
import { ConfigurationError } from "../src/shared/server/config";

if (existsSync(".env.local")) loadEnvFile(".env.local");
try {
  await checkDevDatabase(process.env);
  console.log("Supabase DEV: conexión TLS y rol restringido verificados; sin escrituras.");
} catch (error) {
  console.error(error instanceof ConfigurationError ? error.message
    : "No se pudo verificar Supabase DEV. Revisa red, certificado, credenciales y privilegios del rol.");
  process.exitCode = 1;
}

