"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useState, type FormEvent } from "react";
import {
  parseClientDecimal,
  type CommercialRequestDto,
  type ClientDto,
  type ProductDto,
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

interface NewCabinRow {
  productId: string;
  locationTag: string;
  finish: string;
  customWidth: string;
  customHeight: string;
  notes: string;
}

interface NewItemRow {
  productId: string;
  quantity: number;
  notes: string;
}

export function RequestsView({
  clients,
  catalog,
  readOnly,
  capabilities,
  onCreateQuotation,
  onReload,
}: {
  clients: ClientDto[];
  catalog: ProductDto[];
  readOnly: boolean;
  capabilities: CommercialCapabilities;
  onCreateQuotation?: (requestId: string) => void;
  onReload?: () => void;
}) {
  const [requests, setRequests] = useState<CommercialRequestDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [search, setSearch] = useState("");
  const [selectedRequest, setSelectedRequest] = useState<CommercialRequestDto | null>(null);

  // Modal de creación
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Form State
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [requestPriority, setRequestPriority] = useState<"LOW" | "NORMAL" | "HIGH" | "URGENT">("NORMAL");
  const [requestNotes, setRequestNotes] = useState("");
  const [cabins, setCabins] = useState<NewCabinRow[]>([
    {
      productId: "",
      locationTag: "Baño Principal",
      finish: "Aluminio Negro Mate",
      customWidth: "120",
      customHeight: "200",
      notes: "",
    },
  ]);
  const [items, setItems] = useState<NewItemRow[]>([]);

  const cabinProducts = catalog.filter((p) => p.kind === "CABIN" && p.active);
  const accessoryProducts = catalog.filter(
    (p) => (p.kind === "ACCESSORY" || p.kind === "MATERIAL") && p.active,
  );

  const selectedClient = clients.find((c) => c.id === selectedClientId);
  const clientAddresses = selectedClient?.addresses ?? [];

  const loadRequests = async () => {
    if (!capabilities.canReadRequests) {
      setForbidden(true);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const qParams = new URLSearchParams();
      if (statusFilter !== "ALL") qParams.set("status", statusFilter);
      if (search.trim()) qParams.set("search", search.trim());
      const res = await api<{ items: CommercialRequestDto[]; total: number }>(
        `commercial/requests?${qParams.toString()}`,
      );
      setRequests(res.items);
    } catch (err: unknown) {
      const e = err as ApiError;
      if (e.code === "FORBIDDEN" || e.status === 403) {
        setForbidden(true);
      } else {
        setError(e.message || "Error al cargar solicitudes comerciales.");
      }
    } finally {
      setLoading(false);
    }
  };

  useState(() => {
    void loadRequests();
  });

  const handleOpenCreate = () => {
    setSelectedClientId(clients[0]?.id ?? "");
    setSelectedAddressId(clients[0]?.addresses?.[0]?.id ?? "");
    setRequestNotes("");
    setCabins([
      {
        productId: cabinProducts[0]?.id ?? "",
        locationTag: "Baño Principal",
        finish: "Aluminio Negro Mate",
        customWidth: "120",
        customHeight: "200",
        notes: "",
      },
    ]);
    setItems([]);
    setCreateError(null);
    setShowCreateModal(true);
  };

  const handleClientChange = (cId: string) => {
    setSelectedClientId(cId);
    const cli = clients.find((c) => c.id === cId);
    setSelectedAddressId(cli?.addresses?.[0]?.id ?? "");
  };

  const addCabinRow = () => {
    setCabins([
      ...cabins,
      {
        productId: cabinProducts[0]?.id ?? "",
        locationTag: `Baño ${cabins.length + 1}`,
        finish: "Aluminio Negro Mate",
        customWidth: "90",
        customHeight: "195",
        notes: "",
      },
    ]);
  };

  const removeCabinRow = (idx: number) => {
    if (cabins.length <= 1) return;
    setCabins(cabins.filter((_, i) => i !== idx));
  };

  const updateCabin = (idx: number, field: keyof NewCabinRow, val: string) => {
    const copy = [...cabins];
    copy[idx] = { ...copy[idx]!, [field]: val };
    setCabins(copy);
  };

  const addItemRow = () => {
    setItems([
      ...items,
      {
        productId: accessoryProducts[0]?.id ?? "",
        quantity: 1,
        notes: "",
      },
    ]);
  };

  const removeItemRow = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, field: keyof NewItemRow, val: unknown) => {
    const copy = [...items];
    copy[idx] = { ...copy[idx]!, [field]: val };
    setItems(copy);
  };

  const handleCreateSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !capabilities.canCreateRequests) return;

    if (!selectedClientId) {
      setCreateError("Debe seleccionar un cliente.");
      return;
    }
    if (!selectedAddressId) {
      setCreateError("Debe seleccionar una dirección de obra para el cliente.");
      return;
    }
    if (cabins.length === 0) {
      setCreateError("Debe agregar al menos una cabina física a la solicitud.");
      return;
    }

    for (let i = 0; i < cabins.length; i++) {
      const c = cabins[i]!;
      if (c.customWidth && parseClientDecimal(c.customWidth) === null) {
        setCreateError(`El ancho de la cabina #${i + 1} no es válido. Ingrese un valor numérico (ej. 120 o 120,5).`);
        return;
      }
      if (c.customHeight && parseClientDecimal(c.customHeight) === null) {
        setCreateError(`El alto de la cabina #${i + 1} no es válido. Ingrese un valor numérico (ej. 195 o 195,5).`);
        return;
      }
    }

    setBusy(true);
    setCreateError(null);
    try {
      const payload = {
        clientId: selectedClientId,
        clientAddressId: selectedAddressId,
        priority: requestPriority,
        notes: requestNotes.trim() || null,
        cabins: cabins.map((c) => ({
          productId: c.productId,
          locationTag: c.locationTag.trim() || null,
          finish: c.finish.trim() || null,
          customWidth: c.customWidth ? parseClientDecimal(c.customWidth) : null,
          customHeight: c.customHeight ? parseClientDecimal(c.customHeight) : null,
          notes: c.notes.trim() || null,
        })),
        items: items.map((it) => ({
          productId: it.productId,
          quantity: Number(it.quantity),
          notes: it.notes.trim() || null,
        })),
      };

      await api<CommercialRequestDto>("commercial/requests", "POST", payload);
      setShowCreateModal(false);
      await loadRequests();
      onReload?.();
    } catch (err: unknown) {
      const e = err as ApiError;
      setCreateError(e.message || "Error al crear la solicitud comercial.");
    } finally {
      setBusy(false);
    }
  };

  const handleUpdatePriority = async (
    requestId: string,
    newPriority: "LOW" | "NORMAL" | "HIGH" | "URGENT",
  ) => {
    try {
      const updated = await api<CommercialRequestDto>(`commercial/requests/${requestId}/priority`, "PATCH", {
        priority: newPriority,
      });
      setSelectedRequest((prev) => (prev ? { ...prev, priority: updated.priority } : null));
      await loadRequests();
    } catch (err: unknown) {
      const e = err as ApiError;
      setError(e.message || "Error al actualizar la prioridad.");
    }
  };

  const viewRequestDetail = async (id: string) => {
    try {
      const req = await api<CommercialRequestDto>(`commercial/requests/${id}`);
      setSelectedRequest(req);
    } catch (err: unknown) {
      const e = err as ApiError;
      setError(e.message || "No se pudo cargar el detalle de la solicitud.");
    }
  };

  if (forbidden) {
    return (
      <div className="panel" data-testid="requests-forbidden">
        <p role="alert">🔒 No tienes permisos para consultar solicitudes de obra (requests.read).</p>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="commercial-requests-container">
      <div className="panel">
        <div className="workspace-header">
          <div>
            <span className="eyebrow">OBRAS Y ESPECIFICACIONES FÍSICAS</span>
            <h2>Solicitudes Multicabina</h2>
          </div>
          {capabilities.canCreateRequests && !readOnly && (
            <button
              type="button"
              onClick={handleOpenCreate}
              data-testid="button-new-request"
            >
              + Nueva Solicitud de Obra
            </button>
          )}
        </div>

        {/* Barra de filtros */}
        <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <input
            type="text"
            placeholder="Buscar por código SOL o cliente..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: "320px" }}
            data-testid="input-search-requests"
          />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ maxWidth: "200px" }}
            data-testid="select-filter-status"
          >
            <option value="ALL">Todos los Estados</option>
            <option value="DRAFT">Borrador (DRAFT)</option>
            <option value="QUOTED">Cotizada (QUOTED)</option>
            <option value="CANCELLED">Cancelada (CANCELLED)</option>
          </select>
          <button
            type="button"
            className="secondary button-sm"
            onClick={() => void loadRequests()}
            data-testid="button-refresh-requests"
          >
            Actualizar
          </button>
        </div>

        {error && <p role="alert" style={{ marginBottom: "1rem" }}>{error}</p>}

        {loading ? (
          <p className="muted" data-testid="requests-loading">Cargando solicitudes...</p>
        ) : requests.length === 0 ? (
          <p className="muted" data-testid="requests-empty">No se encontraron solicitudes registradas.</p>
        ) : (
          <div className="table-scroll">
            <table data-testid="table-requests">
              <thead>
                <tr>
                  <th>Código</th>
                  <th>Cliente</th>
                  <th>Dirección de Obra</th>
                  <th>Municipio</th>
                  <th>Cabinas</th>
                  <th>Prioridad</th>
                  <th>Estado</th>
                  <th>Fecha</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} data-testid={`request-row-${r.code}`}>
                    <td style={{ fontWeight: 700 }}>{r.code}</td>
                    <td>{r.clientLegalName}</td>
                    <td>{r.clientAddressText}</td>
                    <td>{r.municipalityName}</td>
                    <td>
                      <span className="tag-badge">
                        {r.cabinsCount ?? r.cabins?.length ?? 1} cabinas
                      </span>
                    </td>
                    <td>
                      <span
                        className={`tag-badge ${
                          r.priority === "URGENT"
                            ? "warning"
                            : r.priority === "HIGH"
                              ? "secondary"
                              : ""
                        }`}
                      >
                        {displayLabel(r.priority ?? "NORMAL")}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`tag-badge ${
                          r.status === "QUOTED"
                            ? ""
                            : r.status === "DRAFT"
                            ? "secondary"
                            : "warning"
                        }`}
                      >
                        {displayLabel(r.status)}
                      </span>
                    </td>
                    <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                    <td>
                      <div style={{ display: "flex", gap: "0.4rem" }}>
                        <button
                          type="button"
                          className="secondary button-sm"
                          onClick={() => void viewRequestDetail(r.id)}
                          data-testid={`btn-view-${r.code}`}
                        >
                          Ver
                        </button>
                        {capabilities.canCreateQuotations && !readOnly && (
                          <button
                            type="button"
                            className="button-sm"
                            onClick={() => onCreateQuotation?.(r.id)}
                            data-testid={`btn-quote-${r.code}`}
                          >
                            Cotizar
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
      </div>

      {/* MODAL DETALLE DE SOLICITUD */}
      {selectedRequest && (
        <div className="panel" style={{ border: "2px solid #14655e" }} data-testid="modal-request-detail">
          <div className="workspace-header">
            <div>
              <span className="eyebrow">EXPEDIENTE DE SOLICITUD</span>
              <h2>{selectedRequest.code} — {selectedRequest.clientLegalName}</h2>
            </div>
            <button
              type="button"
              className="secondary button-sm"
              onClick={() => setSelectedRequest(null)}
              data-testid="btn-close-detail"
            >
              Cerrar
            </button>
          </div>

          <div className="form-grid" style={{ marginBottom: "1.5rem" }}>
            <div>
              <p><strong>Dirección:</strong> {selectedRequest.clientAddressText}</p>
              <p><strong>Municipio:</strong> {selectedRequest.municipalityName}</p>
              <p><strong>Zona de Flete / Instalación:</strong> {selectedRequest.zoneName ?? "Tarifa base"}</p>
            </div>
            <div>
              <p><strong>Estado:</strong> {displayLabel(selectedRequest.status)}</p>
              <p>
                <strong>Prioridad:</strong>{" "}
                <span className="tag-badge">{displayLabel(selectedRequest.priority ?? "NORMAL")}</span>
                {!readOnly && capabilities.canCreateRequests && (
                  <select
                    value={selectedRequest.priority ?? "NORMAL"}
                    onChange={(e) =>
                      void handleUpdatePriority(
                        selectedRequest.id,
                        e.target.value as "LOW" | "NORMAL" | "HIGH" | "URGENT",
                      )
                    }
                    style={{ marginLeft: "0.5rem", width: "auto", display: "inline-block" }}
                  >
                    <option value="LOW">Baja (LOW)</option>
                    <option value="NORMAL">Normal (NORMAL)</option>
                    <option value="HIGH">Alta (HIGH)</option>
                    <option value="URGENT">Urgente (URGENT)</option>
                  </select>
                )}
              </p>
              <p><strong>Revisión:</strong> v{selectedRequest.revision}</p>
              <p><strong>Registrado por:</strong> {selectedRequest.creatorName}</p>
              {selectedRequest.notes && <p><strong>Notas:</strong> {selectedRequest.notes}</p>}
            </div>
          </div>

          <h3>Cabinas Físicas Individuales ({selectedRequest.cabins?.length ?? 0})</h3>
          <div className="table-scroll" style={{ marginBottom: "1.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Ubicación / Etiqueta</th>
                  <th>Modelo</th>
                  <th>Acabado</th>
                  <th>Dimensiones</th>
                  <th>Estado</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {selectedRequest.cabins?.map((c, idx) => (
                  <tr key={c.id}>
                    <td>{idx + 1}</td>
                    <td><strong>{c.locationTag ?? "Sin etiqueta"}</strong></td>
                    <td>{c.productName}</td>
                    <td>{c.finish ?? "Estándar"}</td>
                    <td>
                      {c.customWidth && c.customHeight
                        ? `${c.customWidth} x ${c.customHeight} cm`
                        : "Medidas estándar"}
                    </td>
                    <td>
                      <span className={`tag-badge ${c.active ? "" : "warning"}`}>
                        {c.active ? "ACTIVA" : "RETIRADA"}
                      </span>
                    </td>
                    <td className="muted">{c.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedRequest.items && selectedRequest.items.length > 0 && (
            <>
              <h3>Ítems Complementarios y Accesorios</h3>
              <div className="table-scroll" style={{ marginBottom: "1.5rem" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Concepto</th>
                      <th>Tipo</th>
                      <th>Cantidad</th>
                      <th>Notas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRequest.items.map((it) => (
                      <tr key={it.id}>
                        <td>{it.productName}</td>
                        <td><span className="tag-badge secondary">{displayLabel(it.productKind)}</span></td>
                        <td>{it.quantity}</td>
                        <td className="muted">{it.notes ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem" }}>
            {capabilities.canCreateQuotations && !readOnly && (
              <button
                type="button"
                onClick={() => {
                  const reqId = selectedRequest.id;
                  setSelectedRequest(null);
                  onCreateQuotation?.(reqId);
                }}
                data-testid="btn-quote-from-detail"
              >
                Generar Cotización
              </button>
            )}
          </div>
        </div>
      )}

      {/* MODAL CREAR NUEVA SOLICITUD */}
      {showCreateModal && (
        <div className="panel" style={{ border: "2px solid #27a6b8" }} data-testid="modal-create-request">
          <div className="workspace-header">
            <div>
              <span className="eyebrow">NUEVA SOLICITUD</span>
              <h2>Especificación Multicabina de Obra</h2>
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
            <div className="form-grid">
              <label>
                Cliente
                <select
                  value={selectedClientId}
                  onChange={(e) => handleClientChange(e.target.value)}
                  required
                  data-testid="select-request-client"
                >
                  <option value="">Seleccione cliente...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.legalName} ({c.taxId})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Dirección de la Obra
                <select
                  value={selectedAddressId}
                  onChange={(e) => setSelectedAddressId(e.target.value)}
                  required
                  data-testid="select-request-address"
                >
                  <option value="">Seleccione dirección...</option>
                  {clientAddresses.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.address} — {a.municipalityName}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Prioridad de Atención
                <select
                  value={requestPriority}
                  onChange={(e) => setRequestPriority(e.target.value as typeof requestPriority)}
                  data-testid="select-request-priority"
                >
                  <option value="LOW">Baja (LOW)</option>
                  <option value="NORMAL">Normal (NORMAL)</option>
                  <option value="HIGH">Alta (HIGH)</option>
                  <option value="URGENT">Urgente (URGENT)</option>
                </select>
              </label>
            </div>

            <label>
              Notas Generales de la Obra
              <input
                type="text"
                value={requestNotes}
                onChange={(e) => setRequestNotes(e.target.value)}
                placeholder="Ej. Pisos 14 y 15, accesos por ascensor de carga, requiere arnés"
                data-testid="input-request-notes"
              />
            </label>

            {/* SECCIÓN CABINAS */}
            <div style={{ marginTop: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h3>Cabinas Físicas Requeridas ({cabins.length})</h3>
                <button
                  type="button"
                  className="secondary button-sm"
                  onClick={addCabinRow}
                  data-testid="button-add-cabin-row"
                >
                  + Agregar Cabina
                </button>
              </div>

              {cabins.map((c, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: "1rem",
                    border: "1px solid #d5e2e4",
                    borderRadius: "8px",
                    marginBottom: "0.75rem",
                    background: "#fcfdfe",
                  }}
                  data-testid={`cabin-form-row-${idx}`}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                    <strong>Cabina #{idx + 1}</strong>
                    {cabins.length > 1 && (
                      <button
                        type="button"
                        className="secondary button-sm"
                        style={{ color: "#972e2e" }}
                        onClick={() => removeCabinRow(idx)}
                      >
                        Quitar
                      </button>
                    )}
                  </div>

                  <div className="form-grid">
                    <label>
                      Modelo de Cabina
                      <select
                        value={c.productId}
                        onChange={(e) => updateCabin(idx, "productId", e.target.value)}
                        required
                        data-testid={`select-cabin-product-${idx}`}
                      >
                        <option value="">Seleccione modelo...</option>
                        {cabinProducts.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.sku})
                          </option>
                        ))}
                      </select>
                    </label>

                    <label>
                      Etiqueta / Ubicación en Obra
                      <input
                        type="text"
                        value={c.locationTag}
                        onChange={(e) => updateCabin(idx, "locationTag", e.target.value)}
                        placeholder="Ej. Baño Principal Piso 14"
                        required
                        data-testid={`input-cabin-tag-${idx}`}
                      >
                      </input>
                    </label>
                  </div>

                  <div className="form-grid" style={{ marginTop: "0.5rem" }}>
                    <label>
                      Acabado de Perfilería y Herrajes
                      <input
                        type="text"
                        value={c.finish}
                        onChange={(e) => updateCabin(idx, "finish", e.target.value)}
                        placeholder="Ej. Aluminio Negro Mate, Cromado"
                        data-testid={`input-cabin-finish-${idx}`}
                      />
                    </label>

                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <label style={{ flex: 1 }}>
                        Ancho (cm)
                        <input
                          type="number"
                          step="0.1"
                          value={c.customWidth}
                          onChange={(e) => updateCabin(idx, "customWidth", e.target.value)}
                          placeholder="120"
                          data-testid={`input-cabin-width-${idx}`}
                        />
                      </label>
                      <label style={{ flex: 1 }}>
                        Alto (cm)
                        <input
                          type="number"
                          step="0.1"
                          value={c.customHeight}
                          onChange={(e) => updateCabin(idx, "customHeight", e.target.value)}
                          placeholder="200"
                          data-testid={`input-cabin-height-${idx}`}
                        />
                      </label>
                    </div>
                  </div>

                  <label style={{ marginTop: "0.5rem" }}>
                    Observaciones Técnicas de la Cabina
                    <input
                      type="text"
                      value={c.notes}
                      onChange={(e) => updateCabin(idx, "notes", e.target.value)}
                      placeholder="Ej. Desnivel de 5mm en piso, muro izquierdo en drywall reforzado"
                      data-testid={`input-cabin-notes-${idx}`}
                    />
                  </label>
                </div>
              ))}
            </div>

            {/* SECCIÓN ACCESORIOS */}
            <div style={{ marginTop: "1rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <h3>Accesorios y Materiales Adicionales ({items.length})</h3>
                <button
                  type="button"
                  className="secondary button-sm"
                  onClick={addItemRow}
                  data-testid="button-add-item-row"
                >
                  + Agregar Ítem
                </button>
              </div>

              {items.map((it, idx) => (
                <div
                  key={idx}
                  style={{
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                    marginBottom: "0.5rem",
                  }}
                  data-testid={`item-form-row-${idx}`}
                >
                  <select
                    value={it.productId}
                    onChange={(e) => updateItem(idx, "productId", e.target.value)}
                    required
                    style={{ flex: 3 }}
                    data-testid={`select-item-product-${idx}`}
                  >
                    <option value="">Seleccione accesorio/material...</option>
                    {accessoryProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.sku})
                      </option>
                    ))}
                  </select>

                  <input
                    type="number"
                    min="1"
                    value={it.quantity}
                    onChange={(e) => updateItem(idx, "quantity", e.target.value)}
                    style={{ flex: 1 }}
                    required
                    data-testid={`input-item-qty-${idx}`}
                  />

                  <input
                    type="text"
                    value={it.notes}
                    onChange={(e) => updateItem(idx, "notes", e.target.value)}
                    placeholder="Notas"
                    style={{ flex: 2 }}
                    data-testid={`input-item-notes-${idx}`}
                  />

                  <button
                    type="button"
                    className="secondary button-sm"
                    style={{ color: "#972e2e" }}
                    onClick={() => removeItemRow(idx)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginTop: "1.5rem" }}>
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
                data-testid="btn-submit-request"
              >
                {busy ? "Guardando..." : "Crear Solicitud de Obra"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
