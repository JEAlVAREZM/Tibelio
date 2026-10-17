"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useEffect, useState, type FormEvent, type ChangeEvent } from "react";
import {
  parseClientDecimal,
  parsePercentageRatio,
  type QuotationDto,
  type CommercialRequestDto,
  type CommercialCapabilities,
} from "../../shared/contracts/commercial";

interface ApiError extends Error {
  code?: string;
  status?: number;
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const isMutating = method !== "GET" && method !== "HEAD";
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: isMutating || body !== undefined ? { "Content-Type": "application/json" } : {},
    body: isMutating ? JSON.stringify(body ?? {}) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message ?? "Error en la operación comercial.") as ApiError;
    error.code = result.error?.code ?? (response.status === 403 ? "FORBIDDEN" : "ERROR");
    error.status = response.status;
    throw error;
  }
  return result.data as T;
}

export function QuotationsView({
  requests,
  readOnly,
  capabilities,
  initialRequestId,
}: {
  requests: CommercialRequestDto[];
  readOnly: boolean;
  capabilities: CommercialCapabilities;
  initialRequestId?: string | null;
}) {
  const [quotations, setQuotations] = useState<QuotationDto[]>([]);
  const [extraRequests, setExtraRequests] = useState<CommercialRequestDto[]>([]);
  const availableRequests = requests.length > 0 ? requests : extraRequests;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [selectedQuotation, setSelectedQuotation] = useState<QuotationDto | null>(null);

  // Modal nueva cotización
  const [showCreateModal, setShowCreateModal] = useState(Boolean(initialRequestId));
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [targetRequestId, setTargetRequestId] = useState(initialRequestId ?? "");
  const [pricingMethod, setPricingMethod] = useState<"CATALOG_PRICE" | "COST_MARGIN">("CATALOG_PRICE");
  const [targetMargin, setTargetMargin] = useState("0.35");
  const [validityDays, setValidityDays] = useState(15);
  const [quoteNotes, setQuoteNotes] = useState("");

  const [prevInitialId, setPrevInitialId] = useState(initialRequestId);
  if (initialRequestId !== prevInitialId) {
    setPrevInitialId(initialRequestId);
    if (initialRequestId) {
      setTargetRequestId(initialRequestId);
      setShowCreateModal(true);
    }
  }

  // Modal aprobación cotización
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [approvalFile, setApprovalFile] = useState<File | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  // Modal rechazo
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [rejectError, setRejectError] = useState<string | null>(null);

  // Modal nueva versión v2
  const [showVersionModal, setShowVersionModal] = useState(false);
  const [v2Cabins, setV2Cabins] = useState<
    Array<{
      cabinId: string;
      customWidth: string;
      customHeight: string;
      finish: string;
      notes: string;
    }>
  >([]);
  const [v2Notes, setV2Notes] = useState("");
  const [v2Error, setV2Error] = useState<string | null>(null);

  // Modal nota de ajuste
  const [showAdjustmentModal, setShowAdjustmentModal] = useState(false);
  const [adjType, setAdjType] = useState<"INCREASE" | "DECREASE">("DECREASE");
  const [adjAmount, setAdjAmount] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [adjError, setAdjError] = useState<string | null>(null);

  // Modal aprobación de ajuste (aumento que requiere evidencia de cliente)
  const [pendingAdjId, setPendingAdjId] = useState<string | null>(null);
  const [adjEvidenceFile, setAdjEvidenceFile] = useState<File | null>(null);
  const [adjApproveError, setAdjApproveError] = useState<string | null>(null);

  const loadQuotations = async () => {
    if (!capabilities.canReadQuotations) {
      setForbidden(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const qParams = new URLSearchParams();
      if (statusFilter !== "ALL") qParams.set("status", statusFilter);
      if (search.trim()) qParams.set("search", search.trim());
      const res = await api<{ items: QuotationDto[]; total: number }>(
        `commercial/quotations?${qParams.toString()}`,
      );
      setQuotations(res.items);
    } catch (err: unknown) {
      const e = err as ApiError;
      if (e.code === "FORBIDDEN" || e.status === 403) {
        setForbidden(true);
      } else {
        setError(e.message || "Error al cargar las cotizaciones.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!capabilities.canReadQuotations) {
      return;
    }
    let cancelled = false;
    const qParams = new URLSearchParams();
    if (statusFilter !== "ALL") qParams.set("status", statusFilter);
    if (search.trim()) qParams.set("search", search.trim());
    api<{ items: QuotationDto[]; total: number }>(
      `commercial/quotations?${qParams.toString()}`,
    )
      .then((res) => {
        if (cancelled) return;
        setQuotations(res.items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as ApiError;
        if (e.code === "FORBIDDEN" || e.status === 403) {
          setForbidden(true);
        } else {
          setError(e.message || "Error al cargar las cotizaciones.");
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [statusFilter, capabilities.canReadQuotations, search]);

  const viewQuotationDetail = async (id: string) => {
    try {
      const q = await api<QuotationDto>(`commercial/quotations/${id}`);
      setSelectedQuotation(q);
    } catch (err: unknown) {
      const e = err as ApiError;
      setError(e.message || "No se pudo cargar el detalle de la cotización.");
    }
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !capabilities.canCreateQuotations) return;
    if (!targetRequestId) {
      setCreateError("Debe seleccionar una solicitud de obra.");
      return;
    }

    setBusy(true);
    setCreateError(null);
    try {
      const payload = {
        requestId: targetRequestId,
        pricingMethod,
        targetMargin: pricingMethod === "COST_MARGIN" ? parsePercentageRatio(targetMargin) : undefined,
        validityDays: Number(validityDays),
        notes: quoteNotes.trim() || null,
      };

      const quot = await api<QuotationDto>("commercial/quotations", "POST", payload);
      setShowCreateModal(false);
      await loadQuotations();
      setSelectedQuotation(quot);
    } catch (err: unknown) {
      const e = err as ApiError;
      setCreateError(e.message || "Error al generar la cotización.");
    } finally {
      setBusy(false);
    }
  };

  const handleMarkSent = async (id: string) => {
    if (readOnly || !capabilities.canUpdateQuotations) return;
    setBusy(true);
    try {
      const updated = await api<QuotationDto>(`commercial/quotations/${id}/send`, "POST");
      setSelectedQuotation(updated);
      await loadQuotations();
    } catch (err: unknown) {
      const e = err as ApiError;
      setError(e.message || "No se pudo marcar como enviada.");
    } finally {
      setBusy(false);
    }
  };

  const handleApproveSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !capabilities.canApproveQuotations || !selectedQuotation) return;
    if (!approvalFile) {
      setApproveError("Debe seleccionar un archivo con la evidencia de aprobación del cliente.");
      return;
    }

    setBusy(true);
    setApproveError(null);
    try {
      const res = await fetch(`/api/v1/commercial/quotations/${selectedQuotation.id}/approve`, {
        method: "POST",
        headers: { "Content-Type": approvalFile.type || "application/pdf" },
        body: approvalFile,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message ?? "Error al aprobar la cotización.");
      }
      setSelectedQuotation(data.data as QuotationDto);
      setShowApproveModal(false);
      setApprovalFile(null);
      await loadQuotations();
    } catch (err: unknown) {
      const e = err as Error;
      setApproveError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleRejectSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !selectedQuotation) return;
    if (rejectReason.trim().length < 3) {
      setRejectError("El motivo del rechazo debe tener al menos 3 caracteres.");
      return;
    }

    setBusy(true);
    setRejectError(null);
    try {
      const updated = await api<QuotationDto>(
        `commercial/quotations/${selectedQuotation.id}/reject`,
        "POST",
        { reason: rejectReason.trim() },
      );
      setSelectedQuotation(updated);
      setShowRejectModal(false);
      setRejectReason("");
      await loadQuotations();
    } catch (err: unknown) {
      const e = err as ApiError;
      setRejectError(e.message || "Error al registrar el rechazo.");
    } finally {
      setBusy(false);
    }
  };

  const handleOpenVersionModal = () => {
    if (!selectedQuotation) return;
    setV2Cabins(
      selectedQuotation.cabins?.map((c) => ({
        cabinId: c.cabinId,
        customWidth: c.customWidth ? String(c.customWidth) : "",
        customHeight: c.customHeight ? String(c.customHeight) : "",
        finish: c.finish ?? "",
        notes: c.notes ?? "",
      })) ?? [],
    );
    setV2Notes(`Revisión por ajuste de medidas en obra para ${selectedQuotation.code}`);
    setV2Error(null);
    setShowVersionModal(true);
  };

  const handleVersionSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !capabilities.canCreateQuotations || !selectedQuotation) return;

    for (let i = 0; i < v2Cabins.length; i++) {
      const c = v2Cabins[i]!;
      if (c.customWidth && parseClientDecimal(c.customWidth) === null) {
        setV2Error(`El ancho de la cabina #${i + 1} no es válido.`);
        return;
      }
      if (c.customHeight && parseClientDecimal(c.customHeight) === null) {
        setV2Error(`El alto de la cabina #${i + 1} no es válido.`);
        return;
      }
    }

    setBusy(true);
    setV2Error(null);
    try {
      const payload = {
        notes: v2Notes.trim() || null,
        cabins: v2Cabins.map((c) => ({
          cabinId: c.cabinId,
          customWidth: c.customWidth ? parseClientDecimal(c.customWidth) : null,
          customHeight: c.customHeight ? parseClientDecimal(c.customHeight) : null,
          finish: c.finish.trim() || null,
          notes: c.notes.trim() || null,
        })),
      };

      const newVersion = await api<QuotationDto>(
        `commercial/quotations/${selectedQuotation.id}/versions`,
        "POST",
        payload,
      );
      setShowVersionModal(false);
      setSelectedQuotation(newVersion);
      await loadQuotations();
    } catch (err: unknown) {
      const e = err as ApiError;
      setV2Error(e.message || "Error al generar la nueva versión.");
    } finally {
      setBusy(false);
    }
  };

  const handleAdjustmentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !capabilities.canCreateAdjustments || !selectedQuotation) return;
    const cleanAmount = adjAmount.trim();
    if (!cleanAmount) {
      setAdjError("Debe ingresar un importe para el ajuste.");
      return;
    }
    const amountNum = parseClientDecimal(cleanAmount);
    if (amountNum === null || amountNum <= 0) {
      setAdjError("El importe del ajuste debe ser un valor positivo.");
      return;
    }
    if (adjReason.trim().length < 5) {
      setAdjError("El motivo debe tener al menos 5 caracteres.");
      return;
    }

    setBusy(true);
    setAdjError(null);
    try {
      await api(
        `commercial/quotations/${selectedQuotation.id}/adjustments`,
        "POST",
        {
          adjustmentType: adjType,
          amount: cleanAmount,
          reason: adjReason.trim(),
        },
      );
      setShowAdjustmentModal(false);
      setAdjAmount("");
      setAdjReason("");
      // Recargar la cotización actual para mostrar el nuevo ajuste
      await viewQuotationDetail(selectedQuotation.id);
      await loadQuotations();
    } catch (err: unknown) {
      const e = err as ApiError;
      setAdjError(e.message || "Error al crear la nota de ajuste.");
    } finally {
      setBusy(false);
    }
  };

  const handleApproveAdjustmentSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !capabilities.canAuthorizeAdjustments || !pendingAdjId || !selectedQuotation) return;
    const targetAdj = selectedQuotation.adjustments?.find((a) => a.id === pendingAdjId);
    if (targetAdj?.adjustmentType === "INCREASE" && !adjEvidenceFile) {
      setAdjApproveError("Debe seleccionar un archivo con la evidencia de aprobación del aumento.");
      return;
    }

    setBusy(true);
    setAdjApproveError(null);
    try {
      const headers: Record<string, string> = adjEvidenceFile
        ? { "Content-Type": adjEvidenceFile.type || "application/pdf" }
        : { "Content-Type": "application/json" };
      const body = adjEvidenceFile ? adjEvidenceFile : JSON.stringify({});

      const res = await fetch(`/api/v1/commercial/adjustments/${pendingAdjId}/approve`, {
        method: "POST",
        headers,
        body,
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error?.message ?? "Error al autorizar el ajuste.");
      }
      setPendingAdjId(null);
      setAdjEvidenceFile(null);
      await viewQuotationDetail(selectedQuotation.id);
      await loadQuotations();
    } catch (err: unknown) {
      const e = err as Error;
      setAdjApproveError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (forbidden || !capabilities.canReadQuotations) {
    return (
      <div className="panel" data-testid="quotations-forbidden">
        <p role="alert">🔒 No tienes permisos para consultar cotizaciones comerciales (quotations.read).</p>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="commercial-quotations-container">
      <div className="panel">
        <div className="workspace-header">
          <div>
            <span className="eyebrow">PROPUESTAS Y LIQUIDACIÓN EXACTA</span>
            <h2>Cotizaciones Comerciales</h2>
          </div>
          {capabilities.canCreateQuotations && !readOnly && (
            <button
              type="button"
              onClick={() => {
                if (requests.length === 0 && extraRequests.length === 0) {
                  void api<{ items: CommercialRequestDto[] }>("commercial/requests?limit=100")
                    .then((res) => {
                      if (res?.items) setExtraRequests(res.items);
                    })
                    .catch(() => {});
                }
                setTargetRequestId(availableRequests[0]?.id ?? "");
                setShowCreateModal(true);
              }}
              data-testid="button-new-quotation"
            >
              + Nueva Cotización
            </button>
          )}
        </div>

        {/* Barra de filtros */}
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <input
            type="text"
            placeholder="Buscar por código COT o cliente..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: "320px" }}
            data-testid="input-search-quotations"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ maxWidth: "200px" }}
            data-testid="select-filter-quote-status"
          >
            <option value="ALL">Todos los Estados</option>
            <option value="DRAFT">Borrador (DRAFT)</option>
            <option value="SENT">Enviada (SENT)</option>
            <option value="APPROVED">Aprobada (APPROVED)</option>
            <option value="REJECTED">Rechazada (REJECTED)</option>
            <option value="EXPIRED">Vencida (EXPIRED)</option>
          </select>
          <button
            type="button"
            className="secondary button-sm"
            onClick={() => void loadQuotations()}
            data-testid="button-refresh-quotations"
          >
            Actualizar
          </button>
        </div>

        {error && <p role="alert" style={{ marginBottom: "1rem" }}>{error}</p>}

        {loading ? (
          <p className="muted" data-testid="quotations-loading">Cargando cotizaciones...</p>
        ) : quotations.length === 0 ? (
          <p className="muted" data-testid="quotations-empty">No se encontraron cotizaciones.</p>
        ) : (
          <div className="table-scroll">
            <table data-testid="table-quotations">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Versión</th>
                  <th>Cliente</th>
                  <th>Total Liquidado</th>
                  <th>Estado</th>
                  <th>Vencimiento</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {quotations.map((q) => (
                  <tr key={q.id} data-testid={`quote-row-${q.code}-v${q.version}`}>
                    <td style={{ fontWeight: 700 }}>{q.code}</td>
                    <td><span className="tag-badge secondary">v{q.version}</span></td>
                    <td>{q.clientLegalName}</td>
                    <td style={{ fontWeight: 600 }}>{q.currency} {q.totalAmount}</td>
                    <td>
                      <span
                        className={`tag-badge ${
                          q.status === "APPROVED"
                            ? ""
                            : q.status === "SENT"
                            ? "secondary"
                            : q.status === "REJECTED"
                            ? "warning"
                            : ""
                        }`}
                      >
                        {displayLabel(q.status)}
                      </span>
                    </td>
                    <td>{new Date(q.expiresAt).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        <button
                          type="button"
                          className="secondary button-sm"
                          onClick={() => void viewQuotationDetail(q.id)}
                          data-testid={`btn-view-quote-${q.code}-v${q.version}`}
                        >
                          Ver Detalle
                        </button>
                        <a
                          href={`/api/v1/commercial/quotations/${q.id}/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ textDecoration: "none" }}
                        >
                          <button
                            type="button"
                            className="secondary button-sm"
                            data-testid={`btn-pdf-${q.code}-v${q.version}`}
                          >
                            PDF
                          </button>
                        </a>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* DETALLE Y EXPEDIENTE DE COTIZACIÓN */}
      {selectedQuotation && (
        <div className="panel" style={{ border: "2px solid #14655e" }} data-testid="modal-quotation-detail">
          <div className="workspace-header">
            <div>
              <span className="eyebrow">EXPEDIENTE COMERCIAL</span>
              <h2>
                {selectedQuotation.code} (v{selectedQuotation.version}) — {displayLabel(selectedQuotation.status)}
              </h2>
            </div>
            <button
              type="button"
              className="secondary button-sm"
              onClick={() => setSelectedQuotation(null)}
              data-testid="btn-close-quote-detail"
            >
              Cerrar
            </button>
          </div>

          <div className="form-grid" style={{ marginBottom: "1.5rem" }}>
            <div>
              <p><strong>Cliente:</strong> {selectedQuotation.clientLegalName} ({selectedQuotation.clientTaxId})</p>
              <p><strong>Solicitud Vinculada:</strong> {selectedQuotation.requestCode}</p>
              <p><strong>Método de Costeo:</strong> {selectedQuotation.pricingMethod === "CATALOG_PRICE" ? "Precio de Catálogo" : "Costo + Margen"}</p>
            </div>
            <div>
              <p><strong>Fecha Vencimiento:</strong> {new Date(selectedQuotation.expiresAt).toLocaleDateString()}</p>
              <p><strong>Total Liquidado:</strong> {selectedQuotation.currency} {selectedQuotation.totalAmount}</p>
              {selectedQuotation.approvedAt && (
                <p><strong>Aprobada el:</strong> {new Date(selectedQuotation.approvedAt).toLocaleDateString()}</p>
              )}
              {selectedQuotation.rejectionReason && (
                <p style={{ color: "#972e2e" }}><strong>Motivo de rechazo:</strong> {selectedQuotation.rejectionReason}</p>
              )}
            </div>
          </div>

          {/* TABLA DE CABINAS COTIZADAS */}
          <h3>Cabinas Físicas ({selectedQuotation.cabins?.length ?? 0})</h3>
          <div className="table-scroll" style={{ marginBottom: "1.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Ubicación</th>
                  <th>Modelo</th>
                  <th>Acabado</th>
                  <th>Dimensiones</th>
                  <th>Garantía</th>
                  {capabilities.canReadCosts && <th>Costo Base</th>}
                  <th>Precio Venta</th>
                </tr>
              </thead>
              <tbody>
                {selectedQuotation.cabins?.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.locationTag ?? "Sin ubicación"}</strong></td>
                    <td>{c.productName}</td>
                    <td>{c.finish ?? "Estándar"}</td>
                    <td>
                      {c.customWidth && c.customHeight
                        ? `${c.customWidth} x ${c.customHeight} cm`
                        : "Estándar"}
                    </td>
                    <td>{c.warrantyTerms ?? "12 meses"}</td>
                    {capabilities.canReadCosts && (
                      <td style={{ color: "#526a73" }}>{selectedQuotation.currency} {c.baseCost ?? "—"}</td>
                    )}
                    <td style={{ fontWeight: 600 }}>{selectedQuotation.currency} {c.salePrice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* TABLA DE ÍTEMS Y SERVICIOS */}
          <h3>Ítems, Transporte e Instalación ({selectedQuotation.items?.length ?? 0})</h3>
          <div className="table-scroll" style={{ marginBottom: "1.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th>Tipo</th>
                  <th>Cantidad</th>
                  {capabilities.canReadCosts && <th>Costo Unitario</th>}
                  <th>Precio Unitario</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {selectedQuotation.items?.map((it) => (
                  <tr key={it.id}>
                    <td>{it.concept}</td>
                        <td><span className="tag-badge secondary">{displayLabel(it.itemType)}</span></td>
                    <td>{it.quantity}</td>
                    {capabilities.canReadCosts && (
                      <td style={{ color: "#526a73" }}>{selectedQuotation.currency} {it.unitCost ?? "—"}</td>
                    )}
                    <td>{selectedQuotation.currency} {it.unitPrice}</td>
                    <td style={{ fontWeight: 600 }}>{selectedQuotation.currency} {it.totalPrice}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* LIQUIDACIÓN ECONÓMICA */}
          <div
            style={{
              padding: "1rem",
              background: "#f7faf9",
              borderRadius: "8px",
              border: "1px solid #d5e2e4",
              marginBottom: "1.5rem",
              maxWidth: "360px",
              marginLeft: "auto",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
              <span>Subtotal:</span>
              <span>{selectedQuotation.currency} {selectedQuotation.subtotal}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
              <span>IVA ({(((parseClientDecimal(selectedQuotation.taxRate) ?? 0.19)) * 100).toFixed(0)}%):</span>
              <span>{selectedQuotation.currency} {selectedQuotation.taxAmount}</span>
            </div>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                borderTop: "1px solid #adbec4",
                paddingTop: "0.5rem",
                fontWeight: 700,
                fontSize: "1.05rem",
              }}
            >
              <span>Total Liquidado:</span>
              <span>{selectedQuotation.currency} {selectedQuotation.totalAmount}</span>
            </div>
          </div>

          {/* DOCUMENTOS Y ARCHIVOS */}
          <h3>Documentos y Evidencias</h3>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1.5rem" }}>
            <a
              href={`/api/v1/commercial/quotations/${selectedQuotation.id}/pdf`}
              target="_blank"
              rel="noreferrer"
            >
              <button type="button" data-testid="button-download-pdf">
                📄 Descargar Cotización PDF
              </button>
            </a>

            {selectedQuotation.documents?.map((doc) => (
              <a
                key={doc.id}
                href={`/api/v1/commercial/documents/${doc.id}`}
                target="_blank"
                rel="noreferrer"
              >
                <button type="button" className="secondary button-sm" data-testid={`btn-doc-${doc.id}`}>
                  📎 {doc.documentType === "APPROVAL_EVIDENCE" ? "Evidencia Aprobación" : doc.filename}
                </button>
              </a>
            ))}
          </div>

          {/* HISTORIAL DE NOTAS DE AJUSTE */}
          {selectedQuotation.adjustments && selectedQuotation.adjustments.length > 0 && (
            <>
              <h3>Notas de Ajuste Comercial</h3>
              <div className="table-scroll" style={{ marginBottom: "1.5rem" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Código</th>
                      <th>Tipo</th>
                      <th>Monto</th>
                      <th>Estado</th>
                      <th>Motivo</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedQuotation.adjustments.map((adj) => (
                      <tr key={adj.id}>
                        <td><strong>{adj.code}</strong></td>
                        <td>
                          <span className={`tag-badge ${adj.adjustmentType === "INCREASE" ? "warning" : ""}`}>
                            {adj.adjustmentType === "INCREASE" ? "+ Aumento" : "- Reducción"}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{selectedQuotation.currency} {adj.amount}</td>
                        <td>
                          <span className={`tag-badge ${adj.status === "APPROVED" ? "" : "warning"}`}>
                            {displayLabel(adj.status)}
                          </span>
                        </td>
                        <td>{adj.reason}</td>
                        <td>
                          {adj.status === "PENDING" && capabilities.canAuthorizeAdjustments && !readOnly && (
                            <button
                              type="button"
                              className="button-sm"
                              onClick={() => {
                                setPendingAdjId(adj.id);
                                setAdjEvidenceFile(null);
                                setAdjApproveError(null);
                              }}
                              data-testid={`btn-approve-adj-${adj.code}`}
                            >
                              {adj.adjustmentType === "INCREASE" ? "Adjuntar Aprobación" : "Autorizar Reducción"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* BARRA DE ACCIONES DE CICLO DE VIDA */}
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
            {selectedQuotation.status === "DRAFT" && capabilities.canUpdateQuotations && !readOnly && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => handleMarkSent(selectedQuotation.id)}
                data-testid="button-mark-sent"
              >
                Marcar como Enviada
              </button>
            )}

            {(selectedQuotation.status === "DRAFT" || selectedQuotation.status === "SENT") &&
              capabilities.canApproveQuotations &&
              !readOnly && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setApprovalFile(null);
                    setApproveError(null);
                    setShowApproveModal(true);
                  }}
                  data-testid="button-open-approve"
                >
                  Registrar Aprobación Cliente
                </button>
              )}

            {(selectedQuotation.status === "DRAFT" || selectedQuotation.status === "SENT") &&
              !readOnly && (
                <button
                  type="button"
                  className="secondary"
                  style={{ color: "#972e2e" }}
                  disabled={busy}
                  onClick={() => {
                    setRejectReason("");
                    setRejectError(null);
                    setShowRejectModal(true);
                  }}
                  data-testid="button-open-reject"
                >
                  Rechazar
                </button>
              )}

            {selectedQuotation.status === "APPROVED" && !readOnly && (
              <>
                {capabilities.canCreateQuotations && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={handleOpenVersionModal}
                    data-testid="button-open-v2"
                  >
                    Nueva Versión (v{selectedQuotation.version + 1})
                  </button>
                )}
                {capabilities.canCreateAdjustments && (
                  <button
                    type="button"
                    onClick={() => {
                      setAdjType("DECREASE");
                      setAdjAmount("");
                      setAdjReason("");
                      setAdjError(null);
                      setShowAdjustmentModal(true);
                    }}
                    data-testid="button-open-adjustment"
                  >
                    Crear Nota de Ajuste
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* MODAL CREAR COTIZACIÓN */}
      {showCreateModal && (
        <div className="panel" style={{ border: "2px solid #27a6b8" }} data-testid="modal-create-quotation">
          <div className="workspace-header">
            <div>
              <span className="eyebrow">NUEVA COTIZACIÓN FORMAL</span>
              <h2>Cálculo de Precios y Condiciones</h2>
            </div>
            <button
              type="button"
              className="secondary button-sm"
              onClick={() => setShowCreateModal(false)}
            >
              Cancelar
            </button>
          </div>

          {createError && <p role="alert" style={{ marginBottom: "1rem" }}>{createError}</p>}

          <form onSubmit={handleCreateSubmit} className="stack">
            <label>
              Solicitud de Obra a Cotizar
              <select
                value={targetRequestId}
                onChange={(e) => setTargetRequestId(e.target.value)}
                required
                data-testid="select-quote-request"
              >
                <option value="">Seleccione solicitud...</option>
                {availableRequests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code} — {r.clientLegalName} ({r.cabinsCount ?? r.cabins?.length ?? 1} cabinas)
                  </option>
                ))}
              </select>
            </label>

            <div className="form-grid">
              <label>
                Método de Costeo
                <select
                  value={pricingMethod}
                  onChange={(e) => setPricingMethod(e.target.value as "CATALOG_PRICE" | "COST_MARGIN")}
                  data-testid="select-quote-pricing-method"
                >
                  <option value="CATALOG_PRICE">Precio de Lista de Catálogo</option>
                  <option value="COST_MARGIN">Costo Base + Margen Objetivo</option>
                </select>
              </label>

              {pricingMethod === "COST_MARGIN" && (
                <label>
                  Margen Objetivo (Decimal)
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="0.99"
                    value={targetMargin}
                    onChange={(e) => setTargetMargin(e.target.value)}
                    required
                    data-testid="input-quote-margin"
                  />
                </label>
              )}

              <label>
                Días de Validez
                <input
                  type="number"
                  min="1"
                  max="180"
                  value={validityDays}
                  onChange={(e) => setValidityDays(Number(e.target.value))}
                  required
                  data-testid="input-quote-validity"
                />
              </label>
            </div>

            <label>
              Notas de la Oferta
              <input
                type="text"
                value={quoteNotes}
                onChange={(e) => setQuoteNotes(e.target.value)}
                placeholder="Ej. Despacho incluido en 10 días calendario tras aprobación"
                data-testid="input-quote-notes"
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowCreateModal(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                data-testid="button-submit-create-quotation"
              >
                {busy ? "Calculando..." : "Generar Cotización y PDF"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL APROBAR COTIZACIÓN CON ARCHIVO */}
      {showApproveModal && (
        <div className="panel" style={{ border: "2px solid #14655e" }} data-testid="modal-approve-quotation">
          <h3>Registrar Aprobación del Cliente con Evidencia</h3>
          <p className="muted">
            Adjunte el documento escaneado, carta, correo en PDF o captura de aceptación firmada por el comprador.
          </p>

          {approveError && <p role="alert" style={{ marginBottom: "1rem" }}>{approveError}</p>}

          <form onSubmit={handleApproveSubmit} className="stack">
            <label>
              Archivo de Evidencia (PDF, PNG, JPG)
              <input
                type="file"
                accept=".pdf,image/png,image/jpeg"
                onChange={(e: ChangeEvent<HTMLInputElement>) => {
                  setApprovalFile(e.target.files?.[0] ?? null);
                }}
                required
                data-testid="input-approve-evidence-file"
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowApproveModal(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy || !approvalFile}
                data-testid="button-submit-approve"
              >
                {busy ? "Guardando..." : "Aprobar Cotización Formal"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL RECHAZAR */}
      {showRejectModal && (
        <div className="panel" style={{ border: "2px solid #972e2e" }} data-testid="modal-reject-quotation">
          <h3>Rechazar Cotización</h3>
          <p className="muted">Indique la justificación comercial o técnica del rechazo.</p>

          {rejectError && <p role="alert" style={{ marginBottom: "1rem" }}>{rejectError}</p>}

          <form onSubmit={handleRejectSubmit} className="stack">
            <label>
              Motivo de Rechazo
              <input
                type="text"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Ej. Cliente seleccionó competidor por plazo de entrega"
                required
                data-testid="input-reject-reason"
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowRejectModal(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="secondary"
                style={{ background: "#972e2e", color: "#fff" }}
                disabled={busy}
                data-testid="button-submit-reject"
              >
                {busy ? "Procesando..." : "Confirmar Rechazo"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL NUEVA VERSIÓN V2 */}
      {showVersionModal && selectedQuotation && (
        <div className="panel" style={{ border: "2px solid #27a6b8" }} data-testid="modal-v2-quotation">
          <h3>Nueva Versión (v{selectedQuotation.version + 1}) por Cambio de Medidas</h3>
          <p className="muted">
            Los identificadores físicos de cada cabina se conservan estrictamente para trazabilidad y garantía (DEC-051).
          </p>

          {v2Error && <p role="alert" style={{ marginBottom: "1rem" }}>{v2Error}</p>}

          <form onSubmit={handleVersionSubmit} className="stack">
            {v2Cabins.map((c, idx) => {
              const orig = selectedQuotation.cabins?.find((origC) => origC.cabinId === c.cabinId);
              return (
                <div
                  key={c.cabinId}
                  style={{
                    padding: "1rem",
                    border: "1px solid #d5e2e4",
                    borderRadius: "8px",
                    background: "#fcfdfe",
                  }}
                  data-testid={`v2-cabin-row-${idx}`}
                >
                  <p><strong>{orig?.locationTag ?? `Cabina ${idx + 1}`} ({orig?.productName})</strong></p>
                  <div className="form-grid">
                    <label>
                      Ancho ajustado (cm)
                      <input
                        type="number"
                        step="0.1"
                        value={c.customWidth}
                        onChange={(e) => {
                          const copy = [...v2Cabins];
                          copy[idx]!.customWidth = e.target.value;
                          setV2Cabins(copy);
                        }}
                        data-testid={`input-v2-width-${idx}`}
                      />
                    </label>
                    <label>
                      Alto ajustado (cm)
                      <input
                        type="number"
                        step="0.1"
                        value={c.customHeight}
                        onChange={(e) => {
                          const copy = [...v2Cabins];
                          copy[idx]!.customHeight = e.target.value;
                          setV2Cabins(copy);
                        }}
                        data-testid={`input-v2-height-${idx}`}
                      />
                    </label>
                  </div>
                  <label style={{ marginTop: "0.5rem" }}>
                    Acabado
                    <input
                      type="text"
                      value={c.finish}
                      onChange={(e) => {
                        const copy = [...v2Cabins];
                        copy[idx]!.finish = e.target.value;
                        setV2Cabins(copy);
                      }}
                      data-testid={`input-v2-finish-${idx}`}
                    />
                  </label>
                </div>
              );
            })}

            <label>
              Notas de la Versión
              <input
                type="text"
                value={v2Notes}
                onChange={(e) => setV2Notes(e.target.value)}
                placeholder="Ej. Ajuste de medidas según levantamiento topográfico de vanos"
                data-testid="input-v2-notes"
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowVersionModal(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                data-testid="button-submit-v2"
              >
                {busy ? "Recalculando..." : "Crear Nueva Versión"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL NOTA DE AJUSTE */}
      {showAdjustmentModal && selectedQuotation && (
        <div className="panel" style={{ border: "2px solid #14655e" }} data-testid="modal-adjustment-note">
          <h3>Registrar Nota de Ajuste a Cotización Aprobada</h3>
          <p className="muted">
            Los aumentos requieren aprobación del cliente con evidencia (DEC-044); las reducciones son autorizadas por coordinación (DEC-052).
          </p>

          {adjError && <p role="alert" style={{ marginBottom: "1rem" }}>{adjError}</p>}

          <form onSubmit={handleAdjustmentSubmit} className="stack">
            <div className="form-grid">
              <label>
                Tipo de Ajuste
                <select
                  value={adjType}
                  onChange={(e) => setAdjType(e.target.value as "INCREASE" | "DECREASE")}
                  data-testid="select-adj-type"
                >
                  <option value="DECREASE">Reducción / Descuento comercial</option>
                  <option value="INCREASE">Aumento por alcance adicional</option>
                </select>
              </label>

              <label>
                Importe del Ajuste ({selectedQuotation.currency})
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={adjAmount}
                  onChange={(e) => setAdjAmount(e.target.value)}
                  placeholder="50000"
                  required
                  data-testid="input-adj-amount"
                />
              </label>
            </div>

            <label>
              Justificación / Motivo
              <input
                type="text"
                value={adjReason}
                onChange={(e) => setAdjReason(e.target.value)}
                placeholder="Ej. Adición de sellamiento hermético solicitado por interventoría"
                required
                data-testid="input-adj-reason"
              />
            </label>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
              <button
                type="button"
                className="secondary"
                onClick={() => setShowAdjustmentModal(false)}
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={busy}
                data-testid="button-submit-adj"
              >
                {busy ? "Registrando..." : "Crear Nota de Ajuste"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL AUTORIZAR AJUSTE (AUMENTO O REDUCCIÓN) */}
      {pendingAdjId && selectedQuotation && (() => {
        const targetAdj = selectedQuotation.adjustments?.find((a) => a.id === pendingAdjId);
        const isInc = targetAdj?.adjustmentType === "INCREASE";
        return (
          <div className="panel" style={{ border: `2px solid ${isInc ? "#dfc46d" : "#14655e"}` }} data-testid="modal-approve-adjustment">
            <h3>{isInc ? "Autorizar Aumento con Evidencia de Aceptación del Cliente" : "Autorizar Reducción Comercial"}</h3>
            <p className="muted">
              {isInc
                ? "Por política obligatoria DEC-044, ningún incremento de precio comercial entra en vigor sin documento probatorio del cliente."
                : "Por política DEC-052, las reducciones son autorizadas internamente por coordinación/administración sin requerir nueva aprobación del cliente."}
            </p>

            {adjApproveError && <p role="alert" style={{ marginBottom: "1rem" }}>{adjApproveError}</p>}

            <form onSubmit={handleApproveAdjustmentSubmit} className="stack">
              <label>
                {isInc ? "Carta o Correo de Aceptación del Cliente (Obligatorio)" : "Evidencia o Soporte Interno Opcional (PDF, PNG, JPG)"}
                <input
                  type="file"
                  accept=".pdf,image/png,image/jpeg"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setAdjEvidenceFile(e.target.files?.[0] ?? null);
                  }}
                  required={isInc}
                  data-testid="input-adj-evidence-file"
                />
              </label>

              <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1rem" }}>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setPendingAdjId(null)}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={busy || (isInc && !adjEvidenceFile)}
                  data-testid="button-submit-approve-adj"
                >
                  {busy ? "Procesando..." : isInc ? "Confirmar Autorización de Incremento" : "Autorizar Reducción"}
                </button>
              </div>
            </form>
          </div>
        );
      })()}
    </div>
  );
}
