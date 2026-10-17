import "server-only";

export interface QuotationPdfData {
  company: {
    legalName: string;
    taxId: string;
  };
  client: {
    legalName: string;
    taxId: string;
    address: string;
    municipality: string;
    phone?: string;
    email?: string | null;
  };
  quotation: {
    code: string;
    version: number;
    requestCode: string;
    issuedAt: string;
    expiresAt: string;
    currency: string;
    subtotal: string;
    taxRate: string;
    taxAmount: string;
    totalAmount: string;
    notes?: string | null;
    paymentTerms?: string | null;
  };
  cabins: Array<{
    locationTag?: string | null;
    model: string;
    finish?: string | null;
    dimensions?: string | null;
    warranty?: string | null;
    salePrice: string;
  }>;
  items: Array<{
    concept: string;
    quantity: number;
    unitPrice: string;
    totalPrice: string;
  }>;
}

function escapePdfText(str: string): string {
  // Solo caracteres ASCII imprimibles y escape de parntesis y backslash
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // Eliminar tildes para fuente estndar Tipo 1
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function truncatePdfText(str: string, maxChars: number): string {
  const clean = str.trim();
  if (clean.length <= maxChars) {
    return clean;
  }
  return `${clean.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

export function generateQuotationPdf(data: QuotationPdfData): Buffer {
  const PAGE_WIDTH = 595.28; // A4 pt
  const PAGE_HEIGHT = 841.89;
  const MARGIN_X = 40;
  const MARGIN_BOTTOM = 50;

  // Coleccin de comandos de stream por pgina
  const pages: string[] = [];
  let currentOps: string[] = [];
  let y = PAGE_HEIGHT - 50;

  function flushPage() {
    pages.push(currentOps.join("\n"));
    currentOps = [];
    y = PAGE_HEIGHT - 50;
  }

  function checkY(needed: number) {
    if (y - needed < MARGIN_BOTTOM) {
      flushPage();
      drawHeader(true);
    }
  }

  function drawText(
    text: string,
    x: number,
    yPos: number,
    font = "/F1",
    size = 9,
    color = "0 0 0",
  ) {
    const escaped = escapePdfText(text);
    currentOps.push(
      `BT ${color} rg ${font} ${size} Tf ${x.toFixed(2)} ${yPos.toFixed(2)} Td (${escaped}) Tj ET`,
    );
  }

  function drawRect(
    x: number,
    yPos: number,
    w: number,
    h: number,
    fillColor = "0.95 0.95 0.95",
  ) {
    currentOps.push(`${fillColor} rg ${x} ${yPos} ${w} ${h} re f`);
  }

  function drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    strokeColor = "0.8 0.8 0.8",
  ) {
    currentOps.push(
      `${strokeColor} RG 0.5 w ${x1} ${y1} m ${x2} ${y2} l S`,
    );
  }

  function drawHeader(isContinuation = false) {
    // Franja superior de encabezado
    drawRect(MARGIN_X, y - 5, PAGE_WIDTH - 2 * MARGIN_X, 28, "0.15 0.25 0.45");
    drawText(
      data.company.legalName,
      MARGIN_X + 10,
      y + 6,
      "/F2",
      12,
      "1 1 1",
    );
    drawText(
      `NIT: ${data.company.taxId}`,
      PAGE_WIDTH - MARGIN_X - 120,
      y + 8,
      "/F1",
      8,
      "0.9 0.9 0.9",
    );
    y -= 35;

    if (!isContinuation) {
      // Datos de la cotizacin y del cliente
      drawRect(MARGIN_X, y - 60, PAGE_WIDTH - 2 * MARGIN_X, 60, "0.96 0.97 0.99");
      drawLine(MARGIN_X, y - 60, PAGE_WIDTH - MARGIN_X, y - 60);

      // Columna 1: Cotizacin
      drawText(`COTIZACION: ${data.quotation.code} (v${data.quotation.version})`, MARGIN_X + 10, y - 14, "/F2", 10, "0.1 0.2 0.4");
      drawText(`Solicitud: ${data.quotation.requestCode}`, MARGIN_X + 10, y - 28, "/F1", 8);
      drawText(`Fecha emision: ${data.quotation.issuedAt}`, MARGIN_X + 10, y - 40, "/F1", 8);
      drawText(`Vence: ${data.quotation.expiresAt}`, MARGIN_X + 10, y - 52, "/F1", 8);

      // Columna 2: Cliente
      const col2X = MARGIN_X + 260;
      drawText(`CLIENTE: ${data.client.legalName}`, col2X, y - 14, "/F2", 9, "0.1 0.2 0.4");
      drawText(`NIT / CC: ${data.client.taxId}`, col2X, y - 28, "/F1", 8);
      drawText(`Direccion: ${data.client.address}`, col2X, y - 40, "/F1", 8);
      drawText(`Municipio: ${data.client.municipality}`, col2X, y - 52, "/F1", 8);

      y -= 75;
    }
  }

  // Pgina 1 inicial
  drawHeader(false);

  // Seccin: Cabinas Cotizadas
  checkY(40);
  drawText("ESPECIFICACIONES DE CABINAS", MARGIN_X, y, "/F2", 10, "0.15 0.25 0.45");
  y -= 15;

  // Encabezado de tabla de cabinas
  drawRect(MARGIN_X, y - 14, PAGE_WIDTH - 2 * MARGIN_X, 16, "0.9 0.92 0.95");
  drawText("#", MARGIN_X + 6, y - 10, "/F2", 8);
  drawText("Ubicacion / Modelo", MARGIN_X + 25, y - 10, "/F2", 8);
  drawText("Acabado / Medidas", MARGIN_X + 215, y - 10, "/F2", 8);
  drawText("Garantia", MARGIN_X + 355, y - 10, "/F2", 8);
  drawText("Precio Venta", PAGE_WIDTH - MARGIN_X - 70, y - 10, "/F2", 8);
  y -= 18;

  data.cabins.forEach((cabin, idx) => {
    checkY(20);
    const bg = idx % 2 === 0 ? "1 1 1" : "0.98 0.98 0.98";
    drawRect(MARGIN_X, y - 12, PAGE_WIDTH - 2 * MARGIN_X, 15, bg);

    const desc = `${cabin.locationTag ? `[${cabin.locationTag}] ` : ""}${cabin.model}`;
    const specs = `${cabin.finish ?? "Estandar"} | ${cabin.dimensions ?? "Medidas base"}`;
    const warranty = cabin.warranty ?? "Garantia de fabrica";

    drawText(`${idx + 1}`, MARGIN_X + 6, y - 9, "/F1", 8);
    drawText(truncatePdfText(desc, 36), MARGIN_X + 25, y - 9, "/F1", 8);
    drawText(truncatePdfText(specs, 28), MARGIN_X + 215, y - 9, "/F1", 8);
    drawText(truncatePdfText(warranty, 19), MARGIN_X + 355, y - 9, "/F1", 8);
    drawText(`$${cabin.salePrice}`, PAGE_WIDTH - MARGIN_X - 65, y - 9, "/F2", 8);
    y -= 16;
  });

  y -= 10;

  // Seccin: Componentes y Servicios Adicionales (si existen)
  if (data.items.length > 0) {
    checkY(40);
    drawText("SERVICIOS, TRANSPORTE Y ACCESORIOS", MARGIN_X, y, "/F2", 10, "0.15 0.25 0.45");
    y -= 15;

    drawRect(MARGIN_X, y - 14, PAGE_WIDTH - 2 * MARGIN_X, 16, "0.9 0.92 0.95");
    drawText("Concepto", MARGIN_X + 10, y - 10, "/F2", 8);
    drawText("Cant.", MARGIN_X + 300, y - 10, "/F2", 8);
    drawText("Precio Unitario", MARGIN_X + 360, y - 10, "/F2", 8);
    drawText("Total", PAGE_WIDTH - MARGIN_X - 65, y - 10, "/F2", 8);
    y -= 18;

    data.items.forEach((item, idx) => {
      checkY(20);
      const bg = idx % 2 === 0 ? "1 1 1" : "0.98 0.98 0.98";
      drawRect(MARGIN_X, y - 12, PAGE_WIDTH - 2 * MARGIN_X, 15, bg);

      drawText(item.concept.slice(0, 55), MARGIN_X + 10, y - 9, "/F1", 8);
      drawText(String(item.quantity), MARGIN_X + 305, y - 9, "/F1", 8);
      drawText(`$${item.unitPrice}`, MARGIN_X + 360, y - 9, "/F1", 8);
      drawText(`$${item.totalPrice}`, PAGE_WIDTH - MARGIN_X - 65, y - 9, "/F2", 8);
      y -= 16;
    });

    y -= 10;
  }

  // Seccin: Totales y Liquidacin Final
  checkY(85);
  const totalsX = PAGE_WIDTH - MARGIN_X - 220;
  drawRect(totalsX, y - 60, 220, 60, "0.95 0.96 0.98");
  drawLine(totalsX, y - 60, PAGE_WIDTH - MARGIN_X, y - 60);

  drawText("Subtotal:", totalsX + 15, y - 15, "/F1", 9);
  drawText(`$${data.quotation.subtotal} ${data.quotation.currency}`, PAGE_WIDTH - MARGIN_X - 90, y - 15, "/F1", 9);

  drawText(`Impuestos (${data.quotation.taxRate}):`, totalsX + 15, y - 30, "/F1", 9);
  drawText(`$${data.quotation.taxAmount} ${data.quotation.currency}`, PAGE_WIDTH - MARGIN_X - 90, y - 30, "/F1", 9);

  drawLine(totalsX + 10, y - 37, PAGE_WIDTH - MARGIN_X - 10, y - 37);

  drawText("TOTAL A PAGAR:", totalsX + 15, y - 50, "/F2", 10, "0.15 0.25 0.45");
  drawText(`$${data.quotation.totalAmount} ${data.quotation.currency}`, PAGE_WIDTH - MARGIN_X - 100, y - 50, "/F2", 10, "0.15 0.25 0.45");

  y -= 80;

  // Trminos y condiciones
  checkY(50);
  drawText("CONDICIONES COMERCIALES Y DE GARANTIA", MARGIN_X, y, "/F2", 8, "0.3 0.3 0.3");
  y -= 12;
  const terms = data.quotation.paymentTerms ?? "Forma de pago segun acuerdo comercial.";
  const notes = data.quotation.notes ?? "Precios sujetos a vigencia informada. Instalacion segun cronograma aprobado.";
  drawText(terms.slice(0, 110), MARGIN_X, y, "/F1", 7, "0.4 0.4 0.4");
  y -= 10;
  drawText(notes.slice(0, 110), MARGIN_X, y, "/F1", 7, "0.4 0.4 0.4");

  // Finalizar ltima pgina
  pages.push(currentOps.join("\n"));

  // Ensamblado del archivo PDF binario
  const totalPages = pages.length;
  const objects: string[] = [];

  // Objeto 1: Catlogo
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj");

  // Objeto 4: Fuente F1 (Helvetica)
  objects.push("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj");
  // Objeto 5: Fuente F2 (Helvetica-Bold)
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj");

  // IDs de las pginas: empezando en 6
  // Pgina i: objeto (6 + 2*i), Contenido: objeto (7 + 2*i)
  const pageRefs: string[] = [];
  for (let i = 0; i < totalPages; i++) {
    const pageObjNum = 6 + i * 2;
    pageRefs.push(`${pageObjNum} 0 R`);
  }

  // Objeto 2: Pages
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [ ${pageRefs.join(" ")} ] /Count ${totalPages} >>\nendobj`,
  );

  for (let i = 0; i < totalPages; i++) {
    const pageObjNum = 6 + i * 2;
    const contentObjNum = 7 + i * 2;

    // Agregar pie de pgina
    const footerText = `Pagina ${i + 1} de ${totalPages} - Documento generado por ${data.company.legalName}`;
    const escapedFooter = escapePdfText(footerText);
    const footerOp = `BT 0.5 0.5 0.5 rg /F1 8 Tf ${MARGIN_X} 25 Td (${escapedFooter}) Tj ET`;
    const fullStream = `${pages[i]}\n${footerOp}`;

    const streamLen = Buffer.byteLength(fullStream, "utf-8");

    // Objeto Page
    objects.push(
      `${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT} ] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${contentObjNum} 0 R >>\nendobj`,
    );

    // Objeto Stream de Contenido
    objects.push(
      `${contentObjNum} 0 obj\n<< /Length ${streamLen} >>\nstream\n${fullStream}\nendstream\nendobj`,
    );
  }

  // Construir PDF con tabla XREF y Trailer
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];

  // Objeto 0 vaco para xref
  offsets.push(0);

  // Ordenar objetos por nmero
  const parsedObjects: Array<{ num: number; content: string }> = objects.map((obj) => {
    const match = obj.match(/^(\d+)\s+0\s+obj/);
    return { num: Number(match?.[1] ?? 0), content: obj };
  });
  parsedObjects.sort((a, b) => a.num - b.num);

  for (const obj of parsedObjects) {
    offsets[obj.num] = Buffer.byteLength(pdf, "utf-8");
    pdf += obj.content + "\n";
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf-8");
  const objectCount = Math.max(...parsedObjects.map((obj) => obj.num)) + 1;
  pdf += `xref\n0 ${objectCount}\n`;
  pdf += "0000000000 65535 f \n";

  for (let i = 1; i < objectCount; i++) {
    const offset = offsets[i];
    pdf += offset === undefined ? "0000000000 00000 f \n" : offset.toString().padStart(10, "0") + " 00000 n \n";
  }

  pdf += `trailer\n<< /Size ${objectCount} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "utf-8");
}

/** Repair only the known legacy xref defect, preserving every original content object. */
export function repairLegacyQuotationPdf(bytes: Buffer): Buffer {
  const text = bytes.toString("utf8");
  const matches = Array.from(text.matchAll(/^(\d+) 0 obj\r?$/gm));
  const xref = text.lastIndexOf("\nxref\n") + 1;
  const declared = Number(text.slice(xref).match(/^xref\n0 (\d+)/)?.[1]);
  const max = Math.max(...matches.map((match) => Number(match[1])));
  // Recognize the old writer's layout, never its editable company/footer text.
  // Reject duplicate/injected headers and foreign layouts rather than guessing.
  const ids = new Set(matches.map(match => Number(match[1])));
  const knownLayout = text.includes("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj")
    && text.includes("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj")
    && text.includes("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj");
  if (!text.startsWith("%PDF-1.4\n") || !knownLayout || !xref || declared !== max
    || max < 7 || max % 2 !== 1 || matches.length !== max - 1 || ids.size !== matches.length || ids.has(3)
    || !Buffer.from(text,"utf8").equals(bytes)) return bytes;
  let fixed = text.slice(0, xref);
  const offsets = new Map(matches.map((m) => [Number(m[1]), Buffer.byteLength(text.slice(0, m.index), "utf8")]));
  const start = Buffer.byteLength(fixed, "utf8");
  fixed += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) fixed += offsets.has(i) ? `${String(offsets.get(i)).padStart(10, "0")} 00000 n \n` : "0000000000 00000 f \n";
  fixed += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(fixed, "utf8");
}

/** Correct the legacy hardcoded issuer ("Eliobys SaaS" + 8-hex tenant prefix), footer brand, and overflowing warranty/specs cells on generated quotation PDFs while preserving all commercial contents and rebuilding xref offsets. */
export function correctQuotationIssuerPdf(
  bytes: Buffer,
  issuer: { tenantId?: string; legalName: string; taxId: string },
): Buffer {
  const repaired = repairLegacyQuotationPdf(bytes);
  const text = repaired.toString("utf8");
  const matches = Array.from(text.matchAll(/^(\d+) 0 obj\r?$/gm));
  const xref = text.lastIndexOf("\nxref\n") + 1;
  const declared = Number(text.slice(xref).match(/^xref\n0 (\d+)/)?.[1]);
  const max = Math.max(...matches.map((match) => Number(match[1])));
  const ids = new Set(matches.map((match) => Number(match[1])));
  const knownLayout =
    text.includes("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj") &&
    text.includes("4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj") &&
    text.includes("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj");
  if (
    !text.startsWith("%PDF-1.4\n") ||
    !knownLayout ||
    !xref ||
    declared !== max + 1 ||
    max < 7 ||
    max % 2 !== 1 ||
    matches.length !== max - 1 ||
    ids.size !== matches.length ||
    ids.has(3) ||
    !Buffer.from(text, "utf8").equals(repaired)
  ) {
    return repaired;
  }

  const prefix = issuer.tenantId
    ? escapePdfText(issuer.tenantId.slice(0, 8)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    : "[0-9a-f]{8}";
  const headerPattern = new RegExp(
    `^BT 1 1 1 rg /F2 12 Tf 50\\.00 797\\.89 Td \\((?:Eliobys|Tibelio) Saa[Ss]\\) Tj ET\\nBT 0\\.9 0\\.9 0\\.9 rg /F1 8 Tf 435\\.28 799\\.89 Td \\(NIT: ${prefix}\\) Tj ET$`,
    "gm",
  );
  const legacyFooterPattern = /Documento generado por (?:Eliobys|Tibelio) Saa[Ss]\) Tj ET$/gm;
  const overflowWarrantyPattern =
    /^(BT 0 0 0 rg \/F1 8 Tf 410\.00 \d+\.\d+ Td \()([^)\n]{17,})(\) Tj ET)$/gm;
  const overflowSpecsPattern =
    /^(BT 0 0 0 rg \/F1 8 Tf 260\.00 \d+\.\d+ Td \()([^)\n]{29,})(\) Tj ET)$/gm;

  if (
    !headerPattern.test(text) &&
    !legacyFooterPattern.test(text) &&
    !overflowWarrantyPattern.test(text) &&
    !overflowSpecsPattern.test(text)
  ) {
    return repaired;
  }

  const escapedCompany = escapePdfText(issuer.legalName);
  const replacementHeader =
    `BT 1 1 1 rg /F2 12 Tf 50.00 797.89 Td (${escapedCompany}) Tj ET\n` +
    `BT 0.9 0.9 0.9 rg /F1 8 Tf 435.28 799.89 Td (NIT: ${escapePdfText(issuer.taxId)}) Tj ET`;

  let rebuilt = "%PDF-1.4\n";
  const offsets = new Map<number, number>();

  for (let idx = 0; idx < matches.length; idx++) {
    const num = Number(matches[idx]![1]);
    const startOffset = matches[idx]!.index!;
    const endOffset = idx + 1 < matches.length ? matches[idx + 1]!.index! : xref;
    let objBlock = text.slice(startOffset, endOffset).replace(/\n+$/, "");

    if (num >= 7 && num % 2 === 1) {
      const streamMatch = objBlock.match(
        /^(\d+ 0 obj\n<< \/Length )\d+( >>\nstream\n)([\s\S]*?)(\nendstream\nendobj)$/,
      );
      if (!streamMatch) {
        return repaired;
      }
      const nextStream = streamMatch[3]!
        .replace(headerPattern, () => replacementHeader)
        .replace(legacyFooterPattern, () => `Documento generado por ${escapedCompany}) Tj ET`)
        .replace(
          overflowWarrantyPattern,
          (_m, pre: string, rawWarranty: string, post: string) =>
            `${pre}${escapePdfText(truncatePdfText(rawWarranty, 16))}${post}`,
        )
        .replace(
          overflowSpecsPattern,
          (_m, pre: string, rawSpecs: string, post: string) =>
            `${pre}${escapePdfText(truncatePdfText(rawSpecs, 28))}${post}`,
        );
      const nextLen = Buffer.byteLength(nextStream, "utf8");
      objBlock = `${streamMatch[1]}${nextLen}${streamMatch[2]}${nextStream}${streamMatch[4]}`;
    }

    offsets.set(num, Buffer.byteLength(rebuilt, "utf8"));
    rebuilt += `${objBlock}\n`;
  }

  const start = Buffer.byteLength(rebuilt, "utf8");
  rebuilt += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= max; i++) {
    rebuilt += offsets.has(i)
      ? `${String(offsets.get(i)).padStart(10, "0")} 00000 n \n`
      : "0000000000 00000 f \n";
  }
  rebuilt += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(rebuilt, "utf8");
}
