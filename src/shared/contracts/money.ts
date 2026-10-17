import { z } from "zod";

/**
 * Contrato monetario determinista para Tibelio SaaS:
 * - Acepta números (>= 0, máximo 12 dígitos enteros): normaliza con .toFixed(2).
 * - Acepta formato canónico y enteros: "500000", "500000.5", "500000.50" -> "500000.50".
 * - Acepta coma decimal estándar hispano: "15,50", "1,2", "500000,00" -> "15.50", "1.20", "500000.00".
 * - Acepta agrupaciones de miles válidas con coma: "1,500.00", "1,500,000.50" -> "1500.00", "1500000.50".
 * - Acepta agrupaciones de miles válidas con punto: "500.000,00", "1.500.000,50" -> "500000.00", "1500000.50".
 * - Rechaza terminantemente:
 *   - Agrupaciones de miles inválidas o ambiguas (ej. "1,50,00", "1.50.00", "15,50.00").
 *   - Más de 2 decimales (ej. "15.555", "15,555").
 *   - Valores negativos o cadenas no numéricas.
 *   - Números superiores a 12 dígitos enteros.
 */
export function parseMoney(val: unknown): string {
  if (typeof val === "number") {
    if (!Number.isFinite(val) || val < 0 || val > 999_999_999_999.99) {
      throw new Error("Importe numérico fuera de rango o inválido");
    }
    const s = val.toString();
    if (s.toLowerCase().includes("e-")) {
      throw new Error("Importe numérico con precisión excesiva (máximo 2 decimales)");
    }
    if (Number(val.toFixed(2)) !== val) {
      throw new Error("Importe numérico con precisión excesiva (máximo 2 decimales)");
    }
    if (s.includes(".")) {
      const dec = s.split(".")[1]!;
      if (dec.length > 2) {
        throw new Error("Importe numérico con precisión excesiva (máximo 2 decimales)");
      }
    }
    return val.toFixed(2);
  }

  if (typeof val !== "string") {
    throw new Error("Importe debe ser un número o texto");
  }

  const trimmed = val.trim();
  if (!trimmed) {
    throw new Error("Importe monetario no puede estar vacío");
  }

  // 1. Entero simple: "500000"
  if (/^\d{1,12}$/.test(trimmed)) {
    return `${trimmed}.00`;
  }

  // 2. Punto decimal sin separador de miles: "500000.5" o "500000.50"
  if (/^\d{1,12}\.\d{1,2}$/.test(trimmed)) {
    const [intPart, decPart] = trimmed.split(".");
    return `${intPart}.${decPart!.padEnd(2, "0")}`;
  }

  // 3. Coma decimal sin separador de miles: "15,50" o "1,2" o "500000,00"
  if (/^\d{1,12},\d{1,2}$/.test(trimmed)) {
    const [intPart, decPart] = trimmed.split(",");
    return `${intPart}.${decPart!.padEnd(2, "0")}`;
  }

  // 4. Separador de miles estándar inglés (coma) con punto decimal explícito: "1,500.00", "1,500,000.50"
  // o entero con múltiples grupos de miles: "1,500,000"
  if (
    /^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(trimmed) ||
    /^\d{1,3}(?:,\d{3}){2,}$/.test(trimmed)
  ) {
    const parts = trimmed.split(".");
    const cleanInt = parts[0]!.replace(/,/g, "");
    if (cleanInt.length > 12) {
      throw new Error("Importe excede el límite de 12 dígitos enteros");
    }
    const decPart = (parts[1] ?? "00").padEnd(2, "0");
    return `${cleanInt}.${decPart}`;
  }

  // 5. Separador de miles estándar hispano (punto) con coma decimal explícita: "500.000,00", "1.500.000,50"
  // o entero con múltiples grupos de miles: "1.500.000"
  if (
    /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(trimmed) ||
    /^\d{1,3}(?:\.\d{3}){2,}$/.test(trimmed)
  ) {
    const parts = trimmed.split(",");
    const cleanInt = parts[0]!.replace(/\./g, "");
    if (cleanInt.length > 12) {
      throw new Error("Importe excede el límite de 12 dígitos enteros");
    }
    const decPart = (parts[1] ?? "00").padEnd(2, "0");
    return `${cleanInt}.${decPart}`;
  }

  // Cualquier otro formato es ambiguo o inválido
  throw new Error("Formato monetario inválido o ambiguo");
}

export const canonicalMoneySchema = z.preprocess(
  (val) => {
    try {
      return parseMoney(val);
    } catch {
      return "__INVALID_MONEY__";
    }
  },
  z.string().regex(/^\d{1,12}\.\d{2}$/, {
    message: "Importe monetario inválido (use ej. 500000, 1500.00 o 15,50)",
  }),
);
