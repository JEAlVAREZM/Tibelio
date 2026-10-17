import argon2 from "argon2";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";

// Invoked interactively through PowerShell. Never accepts a password in argv/env,
// never connects to a database, and never prints a password or its hash.
try {
  const reset = process.argv.includes("--reset");
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
    if (source.length > 4096) throw new Error("Entrada excesiva");
  }
  const fields = {
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
    password: z.string().min(12).max(128),
  };
  const schema = reset
    ? z
        .object({ ...fields, confirmPassword: z.string() })
        .strict()
        .refine((d) => d.password === d.confirmPassword)
    : z
        .object({ ...fields, displayName: z.string().trim().min(1).max(160) })
        .strict();
  const data = schema.parse(JSON.parse(source));
  source = "";
  const hash = await argon2.hash(data.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  data.password = "";
  if ("confirmPassword" in data) data.confirmPassword = "";
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const sql = reset
    ? `-- PRIVATE: password reset hash. Execute personally in Tibelio DEV.\nBEGIN;\nSET LOCAL standard_conforming_strings=on;\nDO $$ DECLARE changed integer; BEGIN\n UPDATE app.users SET password_hash=${literal(hash)},updated_by=id\n WHERE username=${literal(data.username)} AND platform_role='SUPERADMIN' AND active;\n GET DIAGNOSTICS changed = ROW_COUNT;\n IF changed<>1 THEN RAISE EXCEPTION 'Active superadministrator not found; reset refused'; END IF;\nEND $$;\nUPDATE app_private.sessions SET revoked_at=now() WHERE user_id IN (SELECT id FROM app.users WHERE username=${literal(data.username)} AND platform_role='SUPERADMIN');\nDELETE FROM app_private.login_limits WHERE key=${literal(createHash("sha256").update(data.username).digest("hex"))};\nCOMMIT;\n`
    : `-- PRIVATE: contains a password hash; do not commit or share.\nBEGIN;\nSET LOCAL standard_conforming_strings=on;\nLOCK TABLE app.users IN EXCLUSIVE MODE;\nDO $$ BEGIN\n IF EXISTS(SELECT 1 FROM app.users WHERE platform_role='SUPERADMIN') THEN\n  RAISE EXCEPTION 'Superadministrator already exists; bootstrap refused';\n END IF;\nEND $$;\nINSERT INTO app.users(username,display_name,password_hash,platform_role,authority)\nVALUES(${literal(data.username)},${literal(data.displayName)},${literal(hash)},'SUPERADMIN','ADMIN');\nCOMMIT;\n`;
  const output = reset
    ? `.local/reset-superadmin-${randomUUID()}.sql`
    : ".local/bootstrap-superadmin.sql";
  await mkdir(".local", { recursive: true });
  await writeFile(output, sql, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `SQL privado preparado en ${output}. No se ha ejecutado ni se ha conectado a Supabase.`,
  );
} catch {
  console.error(
    "No se generó el SQL. Revisa usuario, longitud de contraseña y coincidencia de confirmación; el bootstrap inicial tampoco permite sobrescribir su archivo. No compartas contraseñas en el chat.",
  );
  process.exitCode = 1;
}
