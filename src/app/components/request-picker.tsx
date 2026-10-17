"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useEffect, useId, useState } from "react";
import { apiRequest } from "../../shared/client/api-client";

type RequestOption = { id: string; code: string; clientLegalName?: string };

/** Search the authorized request endpoint; never require report permissions or raw UUIDs. */
export function RequestPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<RequestOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await apiRequest<{ items: RequestOption[]; total: number }>(
          `commercial/requests?search=${encodeURIComponent(search)}&page=${page}&limit=50`,
          "GET", undefined, { signal: controller.signal },
        );
        if (active) { setItems(data.items); setTotal(data.total); }
      } catch (err) {
        if (active) { setItems([]); setError(err instanceof Error ? err.message : "No se pudieron cargar las solicitudes."); }
      } finally { if (active) setLoading(false); }
    }, 200);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [search, page, retry]);
  return <div className="request-picker">
    <label htmlFor={`${id}-search`}>Buscar solicitud</label>
    <input id={`${id}-search`} type="search" value={search} placeholder="Código de solicitud o cliente"
      onChange={(e) => { setSearch(e.target.value); setPage(1); setLoading(true); onChange(""); }} />
    <label htmlFor={id}>Solicitud comercial</label>
    <select id={id} required value={value} disabled={loading || !!error || items.length === 0} onChange={(e) => onChange(e.target.value)}>
      <option value="">{loading ? "Cargando solicitudes…" : items.length ? "Selecciona una solicitud" : "No hay solicitudes disponibles"}</option>
      {items.map((item) => <option key={item.id} value={item.id}>{item.code}{item.clientLegalName ? ` · ${item.clientLegalName}` : ""}</option>)}
    </select>
    {error && <div role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry((r) => r + 1)}>Reintentar solicitudes</button></div>}
    {total > 50 && <div className="picker-pages">
      <button type="button" className="secondary" disabled={loading || page === 1} onClick={() => { setPage(page - 1); onChange(""); }}>Anterior</button>
      <span>Página {page} de {Math.ceil(total / 50)}</span>
      <button type="button" className="secondary" disabled={loading || page * 50 >= total} onClick={() => { setPage(page + 1); onChange(""); }}>Siguiente</button>
    </div>}
  </div>;
}

export function CabinPicker({ requestId, value, onChange }: { requestId: string; value: string; onChange: (id: string) => void }) {
  const id = useId();
  const [cabins, setCabins] = useState<Array<{ id: string; productName?: string; locationTag?: string | null }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    if (!requestId) return;
    Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true); setError(""); setCabins([]);
      try {
        const detail = await apiRequest<{ cabins: typeof cabins }>(`commercial/requests/${requestId}`);
        if (active) setCabins(detail.cabins);
      } catch (err) { if (active) setError(err instanceof Error ? err.message : "No se pudieron cargar las cabinas."); }
      finally { if (active) setLoading(false); }
    });
    return () => { active = false; };
  }, [requestId, retry]);
  return <div className="request-picker">
    <label htmlFor={id}>Cabina física</label>
    <select id={id} value={value} required disabled={!requestId || loading || !!error} onChange={(e) => onChange(e.target.value)}>
      <option value="">{!requestId ? "Selecciona primero una solicitud" : loading ? "Cargando cabinas…" : "Selecciona la unidad"}</option>
      {requestId && !loading && cabins.map((c, index) => <option key={c.id} value={c.id}>Unidad {index + 1} · {c.productName ?? "Cabina"}{c.locationTag ? ` · ${c.locationTag}` : ""}</option>)}
    </select>
    {error && <div role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry((r) => r + 1)}>Reintentar cabinas</button></div>}
  </div>;
}

type QuotationOption = {
  id: string;
  version: number;
  status: string;
  totalAmount: string;
};

export function QuotationPicker({
  requestId,
  value,
  onChange,
  onlyApproved = false,
}: {
  requestId: string;
  value: string;
  onChange: (id: string) => void;
  onlyApproved?: boolean;
}) {
  const id = useId();
  const [quotations, setQuotations] = useState<QuotationOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    if (!requestId) return;
    Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError("");
      setQuotations([]);
      try {
        const res = await apiRequest<{ items: QuotationOption[] }>(
          `commercial/quotations?requestId=${encodeURIComponent(requestId)}`
        );
        if (active) {
          const list = onlyApproved
            ? (res.items || []).filter((q) => q.status === "APPROVED")
            : res.items || [];
          setQuotations(list);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "No se pudieron cargar las cotizaciones.");
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => { active = false; };
  }, [requestId, retry, onlyApproved]);

  return (
    <div className="request-picker">
      <label htmlFor={id}>Cotización {onlyApproved ? "aprobada" : ""}</label>
      <select
        id={id}
        value={value}
        required
        disabled={!requestId || loading || !!error || quotations.length === 0}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">
          {!requestId
            ? "Selecciona primero una solicitud"
            : loading
            ? "Cargando cotizaciones…"
            : quotations.length === 0
            ? (onlyApproved ? "Sin cotizaciones aprobadas para esta solicitud" : "Sin cotizaciones disponibles")
            : "Selecciona una cotización"}
        </option>
        {quotations.map((q) => (
          <option key={q.id} value={q.id}>
            Versión v{q.version} · ${Number(q.totalAmount).toLocaleString("es-CO")} · {displayLabel(q.status)}
          </option>
        ))}
      </select>
      {requestId && !loading && !error && quotations.length === 0 && (
        <small className="muted" style={{ display: "block", marginTop: "4px" }}>
          ℹ️ {onlyApproved ? "Esta solicitud no tiene cotizaciones en estado APROBADA." : "Esta solicitud no tiene cotizaciones registradas."}
        </small>
      )}
      {error && (
        <div role="alert">
          {error}{" "}
          <button type="button" className="secondary" onClick={() => setRetry((r) => r + 1)}>
            Reintentar cotizaciones
          </button>
        </div>
      )}
    </div>
  );
}

export type ProductOption = {
  id: string;
  sku: string;
  name: string;
  kind: string;
  listPrice: string;
};

export function ProductPicker({
  value,
  onChange,
  kind,
}: {
  value: string;
  onChange: (id: string, product?: ProductOption) => void;
  kind?: string;
}) {
  const id = useId();
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.resolve().then(async () => {
      if (!active) return;
      setLoading(true);
      setError("");
      try {
        const data = await apiRequest<ProductOption[]>("catalog");
        if (active) {
          const list = Array.isArray(data) ? data : [];
          const filtered = kind ? list.filter((p) => p.kind === kind) : list;
          setProducts(filtered);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "No se pudieron cargar los productos.");
      } finally {
        if (active) setLoading(false);
      }
    });
    return () => { active = false; };
  }, [retry, kind]);

  return (
    <div className="request-picker">
      <label htmlFor={id}>Producto del catálogo</label>
      <select
        id={id}
        value={value}
        required
        disabled={loading || !!error || products.length === 0}
        onChange={(e) => {
          const selected = products.find((p) => p.id === e.target.value);
          onChange(e.target.value, selected);
        }}
      >
        <option value="">
          {loading
            ? "Cargando catálogo…"
            : products.length === 0
            ? "No hay productos registrados"
            : "Selecciona un producto"}
        </option>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.sku}) · ${Number(p.listPrice).toLocaleString("es-CO")}
          </option>
        ))}
      </select>
      {error && (
        <div role="alert">
          {error}{" "}
          <button type="button" className="secondary" onClick={() => setRetry((r) => r + 1)}>
            Reintentar catálogo
          </button>
        </div>
      )}
    </div>
  );
}
