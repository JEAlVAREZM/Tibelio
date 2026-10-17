"use client";

import { useEffect, useState, type FormEvent } from "react";
import type {
  MunicipalityDto as Municipality,
  ClientDto as Client,
  ZoneDto as Zone,
  ProductDto as Product,
  SessionActorDto,
  CommercialCapabilities,
  CommercialRequestDto,
} from "../shared/contracts/commercial";
import { deriveCommercialCapabilities } from "../shared/contracts/commercial";
import { RequestsView } from "./commercial/requests-view";
import { QuotationsView } from "./commercial/quotations-view";
import { CommercialSettingsView } from "./commercial/settings-view";
import { ProcurementView } from "./procurement/procurement-view";
import { InventoryView } from "./inventory/inventory-view";
import { FinanceView } from "./finance/finance-view";
import { MasterEditor } from "./components/master-editor";

export interface ResourceState<T> {
  data: T;
  loading: boolean;
  error: string | null;
  forbidden: boolean;
}

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

function isForbiddenError(reason: unknown): boolean {
  if (!reason || typeof reason !== "object") return false;
  const r = reason as { code?: string; status?: number; message?: string };
  return (
    r.code === "FORBIDDEN" ||
    r.status === 403 ||
    (typeof r.message === "string" &&
      (r.message.toLowerCase().includes("acceso denegado") ||
        r.message.toLowerCase().includes("no autorizado")))
  );
}

export type CommercialWorkspaceTab =
  | "catalog"
  | "zones"
  | "clients"
  | "requests"
  | "quotations"
  | "procurement"
  | "inventory"
  | "finance"
  | "settings";

export function CommercialWorkspace({
  readOnly = false,
  administrator = false,
  actor,
  activeTab,
  onTabChange,
}: {
  readOnly?: boolean;
  administrator?: boolean;
  actor?: SessionActorDto;
  activeTab?: CommercialWorkspaceTab;
  onTabChange?: (tab: CommercialWorkspaceTab) => void;
}) {
  const [internalTab, setInternalTab] = useState<CommercialWorkspaceTab>(activeTab ?? "catalog");
  const tab = activeTab ?? internalTab;
  const setTab = (newTab: CommercialWorkspaceTab) => {
    setInternalTab(newTab);
    onTabChange?.(newTab);
  };
  const [selectedRequestIdForQuotation, setSelectedRequestIdForQuotation] = useState<string | null>(null);
  const [fetchedActor, setFetchedActor] = useState<SessionActorDto | undefined>(undefined);
  const [municipalities, setMunicipalities] = useState<ResourceState<Municipality[]>>({
    data: [],
    loading: true,
    error: null,
    forbidden: false,
  });
  const [zones, setZones] = useState<ResourceState<Zone[]>>({
    data: [],
    loading: true,
    error: null,
    forbidden: false,
  });
  const [products, setProducts] = useState<ResourceState<Product[]>>({
    data: [],
    loading: true,
    error: null,
    forbidden: false,
  });
  const [clients, setClients] = useState<ResourceState<Client[]>>({
    data: [],
    loading: true,
    error: null,
    forbidden: false,
  });
  const [requests, setRequests] = useState<ResourceState<CommercialRequestDto[]>>({
    data: [],
    loading: true,
    error: null,
    forbidden: false,
  });
  const [revision, setRevision] = useState(0);
  const [listSearch,setListSearch] = useState<Record<string,{search:string;page:number}>>({});
  const listFilter=listSearch[tab] ?? {search:"",page:1};
  const [directoryResult,setDirectoryResult]=useState<{key:string;data:unknown[];error:string|null;forbidden:boolean}|null>(null);
  const directoryKey=`${tab}|${listFilter.search}|${listFilter.page}`;
  const filtering=!!listFilter.search.trim() || listFilter.page>1;
  function directoryState<T>(state:ResourceState<T[]>):ResourceState<T[]> {
    if(!filtering) return state;
    if(directoryResult?.key!==directoryKey) return {data:[],loading:true,error:null,forbidden:false};
    return {...directoryResult,data:directoryResult.data as T[],loading:false};
  }
  useEffect(()=>{
    if(!filtering || !["clients","catalog","zones"].includes(tab)) return;
    let active=true;
    const timer=setTimeout(()=>{ void api<unknown[]>(`${tab}?${new URLSearchParams({search:listFilter.search,page:String(listFilter.page)})}`).then(data=>{
      if(active) setDirectoryResult({key:directoryKey,data,error:null,forbidden:false});
    }).catch(err=>{if(active) setDirectoryResult({key:directoryKey,data:[],error:err.message ?? "No se pudo buscar.",forbidden:isForbiddenError(err)});}); },250);
    return ()=>{active=false;clearTimeout(timer);};
  },[tab,listFilter.search,listFilter.page,directoryKey,filtering,revision]);

  // Filtros
  const [productKindFilter, setProductKindFilter] = useState<string>("ALL");

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([
      api<Municipality[]>("municipalities"),
      api<Zone[]>("zones"),
      api<Product[]>("catalog"),
      api<Client[]>("clients"),
      api<{ items: CommercialRequestDto[]; total: number }>("commercial/requests?limit=100"),
      api<SessionActorDto>("auth/session"),
    ]).then(([munsRes, zonesRes, prodsRes, clientsRes, reqsRes, actorRes]) => {
      if (cancelled) return;

      if (actorRes.status === "fulfilled" && actorRes.value) {
        setFetchedActor(actorRes.value);
      }

      if (munsRes.status === "fulfilled") {
        setMunicipalities({ data: munsRes.value ?? [], loading: false, error: null, forbidden: false });
      } else {
        setMunicipalities({
          data: [],
          loading: false,
          error: munsRes.reason?.message ?? "Error al cargar municipios.",
          forbidden: isForbiddenError(munsRes.reason),
        });
      }

      if (zonesRes.status === "fulfilled") {
        setZones({ data: zonesRes.value ?? [], loading: false, error: null, forbidden: false });
      } else {
        setZones({
          data: [],
          loading: false,
          error: zonesRes.reason?.message ?? "Error al cargar zonas tarifarias.",
          forbidden: isForbiddenError(zonesRes.reason),
        });
      }

      if (prodsRes.status === "fulfilled") {
        setProducts({ data: prodsRes.value ?? [], loading: false, error: null, forbidden: false });
      } else {
        setProducts({
          data: [],
          loading: false,
          error: prodsRes.reason?.message ?? "Error al cargar catálogo de productos.",
          forbidden: isForbiddenError(prodsRes.reason),
        });
      }

      if (clientsRes.status === "fulfilled") {
        setClients({ data: clientsRes.value ?? [], loading: false, error: null, forbidden: false });
      } else {
        setClients({
          data: [],
          loading: false,
          error: clientsRes.reason?.message ?? "Error al cargar directorio de clientes.",
          forbidden: isForbiddenError(clientsRes.reason),
        });
      }

      if (reqsRes.status === "fulfilled") {
        setRequests({
          data: reqsRes.value?.items ?? [],
          loading: false,
          error: null,
          forbidden: false,
        });
      } else {
        setRequests({
          data: [],
          loading: false,
          error: reqsRes.reason?.message ?? "Error al cargar solicitudes de obra.",
          forbidden: isForbiddenError(reqsRes.reason),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [revision]);

  const reloadData = async () => {
    setMunicipalities((s) => ({ ...s, loading: true }));
    setZones((s) => ({ ...s, loading: true }));
    setProducts((s) => ({ ...s, loading: true }));
    setClients((s) => ({ ...s, loading: true }));
    setRequests((s) => ({ ...s, loading: true }));
    setRevision((v) => v + 1);
  };

  const effectiveActor: SessionActorDto | undefined = (actor ?? fetchedActor) ?? (administrator ? {
    userId: "admin-fallback",
    active: true,
    platformRole: "TENANT",
    tenantId: "current",
    authority: "ADMIN",
    rolePermissions: [],
    grants: [],
    denials: [],
  } : undefined);

  const capabilities = deriveCommercialCapabilities(effectiveActor, readOnly);

  return (
    <div className="commercial-module stack">
      <nav className="workspace-tabs" aria-label="Navegación comercial">
        <button
          type="button"
          className={`workspace-tab ${tab === "catalog" ? "active" : ""}`}
          onClick={() => setTab("catalog")}
          data-testid="tab-catalog"
        >
          {products.forbidden ? "🔒" : "📦"} Catálogo de Productos ({products.forbidden ? "Sin acceso" : products.data.length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "zones" ? "active" : ""}`}
          onClick={() => setTab("zones")}
          data-testid="tab-zones"
        >
          {zones.forbidden ? "🔒" : "🗺️"} Zonas Tarifarias ({zones.forbidden ? "Sin acceso" : zones.data.length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "clients" ? "active" : ""}`}
          onClick={() => setTab("clients")}
          data-testid="tab-clients"
        >
          {clients.forbidden ? "🔒" : "👥"} Clientes y Direcciones ({clients.forbidden ? "Sin acceso" : clients.data.length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "requests" ? "active" : ""}`}
          onClick={() => setTab("requests")}
          data-testid="tab-requests"
        >
          {!capabilities.canReadRequests ? "🔒" : "📋"} Solicitudes de Obra ({!capabilities.canReadRequests ? "Sin acceso" : requests.data.length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "quotations" ? "active" : ""}`}
          onClick={() => setTab("quotations")}
          data-testid="tab-quotations"
        >
          {!capabilities.canReadQuotations ? "🔒" : "📄"} Cotizaciones Formales
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "procurement" ? "active" : ""}`}
          onClick={() => setTab("procurement")}
          data-testid="tab-procurement"
        >
          🛒 Compras y Proveedores
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "inventory" ? "active" : ""}`}
          onClick={() => setTab("inventory")}
          data-testid="tab-inventory"
        >
          🏢 Inventario y Despachos
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "finance" ? "active" : ""}`}
          onClick={() => setTab("finance")}
          data-testid="tab-finance"
        >
          💰 Finanzas y Pagos
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "settings" ? "active" : ""}`}
          onClick={() => setTab("settings")}
          data-testid="tab-settings"
        >
          {!capabilities.canManageSettings ? "🔒" : "⚙️"} Configuración Comercial
        </button>
      </nav>

      {["clients","catalog","zones"].includes(tab) && <section className="panel search-toolbar" aria-label="Búsqueda del directorio">
        <label>Buscar {tab==="clients" ? "clientes" : tab==="catalog" ? "productos" : "zonas"}<input type="search" maxLength={160} value={listFilter.search} placeholder={tab==="clients" ? "Nombre, identificación o teléfono…" : tab==="catalog" ? "Nombre o código SKU…" : "Nombre de la zona…"} onChange={e=>setListSearch(s=>({...s,[tab]:{search:e.target.value,page:1}}))} /></label>
        <div className="picker-pages"><button type="button" className="secondary" disabled={listFilter.page===1} onClick={()=>setListSearch(s=>({...s,[tab]:{...listFilter,page:listFilter.page-1}}))}>Anterior</button><span>Página {listFilter.page}</span><button type="button" className="secondary" disabled={directoryState<unknown>(tab==="clients" ? clients : tab==="catalog" ? products : zones).loading || directoryState<unknown>(tab==="clients" ? clients : tab==="catalog" ? products : zones).data.length<200} onClick={()=>setListSearch(s=>({...s,[tab]:{...listFilter,page:listFilter.page+1}}))}>Siguiente</button></div>
      </section>}
      {tab === "catalog" && (
        <CatalogView
          state={directoryState(products)}
          kindFilter={productKindFilter}
          onKindFilterChange={setProductKindFilter}
          readOnly={readOnly}
          canManage={capabilities.canManageCatalog}
          onReload={reloadData}
        />
      )}

      {tab === "zones" && (
        <ZonesView
          state={directoryState(zones)}
          municipalities={municipalities}
          readOnly={readOnly}
          canManage={capabilities.canManageZones}
          onReload={reloadData}
        />
      )}

      {tab === "clients" && (
        <ClientsView
          state={directoryState(clients)}
          municipalities={municipalities}
          readOnly={readOnly}
          capabilities={capabilities}
          onReload={reloadData}
        />
      )}

      {tab === "requests" && (
        <RequestsView
          clients={clients.data}
          catalog={products.data}
          readOnly={readOnly}
          capabilities={capabilities}
          onCreateQuotation={(reqId) => {
            setSelectedRequestIdForQuotation(reqId);
            setTab("quotations");
          }}
          onReload={reloadData}
        />
      )}

      {tab === "quotations" && (
        <QuotationsView
          requests={requests.data}
          readOnly={readOnly}
          capabilities={capabilities}
          initialRequestId={selectedRequestIdForQuotation}
        />
      )}

      {tab === "procurement" && (
        <ProcurementView readOnly={readOnly} actor={effectiveActor} />
      )}

      {tab === "inventory" && (
        <InventoryView readOnly={readOnly} />
      )}

      {tab === "finance" && (
        <FinanceView readOnly={readOnly} />
      )}

      {tab === "settings" && (
        <CommercialSettingsView
          readOnly={readOnly}
          canManage={capabilities.canManageSettings}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------
// 1. VISTA DE CATÁLOGO DE PRODUCTOS
// ------------------------------------------------------------------------------------
function CatalogView({
  state,
  kindFilter,
  onKindFilterChange,
  readOnly,
  canManage,
  onReload,
}: {
  state: ResourceState<Product[]>;
  kindFilter: string;
  onKindFilterChange: (kind: string) => void;
  readOnly: boolean;
  canManage: boolean;
  onReload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [formMsg, setFormMsg] = useState("");
  const [formErr, setFormErr] = useState(false);

  const filtered = state.data.filter((p) => {
    if (kindFilter === "ALL") return true;
    return p.kind === kindFilter;
  });

  async function handleCreateProduct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setFormMsg("");
    setFormErr(false);
    const form = e.currentTarget;
    const fd = new FormData(form);

    try {
      const rawCost = String(fd.get("baseCost") || "").trim();
      const baseCost = rawCost || "0.00";
      const rawPrice = String(fd.get("listPrice") || "").trim();
      const listPrice = rawPrice || "0.00";
      await api("catalog", "POST", {
        kind: fd.get("kind"),
        sku: fd.get("sku"),
        name: fd.get("name"),
        description: fd.get("description") || undefined,
        pricingMethod: fd.get("pricingMethod"),
        baseCost,
        listPrice,
        taxRate: fd.get("taxRate") || "0.000000",
      });
      setFormMsg("Producto registrado en catálogo con éxito.");
      form.reset();
      await onReload();
    } catch (err) {
      setFormErr(true);
      setFormMsg(err instanceof Error ? err.message : "Error al registrar producto.");
    } finally {
      setBusy(false);
    }
  }

  const kindLabel = (kind: string) => {
    switch (kind) {
      case "CABIN":
        return <span className="tag-badge">Cabina</span>;
      case "ACCESSORY":
        return <span className="tag-badge secondary">Accesorio</span>;
      case "MATERIAL":
        return <span className="tag-badge warning">Material</span>;
      default:
        return kind;
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem", flexWrap: "wrap", gap: "1rem" }}>
          <h2>Productos y Acabados de la Empresa</h2>
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: "normal" }}>
            <span>Filtrar por tipo:</span>
            <select
              value={kindFilter}
              onChange={(e) => onKindFilterChange(e.target.value)}
              style={{ width: "auto" }}
            >
              <option value="ALL">Todos los productos</option>
              <option value="CABIN">Solo Cabinas de baño</option>
              <option value="ACCESSORY">Solo Accesorios</option>
              <option value="MATERIAL">Solo Materiales</option>
            </select>
          </label>
        </div>

        {state.loading ? (
          <p className="muted">Cargando productos del catálogo…</p>
        ) : state.forbidden ? (
          <div className="panel notice" role="alert">
            <strong>🔒 Acceso denegado:</strong> Tu rol o usuario no cuenta con el permiso <code>catalog.read</code> para consultar los productos del catálogo.
          </div>
        ) : state.error ? (
          <div className="panel notice" role="alert">
            <strong>⚠️ Error al consultar catálogo:</strong> {state.error}
          </div>
        ) : filtered.length === 0 ? (
          <p className="muted">No hay productos registrados en este filtro.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>SKU</th>
                  <th>Nombre y descripción</th>
                  <th>Método de precio</th>
                  <th>Costo base (DEC-008)</th>
                  <th>Precio de venta</th>
                  <th>IVA</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((prod) => (
                  <tr key={prod.id}>
                    <td>{kindLabel(prod.kind)}</td>
                    <td><code>{prod.sku}</code></td>
                    <td>
                      <strong>{prod.name}</strong>
                      {prod.description && <div className="muted" style={{ fontSize: "0.8rem" }}>{prod.description}</div>}
                    </td>
                    <td>{prod.pricingMethod === "CATALOG_PRICE" ? "Precio de catálogo" : "Costo + margen"}</td>
                    <td>
                      {prod.baseCost !== null ? (
                        <span>${Number(prod.baseCost).toLocaleString("es-CO", { minimumFractionDigits: 2 })}</span>
                      ) : (
                        <span className="muted" title="Oculto por confidencialidad (DEC-008)">🔒 Confidencial</span>
                      )}
                    </td>
                    <td>
                      <strong>${Number(prod.listPrice).toLocaleString("es-CO", { minimumFractionDigits: 2 })}</strong>
                    </td>
                    <td>{(Number(prod.taxRate) * 100).toFixed(0)}%</td>
                    <td>{prod.active ? "Activo" : "Inactivo"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!readOnly && canManage && (
        <form className="panel stack" onSubmit={handleCreateProduct}>
          <h2>Registrar Producto en Catálogo</h2>
          {formMsg && (
            <p className={formErr ? "notice" : "muted"} style={{ fontWeight: 600 }}>
              {formMsg}
            </p>
          )}

          <div className="form-grid">
            <label>
              Tipo de producto *
              <select name="kind" required defaultValue="CABIN">
                <option value="CABIN">Cabina de baño física</option>
                <option value="ACCESSORY">Accesorio complementario</option>
                <option value="MATERIAL">Material / Insumo de obra</option>
              </select>
            </label>

            <label>
              Código SKU *
              <input name="sku" required placeholder="Ej. CAB-TEMPLADA-90" maxLength={60} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Nombre comercial del producto *
              <input name="name" required placeholder="Ej. Cabina Esquinera 90x90 Vidrio Templado 8mm" maxLength={160} />
            </label>

            <label style={{ gridColumn: "1 / -1" }}>
              Descripción / Especificaciones
              <input name="description" placeholder="Vidrio templado transparente, accesorios en acero inoxidable 304" maxLength={1000} />
            </label>

            <label>
              Método de tarificación *
              <select name="pricingMethod" required defaultValue="CATALOG_PRICE">
                <option value="CATALOG_PRICE">Precio de Catálogo fijo</option>
                <option value="COST_MARGIN">Costo más Margen</option>
              </select>
            </label>

            <label>
              Costo base COP (ej. 750000, 750000.00 o 15,50) *
              <input name="baseCost" required defaultValue="0.00" placeholder="750000, 750000.00 o 15,50" />
            </label>

            <label>
              Precio de venta COP (ej. 1200000, 1200000.00 o 25,50) *
              <input name="listPrice" required defaultValue="0.00" placeholder="1200000, 1200000.00 o 25,50" />
            </label>

            <label>
              Tasa de IVA / Impuesto (ej. 0.190000 para 19%) *
              <input name="taxRate" required defaultValue="0.190000" pattern="^0(?:\.\d{1,6})?$" placeholder="0.190000" />
            </label>
          </div>

          <button type="submit" disabled={busy}>
            {busy ? "Guardando…" : "Guardar en catálogo"}
          </button>
        </form>
      )}

      {!readOnly && canManage && <MasterEditor kind="catalog" items={state.data} onSaved={onReload} loading={state.loading} />}
      {!readOnly && !canManage && (
        <p className="muted" style={{ fontStyle: "italic" }}>
          Solo los administradores autorizados pueden agregar productos al catálogo (<code>catalog.manage</code>).
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------
// 2. VISTA DE ZONAS TARIFARIAS Y MUNICIPIOS
// ------------------------------------------------------------------------------------
function ZonesView({
  state,
  municipalities,
  readOnly,
  canManage,
  onReload,
}: {
  state: ResourceState<Zone[]>;
  municipalities: ResourceState<Municipality[]>;
  readOnly: boolean;
  canManage: boolean;
  onReload: () => Promise<void>;
}) {
  const [busyZone, setBusyZone] = useState(false);
  const [zoneMsg, setZoneMsg] = useState("");
  const [zoneErr, setZoneErr] = useState(false);

  const [busyAssign, setBusyAssign] = useState(false);
  const [assignMsg, setAssignMsg] = useState("");
  const [assignErr, setAssignErr] = useState(false);

  async function handleCreateZone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyZone(true);
    setZoneMsg("");
    setZoneErr(false);
    const form = e.currentTarget;
    const fd = new FormData(form);

    try {
      await api("zones", "POST", {
        name: fd.get("name"),
        transportFee: String(fd.get("transportFee") || "0.00").trim(),
        installationFee: String(fd.get("installationFee") || "0.00").trim(),
        targetMargin: fd.get("targetMargin") || "0.250000",
        minimumMargin: fd.get("minimumMargin") || "0.150000",
      });
      setZoneMsg("Zona tarifaria creada con éxito.");
      form.reset();
      await onReload();
    } catch (err) {
      setZoneErr(true);
      setZoneMsg(err instanceof Error ? err.message : "Error al crear zona.");
    } finally {
      setBusyZone(false);
    }
  }

  async function handleAssignMunicipality(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyAssign(true);
    setAssignMsg("");
    setAssignErr(false);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const zoneId = fd.get("zoneId") as string;
    const municipalityId = fd.get("municipalityId") as string;

    try {
      await api(`zones/${zoneId}/municipalities/${municipalityId}`, "POST");
      setAssignMsg("Municipio asignado a la zona correctamente.");
      form.reset();
      await onReload();
    } catch (err) {
      setAssignErr(true);
      setAssignMsg(err instanceof Error ? err.message : "Error al asignar municipio.");
    } finally {
      setBusyAssign(false);
    }
  }

  const [removeMsg, setRemoveMsg] = useState("");
  const [removeErr, setRemoveErr] = useState(false);

  async function handleRemoveMunicipality(zoneId: string, municipalityId: string) {
    if (readOnly || !canManage) return;
    setRemoveMsg("");
    setRemoveErr(false);
    try {
      await api(`zones/${zoneId}/municipalities/${municipalityId}`, "DELETE");
      setRemoveMsg("Municipio desasociado de la zona correctamente.");
      await onReload();
    } catch (err) {
      setRemoveErr(true);
      setRemoveMsg(err instanceof Error ? err.message : "Error al desasociar municipio.");
    }
  }

  return (
    <div className="stack">
      {removeMsg && (
        <div className={`panel notice ${removeErr ? "alert-danger" : ""}`} role={removeErr ? "alert" : "status"} style={{ marginBottom: "1rem" }}>
          <strong>{removeErr ? "⚠️ " : "✓ "}</strong> {removeMsg}
        </div>
      )}
      {municipalities.error && (
        <div className="panel notice" role="alert" style={{ marginBottom: "1rem" }}>
          <strong>⚠️ Error al cargar catálogo de municipios de Antioquia:</strong> {municipalities.error}{" "}
          <button type="button" className="secondary" onClick={onReload} style={{ marginLeft: "0.5rem" }}>
            Reintentar
          </button>
        </div>
      )}

      <section className="panel">
        <h2>Zonas Tarifarias Configuradas</h2>
        <p className="muted" style={{ marginBottom: "1rem" }}>
          Definen fletes de transporte, instalación y márgenes comerciales según el municipio de entrega (Antioquia).
        </p>

        {state.loading ? (
          <p className="muted">Cargando zonas tarifarias…</p>
        ) : state.forbidden ? (
          <div className="panel notice" role="alert">
            <strong>🔒 Acceso denegado:</strong> Tu rol o usuario no cuenta con el permiso requerido para consultar zonas tarifarias (<code>clients.read</code>).
          </div>
        ) : state.error ? (
          <div className="panel notice" role="alert">
            <strong>⚠️ Error al consultar zonas tarifarias:</strong> {state.error}
          </div>
        ) : state.data.length === 0 ? (
          <p className="muted">Todavía no has creado zonas tarifarias para tu empresa.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nombre de Zona</th>
                  <th>Flete Transporte</th>
                  <th>Flete Instalación</th>
                  <th>Margen Objetivo</th>
                  <th>Margen Mínimo</th>
                  <th>Municipios Asignados</th>
                </tr>
              </thead>
              <tbody>
                {state.data.map((zone) => (
                  <tr key={zone.id}>
                    <td><strong>{zone.name}</strong></td>
                    <td>${Number(zone.transportFee ?? zone.transport_fee ?? 0).toLocaleString("es-CO", { minimumFractionDigits: 2 })}</td>
                    <td>${Number(zone.installationFee ?? zone.installation_fee ?? 0).toLocaleString("es-CO", { minimumFractionDigits: 2 })}</td>
                    <td>
                      {zone.targetMargin != null || zone.target_margin != null ? (
                        `${(Number(zone.targetMargin ?? zone.target_margin) * 100).toFixed(1)}%`
                      ) : (
                        <span className="muted">Confidencial</span>
                      )}
                    </td>
                    <td>
                      {zone.minimumMargin != null || zone.minimum_margin != null ? (
                        `${(Number(zone.minimumMargin ?? zone.minimum_margin) * 100).toFixed(1)}%`
                      ) : (
                        <span className="muted">Confidencial</span>
                      )}
                    </td>
                    <td>
                      {zone.municipalities && zone.municipalities.length > 0 ? (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", maxWidth: "400px" }}>
                          {zone.municipalities.map((m) => (
                            <span key={m.id} className="tag-badge">
                              {m.name}
                              {!readOnly && canManage && (
                                <button
                                  type="button"
                                  onClick={() => handleRemoveMunicipality(zone.id, m.id)}
                                  style={{ background: "none", border: "none", color: "#8a2424", cursor: "pointer", marginLeft: "4px", padding: 0, fontWeight: "bold" }}
                                  title="Quitar municipio de esta zona"
                                >
                                  ×
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">Ninguno asignado</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!readOnly && canManage && (
        <div className="form-grid">
          {/* Formulario Crear Zona */}
          <form className="panel stack" onSubmit={handleCreateZone}>
            <h2>Crear Zona Tarifaria</h2>
            {zoneMsg && (
              <p className={zoneErr ? "notice" : "muted"} style={{ fontWeight: 600 }}>
                {zoneMsg}
              </p>
            )}

            <label>
              Nombre de la zona *
              <input name="name" required placeholder="Ej. Área Metropolitana" maxLength={120} />
            </label>

            <label>
              Flete de transporte (COP) *
              <input name="transportFee" required defaultValue="30000.00" placeholder="30000, 30000.00 o 30,50" />
            </label>

            <label>
              Flete de instalación (COP) *
              <input name="installationFee" required defaultValue="50000.00" placeholder="50000, 50000.00 o 50,50" />
            </label>

            <label>
              Margen objetivo comercial (ej. 0.280000 para 28%) *
              <input name="targetMargin" required defaultValue="0.250000" pattern="^0(?:\.\d{1,6})?$" />
            </label>

            <label>
              Margen mínimo permitido (ej. 0.180000 para 18%) *
              <input name="minimumMargin" required defaultValue="0.150000" pattern="^0(?:\.\d{1,6})?$" />
            </label>

            <button type="submit" disabled={busyZone}>
              {busyZone ? "Creando…" : "Crear zona"}
            </button>
          </form>

          {/* Formulario Asignar Municipio a Zona */}
          <form className="panel stack" onSubmit={handleAssignMunicipality}>
            <h2>Asignar Municipio de Antioquia</h2>
            {assignMsg && (
              <p className={assignErr ? "notice" : "muted"} style={{ fontWeight: 600 }}>
                {assignMsg}
              </p>
            )}

            <label>
              Zona tarifaria destino *
              <select name="zoneId" required defaultValue="">
                <option value="">Selecciona una zona…</option>
                {state.data.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Municipio de Antioquia ({municipalities.data.length} disponibles) *
              <select
                name="municipalityId"
                required
                defaultValue=""
                disabled={municipalities.loading || municipalities.data.length === 0 || municipalities.error != null}
              >
                <option value="">
                  {municipalities.loading
                    ? "Cargando municipios de Antioquia…"
                    : municipalities.error
                      ? "Catálogo de municipios no disponible (reintenta)"
                      : municipalities.data.length === 0
                        ? "Sin municipios disponibles"
                        : "Selecciona municipio…"}
                </option>
                {municipalities.data.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.id})
                  </option>
                ))}
              </select>
            </label>

            <button
              type="submit"
              disabled={
                busyAssign ||
                state.data.length === 0 ||
                municipalities.loading ||
                municipalities.data.length === 0 ||
                municipalities.error != null
              }
            >
              {busyAssign ? "Asignando…" : "Asignar municipio a zona"}
            </button>
          </form>
        </div>
      )}

      {!readOnly && canManage && <MasterEditor kind="zones" items={state.data} onSaved={onReload} loading={state.loading} />}
      {!readOnly && !canManage && (
        <p className="muted" style={{ fontStyle: "italic" }}>
          La creación de zonas y asignación de municipios (<code>zones.manage</code>) está reservada al administrador autorizado.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------
// 3. VISTA DE CLIENTES Y LIBRO DE DIRECCIONES
// ------------------------------------------------------------------------------------
function ClientsView({
  state,
  municipalities,
  readOnly,
  capabilities,
  onReload,
}: {
  state: ResourceState<Client[]>;
  municipalities: ResourceState<Municipality[]>;
  readOnly: boolean;
  capabilities: CommercialCapabilities;
  onReload: () => Promise<void>;
}) {
  const [busyClient, setBusyClient] = useState(false);
  const [clientMsg, setClientMsg] = useState("");
  const [clientErr, setClientErr] = useState(false);

  const [busyAddress, setBusyAddress] = useState(false);
  const [addrMsg, setAddrMsg] = useState("");
  const [addrErr, setAddrErr] = useState(false);

  async function handleCreateClient(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyClient(true);
    setClientMsg("");
    setClientErr(false);
    const form = e.currentTarget;
    const fd = new FormData(form);

    try {
      await api("clients", "POST", {
        legalName: fd.get("legalName"),
        taxId: fd.get("taxId"),
        phone: fd.get("phone"),
        email: fd.get("email") || undefined,
        notes: fd.get("notes") || undefined,
        address: {
          municipalityId: fd.get("municipalityId"),
          address: fd.get("address"),
          notes: fd.get("addressNotes") || undefined,
          latitude: fd.get("latitude") || undefined,
          longitude: fd.get("longitude") || undefined,
        },
      });
      setClientMsg("Cliente registrado con éxito con su dirección principal.");
      form.reset();
      await onReload();
    } catch (err) {
      setClientErr(true);
      const isForbid = isForbiddenError(err);
      setClientMsg(
        isForbid
          ? "Acceso denegado: se requiere el permiso clients.create para registrar clientes."
          : err instanceof Error
            ? err.message
            : "Error al registrar cliente.",
      );
    } finally {
      setBusyClient(false);
    }
  }

  async function handleAddAddress(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyAddress(true);
    setAddrMsg("");
    setAddrErr(false);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const clientId = fd.get("clientId") as string;

    try {
      await api(`clients/${clientId}/addresses`, "POST", {
        municipalityId: fd.get("municipalityId"),
        address: fd.get("address"),
        notes: fd.get("notes") || undefined,
        latitude: fd.get("latitude") || undefined,
        longitude: fd.get("longitude") || undefined,
        isPrimary: fd.get("isPrimary") === "on",
      });
      setAddrMsg("Dirección secundaria agregada al cliente con éxito.");
      form.reset();
      await onReload();
    } catch (err) {
      setAddrErr(true);
      const isForbid = isForbiddenError(err);
      setAddrMsg(
        isForbid
          ? "Acceso denegado: se requiere el permiso clients.update para agregar direcciones."
          : err instanceof Error
            ? err.message
            : "Error al agregar dirección.",
      );
    } finally {
      setBusyAddress(false);
    }
  }

  const munName = (id: string) => {
    return municipalities.data.find((m) => m.id === id)?.name ?? id;
  };

  return (
    <div className="stack">
      {municipalities.error && (
        <div className="panel notice" role="alert" style={{ marginBottom: "1rem" }}>
          <strong>⚠️ Error al cargar catálogo de municipios de Antioquia:</strong> {municipalities.error}{" "}
          <button type="button" className="secondary" onClick={onReload} style={{ marginLeft: "0.5rem" }}>
            Reintentar
          </button>
        </div>
      )}

      <section className="panel">
        <h2>Directorio de Clientes de la Empresa</h2>
        <p className="muted" style={{ marginBottom: "1rem" }}>
          Clientes registrados con sus identificaciones tributarias y libro de direcciones en Antioquia.
        </p>

        {state.loading ? (
          <p className="muted">Cargando directorio de clientes…</p>
        ) : state.forbidden ? (
          <div className="panel notice" role="alert">
            <strong>🔒 Acceso denegado:</strong> Tu rol o usuario no cuenta con el permiso <code>clients.read</code> para consultar clientes ni direcciones.
          </div>
        ) : state.error ? (
          <div className="panel notice" role="alert">
            <strong>⚠️ Error al consultar clientes:</strong> {state.error}
          </div>
        ) : state.data.length === 0 ? (
          <p className="muted">Todavía no hay clientes registrados en tu empresa.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Razón Social / Nombre</th>
                  <th>NIT / Cédula</th>
                  <th>Teléfono</th>
                  <th>Correo</th>
                  <th>Direcciones registradas</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {state.data.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.legalName ?? c.legal_name}</strong></td>
                    <td><code>{c.taxId ?? c.tax_id}</code></td>
                    <td>{c.phone}</td>
                    <td>{c.email ?? <span className="muted">—</span>}</td>
                    <td>
                      {c.addresses && c.addresses.length > 0 ? (
                        <div style={{ display: "grid", gap: "4px" }}>
                          {c.addresses.map((a) => (
                            <div key={a.id} style={{ fontSize: "0.85rem" }}>
                              {(a.isPrimary || a.is_primary) && <span className="tag-badge">Principal</span>}
                              <strong>{a.municipalityName ?? munName(a.municipalityId ?? a.municipality_id ?? "")}:</strong> {a.address}
                              {a.latitude && a.longitude && (
                                <span className="muted" style={{ fontSize: "0.75rem", marginLeft: "4px" }}>
                                  ({Number(a.latitude).toFixed(4)}, {Number(a.longitude).toFixed(4)})
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <span className="muted">Sin direcciones</span>
                      )}
                    </td>
                    <td>{c.active ? "Activo" : "Inactivo"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!readOnly && (capabilities.canCreateClients || capabilities.canUpdateClients) && (
        <div className="form-grid">
          {/* Registrar Cliente Nuevo */}
          {capabilities.canCreateClients && (
            <form className="panel stack" onSubmit={handleCreateClient}>
              <h2>Registrar Nuevo Cliente</h2>
              {clientMsg && (
                <p className={clientErr ? "notice" : "muted"} style={{ fontWeight: 600 }}>
                  {clientMsg}
                </p>
              )}

              <label>
                Razón social / Nombre completo *
                <input name="legalName" required placeholder="Ej. Constructora del Valle SAS" maxLength={160} />
              </label>

              <label>
                Identificación tributaria (NIT o CC) *
                <input name="taxId" required placeholder="Ej. 901234567-1" maxLength={60} />
              </label>

              <label>
                Teléfono de contacto *
                <input name="phone" required placeholder="Ej. 3001234567" maxLength={30} />
              </label>

              <label>
                Correo electrónico (opcional)
                <input name="email" type="email" placeholder="contacto@cliente.com" />
              </label>

              <fieldset>
                <legend style={{ fontWeight: 600, fontSize: "0.9rem", color: "#164540", marginBottom: "0.5rem" }}>
                  Dirección Principal de Entrega / Instalación:
                </legend>

                <label>
                  Municipio de Antioquia ({municipalities.data.length} disponibles) *
                  <select
                    name="municipalityId"
                    required
                    defaultValue=""
                    disabled={municipalities.loading || municipalities.data.length === 0 || municipalities.error != null}
                  >
                    <option value="">
                      {municipalities.loading
                        ? "Cargando municipios de Antioquia…"
                        : municipalities.error
                          ? "Catálogo de municipios no disponible (reintenta)"
                          : municipalities.data.length === 0
                            ? "Sin municipios disponibles"
                            : "Selecciona municipio…"}
                    </option>
                    {municipalities.data.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name} ({m.id})
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Dirección física *
                  <input name="address" required placeholder="Ej. Carrera 43A # 1 Sur 100, Torre 2" maxLength={250} />
                </label>

                <label>
                  Detalle o notas de acceso
                  <input name="addressNotes" placeholder="Apartamento 502, frente al centro comercial" maxLength={500} />
                </label>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                  <label>
                    Latitud GPS (opcional)
                    <input name="latitude" placeholder="6.2089" />
                  </label>
                  <label>
                    Longitud GPS (opcional)
                    <input name="longitude" placeholder="-75.5678" />
                  </label>
                </div>
              </fieldset>

              <button
                type="submit"
                disabled={
                  busyClient ||
                  municipalities.loading ||
                  municipalities.data.length === 0 ||
                  municipalities.error != null
                }
              >
                {busyClient ? "Registrando…" : "Registrar cliente"}
              </button>
            </form>
          )}

          {/* Agregar Dirección a Cliente Existente */}
          {capabilities.canUpdateClients && (
            <form className="panel stack" onSubmit={handleAddAddress}>
              <h2>Agregar Dirección a Cliente</h2>
              {addrMsg && (
                <p className={addrErr ? "notice" : "muted"} style={{ fontWeight: 600 }}>
                  {addrMsg}
                </p>
              )}

              <label>
                Seleccionar cliente *
                <select name="clientId" required defaultValue="">
                  <option value="">Selecciona un cliente…</option>
                  {state.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.legalName ?? c.legal_name} ({c.taxId ?? c.tax_id})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Municipio de Antioquia ({municipalities.data.length} disponibles) *
                <select
                  name="municipalityId"
                  required
                  defaultValue=""
                  disabled={municipalities.loading || municipalities.data.length === 0 || municipalities.error != null}
                >
                  <option value="">
                    {municipalities.loading
                      ? "Cargando municipios de Antioquia…"
                      : municipalities.error
                        ? "Catálogo de municipios no disponible (reintenta)"
                        : municipalities.data.length === 0
                          ? "Sin municipios disponibles"
                          : "Selecciona municipio…"}
                  </option>
                  {municipalities.data.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.id})
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Dirección de obra / entrega *
                <input name="address" required placeholder="Ej. Km 7 Vía Llanogrande" maxLength={250} />
              </label>

              <label>
                Notas de acceso
                <input name="notes" placeholder="Bodega 4" maxLength={500} />
              </label>

              <label className="check-option">
                <input type="checkbox" name="isPrimary" />
                Establecer como dirección principal del cliente
              </label>

              <button
                type="submit"
                disabled={
                  busyAddress ||
                  state.data.length === 0 ||
                  municipalities.loading ||
                  municipalities.data.length === 0 ||
                  municipalities.error != null
                }
              >
                {busyAddress ? "Guardando…" : "Agregar dirección"}
              </button>
            </form>
          )}
        </div>
      )}

      {!readOnly && capabilities.canUpdateClients && <MasterEditor kind="clients" items={state.data} onSaved={onReload} loading={state.loading} />}
      {!readOnly && !capabilities.canCreateClients && !capabilities.canUpdateClients && capabilities.canReadClients && (
        <div className="panel" style={{ background: "#f8fafc", borderColor: "#cbd5e1" }}>
          <p className="muted" style={{ margin: 0, fontStyle: "italic" }}>
            ℹ️ Tu rol o permisos actuales permiten consultar el directorio de clientes (<code>clients.read</code>), pero no registrar clientes nuevos (<code>clients.create</code>) ni agregar direcciones secundarias (<code>clients.update</code>).
          </p>
        </div>
      )}
    </div>
  );
}
