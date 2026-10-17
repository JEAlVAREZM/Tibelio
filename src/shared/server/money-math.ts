import "server-only";

/**
 * Motor de Cálculo Monetario y Precisión Decimal — DEC-059 y COT-002.
 * Conserva precisión intermedia exacta mediante escala fija (8 decimales) y
 * aplica redondeo mitad al par (banker's rounding) únicamente sobre los totales finales.
 */

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

export class Decimal {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den: bigint = 1n) {
    if (den === 0n) throw new Error("División por cero en Decimal");
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = gcd(num, den);
    this.num = num / g;
    this.den = den / g;
  }

  static from(input: string | number | bigint | Decimal): Decimal {
    if (input instanceof Decimal) return input;
    if (typeof input === "bigint") return new Decimal(input, 1n);
    const str = String(input).trim();
    if (!str || isNaN(Number(str))) {
      throw new Error(`Número inválido para Decimal: '${str}'`);
    }

    const [intPart = "0", fracPart = ""] = str.split(".");
    const sign = intPart.startsWith("-") ? -1n : 1n;
    const absInt = BigInt(intPart.replace("-", "") || "0");
    if (!fracPart) {
      return new Decimal(sign * absInt, 1n);
    }
    const fracDen = 10n ** BigInt(fracPart.length);
    const fracNum = BigInt(fracPart);
    const totalNum = absInt * fracDen + fracNum;
    return new Decimal(sign * totalNum, fracDen);
  }

  add(other: Decimal | string | number): Decimal {
    const o = Decimal.from(other);
    return new Decimal(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(other: Decimal | string | number): Decimal {
    const o = Decimal.from(other);
    return new Decimal(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(other: Decimal | string | number): Decimal {
    const o = Decimal.from(other);
    return new Decimal(this.num * o.num, this.den * o.den);
  }

  div(other: Decimal | string | number): Decimal {
    const o = Decimal.from(other);
    if (o.num === 0n) throw new Error("División por cero en cálculo comercial");
    return new Decimal(this.num * o.den, this.den * o.num);
  }

  /**
   * Redondeo bancario mitad al par (Half-to-Even) a N decimales (por defecto 2).
   */
  round(decimals = 2): string {
    const scale = 10n ** BigInt(decimals);
    const scaledNum = this.num * scale;
    const sign = scaledNum < 0n ? -1n : 1n;
    const absN = scaledNum < 0n ? -scaledNum : scaledNum;
    const absD = this.den;

    let quotient = absN / absD;
    const remainder = absN % absD;
    const doubleRemainder = remainder * 2n;

    if (doubleRemainder > absD) {
      quotient += 1n;
    } else if (doubleRemainder === absD) {
      // Mitad exacta: redondear al par más cercano
      if (quotient % 2n !== 0n) {
        quotient += 1n;
      }
    }

    const finalVal = sign * quotient;
    const signStr = finalVal < 0n ? "-" : "";
    const absFinal = finalVal < 0n ? -finalVal : finalVal;

    const intPart = (absFinal / scale).toString();
    const fracPart = (absFinal % scale).toString().padStart(decimals, "0");

    return `${signStr}${intPart}.${fracPart}`;
  }

  toNumber(): number {
    return Number(this.round(4));
  }

  abs(): Decimal {
    return new Decimal(this.num < 0n ? -this.num : this.num, this.den);
  }

  isNegative(): boolean {
    return this.num < 0n;
  }

  isZero(): boolean {
    return this.num === 0n;
  }

  isPositive(): boolean {
    return this.num > 0n;
  }

  gte(other: Decimal | string | number): boolean {
    return this.sub(other).num >= 0n;
  }

  lte(other: Decimal | string | number): boolean {
    return this.sub(other).num <= 0n;
  }

  gt(other: Decimal | string | number): boolean {
    return this.sub(other).num > 0n;
  }

  lt(other: Decimal | string | number): boolean {
    return this.sub(other).num < 0n;
  }

  eq(other: Decimal | string | number): boolean {
    return this.sub(other).num === 0n;
  }
}

export interface QuotationCalculationInput {
  pricingMethod: "CATALOG_PRICE" | "COST_MARGIN";
  targetMargin?: number | null; // e.g. 0.35 para 35%
  cabins: Array<{
    id: string;
    baseCost?: string | number | null;
    listPrice?: string | number | null;
  }>;
  items: Array<{
    unitCost?: string | number | null;
    unitPrice?: string | number | null;
    quantity: number;
    type: "ACCESSORY" | "MATERIAL" | "TRANSPORT" | "INSTALLATION" | "SERVICE";
  }>;
  taxRate: number; // e.g. 0.19 para 19%
  taxIncluded: boolean;
}

export interface CalculatedQuotationLine {
  id?: string;
  baseCost: string | null;
  salePrice: string; // Línea redondeada para presentación visual
  intermediatePrice: Decimal; // Precio exacto sin redondear
}

export interface QuotationCalculationResult {
  pricingMethod: "CATALOG_PRICE" | "COST_MARGIN";
  cabins: Array<{
    id: string;
    baseCost: string | null;
    listPrice: string | null;
    salePrice: string;
    intermediatePrice: Decimal;
  }>;
  items: Array<{
    unitCost: string | null;
    unitPrice: string;
    totalPrice: string;
    quantity: number;
    intermediateTotal: Decimal;
  }>;
  subtotal: string; // Base imponible final (2 dec)
  taxAmount: string; // Importe de impuestos final (2 dec)
  totalAmount: string; // Total pagadero final (2 dec)
}

/**
 * Ejecuta el cálculo comercial de cotización bajo COT-002 y DEC-059.
 */
export function calculateQuotation(
  input: QuotationCalculationInput,
): QuotationCalculationResult {
  let intermediateSubtotal = Decimal.from(0);

  // 1. Cálculo de cabinas
  const calculatedCabins = input.cabins.map((cabin) => {
    let intermediatePrice: Decimal;

    if (input.pricingMethod === "COST_MARGIN") {
      const margin = input.targetMargin ?? 0.35;
      if (margin >= 1 || margin < 0) {
        throw new Error("El margen objetivo debe estar entre 0% y 99.99%");
      }
      const cost = Decimal.from(cabin.baseCost ?? 0);
      const denominator = Decimal.from(1).sub(Decimal.from(margin));
      intermediatePrice = cost.div(denominator);
    } else {
      // CATALOG_PRICE
      intermediatePrice = Decimal.from(cabin.listPrice ?? 0);
    }

    intermediateSubtotal = intermediateSubtotal.add(intermediatePrice);

    return {
      id: cabin.id,
      baseCost: cabin.baseCost ? Decimal.from(cabin.baseCost).round(2) : null,
      listPrice: cabin.listPrice ? Decimal.from(cabin.listPrice).round(2) : null,
      salePrice: intermediatePrice.round(2),
      intermediatePrice,
    };
  });

  // 2. Cálculo de ítems complementarios y servicios (flete, instalación, accesorios)
  const calculatedItems = input.items.map((item) => {
    let unitPriceDec: Decimal;

    if (input.pricingMethod === "COST_MARGIN" && item.unitCost != null) {
      const margin = input.targetMargin ?? 0.35;
      const denominator = Decimal.from(1).sub(Decimal.from(margin));
      unitPriceDec = Decimal.from(item.unitCost).div(denominator);
    } else {
      unitPriceDec = Decimal.from(item.unitPrice ?? 0);
    }

    const intermediateTotal = unitPriceDec.mul(item.quantity);
    intermediateSubtotal = intermediateSubtotal.add(intermediateTotal);

    return {
      unitCost: item.unitCost ? Decimal.from(item.unitCost).round(2) : null,
      unitPrice: unitPriceDec.round(2),
      totalPrice: intermediateTotal.round(2),
      quantity: item.quantity,
      intermediateTotal,
    };
  });

  // 3. Cálculo de impuestos y totales según modalidad taxIncluded
  let finalSubtotalDec: Decimal;
  let finalTaxAmountDec: Decimal;
  let finalTotalAmountDec: Decimal;

  const taxRateDec = Decimal.from(input.taxRate);

  if (input.taxIncluded) {
    // intermediateSubtotal ya incluye el impuesto: Total = Subtotal_con_impuesto
    finalTotalAmountDec = intermediateSubtotal;
    const onePlusTax = Decimal.from(1).add(taxRateDec);
    finalSubtotalDec = finalTotalAmountDec.div(onePlusTax);
    finalTaxAmountDec = finalTotalAmountDec.sub(finalSubtotalDec);
  } else {
    // intermediateSubtotal es antes de impuestos
    finalSubtotalDec = intermediateSubtotal;
    finalTaxAmountDec = finalSubtotalDec.mul(taxRateDec);
    finalTotalAmountDec = finalSubtotalDec.add(finalTaxAmountDec);
  }

  return {
    pricingMethod: input.pricingMethod,
    cabins: calculatedCabins,
    items: calculatedItems,
    subtotal: finalSubtotalDec.round(2),
    taxAmount: finalTaxAmountDec.round(2),
    totalAmount: finalTotalAmountDec.round(2),
  };
}
