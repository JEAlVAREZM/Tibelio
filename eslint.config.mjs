import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([".next/**", ".local/**", "next-env.d.ts", "playwright-report/**", "test-results/**", "coverage/**"]),
  { files: ["src/app/**/*.{ts,tsx}"], rules: {
    "no-restricted-imports": ["error", { patterns: [
      { group: ["pg", "prisma", "@prisma/*", "**/server/database*"], message: "Acceder a persistencia mediante casos de uso del servidor." },
    ] }],
  } },
]);

