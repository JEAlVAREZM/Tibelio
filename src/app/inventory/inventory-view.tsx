"use client";
import { displayLabel, searchText } from "../../shared/contracts/ui-labels";

import { useState, useEffect, type FormEvent } from "react";
import type {
  StockItemDto,
  CabinStockDto,
  InventoryMovementDto,
  DispatchEligibilityDto,
} from "../../shared/contracts/operations";
import { RequestPicker, QuotationPicker } from "../components/request-picker";

interface InventoryViewProps {
  readOnly?: boolean;
}

export function InventoryView({ readOnly = false }: InventoryViewProps) {
  const [subTab, setSubTab] = useState<"stock" | "cabins" | "movements" | "dispatch">("stock");
  const [stock, setStock] = useState<StockItemDto[]>([]);
  const [cabins, setCabins] = useState<CabinStockDto[]>([]);
  const [movements, setMovements] = useState<InventoryMovementDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [search,setSearch]=useState("");
  const matches=(...fields:unknown[])=>searchText(fields.join(" ")).includes(searchText(search));
  const visibleStock=stock.filter(item=>matches(item.productName,item.productSku,displayLabel(item.productKind)));
  const visibleCabins=cabins.filter(item=>matches(...Object.values(item),displayLabel(item.status)));
  const visibleMovements=movements.filter(item=>matches(...Object.values(item),displayLabel(item.movementType)));

  // Formulario Ajuste de Stock
  const [adjustProdId, setAdjustProdId] = useState("");
  const [adjustType, setAdjustType] = useState<"ADJUSTMENT" | "DAMAGE" | "RETURN">("ADJUSTMENT");
  const [adjustDelta, setAdjustDelta] = useState("1");
  const [adjustReason, setAdjustReason] = useState("");

  // Despacho
  const [dispReqId, setDispReqId] = useState("");
  const [eligibility, setEligibility] = useState<DispatchEligibilityDto | null>(null);
  const [dispQuotId, setDispQuotId] = useState("");
  const [dispNotes, setDispNotes] = useState("");

  // Actualización de estado de cabina física
  const [editingCabin, setEditingCabin] = useState<CabinStockDto | null>(null);
  const [cabinNewStatus, setCabinNewStatus] = useState<CabinStockDto["status"]>("IN_STOCK");
  const [cabinLocation, setCabinLocation] = useState("");
  const [cabinNotes, setCabinNotes] = useState("");

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const [stockRes, cabinsRes, movRes] = await Promise.all([
        fetch("/api/v1/inventory/stock").then((r) => r.json()),
        fetch("/api/v1/inventory/cabins").then((r) => r.json()),
        fetch("/api/v1/inventory/movements").then((r) => r.json()),
      ]);
      if (stockRes.data) setStock(stockRes.data);
      if (cabinsRes.data) setCabins(cabinsRes.data);
      if (movRes.data) setMovements(movRes.data);
    } catch {
      setError("Error al cargar datos de inventario.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/v1/inventory/stock").then((r) => r.json()),
      fetch("/api/v1/inventory/cabins").then((r) => r.json()),
      fetch("/api/v1/inventory/movements").then((r) => r.json()),
    ])
      .then(([stockRes, cabinsRes, movRes]) => {
        if (cancelled) return;
        if (stockRes.data) setStock(stockRes.data);
        if (cabinsRes.data) setCabins(cabinsRes.data);
        if (movRes.data) setMovements(movRes.data);
      })
      .catch(() => {
        if (!cancelled) setError("Error al cargar datos de inventario.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleAdjustStock(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !adjustProdId) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/inventory/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: adjustProdId,
          movementType: adjustType,
          quantityDelta: Number(adjustDelta),
          reason: adjustReason,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al ajustar inventario");
      setMessage(`Ajuste aplicado correctamente. Nuevo saldo: ${data.data.quantity}`);
      setAdjustReason("");
      void loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleCheckEligibility(e: FormEvent) {
    e.preventDefault();
    if (!dispReqId) return;
    setError(null);
    setMessage(null);
    setEligibility(null);
    try {
      const res = await fetch(`/api/v1/inventory/dispatch/eligibility?requestId=${dispReqId}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al consultar elegibilidad");
      setEligibility(data.data);
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleExecuteDispatch(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !dispReqId || !dispQuotId) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/inventory/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: dispReqId,
          quotationId: dispQuotId,
          notes: dispNotes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al despachar");
      setMessage(`Despacho '${data.data.id}' ejecutado exitosamente. Cabinas y accesorios descontados.`);
      setDispNotes("");
      setEligibility(null);
      void loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  async function handleUpdateCabinStatus(e: FormEvent) {
    e.preventDefault();
    if (readOnly || !editingCabin) return;
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/v1/inventory/cabins/${editingCabin.cabinId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: cabinNewStatus,
          location: cabinLocation || null,
          notes: cabinNotes || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error al actualizar estado de cabina");
      setMessage(`Estado de cabina física actualizado correctamente.`);
      setEditingCabin(null);
      void loadData();
    } catch (err: unknown) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="stack" data-testid="inventory-view-container">
      <div className="panel">
        <div className="workspace-header">
          <div>
            <span className="eyebrow">BODEGA Y LOGÍSTICA (FASES 3.2 & 3.3)</span>
            <h2>Existencias, Movimientos y Despacho</h2>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className={`button-sm ${subTab === "stock" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("stock")}
            >
              Existencias Generales
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "cabins" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("cabins")}
            >
              Cabinas Físicas
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "movements" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("movements")}
            >
              Libro de Movimientos
            </button>
            <button
              type="button"
              className={`button-sm ${subTab === "dispatch" ? "primary" : "secondary"}`}
              onClick={() => setSubTab("dispatch")}
            >
              Despacho a Obra
            </button>
          </div>
        </div>

        {error && <p role="alert" style={{ color: "#d32f2f", marginTop: "1rem" }}>{error}</p>}
        {message && <p role="status" style={{ color: "#2e7d32", marginTop: "1rem" }}>{message}</p>}
        {subTab!=="dispatch" && <label className="search-toolbar">Buscar en inventario<input type="search" value={search} placeholder="Producto, SKU, cabina, solicitud o estado…" onChange={e=>setSearch(e.target.value)} /></label>}
        {search.trim() && subTab!=="dispatch" && <p role="status">{(subTab==="stock" ? visibleStock : subTab==="cabins" ? visibleCabins : visibleMovements).length} resultados para «{search}».</p>}
      </div>

      {subTab === "stock" && (
        <div className="two-columns">
          <div className="panel stack">
            <h3>Existencias en Bodega ({stock.length})</h3>
            {loading ? (
              <p className="muted">Cargando existencias...</p>
            ) : stock.length === 0 ? (
              <p className="muted">No hay existencias registradas en bodega.</p>
            ) : (
              <div className="table-responsive">
                <table>
                  <thead>
                    <tr>
                      <th>Producto</th>
                      <th>SKU</th>
                      <th>Tipo</th>
                      <th>Disponible</th>
                      <th>Actualizado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleStock.map((item) => (
                      <tr key={item.productId}>
                        <td><strong>{item.productName}</strong></td>
                        <td>{item.productSku}</td>
                        <td><span className="tag-badge secondary">{displayLabel(item.productKind)}</span></td>
                        <td><strong>{item.quantity}</strong></td>
                        <td>{new Date(item.updatedAt).toLocaleDateString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <form className="panel stack" onSubmit={handleAdjustStock}>
            <h3>Ajuste Justificado de Bodega</h3>
            <p className="muted">
              Cualquier modificación de saldo genera un asiento inmutable con autor y motivo. Las existencias
              nunca pueden quedar en valores negativos (DEC-029).
            </p>
            <label>
              Producto *
              <select
                value={adjustProdId}
                onChange={(e) => setAdjustProdId(e.target.value)}
                required
                disabled={readOnly}
              >
                <option value="">Selecciona un producto...</option>
                {stock.filter(s=>s.productId===adjustProdId || matches(s.productName,s.productSku,displayLabel(s.productKind))).map((s) => (
                  <option key={s.productId} value={s.productId}>
                    {s.productName} ({s.productSku}) — Saldo actual: {s.quantity}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tipo de Movimiento *
              <select
                value={adjustType}
                onChange={(e) => setAdjustType(e.target.value as "ADJUSTMENT" | "DAMAGE" | "RETURN")}
                disabled={readOnly}
              >
                <option value="ADJUSTMENT">Ajuste de inventario</option>
                <option value="DAMAGE">Baja por daño / avería</option>
                <option value="RETURN">Devolución a bodega</option>
              </select>
            </label>
            <label>
              Variación de Cantidad (+ o -) *
              <input
                type="number"
                value={adjustDelta}
                onChange={(e) => setAdjustDelta(e.target.value)}
                required
                disabled={readOnly}
                placeholder="Ej. -1 o 2"
              />
            </label>
            <label>
              Motivo Justificado *
              <textarea
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                required
                disabled={readOnly}
                rows={2}
                placeholder="Explicación detallada de la discrepancia o daño"
              />
            </label>
            <button type="submit" disabled={readOnly}>Registrar Movimiento en Bodega</button>
          </form>
        </div>
      )}

      {subTab === "cabins" && (
        <div className="panel stack">
          <h3>Identidad Física de Cabinas en Stock ({cabins.length})</h3>
          <p className="muted">
            Cada cabina física existe individualmente para trazabilidad y garantía (DEC-012, DEC-051). Se
            identifica mediante su etiqueta física única sin sustituirla por totales agregados.
          </p>
          {cabins.length === 0 ? (
            <p className="muted">No hay cabinas físicas registradas en bodega actualmente.</p>
          ) : (
            <div className="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>Identificador Físico</th>
                    <th>Solicitud</th>
                    <th>Modelo</th>
                    <th>Estado</th>
                    <th>Ubicación</th>
                    <th>Actualizado</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleCabins.map((c) => (
                    <tr key={c.cabinId}>
                      <td>
                        <span className="tag-badge primary" style={{ fontFamily: "monospace", fontSize: "0.85rem" }}>
                          CAB-{c.cabinId.slice(0, 8).toUpperCase()}
                        </span>
                        <div className="muted" style={{ fontSize: "0.75rem", marginTop: "2px" }} title={c.cabinId}>
                          {c.cabinId}
                        </div>
                      </td>
                      <td>{c.requestCode || c.requestId}</td>
                      <td><strong>{c.productName}</strong></td>
                      <td>
                        <span
                          className={`tag-badge ${
                            c.status === "IN_STOCK"
                              ? "success"
                              : c.status === "DISPATCHED"
                                ? "secondary"
                                : c.status === "DAMAGED"
                                  ? "warning"
                                  : ""
                          }`}
                        >
                          {displayLabel(c.status)}
                        </span>
                      </td>
                      <td>{c.location || "Bodega Central"}</td>
                      <td>{new Date(c.updatedAt).toLocaleDateString()}</td>
                      <td>
                        {!readOnly && (
                          <button
                            type="button"
                            className="button-sm secondary"
                            onClick={() => {
                              setEditingCabin(c);
                              setCabinNewStatus(c.status);
                              setCabinLocation(c.location || "");
                              setCabinNotes(c.notes || "");
                            }}
                          >
                            Estado
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {editingCabin && (
            <form className="panel highlight-panel stack" onSubmit={handleUpdateCabinStatus}>
              <h4>Actualizar Estado de Cabina Física ({editingCabin.cabinId.slice(0, 8)})</h4>
              <div className="form-grid">
                <label>
                  Nuevo Estado *
                  <select
                    value={cabinNewStatus}
                    onChange={(e) => setCabinNewStatus(e.target.value as typeof cabinNewStatus)}
                  >
                    <option value="IN_STOCK">En Bodega (IN_STOCK)</option>
                    <option value="ASSIGNED">Asignada a Obra (ASSIGNED)</option>
                    <option value="DISPATCHED">Despachada (DISPATCHED)</option>
                    <option value="RETURNED">Devuelta de Obra (RETURNED)</option>
                    <option value="DAMAGED">Dañada / Averiada (DAMAGED)</option>
                    <option value="MAINTENANCE">En Mantenimiento (MAINTENANCE)</option>
                  </select>
                </label>
                <label>
                  Ubicación Físico-Espacial
                  <input
                    type="text"
                    value={cabinLocation}
                    onChange={(e) => setCabinLocation(e.target.value)}
                    placeholder="Ej. Bahía B-04 / Obra San Jerónimo"
                  />
                </label>
              </div>
              <label>
                Notas / Motivo de Daño o Devolución
                <input
                  type="text"
                  value={cabinNotes}
                  onChange={(e) => setCabinNotes(e.target.value)}
                  placeholder="Detalles sobre rotura, devolución o mantenimiento"
                />
              </label>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button type="submit" className="button-sm primary">
                  Guardar Estado
                </button>
                <button
                  type="button"
                  className="button-sm secondary"
                  onClick={() => setEditingCabin(null)}
                >
                  Cancelar
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {subTab === "movements" && (
        <div className="panel stack">
          <h3>Libro Diario de Movimientos de Inventario ({movements.length})</h3>
          <p className="muted">
            Registro inmutable: sin borrado físico ni edición silenciosa de saldos (DEC-029).
          </p>
          {movements.length === 0 ? (
            <p className="muted">No hay movimientos registrados.</p>
          ) : (
            <div className="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Producto</th>
                    <th>Tipo</th>
                    <th>Cantidad</th>
                    <th>Saldo Anterior</th>
                    <th>Nuevo Saldo</th>
                    <th>Motivo / Referencia</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMovements.map((m) => (
                    <tr key={m.id}>
                      <td>{new Date(m.createdAt).toLocaleString()}</td>
                      <td><strong>{m.productName}</strong></td>
                      <td><span className="tag-badge secondary">{displayLabel(m.movementType)}</span></td>
                      <td><strong>{m.quantity}</strong></td>
                      <td>{m.previousBalance}</td>
                      <td>{m.newBalance}</td>
                      <td className="muted">{m.notes || m.referenceType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === "dispatch" && (
        <div className="two-columns">
          <form className="panel stack" onSubmit={handleCheckEligibility}>
            <h3>1. Evaluar Elegibilidad de Despacho (3.3)</h3>
            <p className="muted">
              El servicio de elegibilidad valida atómicamente: revisión de compras completada, versión aprobada
              vigente, totalidad de piezas físicas en bodega y recaudos validados.
            </p>
            <RequestPicker
              value={dispReqId}
              onChange={(reqId) => {
                setDispReqId(reqId);
                setDispQuotId("");
                setEligibility(null);
              }}
            />
            <button type="submit">Consultar Disponibilidad y Pagos</button>

            {eligibility && (
              <div
                className="panel"
                style={{
                  marginTop: "1rem",
                  borderColor: eligibility.eligible ? "#2e7d32" : "#d32f2f",
                }}
              >
                <h4>
                  {eligibility.eligible ? "✅ Solicitud Elegible para Despacho" : "⛔ Despacho Bloqueado"}
                </h4>
                <p>
                  <strong>Revisión Compras:</strong> {displayLabel(eligibility.reviewStatus)} <br />
                  <strong>Cotización Aprobada:</strong> {eligibility.approvedQuotationVersion ? `v${eligibility.approvedQuotationVersion}` : "Ninguna"} <br />
                  <strong>Estado Financiero:</strong> Recaudado ${eligibility.validatedAmount} / Exigible ${eligibility.payableAmount}
                </p>
                {!eligibility.eligible && eligibility.reasons.length > 0 && (
                  <div>
                    <strong>Causas concretas de bloqueo:</strong>
                    <ul>
                      {eligibility.reasons.map((r, i) => (
                        <li key={i} style={{ color: "#d32f2f" }}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </form>

          <form className="panel stack" onSubmit={handleExecuteDispatch}>
            <h3>2. Confirmar Despacho Físico a Obra</h3>
            <p className="muted">
              El despacho descuenta cabinas y accesorios atómicamente con bloqueo de fila. Dos despachos
              concurrentes no pueden consumir el mismo stock.
            </p>
            <QuotationPicker
              requestId={dispReqId}
              value={dispQuotId}
              onChange={setDispQuotId}
              onlyApproved
            />
            <label>
              Notas de Despacho / Remisión
              <textarea
                value={dispNotes}
                onChange={(e) => setDispNotes(e.target.value)}
                disabled={readOnly}
                rows={2}
                placeholder="Vehículo, transportador o detalles de entrega"
              />
            </label>
            <button type="submit" disabled={readOnly || !eligibility?.eligible}>
              Ejecutar Despacho y Descontar Stock
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
