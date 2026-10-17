import { defineConfig } from "prisma/config";

// Validación offline del esquema. Las migraciones requieren diseño de Fase 1.
export default defineConfig({ schema: "prisma/schema.prisma" });

