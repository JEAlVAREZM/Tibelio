"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useState, useEffect, type FormEvent } from "react";
import type {
  SupplierDto,
  PurchaseOrderDto,
} from "../../shared/contracts/operations";
import { RequestPicker, QuotationPicker, ProductPicker } from "../components/request-picker";
import { MasterEditor } from "../components/master-editor";
import { hasTenantActionPermission, type SessionActorDto } from "../../shared/contracts/commercial";
import { apiRequest } from "../../shared/client/api-client";

interface ProcurementViewProps {
  readOnly?: boolean;
  actor?: SessionActorDto;
}

export function ProcurementView({ readOnly = false, actor }: ProcurementViewProps) {
  const canManageSuppliers = hasTenantActionPermission(actor, "suppliers.manage", readOnly);
  const [subTab, setSubTab] = useState<"suppliers" | "orders" | "reviews">("suppliers");
  const [suppliers, setSuppliers] = useState<SupplierDto[]>([]);
  const [orders, setOrders] = useState<PurchaseOrderDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Formulario Proveedor
  const [supName, setSupName] = useState("");
  const [supTaxId, setSupTaxId] = useState("");
  const [supContact, setSupContact] = useState("");
  const [supEmail, setSupEmail] = useState("");
  const [supPhone, setSupPhone] = useState("");
  const [supNotes, setSupNotes] = useState("");

  // Formulario Orden de Compra
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const [orderNotes, setOrderNotes] = useState("");
  const [orderLines, setOrderLines] = useState<Array<{ productId: string; quantity: number; unitCost: string; notes: string }>>([
    { productId: "", quantity: 1, unitCost: "10000.00", notes: "" },
  ]);

  // Formulario Recepción
  const [receivingOrderId, setReceivingOrderId] = useState<string | null>(null);
  const [receiveAmounts, setReceiveAmounts] = useState<Record<string, number>>({});

  // Formulario Revisión
  const [reviewReqId, setReviewReqId] = useState("");
  const [reviewQuotId, setReviewQuotId] = useState("");
  const [reviewStatus, setReviewStatus] = useState<"APPROVED" | "REJECTED">("APPROVED");
  const [reviewNotes, setReviewNotes] = useState("");

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [supRes, ordRes] = await Promise.all([
        apiRequest<SupplierDto[]>("procurement/suppliers?activeOnly=false"),
        apiRequest<PurchaseOrderDto[]>("procurement/orders"),
      ]);
      setSuppliers(supRes);
      setOrders(ordRes);
    } catch {
      setError("Error al cargar datos de compras y proveedores.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiRequest<SupplierDto[]>("procurement/suppliers?activeOnly=false"),
      apiRequest<PurchaseOrderDto[]>("procurement/orders"),
    ])
      .then(([supRes, ordRes]) => {
        if (cancelled) return;
        setSuppliers(supRes);
        setOrders(ordRes);
      })
      .catch(() => {
        if (!cancelled) setError("Error al cargar datos de compras y proveedores.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreateSupplier(e: FormEvent) {
    e.preventDefault();
    if (readOnly) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/procurement/suppliers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: supName,
          taxId: supTaxId || null,
          contactName: supContact || null,
          email: supEmail || null,
          phone: supPhone || null,
          notes: supNotes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al crear proveedor");
      setMessage(`Proveedor '${supName}' registrado exitosamente.`);
      setSupName("");
      setSupTaxId("");
      setSupContact("");
      setSupEmail("");
      setSupPhone("");
      setSupNotes("");
      void loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleCreateOrder(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !selectedSupplierId) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/procurement/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supplierId: selectedSupplierId,
          notes: orderNotes || null,
          lines: orderLines.map((l) => ({
            productId: l.productId,
            quantity: Number(l.quantity),
            unitCost: l.unitCost,
            notes: l.notes || null,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al crear orden de compra");
      setMessage(`Orden de compra '${data.data.code}' generada exitosamente.`);
      setOrderNotes("");
      void loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleReceiveOrder(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !receivingOrderId) return;
    setError(null);
    setMessage(null);
    try {
      const lines = Object.entries(receiveAmounts).map(([orderLineId, qty]) => ({
        orderLineId,
        quantityReceived: Number(qty),
      }));

      const res = await fetch(`/api/v1/procurement/orders/${receivingOrderId}/receive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al recibir orden");
      setMessage(`Recepción de orden completada (Estado: ${displayLabel(data.data.status)}). Existencias actualizadas en bodega.`);
      setReceivingOrderId(null);
      setReceiveAmounts({});
      void loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleReviewQuotation(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !reviewReqId || !reviewQuotId) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/procurement/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: reviewReqId,
          quotationId: reviewQuotId,
          status: reviewStatus,
          notes: reviewNotes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al emitir revisión");
      setMessage(`Revisión de compras registrada como ${displayLabel(data.data.status)}. Habilita la elegibilidad de despacho si fue aprobada.`);
      setReviewNotes("");
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack" data-testid="procurement-view-container">
      <div className="panel">
        <div className="workspace-header">
          <div>
            <span className="eyebrow">ABASTECIMIENTO Y COMPRAS (FASE 3.1)</span>
            <h2>Gestión de Proveedores y Órdenes</h2>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className={`button-sm ${subTab === "suppliers" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("suppliers")}
            >
              Proveedores
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "orders" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("orders")}
            >
              Órdenes de Compra
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "reviews" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("reviews")}
            >
              Revisión de Cotizaciones
            </button>
          </div>
        </div>

        {error && <p role="alert" style={{ color: "#d32f2f", marginTop: "1rem" }}>{error}</p>}
        {message && <p role="status" style={{ color: "#2e7d32", marginTop: "1rem" }}>{message}</p>}
      </div>

      {subTab === "suppliers" && (
        <div className="two-columns">
          {canManageSuppliers && <form className="panel stack" onSubmit={handleCreateSupplier}>
            <h3>Registrar Proveedor</h3>
            <label>
              Nombre Comercial / Razón Social *
              <input
                type="text"
                value={supName}
                onChange={(e) => setSupName(e.target.value)}
                required
                disabled={readOnly}
                placeholder="Ej. Vidrios y Perfiles de Antioquia S.A.S."
              />
            </label>
            <div className="form-grid">
              <label>
                NIT / Identificación
                <input
                  type="text"
                  value={supTaxId}
                  onChange={(e) => setSupTaxId(e.target.value)}
                  disabled={readOnly}
                  placeholder="900.123.456-7"
                />
              </label>
              <label>
                Contacto
                <input
                  type="text"
                  value={supContact}
                  onChange={(e) => setSupContact(e.target.value)}
                  disabled={readOnly}
                  placeholder="Carlos Gómez"
                />
              </label>
            </div>
            <div className="form-grid">
              <label>
                Correo Electrónico
                <input
                  type="email"
                  value={supEmail}
                  onChange={(e) => setSupEmail(e.target.value)}
                  disabled={readOnly}
                  placeholder="ventas@proveedor.com"
                />
              </label>
              <label>
                Teléfono
                <input
                  type="text"
                  value={supPhone}
                  onChange={(e) => setSupPhone(e.target.value)}
                  disabled={readOnly}
                  placeholder="300 123 4567"
                />
              </label>
            </div>
            <label>
              Notas
              <textarea
                value={supNotes}
                onChange={(e) => setSupNotes(e.target.value)}
                disabled={readOnly}
                rows={2}
              />
            </label>
            <button type="submit" disabled={readOnly}>Guardar Proveedor</button>
          </form>}

          <div className="panel stack">
            <h3>Proveedores Registrados ({suppliers.length})</h3>
            {loading ? (
              <p className="muted">Cargando proveedores...</p>
            ) : suppliers.length === 0 ? (
              <p className="muted">No hay proveedores registrados aún.</p>
            ) : (
              <div className="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>NIT</th>
                      <th>Contacto</th>
                      <th>Teléfono</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.map((s) => (
                      <tr key={s.id}>
                        <td><strong>{s.name}</strong></td>
                        <td>{s.taxId || "—"}</td>
                        <td>{s.contactName || "—"}</td>
                        <td>{s.phone || "—"}</td>
                        <td>
                          <span className={`tag-badge ${s.active ? "success" : "muted"}`}>
                            {s.active ? "Activo" : "Inactivo"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {subTab === "suppliers" && canManageSuppliers && <MasterEditor kind="suppliers" items={suppliers} onSaved={loadData} loading={loading} />}
      {subTab === "orders" && (
        <div className="stack">
          <div className="two-columns">
            <form className="panel stack" onSubmit={handleCreateOrder}>
              <h3>Crear Orden de Compra (OC)</h3>
              <label>
                Proveedor *
                <select
                  value={selectedSupplierId}
                  onChange={(e) => setSelectedSupplierId(e.target.value)}
                  required
                  disabled={readOnly}
                >
                  <option value="">Selecciona un proveedor...</option>
                  {suppliers.filter((s) => s.active).map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>

              <fieldset>
                <legend>Líneas de la Orden</legend>
                {orderLines.map((line, idx) => (
                  <div key={idx} className="form-grid" style={{ marginBottom: "0.5rem" }}>
                    <div>
                      <ProductPicker
                        value={line.productId}
                        onChange={(prodId, prod) => {
                          const copy = [...orderLines];
                          copy[idx]!.productId = prodId;
                          if (prod && !copy[idx]!.unitCost) {
                            copy[idx]!.unitCost = prod.listPrice;
                          }
                          setOrderLines(copy);
                        }}
                      />
                    </div>
                    <label>
                      Cantidad
                      <input
                        type="number"
                        min="1"
                        value={line.quantity}
                        onChange={(e) => {
                          const copy = [...orderLines];
                          copy[idx]!.quantity = Number(e.target.value);
                          setOrderLines(copy);
                        }}
                        required
                        disabled={readOnly}
                      />
                    </label>
                    <label>
                      Costo Unitario
                      <input
                        type="text"
                        value={line.unitCost}
                        onChange={(e) => {
                          const copy = [...orderLines];
                          copy[idx]!.unitCost = e.target.value;
                          setOrderLines(copy);
                        }}
                        required
                        disabled={readOnly}
                      />
                    </label>
                  </div>
                ))}
              </fieldset>

              <label>
                Notas de la Orden
                <textarea
                  value={orderNotes}
                  onChange={(e) => setOrderNotes(e.target.value)}
                  disabled={readOnly}
                  rows={2}
                />
              </label>
              <button type="submit" disabled={readOnly}>Generar Orden de Compra</button>
            </form>

            <div className="panel stack">
              <h3>Órdenes de Compra Emitidas ({orders.length})</h3>
              {orders.length === 0 ? (
                <p className="muted">No hay órdenes emitidas.</p>
              ) : (
                <div className="table-responsive">
                  <table>
                    <thead>
                      <tr>
                        <th>Código</th>
                        <th>Proveedor</th>
                        <th>Estado</th>
                        <th>Fecha</th>
                        <th>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orders.map((o) => (
                        <tr key={o.id}>
                          <td><strong>{o.code}</strong></td>
                          <td>{o.supplierName}</td>
                          <td>
                            <span className="tag-badge secondary">{displayLabel(o.status)}</span>
                          </td>
                          <td>{new Date(o.createdAt).toLocaleDateString()}</td>
                          <td>
                            {o.status !== "RECEIVED" && o.status !== "CANCELLED" && (
                              <button
                                type="button"
                                className="button-sm primary"
                                onClick={() => {
                                  setReceivingOrderId(o.id);
                                  const initialAmounts: Record<string, number> = {};
                                  o.lines?.forEach((l) => {
                                    initialAmounts[l.id] = Number(l.pendingQuantity);
                                  });
                                  setReceiveAmounts(initialAmounts);
                                }}
                              >
                                Recibir
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {receivingOrderId && (
            <form className="panel stack highlight-panel" onSubmit={handleReceiveOrder}>
              <h3>Recepción de Mercancía — Orden {orders.find((o) => o.id === receivingOrderId)?.code}</h3>
              <p className="muted">
                Registra la cantidad recibida por línea. Al confirmar, las cantidades ingresan atómicamente a bodega
                y generan el asiento inmutable en el libro de movimientos.
              </p>
              {orders
                .find((o) => o.id === receivingOrderId)
                ?.lines?.map((l) => (
                  <div key={l.id} className="form-grid">
                    <div>
                      <strong>{l.productName || l.productId}</strong>
                      <div className="muted">Solicitado: {l.quantity} | Ya recibido: {l.receivedQuantity} | Pendiente: {l.pendingQuantity}</div>
                    </div>
                    <label>
                      Cantidad a Recibir Ahora
                      <input
                        type="number"
                        min="1"
                        max={Number(l.pendingQuantity)}
                        value={receiveAmounts[l.id] ?? Number(l.pendingQuantity)}
                        onChange={(e) =>
                          setReceiveAmounts({
                            ...receiveAmounts,
                            [l.id]: Number(e.target.value),
                          })
                        }
                        required
                        disabled={readOnly}
                      />
                    </label>
                  </div>
                ))}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="submit" disabled={readOnly}>Confirmar Entrada a Bodega</button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setReceivingOrderId(null)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {subTab === "reviews" && (
        <form className="panel stack" onSubmit={handleReviewQuotation} style={{ maxWidth: "600px" }}>
          <h3>Revisión de Compras por Cotización Aprobada</h3>
          <p className="muted">
            Toda cotización aprobada debe pasar obligatoriamente por revisión de compras antes de habilitarse para
            despacho, incluso si ya existe stock disponible en bodega (Fase 3.1).
          </p>
          <RequestPicker
            value={reviewReqId}
            onChange={(reqId) => {
              setReviewReqId(reqId);
              setReviewQuotId("");
            }}
          />
          <QuotationPicker
            requestId={reviewReqId}
            value={reviewQuotId}
            onChange={setReviewQuotId}
            onlyApproved
          />
          <label>
            Dictamen de Compras *
            <select
              value={reviewStatus}
              onChange={(e) => setReviewStatus(e.target.value as "APPROVED" | "REJECTED")}
              disabled={readOnly}
            >
              <option value="APPROVED">APROBADO (Materiales y capacidad verificados)</option>
              <option value="REJECTED">RECHAZADO (Requiere ajuste de compras)</option>
            </select>
          </label>
          <label>
            Notas u Observaciones
            <textarea
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
              disabled={readOnly}
              rows={3}
              placeholder="Observaciones de capacidad o especificaciones"
            />
          </label>
          <button type="submit" disabled={readOnly}>Registrar Dictamen de Compras</button>
        </form>
      )}
    </div>
  );
}
