"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useCallback, useEffect, useState } from "react";
import type { SessionActorDto } from "../../shared/contracts/commercial";
import type {
  WarrantyDto,
  OperationalIssueDto,
  OperationalCostDto,
  ManagementDashboardDto,
  OperationalReportDto,
  IntegratedSearchItemDto,
  InternalNotificationDto,
} from "../../shared/contracts/post-sale";
import { RequestPicker, CabinPicker } from "../components/request-picker";
import { apiRequest as api } from "../../shared/client/api-client";
import { ManagementCalendar } from "./management-calendar";
import { ManagementKanban } from "./management-kanban";
import { IssueEditor } from "./issue-editor";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(",") ? result.split(",")[1]! : result;
      resolve(base64);
    };
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(file);
  });
}

export type ManagementWorkspaceTab = "dashboard" | "calendar" | "kanban" | "warranties" | "issues" | "costs" | "reports" | "alerts";

export function ManagementWorkspace({
  readOnly,
  administrator,
  actor,
  activeTab,
  onTabChange,
}: {
  readOnly: boolean;
  administrator: boolean;
  actor: SessionActorDto | null;
  activeTab?: ManagementWorkspaceTab;
  onTabChange?: (tab: ManagementWorkspaceTab) => void;
}) {
  const [internalTab, setInternalTab] = useState<ManagementWorkspaceTab>(activeTab ?? "dashboard");
  const tab = activeTab ?? internalTab;
  const setTab = (t: ManagementWorkspaceTab) => {
    setInternalTab(t);
    onTabChange?.(t);
  };

  // Estados
  const [dashboard, setDashboard] = useState<ManagementDashboardDto | null>(null);
  const [warranties, setWarranties] = useState<WarrantyDto[]>([]);
  const [issues, setIssues] = useState<OperationalIssueDto[]>([]);
  const [costs, setCosts] = useState<OperationalCostDto[]>([]);
  const [report, setReport] = useState<OperationalReportDto | null>(null);
  const [notifications, setNotifications] = useState<InternalNotificationDto[]>([]);
  const [searchResults, setSearchResults] = useState<IntegratedSearchItemDto[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [pushStatus, setPushStatus] = useState<"unsupported" | "default" | "granted" | "denied">("default");
  const [isPushSubscribed, setIsPushSubscribed] = useState(false);
  const [pushSubscribedCount, setPushSubscribedCount] = useState<number | null>(null);
  const [pushLoading, setPushLoading] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    void Promise.resolve().then(async () => {
      if (typeof window === "undefined") return;
      if (!("Notification" in window)) {
        setPushStatus("unsupported");
        return;
      }
      setPushStatus(Notification.permission);
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.getRegistration("/sw.js");
          if (reg) {
            const sub = await reg.pushManager.getSubscription();
            setIsPushSubscribed(Boolean(sub));
          }
        }
        const statusRes = await api<{ activeSubscriptionsCount: number }>("notifications/push/status");
        setPushSubscribedCount(statusRes.activeSubscriptionsCount);
      } catch {
        // En caso de error de permisos o red, retener fallback
      }
    });
  }, []);

  const handleRequestPush = async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    setPushLoading(true);
    try {
      const permission = await Notification.requestPermission();
      setPushStatus(permission);
      if (permission === "granted") {
        const config = await api<{ serverConfigured: boolean; publicKey?: string }>("notifications/push/status");
        if (!config.serverConfigured || !config.publicKey) throw new Error("Push no configurado. Las alertas siguen disponibles en el centro interno.");
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Este navegador no admite push. Consulta el centro interno.");
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const subscription = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: config.publicKey });
        const serialized = subscription.toJSON();
        await api("notifications/push/subscribe", "POST", { endpoint: serialized.endpoint, keys: serialized.keys, userAgent: navigator.userAgent });

        setIsPushSubscribed(true);
        setPushSubscribedCount((prev) => (prev ?? 0) + 1);
        setSuccessMsg("Dispositivo suscrito exitosamente al canal de notificaciones Web Push.");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al activar notificaciones push");
    } finally {
      setPushLoading(false);
    }
  };

  const handleUnsubscribePush = async () => {
    setPushLoading(true);
    try {
      if (typeof window !== "undefined" && "serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            await api("notifications/push/unsubscribe", "POST", { endpoint: sub.endpoint });
            await sub.unsubscribe();
          }
        }
      }
      setIsPushSubscribed(false);
      setPushSubscribedCount((prev) => Math.max(0, (prev ?? 1) - 1));
      setSuccessMsg("Suscripción a notificaciones push revocada.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al revocar suscripción push");
    } finally {
      setPushLoading(false);
    }
  };

  const handleTestPushNotification = async () => {
    setPushLoading(true);
    try {
      const res = await api<{ success: boolean; deliveredTo: number; message: string }>(
        "notifications/push/test",
        "POST",
        {
          title: "Alerta Operativa de Prueba",
          message: "Entrega real de evento posterior confirmada.",
        },
      );
      setSuccessMsg(res.message);
      reloadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al enviar notificación de prueba");
    } finally {
      setPushLoading(false);
    }
  };

  // Auxiliares para asignación de usuarios y reemplazo de cabinas
  const [tenantUsers, setTenantUsers] = useState<Array<{ id: string; username: string; display_name?: string }>>([]);
  const [inStockCabins, setInStockCabins] = useState<Array<{ cabinId: string; productName?: string; location?: string }>>([]);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [cabinsError, setCabinsError] = useState<string | null>(null);

  // Gestión de Garantía Seleccionada
  const [selectedWarranty, setSelectedWarranty] = useState<WarrantyDto | null>(null);
  const [loadingWarrantyDetail, setLoadingWarrantyDetail] = useState(false);
  const [warrantySubAction, setWarrantySubAction] = useState<"ASSIGN" | "PHOTO" | "RESOLVE" | "REJECT" | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [isReplacement, setIsReplacement] = useState(false);
  const [replacementCabinId, setReplacementCabinId] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPhase, setPhotoPhase] = useState<"REPORT" | "INSPECTION" | "RESOLUTION">("INSPECTION");
  const [photoCaption, setPhotoCaption] = useState("");
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Anulación formal de costo
  const [annullingCost, setAnnullingCost] = useState<OperationalCostDto | null>(null);
  const [annulReason, setAnnulReason] = useState("");
  const [annulError, setAnnulError] = useState<string | null>(null);
  const [annulSubmitting, setAnnulSubmitting] = useState(false);

  // Formularios
  const [newWarranty, setNewWarranty] = useState({
    requestId: "",
    cabinId: "",
    claimType: "ACOUSTIC_DEFECT",
    description: "",
  });
  const [newIssue, setNewIssue] = useState({
    requestId: "",
    stage: "INSTALLATION",
    title: "",
    description: "",
    severity: "MEDIUM",
  });
  const [newCost, setNewCost] = useState({
    requestId: "",
    category: "INSTALLATION",
    concept: "",
    amount: "",
  });

  const [saving, setSaving] = useState(false);
  const canManage = (action: string) => !readOnly && !!actor?.active && actor.platformRole === "TENANT" &&
    !actor.denials?.includes(action) && (actor.authority === "ADMIN" || !!actor.grants?.includes(action) || !!actor.rolePermissions?.includes(action));
  const [formErrors, setFormErrors] = useState<{ warranty?: string; issue?: string; cost?: string }>({});

  const canSeeCosts =
    !actor?.denials?.includes("costs.read") &&
    (administrator ||
      actor?.authority === "ADMIN" ||
      actor?.grants?.includes("costs.read") ||
      actor?.rolePermissions?.includes("costs.read"));

  const reloadData = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      switch (tab) {
        case "dashboard": setDashboard(await api<ManagementDashboardDto>("management/dashboard")); break;
        case "warranties": setWarranties(await api<WarrantyDto[]>("warranties")); break;
        case "issues": setIssues(await api<OperationalIssueDto[]>("issues")); break;
        case "costs": setCosts(await api<OperationalCostDto[]>("costs")); break;
        case "reports": setReport(await api<OperationalReportDto>("management/reports")); break;
        case "alerts": setNotifications(await api<InternalNotificationDto[]>("notifications")); break;
      }
    } catch (err) { setError(err instanceof Error ? err.message : "No se pudo cargar esta sección."); }
    finally { setLoading(false); }
  }, [tab]);
  useEffect(() => { void Promise.resolve().then(reloadData); }, [reloadData]);

  useEffect(() => {
    if (tab === "warranties") {
      void Promise.resolve().then(async () => {
        setUsersError(null);
        setCabinsError(null);
        const [usersRes, cabinsRes] = await Promise.allSettled([
          api<Array<{ id: string; username: string; display_name?: string }>>("users"),
          api<Array<{ cabinId: string; productName?: string; location?: string; status: string }>>("inventory/cabins?status=IN_STOCK"),
        ]);
        if (usersRes.status === "fulfilled" && Array.isArray(usersRes.value)) {
          setTenantUsers(usersRes.value);
        } else if (usersRes.status === "rejected") {
          setTenantUsers([]);
          setUsersError("Sin autorización para listar usuarios / asignación técnica reservada.");
        }
        if (cabinsRes.status === "fulfilled" && Array.isArray(cabinsRes.value)) {
          setInStockCabins(cabinsRes.value.filter((c) => c.status === "IN_STOCK"));
        } else if (cabinsRes.status === "rejected") {
          setInStockCabins([]);
          setCabinsError("Sin autorización para consultar inventario de cabinas físicas.");
        }
      });
    }
  }, [tab]);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    try {
      const res = await api<IntegratedSearchItemDto[]>(`management/search?q=${encodeURIComponent(searchQuery)}`);
      setSearchResults(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al buscar");
    }
  };

  const handleCreateWarranty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || saving) return;
    setSaving(true);
    setError(null);
    setFormErrors((prev) => ({ ...prev, warranty: undefined }));
    try {
      await api("warranties", "POST", newWarranty);
      setSuccessMsg("Reclamo de garantía radicado exitosamente.");
      setNewWarranty({ requestId: "", cabinId: "", claimType: "ACOUSTIC_DEFECT", description: "" });
      reloadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al radicar garantía";
      setFormErrors((prev) => ({ ...prev, warranty: msg }));
    } finally {
      setSaving(false);
    }
  };

  const handleSelectWarranty = async (warranty: WarrantyDto) => {
    setSelectedWarranty(warranty);
    setLoadingWarrantyDetail(true);
    setActionError(null);
    setWarrantySubAction(null);
    try {
      const detail = await api<WarrantyDto>(`warranties/${warranty.id}`);
      setSelectedWarranty(detail);
      setAssigneeId(detail.assignedTo || "");
    } catch {
      // Retener el resumen previo
    } finally {
      setLoadingWarrantyDetail(false);
    }
  };

  const handleAssignWarranty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarranty || readOnly || !assigneeId) return;
    setActionSubmitting(true);
    setActionError(null);
    try {
      const updated = await api<WarrantyDto>(`warranties/${selectedWarranty.id}/status`, "POST", {
        status: selectedWarranty.status,
        assignedTo: assigneeId,
      });
      setSelectedWarranty(updated);
      setSuccessMsg(`Reclamo ${updated.code} asignado correctamente.`);
      setWarrantySubAction(null);
      reloadData();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error al asignar técnico.");
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleStartReview = async () => {
    if (!selectedWarranty || readOnly) return;
    setActionSubmitting(true);
    setActionError(null);
    try {
      const updated = await api<WarrantyDto>(`warranties/${selectedWarranty.id}/status`, "POST", {
        status: "IN_REVIEW",
      });
      setSelectedWarranty(updated);
      setSuccessMsg(`Reclamo ${updated.code} puesto en revisión.`);
      reloadData();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error al poner en revisión.");
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleUploadPhoto = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarranty || readOnly || !photoFile) return;
    if (!["image/jpeg", "image/png"].includes(photoFile.type)) {
      setActionError("El archivo debe ser una imagen válida (JPEG o PNG).");
      return;
    }
    setActionSubmitting(true);
    setActionError(null);
    try {
      const base64 = await fileToBase64(photoFile);
      await api("warranties/photos", "POST", {
        warrantyId: selectedWarranty.id,
        photoBase64: base64,
        mimeType: photoFile.type,
        photoPhase,
        caption: photoCaption.trim() || undefined,
      });
      const updated = await api<WarrantyDto>(`warranties/${selectedWarranty.id}`);
      setSelectedWarranty(updated);
      setPhotoFile(null);
      setPhotoCaption("");
      setSuccessMsg("Fotografía de evidencia anexada exitosamente.");
      setWarrantySubAction(null);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error al subir fotografía.");
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleResolveWarranty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarranty || readOnly) return;
    if (!resolutionNotes || resolutionNotes.trim().length < 5) {
      setActionError("Las notas de resolución técnica son obligatorias (mínimo 5 caracteres).");
      return;
    }
    if (isReplacement && !replacementCabinId) {
      setActionError("Para un reemplazo físico se debe seleccionar la cabina disponible en almacén.");
      return;
    }
    setActionSubmitting(true);
    setActionError(null);
    try {
      const payload: {
        status: "RESOLVED";
        resolutionNotes: string;
        isReplacement?: boolean;
        replacementCabinId?: string;
      } = {
        status: "RESOLVED",
        resolutionNotes: resolutionNotes.trim(),
        isReplacement,
        replacementCabinId: isReplacement ? replacementCabinId : undefined,
      };
      const updated = await api<WarrantyDto>(`warranties/${selectedWarranty.id}/status`, "POST", payload);
      setSelectedWarranty(updated);
      setSuccessMsg(`Reclamo ${updated.code} resuelto exitosamente.`);
      setWarrantySubAction(null);
      reloadData();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error al resolver reclamo.");
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleRejectWarranty = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarranty || readOnly) return;
    if (!rejectionReason || rejectionReason.trim().length < 5) {
      setActionError("El motivo formal de rechazo es obligatorio (mínimo 5 caracteres).");
      return;
    }
    setActionSubmitting(true);
    setActionError(null);
    try {
      const updated = await api<WarrantyDto>(`warranties/${selectedWarranty.id}/status`, "POST", {
        status: "REJECTED",
        rejectionReason: rejectionReason.trim(),
      });
      setSelectedWarranty(updated);
      setSuccessMsg(`Reclamo ${updated.code} ha sido rechazado.`);
      setWarrantySubAction(null);
      reloadData();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error al rechazar reclamo.");
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleCloseWarranty = async () => {
    if (!selectedWarranty || readOnly) return;
    setActionSubmitting(true);
    setActionError(null);
    try {
      const updated = await api<WarrantyDto>(`warranties/${selectedWarranty.id}/status`, "POST", {
        status: "CLOSED",
        resolutionNotes: selectedWarranty.resolutionNotes || "Cierre formal ratificado.",
      });
      setSelectedWarranty(updated);
      setSuccessMsg(`Reclamo ${updated.code} cerrado formalmente.`);
      setWarrantySubAction(null);
      reloadData();
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Error al cerrar reclamo.");
    } finally {
      setActionSubmitting(false);
    }
  };

  const handleCreateIssue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || saving) return;
    setSaving(true);
    setError(null);
    setFormErrors((prev) => ({ ...prev, issue: undefined }));
    try {
      await api("issues", "POST", newIssue);
      setSuccessMsg("Novedad operativa registrada exitosamente.");
      setNewIssue({ requestId: "", stage: "INSTALLATION", title: "", description: "", severity: "MEDIUM" });
      reloadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al registrar novedad";
      setFormErrors((prev) => ({ ...prev, issue: msg }));
    } finally {
      setSaving(false);
    }
  };

  const handleCreateCost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly || saving) return;
    setSaving(true);
    setError(null);
    setFormErrors((prev) => ({ ...prev, cost: undefined }));
    try {
      await api("costs", "POST", { ...newCost, amount: newCost.amount.trim().replace(",", ".") });
      setSuccessMsg("Costo operativo registrado exitosamente.");
      setNewCost({ requestId: "", category: "INSTALLATION", concept: "", amount: "" });
      reloadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Error al registrar costo";
      setFormErrors((prev) => ({ ...prev, cost: msg }));
    } finally {
      setSaving(false);
    }
  };

  const handleStartAnnulCost = (cost: OperationalCostDto) => {
    if (readOnly) return;
    setAnnullingCost(cost);
    setAnnulReason("");
    setAnnulError(null);
  };

  const handleConfirmAnnulCost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!annullingCost || readOnly) return;
    if (!annulReason || annulReason.trim().length < 5) {
      setAnnulError("El motivo de anulación es obligatorio (mínimo 5 caracteres).");
      return;
    }
    setAnnulSubmitting(true);
    setAnnulError(null);
    try {
      await api(`costs/${annullingCost.id}/annul`, "POST", { reason: annulReason.trim() });
      setSuccessMsg("Costo operativo anulado con éxito.");
      setAnnullingCost(null);
      reloadData();
    } catch (err: unknown) {
      setAnnulError(err instanceof Error ? err.message : "Error al anular costo");
    } finally {
      setAnnulSubmitting(false);
    }
  };

  const handleMarkNotificationRead = async (id: string) => {
    try {
      await api("notifications/read", "POST", { notificationId: id });
      setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    } catch {
      // Ignorar fallo de lectura individual
    }
  };

  const handleScanAlerts = async () => {
    try {
      const res = await api<{ generatedCount: number }>("notifications/scan", "POST", {});
      setSuccessMsg(`Escaneo completado: ${res.generatedCount} nuevas alertas generadas.`);
      reloadData();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error al escanear alertas");
    }
  };

  return (
    <div className="management-workspace">
      {/* Navegación por Pestañas */}
      <nav className="workspace-tabs" aria-label="Secciones de Posventa y Gestión">
        <button
          type="button"
          className={`workspace-tab ${tab === "dashboard" ? "active" : ""}`}
          onClick={() => setTab("dashboard")}
        >
           Panel de Control
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "calendar" ? "active" : ""}`}
          onClick={() => setTab("calendar")}
        >
           Calendario Integrado
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "kanban" ? "active" : ""}`}
          onClick={() => setTab("kanban")}
        >
           Tablero Kanban
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "warranties" ? "active" : ""}`}
          onClick={() => setTab("warranties")}
        >
           Garantías ({warranties.filter((w) => w.status !== "CLOSED" && w.status !== "REJECTED").length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "issues" ? "active" : ""}`}
          onClick={() => setTab("issues")}
        >
           Novedades ({issues.filter((i) => i.status === "OPEN" || i.status === "IN_PROGRESS").length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "costs" ? "active" : ""}`}
          onClick={() => setTab("costs")}
        >
           Costos Reales
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "reports" ? "active" : ""}`}
          onClick={() => setTab("reports")}
        >
           Reportes de Operación
        </button>
        <button
          type="button"
          className={`workspace-tab ${tab === "alerts" ? "active" : ""}`}
          onClick={() => setTab("alerts")}
        >
           Alertas ({notifications.filter((n) => !n.readAt).length})
        </button>
      </nav>

      {/* Avisos globales */}
      {error && (
        <div className="notice" role="alert" style={{ background: "#fdf2f2", borderColor: "#f8b4b4", color: "#9b1c1c", margin: "1rem 0" }}>
          <p style={{ margin: 0 }}><strong>Aviso:</strong> {error}</p>
          <button className="secondary" style={{ marginTop: "0.5rem" }} onClick={reloadData}>
             Reintentar Carga
          </button>
        </div>
      )}

      {successMsg && (
        <div className="notice" role="status" style={{ background: "#f0fdf4", borderColor: "#bbf7d0", color: "#166534", margin: "1rem 0" }}>
          <p style={{ margin: 0 }}>{successMsg}</p>
          <button className="secondary" style={{ marginTop: "0.5rem" }} onClick={() => setSuccessMsg(null)}>
            Cerrar aviso
          </button>
        </div>
      )}

      {loading && <p role="status">Cargando información del módulo…</p>}

      {/* PESTAÑA: DASHBOARD */}
      {tab === "dashboard" && dashboard && (
        <div className="tab-pane">
          {/* Buscador Integrado */}
          <section className="panel" style={{ marginBottom: "1.5rem" }}>
            <h2> Búsqueda Integrada</h2>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="text"
                placeholder="Buscar por código de solicitud, cliente, garantía o novedad..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="submit" className="primary">Buscar</button>
            </form>

            {searchResults.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <h3>Resultados encontrados ({searchResults.length}):</h3>
                <ul style={{ listStyle: "none", padding: 0 }}>
                  {searchResults.map((item) => (
                    <li key={`${displayLabel(item.kind)}-${item.id}`} style={{ padding: "0.5rem", borderBottom: "1px solid #e5e7eb" }}>
                      <strong>[{displayLabel(item.kind)}] {item.title}</strong> — <span className="muted">{item.subtitle}</span> ({displayLabel(item.status)})
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Tarjetas KPI */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", marginBottom: "1.5rem" }}>
            <div className="panel" style={{ textAlign: "center" }}>
              <p className="muted" style={{ margin: 0 }}>Solicitudes Activas</p>
              <h2 style={{ fontSize: "2rem", margin: "0.5rem 0", color: "#0e7490" }}>{dashboard.summary.activeRequests}</h2>
              <small className="muted">Total: {dashboard.summary.totalRequests}</small>
            </div>
            <div className="panel" style={{ textAlign: "center" }}>
              <p className="muted" style={{ margin: 0 }}>Cabinas Despachadas</p>
              <h2 style={{ fontSize: "2rem", margin: "0.5rem 0", color: "#166534" }}>{dashboard.summary.dispatchedCabins}</h2>
              <small className="muted">Pendientes obra: {dashboard.summary.pendingInstallations}</small>
            </div>
            <div className="panel" style={{ textAlign: "center" }}>
              <p className="muted" style={{ margin: 0 }}>Novedades Abiertas</p>
              <h2 style={{ fontSize: "2rem", margin: "0.5rem 0", color: "#b45309" }}>{dashboard.summary.openIssues}</h2>
              <small className="muted">Requieren atención</small>
            </div>
            <div className="panel" style={{ textAlign: "center" }}>
              <p className="muted" style={{ margin: 0 }}>Garantías en Curso</p>
              <h2 style={{ fontSize: "2rem", margin: "0.5rem 0", color: "#7e22ce" }}>{dashboard.summary.openWarranties}</h2>
              <small className="muted">Por cabina física</small>
            </div>
          </div>

          {/* Resumen Financiero */}
          <section className="panel" style={{ marginBottom: "1.5rem" }}>
            <h2> Indicadores Financieros de Gestión</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem" }}>
              <div>
                <p className="muted" style={{ margin: 0 }}>Total Cotizado Aprobado</p>
                <h3 style={{ margin: "0.2rem 0" }}>${dashboard.summary.financialTotals.quotedAmount}</h3>
              </div>
              <div>
                <p className="muted" style={{ margin: 0 }}>Recaudo Neto Validado</p>
                <h3 style={{ margin: "0.2rem 0", color: "#166534" }}>${dashboard.summary.financialTotals.collectedAmount}</h3>
              </div>
              <div>
                <p className="muted" style={{ margin: 0 }}>Saldo por Cobrar</p>
                <h3 style={{ margin: "0.2rem 0", color: "#b45309" }}>${dashboard.summary.financialTotals.outstandingBalance}</h3>
              </div>
              <div>
                <p className="muted" style={{ margin: 0 }}>Costos Operativos Reales</p>
                <h3 style={{ margin: "0.2rem 0" }}>
                  {dashboard.summary.financialTotals.operationalCosts !== null
                    ? `$${dashboard.summary.financialTotals.operationalCosts}`
                    : "[CONFIDENCIAL]"}
                </h3>
              </div>
              <div>
                <p className="muted" style={{ margin: 0 }}>Margen Neto Estimado</p>
                <h3 style={{ margin: "0.2rem 0", color: "#0e7490" }}>
                  {dashboard.summary.financialTotals.netMargin !== null
                    ? `$${dashboard.summary.financialTotals.netMargin}`
                    : "[CONFIDENCIAL]"}
                </h3>
              </div>
            </div>
          </section>
        </div>
      )}

      {/* PESTAÑA: CALENDARIO INTEGRADO */}
      {tab === "calendar" && (
        <div className="tab-pane">
          <ManagementCalendar />
        </div>
      )}

      {/* PESTAÑA: TABLERO KANBAN */}
      {tab === "kanban" && (
        <div className="tab-pane">
          <ManagementKanban />
        </div>
      )}

      {/* PESTAÑA: GARANTÍAS */}
      {tab === "warranties" && (
        <div className="tab-pane">
          {canManage("warranties.manage") && (
            <section className="panel" style={{ marginBottom: "1.5rem" }}>
              <h2>Radicar Reclamo de Garantía</h2>
              <form onSubmit={handleCreateWarranty} className="management-form">
                <div>
                  <RequestPicker value={newWarranty.requestId} onChange={(requestId) => setNewWarranty({ ...newWarranty, requestId, cabinId: "" })} />
                </div>
                <div>
                  <CabinPicker key={newWarranty.requestId} requestId={newWarranty.requestId} value={newWarranty.cabinId} onChange={(cabinId) => setNewWarranty({ ...newWarranty, cabinId })} />
                </div>
                <div>
                  <label htmlFor="management-field-1">Tipo de Reclamo:</label>
                  <select id="management-field-1"
                    value={newWarranty.claimType}
                    onChange={(e) => setNewWarranty({ ...newWarranty, claimType: e.target.value })}
                  >
                    <option value="ACOUSTIC_DEFECT">Falla Acústica / Aislamiento</option>
                    <option value="STRUCTURAL_DEFECT">Falla Estructural / Desajuste</option>
                    <option value="HARDWARE_DEFECT">Herrajes / Cerraduras / Bisagras</option>
                    <option value="FINISH_DEFECT">Defecto de Acabados / Tapicería</option>
                    <option value="INSTALLATION_DEFECT">Defecto de Montaje / Anclaje</option>
                    <option value="OTHER">Otro</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="management-field-2">Descripción detallada de la anomalía:</label>
                  <textarea id="management-field-2"
                    required
                    rows={3}
                    value={newWarranty.description}
                    onChange={(e) => setNewWarranty({ ...newWarranty, description: e.target.value })}
                    placeholder="Detalles de la falla observada por el cliente..."
                  />
                </div>
                {formErrors.warranty && (
                  <p style={{ color: "#dc2626", margin: "0.2rem 0", fontSize: "0.9rem" }}>
                     {formErrors.warranty}
                  </p>
                )}
                <button type="submit" className="primary" disabled={saving || !newWarranty.requestId || !newWarranty.cabinId}>Radicar Garantía</button>
              </form>
            </section>
          )}

          <section className="panel">
            <h2>Historial de Garantías Radicadas</h2>
            {warranties.length === 0 ? (
              <p className="muted">No hay reclamos de garantía registrados.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                    <th>Código</th>
                    <th>Solicitud</th>
                    <th>Producto</th>
                    <th>Tipo</th>
                    <th>Estado</th>
                    <th>Asignado</th>
                    <th>Fecha</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {warranties.map((w) => (
                    <tr key={w.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td><strong>{w.code}</strong></td>
                      <td>{w.requestCode || w.requestId.slice(0, 8)}</td>
                      <td>{w.productName || "Cabina"}</td>
                      <td>{displayLabel(w.claimType)}</td>
                      <td>
                        <span style={{
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.85rem",
                          background: (w.status === "RESOLVED" || w.status === "CLOSED") ? "#dcfce7" : w.status === "REJECTED" ? "#fee2e2" : "#fef3c7",
                          color: (w.status === "RESOLVED" || w.status === "CLOSED") ? "#166534" : w.status === "REJECTED" ? "#991b1b" : "#92400e",
                        }}>
                          {displayLabel(w.status)}
                        </span>
                      </td>
                      <td>{w.assignedToName || "Sin asignar"}</td>
                      <td>{new Date(w.createdAt).toLocaleDateString()}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => handleSelectWarranty(w)}
                        >
                          Gestionar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {/* Panel de Expediente y Gestión de Garantía */}
          {selectedWarranty && (
            <section className="panel" style={{ marginTop: "1.5rem", border: "1px solid #739e90", background: "#fcfdfd" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
                <h3 style={{ margin: 0 }}>
                  Expediente de Garantía: <strong>{selectedWarranty.code}</strong>
                </h3>
                <button type="button" className="secondary" onClick={() => setSelectedWarranty(null)}>
                  Cerrar Expediente
                </button>
              </div>

              {loadingWarrantyDetail && <p role="status">Cargando expediente completo de garantía…</p>}

              {/* Resumen del caso */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "1rem" }}>
                <div>
                  <p className="muted" style={{ margin: 0 }}>Solicitud de Origen</p>
                  <strong>{selectedWarranty.requestCode || selectedWarranty.requestId.slice(0, 8)}</strong>
                </div>
                <div>
                  <p className="muted" style={{ margin: 0 }}>Cabina Física Individual</p>
                  <strong>{selectedWarranty.productName || "Cabina"}</strong>
                  <br />
                  <small className="muted">{selectedWarranty.cabinId}</small>
                </div>
                <div>
                  <p className="muted" style={{ margin: 0 }}>Tipo de Reclamo</p>
                  <strong>{displayLabel(selectedWarranty.claimType)}</strong>
                </div>
                <div>
                  <p className="muted" style={{ margin: 0 }}>Estado Actual</p>
                  <span style={{
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "0.85rem",
                    fontWeight: 600,
                    background: (selectedWarranty.status === "RESOLVED" || selectedWarranty.status === "CLOSED") ? "#dcfce7" : selectedWarranty.status === "REJECTED" ? "#fee2e2" : "#fef3c7",
                    color: (selectedWarranty.status === "RESOLVED" || selectedWarranty.status === "CLOSED") ? "#166534" : selectedWarranty.status === "REJECTED" ? "#991b1b" : "#92400e",
                  }}>
                    {displayLabel(selectedWarranty.status)}
                  </span>
                </div>
                <div>
                  <p className="muted" style={{ margin: 0 }}>Responsable Asignado</p>
                  <strong>{selectedWarranty.assignedToName || "Sin asignar"}</strong>
                </div>
              </div>

              {/* Descripción inicial y términos pactados */}
              <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "8px", marginBottom: "1rem" }}>
                <p style={{ margin: "0 0 6px 0" }}><strong>Descripción reportada por el cliente:</strong></p>
                <p style={{ margin: 0, color: "#334155" }}>{selectedWarranty.description}</p>
                {selectedWarranty.warrantyTermsSnapshot != null && (
                  <div style={{ marginTop: "10px", paddingTop: "10px", borderTop: "1px dashed #cbd5e1", fontSize: "0.85rem", color: "#475569" }}>
                    <strong>Términos pactados en acta de entrega:</strong>{" "}
                    {(selectedWarranty.warrantyTermsSnapshot as { pactado?: string | null })?.pactado || "Términos estándar según acta de cierre operativo."}
                    {" "}
                    <span className="muted">
                      (Firmado: {(selectedWarranty.warrantyTermsSnapshot as { signedAt?: string | null })?.signedAt
                        ? new Date((selectedWarranty.warrantyTermsSnapshot as { signedAt: string }).signedAt).toLocaleDateString()
                        : "Conforme"})
                    </span>
                  </div>
                )}
              </div>

              {/* Avisos de resolución o rechazo */}
              {selectedWarranty.status === "REJECTED" && (
                <div className="notice" role="alert" style={{ background: "#fef2f2", borderColor: "#fca5a5", color: "#991b1b", marginBottom: "1rem" }}>
                  <strong>Reclamo Rechazado:</strong> {selectedWarranty.rejectionReason}
                </div>
              )}

              {(selectedWarranty.status === "RESOLVED" || selectedWarranty.status === "CLOSED") && (
                <div className="notice" role="status" style={{ background: "#f0fdf4", borderColor: "#86efac", color: "#166534", marginBottom: "1rem" }}>
                  <p style={{ margin: 0 }}><strong>Resolución Técnica:</strong> {selectedWarranty.resolutionNotes}</p>
                  {selectedWarranty.isReplacement && (
                    <p style={{ margin: "6px 0 0 0" }}>
                      <strong>Reemplazo Físico Autorizado:</strong> Cabina instalada ID <code>{selectedWarranty.replacementCabinId}</code>
                    </p>
                  )}
                </div>
              )}

              {/* Evidencias fotográficas */}
              <div style={{ marginBottom: "1.5rem" }}>
                <h4>Evidencias Fotográficas ({selectedWarranty.photos?.length ?? 0})</h4>
                {(!selectedWarranty.photos || selectedWarranty.photos.length === 0) ? (
                  <p className="muted" style={{ fontSize: "0.9rem" }}>No se han registrado fotografías de evidencia para este reclamo.</p>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "10px", marginTop: "8px" }}>
                    {selectedWarranty.photos.map((p) => (
                      <div key={p.id} style={{ border: "1px solid #e2e8f0", borderRadius: "8px", padding: "10px", background: "#fff" }}>
                        <span style={{ fontSize: "0.75rem", background: "#e0e7ff", color: "#3730a3", padding: "2px 6px", borderRadius: "4px" }}>
                          {displayLabel(p.photoPhase)}
                        </span>
                        <p style={{ margin: "6px 0 4px", fontSize: "0.85rem" }}>{p.caption || "Sin descripción"}</p>
                        <small className="muted">{new Date(p.createdAt).toLocaleString()}</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Mensaje de error de acción si ocurre */}
              {actionError && (
                <div className="notice" role="alert" style={{ background: "#fef2f2", borderColor: "#fca5a5", color: "#991b1b", marginBottom: "1rem" }}>
                  <strong>Error:</strong> {actionError}
                </div>
              )}

              {/* Botones de acción según estado */}
              {canManage("warranties.manage") && selectedWarranty.status !== "CLOSED" && selectedWarranty.status !== "REJECTED" && (
                <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "1rem" }}>
                  <h4 style={{ marginBottom: "0.75rem" }}>Acciones del Expediente</h4>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "1rem" }}>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => { setWarrantySubAction(warrantySubAction === "ASSIGN" ? null : "ASSIGN"); setActionError(null); }}
                    >
                      Asignar Responsable
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => { setWarrantySubAction(warrantySubAction === "PHOTO" ? null : "PHOTO"); setActionError(null); }}
                    >
                      Adjuntar Evidencia Fotográfica
                    </button>
                    {selectedWarranty.status === "REGISTERED" && (
                      <button
                        type="button"
                        className="primary"
                        disabled={actionSubmitting}
                        onClick={handleStartReview}
                      >
                        Iniciar Revisión / Atender
                      </button>
                    )}
                    {(selectedWarranty.status === "IN_REVIEW" || selectedWarranty.status === "IN_PROGRESS" || selectedWarranty.status === "ACCEPTED") && (
                      <>
                        <button
                          type="button"
                          className="primary"
                          onClick={() => { setWarrantySubAction(warrantySubAction === "RESOLVE" ? null : "RESOLVE"); setActionError(null); }}
                        >
                          Resolver Reclamo
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          style={{ color: "#dc2626", borderColor: "#fca5a5" }}
                          onClick={() => { setWarrantySubAction(warrantySubAction === "REJECT" ? null : "REJECT"); setActionError(null); }}
                        >
                          Rechazar Reclamo
                        </button>
                      </>
                    )}
                    {selectedWarranty.status === "RESOLVED" && (
                      <button
                        type="button"
                        className="primary"
                        disabled={actionSubmitting}
                        onClick={handleCloseWarranty}
                      >
                        Cerrar Reclamo Formalmente
                      </button>
                    )}
                  </div>

                  {/* Subformulario: ASIGNAR */}
                  {warrantySubAction === "ASSIGN" && (
                    <form onSubmit={handleAssignWarranty} style={{ background: "#f8fafc", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
                      <h5>Asignar Técnico o Responsable</h5>
                      {usersError && (
                        <p className="notice" role="alert" style={{ fontSize: "0.85rem", color: "#b45309", marginBottom: "0.5rem" }}>
                          ℹ️ {usersError}
                        </p>
                      )}
                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <select
                          value={assigneeId}
                          onChange={(e) => setAssigneeId(e.target.value)}
                          style={{ flex: 1 }}
                          disabled={!!usersError || tenantUsers.length === 0}
                        >
                          <option value="">
                            {usersError ? `-- ${usersError} --` : "-- Seleccionar técnico / usuario --"}
                          </option>
                          {tenantUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.display_name ? `${u.display_name} (${u.username})` : u.username}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="primary" disabled={actionSubmitting || !assigneeId}>
                          Guardar Asignación
                        </button>
                        <button type="button" className="secondary" onClick={() => setWarrantySubAction(null)}>
                          Cancelar
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Subformulario: FOTO */}
                  {warrantySubAction === "PHOTO" && (
                    <form onSubmit={handleUploadPhoto} style={{ background: "#f8fafc", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
                      <h5>Subir Fotografía de Evidencia</h5>
                      <div style={{ display: "grid", gap: "0.75rem", maxWidth: "600px" }}>
                        <div>
                          <label htmlFor="warranty-photo-input">Archivo de imagen (JPEG o PNG):</label>
                          <input
                            id="warranty-photo-input"
                            type="file"
                            accept="image/jpeg,image/png"
                            onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                          />
                        </div>
                        <div>
                          <label htmlFor="warranty-phase-select">Fase de la Evidencia:</label>
                          <select
                            id="warranty-phase-select"
                            value={photoPhase}
                            onChange={(e) => setPhotoPhase(e.target.value as "REPORT" | "INSPECTION" | "RESOLUTION")}
                          >
                            <option value="INSPECTION">Inspección Técnica en Sitio</option>
                            <option value="RESOLUTION">Resolución / Reparación</option>
                            <option value="REPORT">Reporte de Cliente</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="warranty-caption-input">Descripción / Observación:</label>
                          <input
                            id="warranty-caption-input"
                            type="text"
                            value={photoCaption}
                            onChange={(e) => setPhotoCaption(e.target.value)}
                            placeholder="Ej. Detalle de junta desalineada en panel izquierdo"
                          />
                        </div>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button type="submit" className="primary" disabled={actionSubmitting || !photoFile}>
                            {actionSubmitting ? "Subiendo…" : "Adjuntar Fotografía"}
                          </button>
                          <button type="button" className="secondary" onClick={() => setWarrantySubAction(null)}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    </form>
                  )}

                  {/* Subformulario: RESOLVER */}
                  {warrantySubAction === "RESOLVE" && (
                    <form onSubmit={handleResolveWarranty} style={{ background: "#f8fafc", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
                      <h5>Resolución Técnica del Reclamo</h5>
                      <div style={{ display: "grid", gap: "0.75rem", maxWidth: "600px" }}>
                        <div>
                          <label htmlFor="warranty-resolve-notes">Notas detalladas de resolución técnica:</label>
                          <textarea
                            id="warranty-resolve-notes"
                            rows={3}
                            required
                            value={resolutionNotes}
                            onChange={(e) => setResolutionNotes(e.target.value)}
                            placeholder="Detalles del trabajo correctivo realizado en la cabina..."
                          />
                        </div>

                        {(administrator || actor?.authority === "ADMIN") && (
                          <div style={{ border: "1px solid #e2e8f0", padding: "10px", borderRadius: "6px", background: "#fff" }}>
                            <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={isReplacement}
                                onChange={(e) => setIsReplacement(e.target.checked)}
                              />
                              <strong>Reemplazo Físico de Cabina (Decisión Administrativa)</strong>
                            </label>
                            {isReplacement && (
                              <div style={{ marginTop: "10px" }}>
                                <label htmlFor="replacement-cabin-select">Cabina de reemplazo disponible en almacén (IN_STOCK):</label>
                                <select
                                  id="replacement-cabin-select"
                                  value={replacementCabinId}
                                  onChange={(e) => setReplacementCabinId(e.target.value)}
                                  required={isReplacement}
                                  style={{ width: "100%", marginTop: "4px" }}
                                >
                                  <option value="">-- Seleccionar cabina en existencias --</option>
                                  {inStockCabins.map((c) => (
                                    <option key={c.cabinId} value={c.cabinId}>
                                      {c.productName || "Cabina"} (ID: {c.cabinId.slice(0, 8)}…) {c.location ? `- Ubicación: ${c.location}` : ""}
                                    </option>
                                  ))}
                                </select>
                                {cabinsError ? (
                                  <small style={{ color: "#dc2626" }}>⚠️ {cabinsError}</small>
                                ) : inStockCabins.length === 0 ? (
                                  <small style={{ color: "#dc2626" }}>
                                    No hay cabinas con estado IN_STOCK disponibles en almacén para reemplazo.
                                  </small>
                                ) : null}
                              </div>
                            )}
                          </div>
                        )}

                        {(!selectedWarranty.photos || selectedWarranty.photos.length === 0) && (
                          <p style={{ color: "#b45309", fontSize: "0.85rem", margin: 0 }}>
                            Aviso: El backend exige al menos una fotografía de evidencia previa antes de resolver.
                          </p>
                        )}

                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button type="submit" className="primary" disabled={actionSubmitting}>
                            {actionSubmitting ? "Resolviendo…" : "Confirmar Resolución"}
                          </button>
                          <button type="button" className="secondary" onClick={() => setWarrantySubAction(null)}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    </form>
                  )}

                  {/* Subformulario: RECHAZAR */}
                  {warrantySubAction === "REJECT" && (
                    <form onSubmit={handleRejectWarranty} style={{ background: "#f8fafc", padding: "1rem", borderRadius: "8px", marginBottom: "1rem" }}>
                      <h5>Rechazo Sustentado del Reclamo</h5>
                      <div style={{ display: "grid", gap: "0.75rem", maxWidth: "600px" }}>
                        <div>
                          <label htmlFor="warranty-reject-reason">Motivo formal de rechazo con sustento:</label>
                          <textarea
                            id="warranty-reject-reason"
                            rows={3}
                            required
                            value={rejectionReason}
                            onChange={(e) => setRejectionReason(e.target.value)}
                            placeholder="Detallar por qué el defecto no está cubierto según los términos pactados..."
                          />
                        </div>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button type="submit" className="primary" style={{ background: "#dc2626" }} disabled={actionSubmitting}>
                            {actionSubmitting ? "Rechazando…" : "Confirmar Rechazo"}
                          </button>
                          <button type="button" className="secondary" onClick={() => setWarrantySubAction(null)}>
                            Cancelar
                          </button>
                        </div>
                      </div>
                    </form>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* PESTAÑA: NOVEDADES */}
      {tab === "issues" && (
        <div className="tab-pane">
          {canManage("issues.manage") && (
            <section className="panel" style={{ marginBottom: "1.5rem" }}>
              <h2>Registrar Nueva Novedad Operativa</h2>
              <form onSubmit={handleCreateIssue} className="management-form">
                <div>
                  <RequestPicker value={newIssue.requestId} onChange={(requestId) => setNewIssue({ ...newIssue, requestId })} />
                </div>
                <div>
                  <label htmlFor="management-field-3">Etapa del Flujo:</label>
                  <select id="management-field-3"
                    value={newIssue.stage}
                    onChange={(e) => setNewIssue({ ...newIssue, stage: e.target.value })}
                  >
                    <option value="VISIT">Visita Técnica</option>
                    <option value="PROCUREMENT">Compras y Suministros</option>
                    <option value="TRANSPORT">Transporte y Ruta</option>
                    <option value="INSTALLATION">Instalación en Campo</option>
                    <option value="WARRANTY">Posventa y Garantía</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="management-field-4">Severidad:</label>
                  <select id="management-field-4"
                    value={newIssue.severity}
                    onChange={(e) => setNewIssue({ ...newIssue, severity: e.target.value })}
                  >
                    <option value="LOW">Baja (Informativa)</option>
                    <option value="MEDIUM">Media (Desviación menor)</option>
                    <option value="HIGH">Alta (Riesgo operativo)</option>
                    <option value="BLOCKING">Bloqueante (Detiene operación)</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="management-field-5">Título de la Novedad:</label>
                  <input id="management-field-5"
                    type="text"
                    required
                    value={newIssue.title}
                    onChange={(e) => setNewIssue({ ...newIssue, title: e.target.value })}
                    placeholder="Ej. Inconsistencia de medidas en hueco de escalera"
                  />
                </div>
                <div>
                  <label htmlFor="management-field-6">Descripción detallada:</label>
                  <textarea id="management-field-6"
                    required
                    rows={3}
                    value={newIssue.description}
                    onChange={(e) => setNewIssue({ ...newIssue, description: e.target.value })}
                  />
                </div>
                {formErrors.issue && (
                  <p style={{ color: "#dc2626", margin: "0.2rem 0", fontSize: "0.9rem" }}>
                     {formErrors.issue}
                  </p>
                )}
                <button type="submit" className="primary" disabled={saving || !newIssue.requestId}>Registrar Novedad</button>
              </form>
            </section>
          )}

          <section className="panel">
            <h2>Novedades Registradas</h2>
            {issues.length === 0 ? (
              <p className="muted">No hay novedades registradas.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                    <th>Etapa</th>
                    <th>Título</th>
                    <th>Severidad</th>
                    <th>Estado</th>
                    <th>Solicitud</th>
                    <th>Fecha</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.map((i) => (
                    <tr key={i.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td><strong>{displayLabel(i.stage)}</strong></td>
                      <td>{i.title}</td>
                      <td>
                        <span style={{
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "0.85rem",
                          background: i.severity === "BLOCKING" ? "#fee2e2" : i.severity === "HIGH" ? "#ffedd5" : "#f3f4f6",
                          color: i.severity === "BLOCKING" ? "#991b1b" : i.severity === "HIGH" ? "#9a3412" : "#374151",
                        }}>
                          {displayLabel(i.severity)}
                        </span>
                      </td>
                      <td>{displayLabel(i.status)}{i.resolutionNotes && <p className="muted">{i.resolutionNotes}</p>}</td>
                      <td>{i.requestCode || i.requestId.slice(0, 8)}</td>
                      <td>{new Date(i.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      {tab === "issues" && canManage("issues.manage") && <IssueEditor issues={issues} onSaved={reloadData} />}

      {/* PESTAÑA: COSTOS REALES */}
      {tab === "costs" && (
        <div className="tab-pane">
          {!canSeeCosts && (
            <p className="notice" role="status" style={{ marginBottom: "1rem" }}>
               Confidencialidad activa: Los montos financieros están restringidos para su perfil de usuario (requiere permiso costs.read o rol Administrador).
            </p>
          )}
          {canManage("costs.manage") && (
            <section className="panel" style={{ marginBottom: "1.5rem" }}>
              <h2>Imputar Costo Operativo Real</h2>
              <form onSubmit={handleCreateCost} className="management-form">
                <div>
                  <RequestPicker value={newCost.requestId} onChange={(requestId) => setNewCost({ ...newCost, requestId })} />
                </div>
                <div>
                  <label htmlFor="management-field-7">Categoría del Gasto:</label>
                  <select id="management-field-7"
                    value={newCost.category}
                    onChange={(e) => setNewCost({ ...newCost, category: e.target.value })}
                  >
                    <option value="PURCHASE">Compras / Proveedores</option>
                    <option value="INSTALLATION">Mano de Obra / Instalación</option>
                    <option value="TRANSPORT">Flete / Transporte</option>
                    <option value="PER_DIEM">Viáticos / Alimentación</option>
                    <option value="MATERIAL">Materiales Adicionales</option>
                    <option value="REWORK">Reprocesos / Correcciones</option>
                    <option value="WARRANTY">Atención de Garantía</option>
                    <option value="OTHER">Otros Gastos Operativos</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="management-field-8">Concepto:</label>
                  <input id="management-field-8"
                    type="text"
                    required
                    value={newCost.concept}
                    onChange={(e) => setNewCost({ ...newCost, concept: e.target.value })}
                    placeholder="Ej. Peajes y combustible ruta Medellín-Rionegro"
                  />
                </div>
                <div>
                  <label htmlFor="management-field-9">Importe exacto (COP):</label>
                  <input id="management-field-9"
                    type="text"
                    required
                    value={newCost.amount}
                    onChange={(e) => setNewCost({ ...newCost, amount: e.target.value })}
                    placeholder="150000.00"
                  />
                </div>
                {formErrors.cost && (
                  <p style={{ color: "#dc2626", margin: "0.2rem 0", fontSize: "0.9rem" }}>
                     {formErrors.cost}
                  </p>
                )}
                <button type="submit" className="primary" disabled={saving || !newCost.requestId}>Imputar Costo</button>
              </form>
            </section>
          )}

          {/* Panel de Confirmación de Anulación de Costo */}
          {annullingCost && (
            <section className="panel" style={{ marginBottom: "1.5rem", border: "1px solid #f87171", background: "#fef2f2" }}>
              <h3 style={{ color: "#991b1b", marginTop: 0 }}>Confirmar Anulación de Costo Operativo</h3>
              <p>
                ¿Está seguro de anular el costo <strong>{annullingCost.concept}</strong> ({displayLabel(annullingCost.category)}) por importe{" "}
                <strong>{annullingCost.amount ? `$${annullingCost.amount}` : ""}</strong>?
              </p>
              <form onSubmit={handleConfirmAnnulCost}>
                <label htmlFor="cost-annul-reason">Motivo formal y justificación de la anulación (mínimo 5 caracteres):</label>
                <input
                  id="cost-annul-reason"
                  type="text"
                  required
                  value={annulReason}
                  onChange={(e) => setAnnulReason(e.target.value)}
                  placeholder="Ej. Duplicidad de comprobante de flete Medellín-Rionegro"
                  style={{ width: "100%", marginTop: "0.25rem", marginBottom: "0.5rem" }}
                />
                {annulError && (
                  <p style={{ color: "#dc2626", margin: "0.25rem 0 0.5rem", fontSize: "0.9rem" }}>
                    {annulError}
                  </p>
                )}
                <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.75rem" }}>
                  <button
                    type="submit"
                    className="primary"
                    style={{ background: "#dc2626" }}
                    disabled={annulSubmitting}
                  >
                    {annulSubmitting ? "Anulando…" : "Confirmar Anulación"}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={annulSubmitting}
                    onClick={() => setAnnullingCost(null)}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            </section>
          )}

          <section className="panel">
            <h2>Gastos y Costos Imputados</h2>
            {costs.length === 0 ? (
              <p className="muted">No hay costos operativos registrados.</p>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                    <th>Categoría</th>
                    <th>Concepto</th>
                    <th>Importe</th>
                    <th>Solicitud</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.map((c) => (
                    <tr key={c.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                      <td><strong>{displayLabel(c.category)}</strong></td>
                      <td>{c.concept}</td>
                      <td>
                        <strong>{canSeeCosts && c.amount !== null ? `$${c.amount}` : "[CONFIDENCIAL]"}</strong>
                      </td>
                      <td>{c.requestCode || c.requestId.slice(0, 8)}</td>
                      <td>{c.active ? "Activo" : `Anulado (${c.annulmentReason})`}</td>
                      <td>
                        {c.active && !readOnly && (
                          <button className="secondary" onClick={() => handleStartAnnulCost(c)}>
                            Anular
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}

      {/* PESTAÑA: REPORTES */}
      {tab === "reports" && report && (
        <div className="tab-pane">
          <section className="panel">
            <h2>Informe Operativo Consolidado por Solicitud</h2>
            <div style={{ display: "flex", gap: "2rem", marginBottom: "1rem" }}>
              <div><strong>Total Solicitudes:</strong> {report.totals.totalRequests}</div>
              <div><strong>Total Cabinas:</strong> {report.totals.totalCabins}</div>
              <div><strong>Total Cotizado:</strong> ${report.totals.quotedSum}</div>
              <div><strong>Total Recaudado:</strong> ${report.totals.collectedSum}</div>
              <div><strong>Saldo Pendiente:</strong> ${report.totals.balanceSum}</div>
              <div>
                <strong>Costos Totales:</strong>{" "}
                {report.totals.costsSum !== null ? `$${report.totals.costsSum}` : "[CONFIDENCIAL]"}
              </div>
            </div>

            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
                  <th>Código</th>
                  <th>Cliente</th>
                  <th>Cabinas</th>
                  <th>Estado Comercial</th>
                  <th>Estado Operativo</th>
                  <th>Estado Financiero</th>
                  <th>Cotizado</th>
                  <th>Recaudado</th>
                  <th>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.requestId} style={{ borderBottom: "1px solid #f3f4f6" }}>
                    <td><strong>{r.requestCode}</strong></td>
                    <td>{r.clientName}</td>
                    <td>{r.totalCabins}</td>
                    <td>{displayLabel(r.commercialStatus)}</td>
                    <td>{displayLabel(r.operationalStatus)}</td>
                    <td>{displayLabel(r.financialStatus)}</td>
                    <td>${r.quotedTotal}</td>
                    <td>${r.netCollected}</td>
                    <td>${r.pendingBalance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {/* PESTAÑA: ALERTAS */}
      {tab === "alerts" && (
        <div className="tab-pane">
          <section className="panel" style={{ marginBottom: "1.5rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2>Centro Interno de Alertas Persistentes</h2>
              {!readOnly && (
                <button className="primary" onClick={handleScanAlerts}>
                   Escanear Alertas Automáticas
                </button>
              )}
            </div>

            {/* Control voluntario de Web Push con Fallback Interno */}
            <div
              style={{
                marginTop: "1rem",
                padding: "1rem",
                borderRadius: "6px",
                border: "1px solid #e5e7eb",
                background: "#f9fafb",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.75rem",
              }}
            >
              <div>
                <strong>Notificaciones de Escritorio (Web Push)</strong>
                <p style={{ margin: "0.25rem 0 0", color: "#4b5563", fontSize: "0.875rem" }}>
                  {pushStatus === "granted" && isPushSubscribed && "🟢 Notificaciones Web Push activas con Service Worker registrado."}
                  {pushStatus === "granted" && !isPushSubscribed && "🟡 Permiso de navegador concedido. Puedes suscribir este dispositivo al canal push."}
                  {pushStatus === "default" && "⚪ Las notificaciones de navegador son opcionales. Puedes activarlas voluntariamente sin instalar PWA."}
                  {pushStatus === "denied" && "🔴 Notificaciones bloqueadas en el navegador. Las alertas se preservan en este centro interno."}
                  {pushStatus === "unsupported" && "ℹ️ Tu navegador no soporta Web Push. El centro interno persistente almacena todas tus alertas."}
                  {pushSubscribedCount !== null && pushSubscribedCount > 0 && ` (${pushSubscribedCount} dispositivo(s) registrado(s))`}
                </p>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                {pushStatus !== "unsupported" && pushStatus !== "denied" && !isPushSubscribed && (
                  <button type="button" className="secondary" onClick={handleRequestPush} disabled={pushLoading}>
                    {pushLoading ? "Conectando…" : "Activar Web Push"}
                  </button>
                )}
                {isPushSubscribed && (
                  <>
                    <button type="button" className="secondary" onClick={handleTestPushNotification} disabled={pushLoading}>
                      Enviar Notificación de Prueba Real
                    </button>
                    <button type="button" className="secondary" onClick={handleUnsubscribePush} disabled={pushLoading} style={{ color: "#b91c1c" }}>
                      Revocar Suscripción
                    </button>
                  </>
                )}
              </div>
            </div>

            {notifications.length === 0 ? (
              <p className="muted">No hay alertas ni notificaciones pendientes.</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0 }}>
                {notifications.map((n) => (
                  <li
                    key={n.id}
                    style={{
                      padding: "1rem",
                      marginBottom: "0.5rem",
                      borderRadius: "6px",
                      background: n.readAt ? "#f9fafb" : "#fffbeb",
                      border: `1px solid ${n.readAt ? "#e5e7eb" : "#fef08a"}`,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <strong style={{ color: n.readAt ? "#4b5563" : "#854d0e" }}>
                        [{displayLabel(n.eventType)}] {n.title}
                      </strong>
                      <p style={{ margin: "0.3rem 0 0", color: "#374151" }}>{n.message}</p>
                      <small className="muted">{new Date(n.createdAt).toLocaleString()}</small>
                    </div>
                    {!n.readAt && (
                      <button className="secondary" onClick={() => handleMarkNotificationRead(n.id)}>
                        Marcar como leída
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
