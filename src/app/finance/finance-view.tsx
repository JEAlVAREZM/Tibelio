"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useState, type FormEvent, type ChangeEvent } from "react";
import type {
  ClientPaymentDto,
  FinancialSummaryDto,
  PaymentTermDto,
  RefundRecordDto,
} from "../../shared/contracts/operations";
import { RequestPicker, QuotationPicker } from "../components/request-picker";

interface FinanceViewProps {
  readOnly?: boolean;
}

interface NewTermRow {
  milestone: "DOWN_PAYMENT" | "MANUFACTURE" | "PRE_DISPATCH" | "DELIVERY" | "FINAL";
  percentage: string;
  amount: string;
  dueDate: string;
  notes: string;
}

export function FinanceView({ readOnly = false }: FinanceViewProps) {
  const [subTab, setSubTab] = useState<"payments" | "terms" | "refunds">("payments");
  const [targetRequestId, setTargetRequestId] = useState("");
  const [payments, setPayments] = useState<ClientPaymentDto[]>([]);
  const [refunds, setRefunds] = useState<RefundRecordDto[]>([]);
  const [summary, setSummary] = useState<FinancialSummaryDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Formulario Registro de Pago
  const [payAmount, setPayAmount] = useState("");
  const [payDate, setPayDate] = useState(new Date().toISOString().slice(0, 10));
  const [payMethod, setPayMethod] = useState<"TRANSFER" | "DEPOSIT" | "CARD" | "CASH" | "OTHER">("TRANSFER");
  const [payRef, setPayRef] = useState("");
  const [payNotes, setPayNotes] = useState("");
  const [receiptBase64, setReceiptBase64] = useState<string | null>(null);
  const [receiptMimeType, setReceiptMimeType] = useState<string | null>(null);
  const [receiptFileName, setReceiptFileName] = useState("");

  // Formulario Validación / Rechazo / Anulación
  const [validatingPayId, setValidatingPayId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [annullingPayId, setAnnullingPayId] = useState<string | null>(null);
  const [annulReason, setAnnulReason] = useState("");

  // Condiciones de Pago
  const [termsQuotationId, setTermsQuotationId] = useState("");
  const [existingTerms, setExistingTerms] = useState<PaymentTermDto[]>([]);
  const [loadingTerms, setLoadingTerms] = useState(false);
  const [termRows, setTermRows] = useState<NewTermRow[]>([
    { milestone: "DOWN_PAYMENT", percentage: "50.00", amount: "", dueDate: "", notes: "Anticipo de inicio" },
    { milestone: "PRE_DISPATCH", percentage: "40.00", amount: "", dueDate: "", notes: "Previo a despacho de bodega" },
    { milestone: "DELIVERY", percentage: "10.00", amount: "", dueDate: "", notes: "Contra entrega en obra" },
  ]);

  // Formulario Reembolso y Desembolso
  const [refAmount, setRefAmount] = useState("");
  const [refReason, setRefReason] = useState("");
  const [disbursingRefId, setDisbursingRefId] = useState<string | null>(null);
  const [disburseReceiptBase64, setDisburseReceiptBase64] = useState<string | null>(null);
  const [disburseReceiptMimeType, setDisburseReceiptMimeType] = useState<string | null>(null);
  const [disburseReceiptFileName, setDisburseReceiptFileName] = useState("");

  // Formulario Cancelación
  const [cancelReason, setCancelReason] = useState("");
  const [internalCosts, setInternalCosts] = useState("0.00");

  async function loadRequestFinance(reqId: string) {
    if (!reqId) return;
    setLoading(true);
    setError(null);
    try {
      const [payRes, sumRes, refRes] = await Promise.all([
        fetch(`/api/v1/finance/payments?requestId=${reqId}`).then((r) => r.json()),
        fetch(`/api/v1/finance/summary?requestId=${reqId}`).then((r) => r.json()),
        fetch(`/api/v1/finance/refunds?requestId=${reqId}`).then((r) => r.json()),
      ]);
      if (payRes.data) setPayments(payRes.data);
      if (sumRes.data) setSummary(sumRes.data);
      if (refRes.data) setRefunds(refRes.data);
    } catch {
      setError("Error al cargar la información financiera de la solicitud.");
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setReceiptBase64(null);
      setReceiptMimeType(null);
      setReceiptFileName("");
      return;
    }
    setReceiptFileName(file.name);
    setReceiptMimeType(file.type || "application/pdf");
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      setReceiptBase64(base64);
    };
    reader.readAsDataURL(file);
  }

  function handleDisburseFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setDisburseReceiptBase64(null);
      setDisburseReceiptMimeType(null);
      setDisburseReceiptFileName("");
      return;
    }
    setDisburseReceiptFileName(file.name);
    setDisburseReceiptMimeType(file.type || "application/pdf");
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      setDisburseReceiptBase64(base64);
    };
    reader.readAsDataURL(file);
  }

  async function handleRegisterPayment(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !targetRequestId) return;
    if (!receiptBase64) {
      setError("El comprobante de pago es estrictamente obligatorio.");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/finance/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: targetRequestId,
          amount: payAmount,
          paymentDate: payDate,
          paymentMethod: payMethod,
          referenceCode: payRef || null,
          notes: payNotes || null,
          receiptBase64,
          receiptMimeType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al registrar pago");
      setMessage("Pago registrado en estado PENDING. Pendiente de validación autorizada.");
      setPayAmount("");
      setPayRef("");
      setPayNotes("");
      setReceiptBase64(null);
      setReceiptFileName("");
      void loadRequestFinance(targetRequestId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleValidate(paymentId: string, status: "VALIDATED" | "REJECTED") {
    if (readOnly) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/finance/payments/${paymentId}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          rejectionReason: status === "REJECTED" ? rejectReason : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al validar pago");
      setMessage(
        status === "VALIDATED"
          ? "Pago validado exitosamente. Se abonó al recaudo de la solicitud."
          : "Pago rechazado con justificación registrada.",
      );
      setValidatingPayId(null);
      setRejectReason("");
      void loadRequestFinance(targetRequestId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleAnnulPayment(paymentId: string) {
    if (readOnly || !annulReason.trim()) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/finance/payments/${paymentId}/annul`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: annulReason.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al anular pago");
      setMessage("Pago anulado formalmente (ANNULLED). No computa en el recaudo neto.");
      setAnnullingPayId(null);
      setAnnulReason("");
      void loadRequestFinance(targetRequestId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function loadTerms(quotationId: string) {
    if (!quotationId) return;
    setLoadingTerms(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/finance/terms?quotationId=${quotationId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al consultar condiciones de pago");
      setExistingTerms(data.data ?? []);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoadingTerms(false);
    }
  }

  async function handleSavePaymentTerms(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !targetRequestId || !termsQuotationId) {
      setError("Debes seleccionar una solicitud y una cotización aprobada.");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const payload = {
        requestId: targetRequestId,
        quotationId: termsQuotationId,
        terms: termRows.map((r) => ({
          milestone: r.milestone,
          percentage: Number(r.percentage),
          amount: r.amount,
          dueDate: r.dueDate || null,
          notes: r.notes || null,
        })),
      };
      const res = await fetch("/api/v1/finance/terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al guardar condiciones de pago");
      setMessage("Condiciones de pago guardadas con nueva versión activa (historial inmutable preservado).");
      void loadTerms(termsQuotationId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleCreateRefund(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !targetRequestId) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/finance/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: targetRequestId,
          amount: refAmount,
          reason: refReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al procesar reembolso");
      setMessage(`Reembolso por $${data.data.amount} autorizado (${displayLabel(data.data.status)}).`);
      setRefAmount("");
      setRefReason("");
      void loadRequestFinance(targetRequestId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleDisburseRefund(refundId: string) {
    if (readOnly || !disburseReceiptBase64) {
      setError("El comprobante de egreso es obligatorio para confirmar el desembolso.");
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/finance/refunds/${refundId}/disburse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptBase64: disburseReceiptBase64,
          receiptMimeType: disburseReceiptMimeType,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al confirmar desembolso");
      setMessage(`Desembolso de reembolso confirmado exitosamente.`);
      setDisbursingRefId(null);
      setDisburseReceiptBase64(null);
      setDisburseReceiptFileName("");
      void loadRequestFinance(targetRequestId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleCancelRequest(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !targetRequestId) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/finance/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: targetRequestId,
          reason: cancelReason,
          internalCosts,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al cancelar solicitud");
      setMessage(`Solicitud cancelada. Devolución computable: $${data.data.refundAmount}.`);
      setCancelReason("");
      void loadRequestFinance(targetRequestId);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack" data-testid="finance-view-container">
      <div className="panel">
        <div className="workspace-header">
          <div>
            <span className="eyebrow">FINANZAS Y RECAUDOS (FASES 3.4 & 3.5)</span>
            <h2>Gestión de Pagos, Condiciones, Saldos y Cierre Financiero</h2>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className={`button-sm ${subTab === "payments" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("payments")}
            >
              Pagos y Recaudos
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "terms" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("terms")}
            >
              Condiciones de Pago
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "refunds" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("refunds")}
            >
              Devoluciones y Cancelación
            </button>
          </div>
        </div>

        <div style={{ marginTop: "1rem" }}>
          <RequestPicker
            value={targetRequestId}
            onChange={(reqId) => {
              setTargetRequestId(reqId);
              setTermsQuotationId("");
              setExistingTerms([]);
              if (reqId) {
                void loadRequestFinance(reqId);
              } else {
                setPayments([]);
                setSummary(null);
                setRefunds([]);
              }
            }}
          />
        </div>

        {error && <p role="alert" style={{ color: "#d32f2f", marginTop: "1rem" }}>{error}</p>}
        {message && <p role="status" style={{ color: "#2e7d32", marginTop: "1rem" }}>{message}</p>}
      </div>

      {summary && (
        <div className="panel" style={{ backgroundColor: "#f8f9fa" }}>
          <h3>Estado de Cuenta de la Solicitud</h3>
          <div className="form-grid">
            <div>
              <span className="muted">Total Cotizado:</span>
              <h4>${summary.quotationTotal}</h4>
            </div>
            <div>
              <span className="muted">Ajustes Efectivos:</span>
              <h4>${summary.effectiveAdjustments}</h4>
            </div>
            <div>
              <span className="muted">Total Exigible:</span>
              <h4 style={{ color: "#1976d2" }}>${summary.totalPayable}</h4>
            </div>
            <div>
              <span className="muted">Pagos Validados:</span>
              <h4 style={{ color: "#2e7d32" }}>${summary.validatedPayments}</h4>
            </div>
            <div>
              <span className="muted">Recaudo Neto:</span>
              <h4 style={{ color: "#00695c" }}>${summary.netCollected}</h4>
            </div>
            <div>
              <span className="muted">Pagos en Revisión (PENDING):</span>
              <h4 style={{ color: "#ed6c02" }}>${summary.pendingPayments}</h4>
            </div>
            <div>
              <span className="muted">Saldo Pendiente:</span>
              <h4 style={{ color: summary.isFullyPaid ? "#2e7d32" : "#d32f2f" }}>
                ${summary.outstandingBalance} {summary.isFullyPaid ? "(100% Cubierto)" : ""}
              </h4>
            </div>
            <div>
              <span className="muted">Crédito Disponible / Sobrepago:</span>
              <h4 style={{ color: "#6a1b9a" }}>${summary.availableCredit}</h4>
            </div>
          </div>
        </div>
      )}

      {subTab === "payments" && (
        <div className="two-columns">
          <form className="panel stack" onSubmit={handleRegisterPayment}>
            <h3>Registrar Pago de Cliente</h3>
            <p className="muted">
              Todo pago inicia en PENDING y exige comprobante digital privado. No se auto-valida al registrarse (DEC-060).
            </p>
            <div className="form-grid">
              <label>
                Importe Pagado *
                <input
                  type="text"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  placeholder="Ej. 500000.00"
                  required
                  disabled={readOnly}
                />
              </label>
              <label>
                Fecha de Pago *
                <input
                  type="date"
                  value={payDate}
                  onChange={(e) => setPayDate(e.target.value)}
                  required
                  disabled={readOnly}
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Método de Pago *
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as typeof payMethod)}
                  disabled={readOnly}
                >
                  <option value="TRANSFER">Transferencia Bancaria</option>
                  <option value="DEPOSIT">Consignación</option>
                  <option value="CARD">Tarjeta Débito / Crédito</option>
                  <option value="CASH">Efectivo en Caja</option>
                  <option value="OTHER">Otro</option>
                </select>
              </label>
              <label>
                Código / Referencia de Transacción
                <input
                  type="text"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="Número de comprobante"
                  disabled={readOnly}
                />
              </label>
            </div>
            <label>
              Comprobante de Pago Obligatorio (PDF / Imagen) *
              <input
                type="file"
                accept="application/pdf,image/png,image/jpeg"
                onChange={handleFileChange}
                required
                disabled={readOnly}
              />
              {receiptFileName && <span className="muted">Archivo: {receiptFileName}</span>}
            </label>
            <label>
              Notas
              <textarea
                value={payNotes}
                onChange={(e) => setPayNotes(e.target.value)}
                disabled={readOnly}
                rows={2}
              />
            </label>
            <button type="submit" disabled={readOnly || !targetRequestId}>
              Registrar Pago (PENDING)
            </button>
          </form>

          <div className="panel stack">
            <h3>Historial de Pagos de la Solicitud ({payments.length})</h3>
            {loading ? (
              <p className="muted">Cargando pagos...</p>
            ) : payments.length === 0 ? (
              <p className="muted">No hay pagos registrados para esta solicitud.</p>
            ) : (
              <div className="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Importe</th>
                      <th>Método</th>
                      <th>Estado</th>
                      <th>Comprobante</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id}>
                        <td>{p.paymentDate}</td>
                        <td><strong>${p.amount}</strong></td>
                        <td>{displayLabel(p.paymentMethod)}</td>
                        <td>
                          <span
                            className={`tag-badge ${
                              p.status === "VALIDATED"
                                ? "success"
                                : p.status === "PENDING"
                                  ? "secondary"
                                  : p.status === "ANNULLED"
                                    ? "warning"
                                    : "muted"
                            }`}
                          >
                            {displayLabel(p.status)}
                          </span>
                        </td>
                        <td>
                          <a
                            href={`/api/v1/finance/payments/${p.id}/receipt`}
                            target="_blank"
                            rel="noreferrer"
                            className="button-sm secondary"
                          >
                            Descargar
                          </a>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
                            {p.status === "PENDING" && !readOnly && (
                              <>
                                <button
                                  type="button"
                                  className="button-sm primary"
                                  onClick={() => void handleValidate(p.id, "VALIDATED")}
                                >
                                  Validar
                                </button>
                                <button
                                  type="button"
                                  className="button-sm secondary"
                                  onClick={() => setValidatingPayId(p.id)}
                                >
                                  Rechazar
                                </button>
                              </>
                            )}
                            {p.status !== "ANNULLED" && !readOnly && (
                              <button
                                type="button"
                                className="button-sm secondary"
                                style={{ color: "#d32f2f" }}
                                onClick={() => setAnnullingPayId(p.id)}
                              >
                                Anular
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {validatingPayId && (
              <div className="panel highlight-panel stack">
                <h4>Rechazar Pago</h4>
                <label>
                  Motivo de Rechazo *
                  <input
                    type="text"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Ej. Comprobante no coincide con extracto bancario"
                    required
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    className="button-sm primary"
                    onClick={() => void handleValidate(validatingPayId, "REJECTED")}
                  >
                    Confirmar Rechazo
                  </button>
                  <button
                    type="button"
                    className="button-sm secondary"
                    onClick={() => setValidatingPayId(null)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {annullingPayId && (
              <div className="panel highlight-panel stack" style={{ borderColor: "#d32f2f" }}>
                <h4>Anular Pago Formalmente</h4>
                <p className="muted">
                  La anulación es irreversible y registra el motivo auditado. No borra físicamente el pago (DEC-029).
                </p>
                <label>
                  Motivo Justificado de Anulación *
                  <input
                    type="text"
                    value={annulReason}
                    onChange={(e) => setAnnulReason(e.target.value)}
                    placeholder="Ej. Cheque devuelto por fondos insuficientes o pago duplicado"
                    required
                  />
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    className="button-sm primary"
                    style={{ backgroundColor: "#d32f2f" }}
                    onClick={() => void handleAnnulPayment(annullingPayId)}
                  >
                    Confirmar Anulación
                  </button>
                  <button
                    type="button"
                    className="button-sm secondary"
                    onClick={() => setAnnullingPayId(null)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "terms" && (
        <div className="two-columns">
          <form className="panel stack" onSubmit={handleSavePaymentTerms}>
            <h3>Definir Hitos y Condiciones de Pago (3.4)</h3>
            <p className="muted">
              Pacta los porcentajes e importes por hito. La suma debe dar exactamente 100% y coincidir con el total cotizado.
              Al guardar, se versiona automáticamente sin borrado físico (DEC-029).
            </p>
            <div>
              <QuotationPicker
                requestId={targetRequestId}
                value={termsQuotationId}
                onChange={(quotId) => {
                  setTermsQuotationId(quotId);
                  if (quotId) void loadTerms(quotId);
                }}
                onlyApproved
              />
            </div>

            <h4>Hitos Programados</h4>
            {termRows.map((row, idx) => (
              <div key={idx} className="panel" style={{ padding: "0.75rem" }}>
                <div className="form-grid">
                  <label>
                    Hito
                    <select
                      value={row.milestone}
                      onChange={(e) => {
                        const copy = [...termRows];
                        copy[idx]!.milestone = e.target.value as NewTermRow["milestone"];
                        setTermRows(copy);
                      }}
                    >
                      <option value="DOWN_PAYMENT">Anticipo (DOWN_PAYMENT)</option>
                      <option value="MANUFACTURE">Fabricación (MANUFACTURE)</option>
                      <option value="PRE_DISPATCH">Previo a Despacho (PRE_DISPATCH)</option>
                      <option value="DELIVERY">Entrega (DELIVERY)</option>
                      <option value="FINAL">Liquidación Final (FINAL)</option>
                    </select>
                  </label>
                  <label>
                    Porcentaje (%)
                    <input
                      type="text"
                      value={row.percentage}
                      onChange={(e) => {
                        const copy = [...termRows];
                        copy[idx]!.percentage = e.target.value;
                        setTermRows(copy);
                      }}
                      placeholder="Ej. 50.00"
                      required
                    />
                  </label>
                  <label>
                    Importe ($)
                    <input
                      type="text"
                      value={row.amount}
                      onChange={(e) => {
                        const copy = [...termRows];
                        copy[idx]!.amount = e.target.value;
                        setTermRows(copy);
                      }}
                      placeholder="Ej. 1500000.00"
                      required
                    />
                  </label>
                </div>
                <div className="form-grid" style={{ marginTop: "0.5rem" }}>
                  <label>
                    Vencimiento Estimado
                    <input
                      type="date"
                      value={row.dueDate}
                      onChange={(e) => {
                        const copy = [...termRows];
                        copy[idx]!.dueDate = e.target.value;
                        setTermRows(copy);
                      }}
                    />
                  </label>
                  <label>
                    Notas
                    <input
                      type="text"
                      value={row.notes}
                      onChange={(e) => {
                        const copy = [...termRows];
                        copy[idx]!.notes = e.target.value;
                        setTermRows(copy);
                      }}
                      placeholder="Observaciones del hito"
                    />
                  </label>
                </div>
              </div>
            ))}

            <button type="submit" disabled={readOnly || !targetRequestId || !termsQuotationId}>
              Guardar Condiciones de Pago (Nueva Versión)
            </button>
          </form>

          <div className="panel stack">
            <h3>Condiciones de Pago Activas ({existingTerms.length})</h3>
            {loadingTerms ? (
              <p className="muted">Cargando condiciones...</p>
            ) : existingTerms.length === 0 ? (
              <p className="muted">No hay condiciones registradas para esta cotización.</p>
            ) : (
              <div className="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>Versión</th>
                      <th>Hito</th>
                      <th>%</th>
                      <th>Importe</th>
                      <th>Vencimiento</th>
                    </tr>
                  </thead>
                  <tbody>
                    {existingTerms.map((t) => (
                      <tr key={t.id}>
                        <td>v{t.version}</td>
                        <td><strong>{displayLabel(t.milestone)}</strong></td>
                        <td>{t.percentage}%</td>
                        <td>${t.amount}</td>
                        <td>{t.dueDate || "Sin fecha fija"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "refunds" && (
        <div className="two-columns">
          <div className="stack">
            <form className="panel stack" onSubmit={handleCreateRefund}>
              <h3>1. Emitir Reembolso por Sobrepago / Reducción (DEC-052)</h3>
              <p className="muted">
                Una nota de reducción con sobrepago genera saldo a favor y obligación de devolución. Se valida que
                el reembolso no supere el crédito disponible ($ {summary?.availableCredit ?? "0.00"}).
              </p>
              <label>
                Importe a Reembolsar *
                <input
                  type="text"
                  value={refAmount}
                  onChange={(e) => setRefAmount(e.target.value)}
                  placeholder="Ej. 150000.00"
                  required
                  disabled={readOnly}
                />
              </label>
              <label>
                Motivo del Reembolso *
                <textarea
                  value={refReason}
                  onChange={(e) => setRefReason(e.target.value)}
                  required
                  disabled={readOnly}
                  rows={2}
                  placeholder="Explicación del saldo a favor o nota comercial aplicada"
                />
              </label>
              <button type="submit" disabled={readOnly || !targetRequestId}>
                Autorizar Reembolso (Obligación de Egreso)
              </button>
            </form>

            <form className="panel stack" onSubmit={handleCancelRequest}>
              <h3>2. Cancelación Integral de Solicitud</h3>
              <p className="muted">
                La cancelación devuelve íntegramente el dinero recibido que corresponda (descontando devoluciones
                previas para evitar doble reembolso). Los costos internos quedan a cargo de la empresa.
              </p>
              <label>
                Motivo Formal de Cancelación *
                <textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  required
                  disabled={readOnly}
                  rows={2}
                  placeholder="Justificación formal de la cancelación"
                />
              </label>
              <label>
                Costos Internos Incurridos (a cargo de la empresa)
                <input
                  type="text"
                  value={internalCosts}
                  onChange={(e) => setInternalCosts(e.target.value)}
                  disabled={readOnly}
                  placeholder="0.00"
                />
              </label>
              <button
                type="submit"
                disabled={readOnly || !targetRequestId}
                style={{ backgroundColor: "#d32f2f", color: "white" }}
              >
                Cancelar Solicitud y Liquidar Devolución
              </button>
            </form>
          </div>

          <div className="panel stack">
            <h3>Registro de Devoluciones y Desembolsos ({refunds.length})</h3>
            {refunds.length === 0 ? (
              <p className="muted">No hay reembolsos registrados para esta solicitud.</p>
            ) : (
              <div className="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Importe</th>
                      <th>Motivo</th>
                      <th>Estado</th>
                      <th>Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {refunds.map((ref) => (
                      <tr key={ref.id}>
                        <td>{new Date(ref.authorizedAt).toLocaleDateString()}</td>
                        <td><strong>${ref.amount}</strong></td>
                        <td className="muted">{ref.reason}</td>
                        <td>
                          <span
                            className={`tag-badge ${
                              ref.status === "DISBURSED" ? "success" : "secondary"
                            }`}
                          >
                            {displayLabel(ref.status)}
                          </span>
                        </td>
                        <td>
                          {ref.status === "AUTHORIZED" && !readOnly && (
                            <button
                              type="button"
                              className="button-sm primary"
                              onClick={() => setDisbursingRefId(ref.id)}
                            >
                              Confirmar Egreso
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {disbursingRefId && (
              <div className="panel highlight-panel stack">
                <h4>Confirmar Desembolso de Reembolso</h4>
                <p className="muted">
                  Adjunta el comprobante bancario o recibo de egreso para asentar la salida de dinero efectiva.
                </p>
                <label>
                  Comprobante de Egreso Obligatorio *
                  <input
                    type="file"
                    accept="application/pdf,image/png,image/jpeg"
                    onChange={handleDisburseFileChange}
                    required
                  />
                  {disburseReceiptFileName && <span className="muted">Archivo: {disburseReceiptFileName}</span>}
                </label>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    type="button"
                    className="button-sm primary"
                    onClick={() => void handleDisburseRefund(disbursingRefId)}
                  >
                    Registrar Egreso Efectivo
                  </button>
                  <button
                    type="button"
                    className="button-sm secondary"
                    onClick={() => {
                      setDisbursingRefId(null);
                      setDisburseReceiptBase64(null);
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
