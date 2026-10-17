"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PaymentReceipts } from "./payment-receipts";
import { AuditView } from "./components/audit-view";
import { displayLabel } from "../shared/contracts/ui-labels";
import {
  AnnulPayment,
  CompanyLogo,
  WorkspaceOverview,
} from "./platform-completion";
import {
  CommercialWorkspace,
  type CommercialWorkspaceTab,
} from "./commercial-workspace";
import {
  FieldWorkspace,
  type FieldWorkspaceTab,
} from "./field/field-workspace";
import {
  ManagementWorkspace,
  type ManagementWorkspaceTab,
} from "./management/management-workspace";
import type { SessionActorDto } from "../shared/contracts/commercial";
import {
  IconBrand,
  IconHome,
  IconDocument,
  IconShopping,
  IconCash,
  IconWrench,
  IconShield,
  IconChartBar,
  IconBell,
  IconSettings,
  IconLogout,
  IconMenu,
  IconX,
  IconChevronRight,
  IconBuilding,
} from "./components/icons";

type Row = Record<string, string | number | boolean | string[]>;
type Field = {
  name: string;
  label: string;
  type?: string;
  options?: { value: string; label: string }[];
  optional?: boolean;
  multiple?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  title?: string;
  placeholder?: string;
  min?: number;
  step?: string;
};
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error?.message ?? "No fue posible completar la operación.",
    );
  return result.data;
}
function ActionForm({
  title,
  fields,
  submit,
  disabled = false,
  id,
}: {
  title: string;
  fields: Field[];
  submit: (values: Record<string, string>) => Promise<void>;
  disabled?: boolean;
  id?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const form = event.currentTarget;
    try {
      const data = new FormData(form);
      const values = Object.fromEntries(data) as Record<string, string>;
      for (const field of fields)
        if (field.multiple)
          values[field.name] = data.getAll(field.name).join(",");
      await submit(values);
      setMessage("Cambios guardados.");
      setFailed(false);
      form.reset();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Revisa la conexión e intenta nuevamente.",
      );
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form id={id} className="panel stack" onSubmit={send}>
      <h2>{title}</h2>
      <fieldset disabled={disabled || busy}>
        {fields.map((field) =>
          field.multiple ? (
            <fieldset key={field.name}>
              <legend>{field.label}</legend>
              {field.options?.map((option) => (
                <label key={option.value} className="check-option">
                  <input
                    type="checkbox"
                    name={field.name}
                    value={option.value}
                  />
                  {option.label}
                </label>
              ))}
            </fieldset>
          ) : (
            <label key={field.name}>
              {field.label}
              {field.options ? (
                <select name={field.name} required={!field.optional}>
                  <option value="">Selecciona…</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={field.name}
                  type={field.type ?? "text"}
                  required={!field.optional}
                  step={
                    field.step ?? (field.type === "number" ? "1" : undefined)
                  }
                  min={field.min ?? (field.type === "number" ? 1 : undefined)}
                  minLength={field.minLength}
                  maxLength={field.maxLength}
                  pattern={field.pattern}
                  title={field.title}
                  placeholder={field.placeholder}
                  autoComplete={
                    field.type === "password" ? "new-password" : undefined
                  }
                />
              )}
            </label>
          ),
        )}
      </fieldset>
      {message && <p role={failed ? "alert" : "status"}>{message}</p>}
      <button disabled={disabled || busy}>
        {busy ? "Guardando…" : "Guardar"}
      </button>
    </form>
  );
}
function DataTable({
  rows,
  columns,
}: {
  rows: Row[];
  columns: { key: string; label: string }[];
}) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((c) => (
                <td key={c.key}>
                  {Array.isArray(row[c.key])
                    ? (row[c.key] as string[]).join(", ")
                    : typeof row[c.key] === "boolean"
                      ? row[c.key]
                        ? "Activo"
                        : "Inactivo"
                      : ["authority", "status", "kind", "priority"].includes(c.key)
                        ? displayLabel(String(row[c.key] ?? ""))
                        : String(row[c.key] ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="muted">Todavía no hay registros.</p>
  );
}
const permissionOptions = [
  { value: "audit.read", label: "Consultar historial de auditoría (admin)" },
  { value: "users.read", label: "Consultar usuarios y roles (admin)" },
  { value: "users.create", label: "Crear usuarios (admin)" },
  { value: "users.update", label: "Editar usuarios y restablecer contraseñas (admin)" },
  { value: "roles.manage", label: "Administrar roles (admin)" },
  { value: "permissions.manage", label: "Asignar roles y permisos (admin)" },
  { value: "clients.read", label: "Consultar clientes y direcciones" },
  { value: "clients.create", label: "Registrar nuevos clientes" },
  { value: "clients.update", label: "Editar clientes y agregar direcciones" },
  { value: "catalog.read", label: "Consultar catálogo de productos" },
  { value: "catalog.manage", label: "Administrar catálogo (admin)" },
  { value: "zones.manage", label: "Administrar zonas tarifarias (admin)" },
  { value: "costs.read", label: "Consultar costos base y márgenes de rentabilidad" },
  { value: "requests.read", label: "Consultar solicitudes de obra" },
  { value: "requests.create", label: "Crear solicitudes multicabina" },
  { value: "requests.update", label: "Modificar solicitudes de obra" },
  { value: "quotations.read", label: "Consultar cotizaciones formales" },
  { value: "quotations.create", label: "Crear cotizaciones formales" },
  { value: "quotations.update", label: "Modificar cotizaciones formales" },
  { value: "quotations.approve", label: "Aprobar cotizaciones con evidencia" },
  { value: "adjustments.create", label: "Crear notas de ajuste comercial" },
  { value: "adjustments.authorize", label: "Autorizar notas de ajuste (aumento/reducción)" },
  { value: "settings.manage", label: "Administrar parámetros comerciales (admin)" },
];
const parseList = (value: string | undefined) =>
  value
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
export function AdminWorkspace({
  platform,
  administrator = true,
  readOnly = false,
  actor,
}: {
  platform: boolean;
  administrator?: boolean;
  readOnly?: boolean;
  actor?: SessionActorDto;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[]>([]);
  const [aux, setAux] = useState<Row[]>([]);
  const [payments, setPayments] = useState<Row[]>([]);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(platform || administrator);
  const [revision, setRevision] = useState(0);
  const [tenantTab, setTenantTab] = useState<"commercial" | "admin" | "field" | "management" | "audit">(
    administrator ? "admin" : "commercial",
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [commercialTab, setCommercialTab] = useState<CommercialWorkspaceTab>("catalog");
  const [fieldTab, setFieldTab] = useState<FieldWorkspaceTab>("visits");
  const [managementTab, setManagementTab] = useState<ManagementWorkspaceTab>("dashboard");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    commercial: true,
    procurement: false,
    finance: false,
    field: true,
    postsale: true,
    management: false,
    admin: false,
  });

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    const menuButton = menuButtonRef.current;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(drawerRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled), a[href]") ?? []).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileDrawerOpen(false);
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    };
    const onResize = () => {
      if (window.innerWidth > 1024) setMobileDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
      menuButton?.focus();
    };
  }, [mobileDrawerOpen]);

  useEffect(() => {
    let cancelled = false;
    if (!platform && !administrator) return;
    Promise.all([
      api(`${platform ? "platform/tenants" : "users"}?page=${page}`),
      api(`${platform ? "platform/tiers" : "roles"}?page=${page}`),
      platform
        ? api(`platform/subscriptions?page=${page}`)
        : Promise.resolve([]),
    ])
      .then(([a, b, c]) => {
        if (!cancelled) {
          setRows(a);
          setAux(b);
          setPayments(c);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [platform, administrator, revision, page]);

  useEffect(() => {
    if (platform) return;
    let cancelled = false;
    api("notifications?unreadOnly=true")
      .then((res: unknown) => {
        if (
          !cancelled &&
          res &&
          typeof res === "object" &&
          "unreadCount" in res &&
          typeof (res as { unreadCount: unknown }).unreadCount === "number"
        ) {
          setUnreadNotifications((res as { unreadCount: number }).unreadCount);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [platform, revision, tenantTab]);

  const reload = () => setRevision((v) => v + 1);
  const companyOptions = rows.map((r) => ({
    value: String(r.id),
    label: String(r.legal_name ?? r.username),
  }));
  const tierOptions = aux
    .filter((r) => !platform || r.active)
    .map((r) => ({
      value: String(r.id),
      label: platform
        ? `${r.min_users}–${r.max_users} usuarios · ${r.monthly_price} ${r.currency}`
        : String(r.name),
    }));
  const save = async (path: string, method: string, data: unknown) => {
    await api(path, method, data);
    reload();
  };

  const navigateTo = (
    tab: "commercial" | "admin" | "field" | "management" | "audit",
    sub?: string,
    toggledGroup?: string,
  ) => {
    setTenantTab(tab);
    if (tab === "commercial") {
      if (sub === "procurement" || sub === "inventory") {
        setOpenGroups((prev) => ({ ...prev, procurement: true }));
      } else if (sub === "finance") {
        setOpenGroups((prev) => ({ ...prev, finance: true }));
      } else if (sub === "settings") {
        setOpenGroups((prev) => ({ ...prev, admin: true }));
      } else {
        setOpenGroups((prev) => ({ ...prev, commercial: true }));
      }
      if (sub) setCommercialTab(sub as CommercialWorkspaceTab);
    }
    if (tab === "field") {
      setOpenGroups((prev) => ({ ...prev, field: true }));
      if (sub) setFieldTab(sub as FieldWorkspaceTab);
    }
    if (tab === "management") {
      if (sub === "warranties" || sub === "issues") {
        setOpenGroups((prev) => ({ ...prev, postsale: true }));
      } else if (sub === "costs") {
        setOpenGroups((prev) => ({ ...prev, finance: true }));
      } else {
        setOpenGroups((prev) => ({ ...prev, management: true }));
      }
      if (sub) setManagementTab(sub as ManagementWorkspaceTab);
    }
    if (tab === "admin" || tab === "audit") {
      setOpenGroups((prev) => ({ ...prev, admin: true }));
    }
    if (toggledGroup) {
      // Toggle after navigation's default expansion, using the rendered state.
      setOpenGroups((prev) => ({ ...prev, [toggledGroup]: !openGroups[toggledGroup] }));
      setSidebarCollapsed(false);
    } else {
      setMobileDrawerOpen(false);
    }
  };

  const handleLogout = async () => {
    try {
      await api("auth/logout", "POST", {});
      router.replace("/login");
      router.refresh();
    } catch {
      setError("No se pudo cerrar la sesión. Intenta de nuevo.");
    }
  };

  const getBreadcrumbLabel = () => {
    if (tenantTab === "audit") return "Administración / Historial de auditoría";
    if (tenantTab === "admin") return "Administración de Empresa";
    if (tenantTab === "field") {
      const labels: Record<string, string> = {
        visits: "Visitas Técnicas",
        tasks: "Tareas y Rutas",
        installation: "Instalación en Sitio",
        closure: "Cierre Operativo",
      };
      return `Operaciones de Campo / ${labels[fieldTab] ?? "General"}`;
    }
    if (tenantTab === "management") {
      const labels: Record<string, string> = {
        dashboard: "Dashboard Ejecutivo",
        calendar: "Calendario Integrado",
        kanban: "Tablero Kanban",
        warranties: "Garantías",
        issues: "Novedades de Servicio",
        costs: "Costos Operativos",
        reports: "Reportes",
        alerts: "Alertas",
      };
      return `Posventa y Gestión / ${labels[managementTab] ?? "General"}`;
    }
    const labels: Record<string, string> = {
      catalog: "Catálogo de Productos",
      zones: "Zonas Tarifarias",
      clients: "Clientes y Direcciones",
      requests: "Solicitudes de Obra",
      quotations: "Cotizaciones Formales",
      procurement: "Compras y Proveedores",
      inventory: "Inventario y Almacén",
      finance: "Finanzas y Pagos",
      settings: "Configuración Comercial",
    };
    return `Módulo Comercial / ${labels[commercialTab] ?? "Catálogo"}`;
  };

  const renderPlatformSidebarContent = () => (
    <>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">
            <IconBrand className="w-5 h-5" />
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">Tibelio SaaS</span>
            <span className="sidebar-brand-role">Superadmin</span>
          </div>
        </div>
        {mobileDrawerOpen && (
          <button
            type="button"
            className="topbar-btn"
            onClick={() => setMobileDrawerOpen(false)}
            aria-label="Cerrar menú"
          >
            <IconX className="w-5 h-5" />
          </button>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Navegación de plataforma">
        <div className="sidebar-group-label">Plataforma</div>
        <a
          href="#resumen"
          className="sidebar-item"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div className="sidebar-item-icon">
            <IconHome className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Resumen General</span>
        </a>
        <a
          href="#empresas"
          className="sidebar-item"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div className="sidebar-item-icon">
            <IconBuilding className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Empresas ({rows.length})</span>
        </a>
        <a
          href="#tarifas"
          className="sidebar-item"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div className="sidebar-item-icon">
            <IconCash className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Tarifas ({aux.length})</span>
        </a>
        <a
          href="#pagos"
          className="sidebar-item"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div className="sidebar-item-icon">
            <IconDocument className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Pagos SaaS ({payments.length})</span>
        </a>

        <div className="sidebar-group-label">Operaciones</div>
        <a
          href="#crear-tarifa"
          className="sidebar-item"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div className="sidebar-item-icon">
            <IconCash className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">+ Crear Tarifa</span>
        </a>
        <a
          href="#crear-empresa"
          className="sidebar-item"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div className="sidebar-item-icon">
            <IconBuilding className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">+ Crear Empresa</span>
        </a>
      </nav>

      <div className="sidebar-footer">
        <div className="user-profile-badge">
          <div className="user-avatar">SA</div>
          <div className="user-details">
            <span className="user-name">Superadmin</span>
            <span className="user-role">Control de Plataforma</span>
          </div>
        </div>
        <button
          type="button"
          className="sidebar-item"
          onClick={handleLogout}
          style={{ color: "#dc2626" }}
          aria-label="Salir"
        >
          <div className="sidebar-item-icon">
            <IconLogout className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Salir</span>
        </button>
      </div>
    </>
  );

  const renderTenantSidebarContent = () => (
    <>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="sidebar-brand-icon">
            <IconBrand className="w-5 h-5" />
          </div>
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">Tibelio SaaS</span>
            <span className="sidebar-brand-role">
              {administrator ? "Administrador" : "Espacio Empresa"}
            </span>
          </div>
        </div>
        {mobileDrawerOpen && (
          <button
            type="button"
            className="topbar-btn"
            onClick={() => setMobileDrawerOpen(false)}
            aria-label="Cerrar menú"
          >
            <IconX className="w-5 h-5" />
          </button>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Navegación del workspace">
        <div className="sidebar-group-label">Inicio</div>
        <button
          type="button"
          className={`sidebar-item ${tenantTab === "management" && managementTab === "dashboard" ? "active" : ""}`}
          onClick={() => navigateTo("management", "dashboard")}
        >
          <div className="sidebar-item-icon">
            <IconHome className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Inicio / Resumen</span>
        </button>

        <div className="sidebar-group-label">Comercial</div>
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-group-btn ${tenantTab === "commercial" && !["procurement", "inventory", "finance"].includes(commercialTab) ? "active" : ""}`}
            onClick={() => {
              navigateTo("commercial", undefined, "commercial");
            }}
            aria-expanded={openGroups.commercial}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <div className="sidebar-item-icon">
                <IconDocument className="w-5 h-5" />
              </div>
              <span className="sidebar-item-text">Módulo Comercial</span>
            </div>
            <IconChevronRight className={`sidebar-chevron ${openGroups.commercial ? "expanded" : ""}`} />
          </button>
          {openGroups.commercial && (
            <div className="sidebar-subgroup">
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "requests" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "requests")}
              >
                <span className="sidebar-item-text">Solicitudes</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "quotations" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "quotations")}
              >
                <span className="sidebar-item-text">Cotizaciones</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "clients" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "clients")}
              >
                <span className="sidebar-item-text">Directorio Clientes</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "catalog" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "catalog")}
              >
                <span className="sidebar-item-text">Catálogo General</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "zones" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "zones")}
              >
                <span className="sidebar-item-text">Zonas y Fletes</span>
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-group-label">Compras & Inventario</div>
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-group-btn ${tenantTab === "commercial" && (commercialTab === "procurement" || commercialTab === "inventory") ? "active" : ""}`}
            onClick={() => {
              navigateTo("commercial", "procurement", "procurement");
            }}
            aria-expanded={openGroups.procurement}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <div className="sidebar-item-icon">
                <IconShopping className="w-5 h-5" />
              </div>
              <span className="sidebar-item-text">Compras & Inventario</span>
            </div>
            <IconChevronRight className={`sidebar-chevron ${openGroups.procurement ? "expanded" : ""}`} />
          </button>
          {openGroups.procurement && (
            <div className="sidebar-subgroup">
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "procurement" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "procurement")}
              >
                <span className="sidebar-item-text">Órdenes de Compra</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "inventory" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "inventory")}
              >
                <span className="sidebar-item-text">Almacén & Cabinas</span>
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-group-label">Finanzas</div>
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-group-btn ${(tenantTab === "commercial" && commercialTab === "finance") || (tenantTab === "management" && managementTab === "costs") ? "active" : ""}`}
            onClick={() => {
              navigateTo("commercial", "finance", "finance");
            }}
            aria-expanded={openGroups.finance}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <div className="sidebar-item-icon">
                <IconCash className="w-5 h-5" />
              </div>
              <span className="sidebar-item-text">Finanzas & Pagos</span>
            </div>
            <IconChevronRight className={`sidebar-chevron ${openGroups.finance ? "expanded" : ""}`} />
          </button>
          {openGroups.finance && (
            <div className="sidebar-subgroup">
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "finance" ? "active" : ""}`}
                onClick={() => navigateTo("commercial", "finance")}
              >
                <span className="sidebar-item-text">Pagos y Recaudos</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "costs" ? "active" : ""}`}
                onClick={() => navigateTo("management", "costs")}
              >
                <span className="sidebar-item-text">Costos Operativos</span>
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-group-label">Operaciones de Campo</div>
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-group-btn ${tenantTab === "field" ? "active" : ""}`}
            onClick={() => {
              navigateTo("field", undefined, "field");
            }}
            aria-expanded={openGroups.field}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <div className="sidebar-item-icon">
                <IconWrench className="w-5 h-5" />
              </div>
              <span className="sidebar-item-text">Operaciones de Campo</span>
            </div>
            <IconChevronRight className={`sidebar-chevron ${openGroups.field ? "expanded" : ""}`} />
          </button>
          {openGroups.field && (
            <div className="sidebar-subgroup">
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "field" && fieldTab === "visits" ? "active" : ""}`}
                onClick={() => navigateTo("field", "visits")}
              >
                <span className="sidebar-item-text">Visitas Técnicas</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "field" && fieldTab === "tasks" ? "active" : ""}`}
                onClick={() => navigateTo("field", "tasks")}
              >
                <span className="sidebar-item-text">Tareas y Despacho</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "field" && fieldTab === "installation" ? "active" : ""}`}
                onClick={() => navigateTo("field", "installation")}
              >
                <span className="sidebar-item-text">Instalación en Sitio</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "field" && fieldTab === "closure" ? "active" : ""}`}
                onClick={() => navigateTo("field", "closure")}
              >
                <span className="sidebar-item-text">Cierre Operativo</span>
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-group-label">Posventa</div>
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-group-btn ${tenantTab === "management" && (managementTab === "warranties" || managementTab === "issues") ? "active" : ""}`}
            onClick={() => {
              navigateTo("management", "warranties", "postsale");
            }}
            aria-expanded={openGroups.postsale}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <div className="sidebar-item-icon">
                <IconShield className="w-5 h-5" />
              </div>
              <span className="sidebar-item-text">Posventa & Garantías</span>
            </div>
            <IconChevronRight className={`sidebar-chevron ${openGroups.postsale ? "expanded" : ""}`} />
          </button>
          {openGroups.postsale && (
            <div className="sidebar-subgroup">
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "warranties" ? "active" : ""}`}
                onClick={() => navigateTo("management", "warranties")}
              >
                <span className="sidebar-item-text">Garantías</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "issues" ? "active" : ""}`}
                onClick={() => navigateTo("management", "issues")}
              >
                <span className="sidebar-item-text">Novedades de Servicio</span>
              </button>
            </div>
          )}
        </div>

        <div className="sidebar-group-label">Gestión & Reportes</div>
        <div className="sidebar-group">
          <button
            type="button"
            className={`sidebar-group-btn ${tenantTab === "management" && !["warranties", "issues", "costs"].includes(managementTab) ? "active" : ""}`}
            onClick={() => {
              navigateTo("management", undefined, "management");
            }}
            aria-expanded={openGroups.management}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <div className="sidebar-item-icon">
                <IconChartBar className="w-5 h-5" />
              </div>
              <span className="sidebar-item-text">Posventa y Gestión</span>
            </div>
            <IconChevronRight className={`sidebar-chevron ${openGroups.management ? "expanded" : ""}`} />
          </button>
          {openGroups.management && (
            <div className="sidebar-subgroup">
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "calendar" ? "active" : ""}`}
                onClick={() => navigateTo("management", "calendar")}
              >
                <span className="sidebar-item-text">Calendario Integrado</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "kanban" ? "active" : ""}`}
                onClick={() => navigateTo("management", "kanban")}
              >
                <span className="sidebar-item-text">Tablero Kanban</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "reports" ? "active" : ""}`}
                onClick={() => navigateTo("management", "reports")}
              >
                <span className="sidebar-item-text">Reportes Ejecutivos</span>
              </button>
              <button
                type="button"
                className={`sidebar-subitem ${tenantTab === "management" && managementTab === "alerts" ? "active" : ""}`}
                onClick={() => navigateTo("management", "alerts")}
              >
                <span className="sidebar-item-text">Alertas y Avisos</span>
                {unreadNotifications > 0 && (
                  <span className="sidebar-item-badge">{unreadNotifications}</span>
                )}
              </button>
            </div>
          )}
        </div>

        {administrator && (
          <>
            <div className="sidebar-group-label">Configuración</div>
            <div className="sidebar-group">
              <button
                type="button"
                className={`sidebar-group-btn ${tenantTab === "admin" || (tenantTab === "commercial" && commercialTab === "settings") ? "active" : ""}`}
                onClick={() => {
                  navigateTo("admin", undefined, "admin");
                }}
                aria-expanded={openGroups.admin}
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
                  <div className="sidebar-item-icon">
                    <IconSettings className="w-5 h-5" />
                  </div>
                  <span className="sidebar-item-text">Administración de Empresa</span>
                </div>
                <IconChevronRight className={`sidebar-chevron ${openGroups.admin ? "expanded" : ""}`} />
              </button>
              {openGroups.admin && (
                <div className="sidebar-subgroup">
                  <button
                    type="button"
                    className={`sidebar-subitem ${tenantTab === "admin" ? "active" : ""}`}
                    onClick={() => navigateTo("admin")}
                  >
                    <span className="sidebar-item-text">Usuarios y Roles</span>
                  </button>
                  {!actor?.denials?.includes("audit.read") && <button type="button" className={`sidebar-subitem ${tenantTab === "audit" ? "active" : ""}`} onClick={() => navigateTo("audit")}>
                    <span className="sidebar-item-text">Historial de auditoría</span>
                  </button>}
                  <button
                    type="button"
                    className={`sidebar-subitem ${tenantTab === "commercial" && commercialTab === "settings" ? "active" : ""}`}
                    onClick={() => navigateTo("commercial", "settings")}
                  >
                    <span className="sidebar-item-text">Parámetros de Cotización</span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </nav>

      <div className="sidebar-footer">
        <div className="user-profile-badge">
          <div className="user-avatar">
            {administrator ? "AD" : "US"}
          </div>
          <div className="user-details">
            <span className="user-name">Mi cuenta</span>
            <span className="user-role">
              {actor?.authority === "ADMIN" ? "Administrador" : "Usuario de Empresa"}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="sidebar-item"
          onClick={handleLogout}
          style={{ color: "#dc2626" }}
          aria-label="Salir"
        >
          <div className="sidebar-item-icon">
            <IconLogout className="w-5 h-5" />
          </div>
          <span className="sidebar-item-text">Salir</span>
        </button>
      </div>
    </>
  );

  return (
    <div className="app-shell">
      {/* Desktop Sidebar */}
      <aside className={`app-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        {platform ? renderPlatformSidebarContent() : renderTenantSidebarContent()}
      </aside>

      {/* Mobile Drawer Overlay */}
      {mobileDrawerOpen && (
        <div
          className="mobile-drawer-overlay"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Menú de navegación"
            className="mobile-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            {platform ? renderPlatformSidebarContent() : renderTenantSidebarContent()}
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="app-content-area" inert={mobileDrawerOpen}>
        <header className="app-topbar">
          <div className="topbar-left">
            <button
              ref={menuButtonRef}
              type="button"
              className="topbar-btn"
              onClick={() => {
                if (typeof window !== "undefined" && window.innerWidth <= 1024) {
                  setMobileDrawerOpen(true);
                } else {
                  setSidebarCollapsed(!sidebarCollapsed);
                }
              }}
              title="Menú de navegación"
              aria-label="Abrir menú de navegación"
            >
              <IconMenu className="w-5 h-5" />
            </button>
            <div className="topbar-breadcrumb">
              <span>Tibelio</span>
              <IconChevronRight className="w-3 h-3" />
              <span className="topbar-breadcrumb-active">
                {platform ? "Plataforma SaaS" : getBreadcrumbLabel()}
              </span>
            </div>
          </div>
          <div className="topbar-right">
            {!platform && (
              <button
                type="button"
                className="topbar-btn alert-bell-btn"
                onClick={() => navigateTo("management", "alerts")}
                title="Alertas y Notificaciones"
                aria-label="Alertas y Notificaciones"
              >
                <IconBell className="w-5 h-5" />
                {unreadNotifications > 0 && (
                  <span className="alert-bell-badge">{unreadNotifications}</span>
                )}
              </button>
            )}
            <button
              type="button"
              className="topbar-btn"
              onClick={handleLogout}
              title="Salir"
              aria-label="Salir"
            >
              <IconLogout className="w-5 h-5" />
            </button>
          </div>
        </header>

        <div className="app-body">
          <main className="workspace">
            <header className="workspace-header">
              <div>
                <p className="eyebrow">
                  TIBELIO / {platform ? "PLATAFORMA" : "MI EMPRESA"}
                </p>
                <h1>
                  {platform ? "Administración SaaS" : "Administración de empresa"}
                </h1>
              </div>
              <button
                className="secondary"
                onClick={handleLogout}
              >
                Cerrar sesión
              </button>
            </header>
            {readOnly && (
              <p className="notice" role="status">
                Suscripción en solo lectura. Puedes consultar la información
                disponible; renueva para realizar cambios.
              </p>
            )}
            {error && (
              <p role="alert" className="notice">
                {error}{" "}
                <button className="secondary" onClick={reload}>
                  Reintentar
                </button>
              </p>
            )}
            {loading ? (
              <p role="status">Cargando…</p>
            ) : (
              <>
                {!platform && (
                  <nav className="workspace-tabs mobile-only-tabs" aria-label="Secciones de la empresa">
                    {administrator && (
                      <button
                        type="button"
                        className={`workspace-tab ${tenantTab === "admin" ? "active" : ""}`}
                        onClick={() => setTenantTab("admin")}
                      >
                         Administración de Empresa (Usuarios y Roles)
                      </button>
                    )}
                    <button
                      type="button"
                      className={`workspace-tab ${tenantTab === "commercial" ? "active" : ""}`}
                      onClick={() => setTenantTab("commercial")}
                    >
                       Módulo Comercial
                    </button>
                    <button
                      type="button"
                      className={`workspace-tab ${tenantTab === "field" ? "active" : ""}`}
                      onClick={() => setTenantTab("field")}
                    >
                       Operaciones de Campo
                    </button>
                    <button
                      type="button"
                      className={`workspace-tab ${tenantTab === "management" ? "active" : ""}`}
                      onClick={() => setTenantTab("management")}
                    >
                       Posventa y Gestión
                    </button>
                  </nav>
                )}

                {!platform && tenantTab === "audit" ? <AuditView /> : !platform && tenantTab === "management" ? (
                  <ManagementWorkspace
                    readOnly={!!readOnly}
                    administrator={administrator ?? false}
                    actor={actor ?? null}
                    activeTab={managementTab}
                    onTabChange={setManagementTab}
                  />
                ) : !platform && tenantTab === "field" ? (
                  <FieldWorkspace
                    readOnly={!!readOnly}
                    administrator={administrator ?? false}
                    actor={actor ?? null}
                    activeTab={fieldTab}
                    onTabChange={setFieldTab}
                  />
                ) : !platform && tenantTab === "commercial" ? (
                  <CommercialWorkspace
                    readOnly={readOnly}
                    administrator={administrator}
                    actor={actor}
                    activeTab={commercialTab}
                    onTabChange={setCommercialTab}
                  />
                ) : (
                  <>
              {platform && (
                <div
                  className="panel"
                  style={{
                    background: "#f0f8f7",
                    borderColor: "#a4dcd3",
                    marginBottom: "1.5rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: "1rem",
                    }}
                  >
                    <div>
                      <h2 style={{ margin: "0 0 0.4rem", color: "#114f48" }}>
                         Guía rápida de inicialización del SaaS
                      </h2>
                      <p className="muted" style={{ margin: 0 }}>
                        1. <strong>Crea una tarifa</strong> de precios → 2. <strong>Crea la empresa</strong> con su administrador → 3. <strong>Inicia sesión</strong> con ese usuario en <code>/login</code> para acceder al espacio de la empresa en <code>/app</code>.
                      </p>
                    </div>
                    <div style={{ display: "flex", gap: "0.5rem" }}>
                      <a
                        href="#crear-tarifa"
                        style={{
                          textDecoration: "none",
                          padding: "0.6rem 1rem",
                          borderRadius: "7px",
                          background: "#14655e",
                          color: "#fff",
                          fontWeight: 600,
                          fontSize: "0.88rem",
                        }}
                      >
                        + Crear Tarifa
                      </a>
                      <a
                        href="#crear-empresa"
                        style={{
                          textDecoration: "none",
                          padding: "0.6rem 1rem",
                          borderRadius: "7px",
                          background: "#e8f0ef",
                          color: "#153e3a",
                          fontWeight: 600,
                          fontSize: "0.88rem",
                        }}
                      >
                        + Crear Empresa
                      </a>
                    </div>
                  </div>
                </div>
              )}
              <div id="resumen"><WorkspaceOverview key={revision} platform={platform} /></div>
          <nav
            aria-label="Páginas de los listados"
            className="workspace-header"
          >
            <button
              className="secondary"
              disabled={page === 1}
              onClick={() => setPage(page - 1)}
            >
              Anterior
            </button>
            <span>Página {page} · hasta 200 registros por listado</span>
            <button
              className="secondary"
              disabled={
                Math.max(rows.length, aux.length, payments.length) < 200
              }
              onClick={() => setPage(page + 1)}
            >
              Siguiente
            </button>
          </nav>
          <section id={platform ? "empresas" : undefined} className="panel">
            <h2>{platform ? "Empresas" : "Usuarios de tu empresa"}</h2>
            {!platform && administrator && !actor?.denials?.includes("audit.read") && <p>
              <button type="button" className="secondary" onClick={()=>navigateTo("audit")}>Ver historial de auditoría</button>
              <span className="muted"> Consulta los cambios de tu empresa y sus responsables.</span>
            </p>}
            <DataTable
              rows={rows}
              columns={
                platform
                  ? [
                      { key: "legal_name", label: "Empresa" },
                      { key: "active", label: "Estado" },
                      { key: "seats", label: "Cupos" },
                      { key: "active_users", label: "Usuarios activos" },
                      { key: "tax_id", label: "Identificación tributaria" },
                      { key: "expires_at", label: "Vencimiento" },
                      { key: "current_amount", label: "Mensualidad actual" },
                      { key: "next_amount", label: "Próximo ciclo" },
                      { key: "currency", label: "Moneda" },
                    ]
                  : [
                      { key: "username", label: "Usuario" },
                      { key: "display_name", label: "Nombre" },
                      { key: "authority", label: "Autoridad" },
                      { key: "active", label: "Estado" },
                    ]
              }
            />
          </section>
          <section id={platform ? "tarifas" : undefined} className="panel">
            <h2>{platform ? "Tarifas por rango" : "Roles empresariales"}</h2>
            <DataTable
              rows={aux}
              columns={
                platform
                  ? [
                      { key: "min_users", label: "Desde" },
                      { key: "max_users", label: "Hasta" },
                      { key: "monthly_price", label: "Mensualidad" },
                      { key: "active", label: "Estado" },
                      { key: "currency", label: "Moneda" },
                    ]
                  : [
                      { key: "name", label: "Rol" },
                      { key: "permissions", label: "Permisos" },
                    ]
              }
            />
          </section>
          {platform && (
            <section id="pagos" className="panel">
              <h2>Historial de pagos SaaS</h2>
              <DataTable
                rows={payments}
                columns={[
                  { key: "legal_name", label: "Empresa" },
                  { key: "reference", label: "Referencia" },
                  { key: "amount", label: "Importe" },
                  { key: "status", label: "Estado" },
                  { key: "correction_amount", label: "Corrección" },
                  { key: "net_amount", label: "Neto" },
                  { key: "annulment_reason", label: "Motivo de anulación" },
                  { key: "annulled_at", label: "Fecha de anulación" },
                  { key: "annulled_by", label: "Responsable de anulación" },
                  { key: "currency", label: "Moneda" },
                  { key: "period_start", label: "Inicio" },
                  { key: "period_end", label: "Fin" },
                ]}
              />
            </section>
          )}
          {platform && (
            <PaymentReceipts
              payments={payments.map((p) => ({
                id: String(p.id),
                label: `${p.legal_name} · ${p.reference}`,
              }))}
            />
          )}
          <div className="form-grid">
            {platform ? (
              <>
                {tierOptions.length === 0 && (
                  <div
                    className="panel notice"
                    style={{ gridColumn: "1 / -1", margin: "0 0 0.5rem" }}
                  >
                    <strong> Tarifa requerida:</strong> Aún no tienes tarifas registradas en el sistema. Debes registrar al menos una tarifa en el formulario <em>&ldquo;Crear tarifa&rdquo;</em> abajo para poder seleccionarla al crear una empresa.
                  </div>
                )}
                <ActionForm
                  id="crear-tarifa"
                  title="Crear tarifa"
                  fields={[
                    {
                      name: "minUsers",
                      label: "Desde cuántos usuarios",
                      type: "number",
                    },
                    {
                      name: "maxUsers",
                      label: "Hasta cuántos usuarios",
                      type: "number",
                    },
                    {
                      name: "monthlyPrice",
                      label: "Mensualidad (ej. 150000, 1500.00 o 15,50)",
                    },
                    { name: "currency", label: "Moneda ISO (ej. COP)" },
                  ]}
                  submit={(v) => {
                    const monthlyPrice = v.monthlyPrice?.trim() ?? "";
                    return save("platform/tiers", "POST", {
                      ...v,
                      minUsers: Number(v.minUsers),
                      maxUsers: Number(v.maxUsers),
                      monthlyPrice,
                    });
                  }}
                />
                <ActionForm
                  id="crear-empresa"
                  title="Crear empresa"
                  fields={[
                    {
                      name: "legalName",
                      label: "Razón social",
                      placeholder: "ej. Inversiones Tibelio SaaS",
                    },
                    {
                      name: "taxId",
                      label: "Identificación tributaria",
                      placeholder: "ej. 901234567-8",
                    },
                    {
                      name: "seats",
                      label: "Cupos, incluido administrador",
                      type: "number",
                      min: 1,
                      placeholder: "ej. 10",
                    },
                    {
                      name: "expiresAt",
                      label: "Vencimiento",
                      type: "datetime-local",
                    },
                    { name: "tierId", label: "Tarifa", options: tierOptions },
                    {
                      name: "adminUsername",
                      label: "Usuario administrador",
                      pattern: "^[A-Za-z0-9][A-Za-z0-9._\\-]{2,63}$",
                      title:
                        "Mínimo 3 caracteres (letras, números, punto o guion)",
                      placeholder: "ej. admin.empresa",
                    },
                    {
                      name: "adminName",
                      label: "Nombre del administrador",
                      placeholder: "ej. Carlos Gómez",
                    },
                    {
                      name: "adminPassword",
                      label: "Contraseña inicial (mínimo 12 caracteres)",
                      type: "password",
                      minLength: 12,
                      placeholder: "Mínimo 12 caracteres",
                    },
                  ]}
                  submit={(v) =>
                    save("platform/tenants", "POST", {
                      ...v,
                      adminUsername: v.adminUsername?.trim().toLowerCase(),
                      seats: Number(v.seats),
                      expiresAt: new Date(v.expiresAt!).toISOString(),
                    })
                  }
                />
                <AnnulPayment
                  payments={payments
                    .filter((p) => p.status === "CONFIRMADO")
                    .map((p) => ({
                      id: String(p.id),
                      label: `${p.legal_name} · ${p.reference}`,
                      amount: String(p.amount),
                      currency: String(p.currency),
                    }))}
                  reload={reload}
                />
                <CompanyLogo
                  companies={rows.map((r) => ({
                    id: String(r.id),
                    label: String(r.legal_name),
                    hasLogo: !!r.logo_id,
                  }))}
                  reload={reload}
                />
                <ActionForm
                  title="Editar datos de empresa"
                  fields={[
                    {
                      name: "tenantId",
                      label: "Empresa a editar",
                      options: companyOptions,
                    },
                    {
                      name: "legalName",
                      label: "Nueva razón social",
                      optional: true,
                    },
                    {
                      name: "taxId",
                      label: "Nueva identificación tributaria",
                      optional: true,
                    },
                  ]}
                  submit={(v) =>
                    save(`platform/tenants/${v.tenantId}`, "PATCH", {
                      ...(v.legalName ? { legalName: v.legalName } : {}),
                      ...(v.taxId ? { taxId: v.taxId } : {}),
                    })
                  }
                />
                <ActionForm
                  title="Actualizar tarifa"
                  fields={[
                    {
                      name: "tierId",
                      label: "Tarifa a actualizar",
                      options: aux.map((r) => ({
                        value: String(r.id),
                        label: `${r.min_users}–${r.max_users} · ${r.monthly_price} ${r.currency} · ${r.active ? "Activa" : "Inactiva"}`,
                      })),
                    },
                    {
                      name: "monthlyPrice",
                      label: "Nueva mensualidad (ej. 150000, 1500.00 o 15,50)",
                      optional: true,
                    },
                    {
                      name: "active",
                      label: "Estado de tarifa",
                      options: [
                        { value: "true", label: "Activa" },
                        { value: "false", label: "Inactiva" },
                      ],
                      optional: true,
                    },
                  ]}
                  submit={(v) => {
                    const monthlyPrice = v.monthlyPrice?.trim() || undefined;
                    return save(`platform/tiers/${v.tierId}`, "PATCH", {
                      ...(monthlyPrice ? { monthlyPrice } : {}),
                      ...(v.active ? { active: v.active === "true" } : {}),
                    });
                  }}
                />
                <p className="muted">
                  Actualizar una tarifa conserva las mensualidades ya pactadas.
                  Usa Cambiar cupos para asignar expresamente una tarifa al
                  próximo ciclo.
                </p>
                <ActionForm
                  title="Cambiar cupos"
                  fields={[
                    {
                      name: "tenantId",
                      label: "Empresa",
                      options: companyOptions,
                    },
                    {
                      name: "seats",
                      label: "Nuevo total de cupos",
                      type: "number",
                    },
                    {
                      name: "tierId",
                      label: "Tarifa para el próximo ciclo",
                      options: tierOptions,
                    },
                  ]}
                  submit={(v) =>
                    save(`platform/tenants/${v.tenantId}/seats`, "POST", {
                      seats: Number(v.seats),
                      tierId: v.tierId,
                    })
                  }
                />
                <ActionForm
                  title="Confirmar pago y renovar"
                  fields={[
                    {
                      name: "tenantId",
                      label: "Empresa",
                      options: companyOptions,
                    },
                    {
                      name: "reference",
                      label: "Referencia del pago verificado",
                    },
                    {
                      name: "amount",
                      label: "Importe de la mensualidad (ej. 150000, 1500.00 o 15,50)",
                    },
                    { name: "currency", label: "Moneda ISO" },
                    {
                      name: "periodStart",
                      label: "Inicio del ciclo",
                      type: "datetime-local",
                    },
                    {
                      name: "periodEnd",
                      label: "Fin del ciclo",
                      type: "datetime-local",
                    },
                  ]}
                  submit={(v) => {
                    const amount = v.amount?.trim() ?? "";
                    return save("platform/subscriptions", "POST", {
                      ...v,
                      amount,
                      periodStart: new Date(v.periodStart!).toISOString(),
                      periodEnd: new Date(v.periodEnd!).toISOString(),
                    });
                  }}
                />
                <ActionForm
                  title="Estado de empresa"
                  fields={[
                    {
                      name: "tenantId",
                      label: "Empresa",
                      options: companyOptions,
                    },
                    {
                      name: "active",
                      label: "Estado",
                      options: [
                        { value: "true", label: "Activa" },
                        { value: "false", label: "Suspendida" },
                      ],
                    },
                  ]}
                  submit={(v) =>
                    save(`platform/tenants/${v.tenantId}`, "PATCH", {
                      active: v.active === "true",
                    })
                  }
                />
              </>
            ) : (
              <>
                <ActionForm
                  disabled={readOnly}
                  title="Crear usuario"
                  fields={[
                    {
                      name: "username",
                      label: "Usuario",
                      pattern: "^[A-Za-z0-9][A-Za-z0-9._\\-]{2,63}$",
                      title:
                        "Mínimo 3 caracteres (letras, números, punto o guion)",
                      placeholder: "ej. juan.perez",
                    },
                    {
                      name: "displayName",
                      label: "Nombre",
                      placeholder: "ej. Juan Pérez",
                    },
                    {
                      name: "email",
                      label: "Correo (opcional)",
                      type: "email",
                      optional: true,
                    },
                    {
                      name: "password",
                      label: "Contraseña inicial (mínimo 12 caracteres)",
                      type: "password",
                      minLength: 12,
                      placeholder: "Mínimo 12 caracteres",
                    },
                    {
                      name: "authority",
                      label: "Autoridad",
                      options: [
                        { value: "MEMBER", label: "Usuario empresarial" },
                        { value: "ADMIN", label: "Administrador" },
                      ],
                    },
                  ]}
                  submit={(v) =>
                    save("users", "POST", {
                      ...v,
                      username: v.username?.trim().toLowerCase(),
                      email: v.email || undefined,
                    })
                  }
                />
                <ActionForm
                  disabled={readOnly}
                  title="Actualizar usuario"
                  fields={[
                    { name: "id", label: "Usuario", options: companyOptions },
                    {
                      name: "displayName",
                      label: "Nuevo nombre (opcional)",
                      optional: true,
                    },
                    {
                      name: "active",
                      label: "Estado",
                      options: [
                        { value: "true", label: "Activo" },
                        { value: "false", label: "Inactivo" },
                      ],
                    },
                    {
                      name: "authority",
                      label: "Autoridad",
                      options: [
                        { value: "MEMBER", label: "Usuario empresarial" },
                        { value: "ADMIN", label: "Administrador" },
                      ],
                    },
                    {
                      name: "password",
                      label: "Nueva contraseña (opcional)",
                      type: "password",
                      optional: true,
                      minLength: 12,
                      placeholder: "Mínimo 12 caracteres",
                    },
                  ]}
                  submit={(v) =>
                    save(`users/${v.id}`, "PATCH", {
                      ...(v.displayName ? { displayName: v.displayName } : {}),
                      active: v.active === "true",
                      authority: v.authority,
                      ...(v.password ? { password: v.password } : {}),
                    })
                  }
                />
                <ActionForm
                  disabled={readOnly}
                  title="Crear o editar rol"
                  fields={[
                    {
                      name: "id",
                      label: "Rol existente (vacío para crear)",
                      options: tierOptions,
                      optional: true,
                    },
                    { name: "name", label: "Nombre del rol" },
                    {
                      name: "permissions",
                      label: "Permisos del rol",
                      options: permissionOptions,
                      multiple: true,
                      optional: true,
                    },
                  ]}
                  submit={(v) =>
                    save("roles", v.id ? "PUT" : "POST", {
                      id: v.id || undefined,
                      name: v.name,
                      permissions: parseList(v.permissions),
                    })
                  }
                />
                <ActionForm
                  disabled={readOnly}
                  title="Reemplazar roles y excepciones"
                  fields={[
                    { name: "id", label: "Usuario", options: companyOptions },
                    {
                      name: "roleIds",
                      label: "Roles (sin selección se retiran los actuales)",
                      options: tierOptions,
                      multiple: true,
                      optional: true,
                    },
                    {
                      name: "grants",
                      label: "Conceder permisos",
                      options: permissionOptions,
                      multiple: true,
                      optional: true,
                    },
                    {
                      name: "denials",
                      label: "Denegar permisos",
                      options: permissionOptions,
                      multiple: true,
                      optional: true,
                    },
                  ]}
                  submit={(v) =>
                    save(`users/${v.id}/permissions`, "PUT", {
                      roleIds: parseList(v.roleIds),
                      grants: parseList(v.grants),
                      denials: parseList(v.denials),
                    })
                  }
                />
                <section className="panel">
                  <h2>Permisos disponibles</h2>
                  <p>{permissionOptions.map((p) => p.label).join(" · ")}</p>
                  <p className="muted">
                    Las funciones administrativas requieren autoridad de
                    administrador. Asignar un permiso no convierte a un usuario
                    en administrador.
                  </p>
                </section>
              </>
            )}
          </div>
        </>
      )}
    </>
  )}
</main>
</div>
</div>
</div>
);
}
