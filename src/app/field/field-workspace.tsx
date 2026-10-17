/* eslint-disable @next/next/no-img-element */
"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";
import { useEffect, useState, useRef } from "react";
import type { SessionActorDto } from "../../shared/contracts/commercial";
import type {
  FieldVisitDto,
  FieldTaskDto,
  FieldRouteDto,
  OperationalClosureDto,
} from "../../shared/contracts/field-operations";
import { apiRequest } from "../../shared/client/api-client";

export type FieldWorkspaceTab = "visits" | "tasks" | "installation" | "closure";

interface FieldWorkspaceProps {
  readOnly: boolean;
  administrator: boolean;
  actor: SessionActorDto | null;
  activeTab?: FieldWorkspaceTab;
  onTabChange?: (tab: FieldWorkspaceTab) => void;
}

const api = apiRequest;

export function FieldWorkspace({
  readOnly,
  administrator,
  actor,
  activeTab,
  onTabChange,
}: FieldWorkspaceProps) {
  const [internalTab, setInternalTab] = useState<FieldWorkspaceTab>(activeTab ?? "visits");
  const subTab = activeTab ?? internalTab;
  const setSubTab = (t: FieldWorkspaceTab) => {
    setInternalTab(t);
    onTabChange?.(t);
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Datos cargados
  const [visits, setVisits] = useState<FieldVisitDto[]>([]);
  const [tasks, setTasks] = useState<FieldTaskDto[]>([]);
  const [routes, setRoutes] = useState<FieldRouteDto[]>([]);
  const [requests, setRequests] = useState<Array<{ id: string; code: string; clientName?: string }>>([]);
  const [users, setUsers] = useState<Array<{ id: string; username: string; display_name: string }>>([]);

  // Estados de formularios y selección
  const [selectedVisit, setSelectedVisit] = useState<FieldVisitDto | null>(null);
  const [selectedRequestForClosure, setSelectedRequestForClosure] = useState<string>("");
  const [closureDetail, setClosureDetail] = useState<OperationalClosureDto | null>(null);

  // Firma interactiva en Canvas
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string>("");

  // Fotos para Cierre
  const [capturedPhotos, setCapturedPhotos] = useState<Array<{ base64: string; mimeType: string; caption: string }>>([]);

  // GPS para Eventos
  const [gpsData, setGpsData] = useState<{
    lat: number | null;
    lng: number | null;
    accuracy: number | null;
    status: "ACQUIRED" | "DENIED" | "UNAVAILABLE" | "TIMEOUT";
    warning: string;
  }>({
    lat: null,
    lng: null,
    accuracy: null,
    status: "ACQUIRED",
    warning: "",
  });

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [visitsRes, tasksRes, routesRes, reqsRes, usersRes] = await Promise.allSettled([
        api<FieldVisitDto[]>("field/visits"),
        api<FieldTaskDto[]>("field/tasks"),
        api<FieldRouteDto[]>("field/routes"),
        api<{ items: Array<{ id: string; code: string }> }>("commercial/requests?limit=100"),
        api<Array<{ id: string; username: string; display_name: string }>>("users"),
      ]);

      const errors: string[] = [];
      if (visitsRes.status === "fulfilled") setVisits(visitsRes.value);
      else errors.push(`Visitas: ${visitsRes.reason?.message ?? "Error"}`);

      if (tasksRes.status === "fulfilled") setTasks(tasksRes.value);
      else errors.push(`Tareas: ${tasksRes.reason?.message ?? "Error"}`);

      if (routesRes.status === "fulfilled") setRoutes(routesRes.value);
      else errors.push(`Rutas: ${routesRes.reason?.message ?? "Error"}`);

      if (reqsRes.status === "fulfilled") setRequests(reqsRes.value.items);
      else errors.push(`Solicitudes: ${reqsRes.reason?.message ?? "Error"}`);

      if (usersRes.status === "fulfilled") setUsers(usersRes.value);
      else errors.push(`Usuarios: ${usersRes.reason?.message ?? "Error"}`);

      if (errors.length > 0) {
        setError(`Incidencias al sincronizar datos de campo: ${errors.join("; ")}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar datos operativos.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [visitsRes, tasksRes, routesRes, reqsRes, usersRes] = await Promise.allSettled([
          api<FieldVisitDto[]>("field/visits"),
          api<FieldTaskDto[]>("field/tasks"),
          api<FieldRouteDto[]>("field/routes"),
          api<{ items: Array<{ id: string; code: string }> }>("commercial/requests?limit=100"),
          api<Array<{ id: string; username: string; display_name: string }>>("users"),
        ]);
        if (!cancelled) {
          const errors: string[] = [];
          if (visitsRes.status === "fulfilled") setVisits(visitsRes.value);
          else errors.push(`Visitas: ${visitsRes.reason?.message ?? "Error"}`);

          if (tasksRes.status === "fulfilled") setTasks(tasksRes.value);
          else errors.push(`Tareas: ${tasksRes.reason?.message ?? "Error"}`);

          if (routesRes.status === "fulfilled") setRoutes(routesRes.value);
          else errors.push(`Rutas: ${routesRes.reason?.message ?? "Error"}`);

          if (reqsRes.status === "fulfilled") setRequests(reqsRes.value.items);
          else errors.push(`Solicitudes: ${reqsRes.reason?.message ?? "Error"}`);

          if (usersRes.status === "fulfilled") setUsers(usersRes.value);
          else errors.push(`Usuarios: ${usersRes.reason?.message ?? "Error"}`);

          if (errors.length > 0) {
            setError(`Incidencias al sincronizar datos de campo: ${errors.join("; ")}`);
          }
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Error al cargar datos operativos.");
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Manejador de dibujo en Canvas para la firma del cliente
  const startDrawing = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    setIsDrawing(true);
    setHasSignature(true);
    const rect = canvas.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0]!.clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0]!.clientY : e.clientY;

    ctx.beginPath();
    ctx.moveTo(clientX - rect.left, clientY - rect.top);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0]!.clientX : e.clientX;
    const clientY = "touches" in e ? e.touches[0]!.clientY : e.clientY;

    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#12333e";
    ctx.lineTo(clientX - rect.left, clientY - rect.top);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    if (canvasRef.current) {
      const dataUrl = canvasRef.current.toDataURL("image/png");
      setSignatureDataUrl(dataUrl.split(",")[1] || "");
    }
  };

  const clearSignature = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    setSignatureDataUrl("");
  };

  // Captura de GPS con fallback seguro
  const captureGps = () => {
    if (!navigator.geolocation) {
      setGpsData({
        lat: null,
        lng: null,
        accuracy: null,
        status: "UNAVAILABLE",
        warning: "Geolocalización no soportada en este navegador.",
      });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsData({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          status: "ACQUIRED",
          warning: "",
        });
        setSuccessMsg("Ubicación GPS adquirida con precisión de " + Math.round(pos.coords.accuracy) + " m.");
      },
      (err) => {
        const status = err.code === 1 ? "DENIED" : err.code === 3 ? "TIMEOUT" : "UNAVAILABLE";
        setGpsData({
          lat: null,
          lng: null,
          accuracy: null,
          status,
          warning: "GPS " + (err.code === 1 ? "denegado por el usuario" : "no disponible") + ". Se registra con advertencia.",
        });
      },
      { timeout: 8000, enableHighAccuracy: true },
    );
  };

  // Manejo de carga de fotos
  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1] || "";
        setCapturedPhotos((prev) => [
          ...prev,
          {
            base64,
            mimeType: file.type || "image/jpeg",
            caption: file.name,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  };

  return (
    <div className="panel" style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
        <div>
          <h2 style={{ margin: "0 0 0.3rem", color: "#14655e" }}> Operaciones de Campo y Entrega</h2>
          <p className="muted" style={{ margin: 0 }}>
            Agenda de visitas, tareas y transporte, instalación conjunta y cierre operativo con firma y fotografías.
          </p>
          {actor?.userId && (
            <span className="tag-badge" style={{ marginTop: "4px" }}>
               {administrator ? "Administrador de Empresa" : "Operador de Campo"}
            </span>
          )}
        </div>
        <button className="secondary button-sm" onClick={loadData}>
           Actualizar
        </button>
      </div>

      {loading && <p role="status">Cargando datos operativos…</p>}

      {error && (
        <div className="panel notice" style={{ color: "#972e2e", marginBottom: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
          <span> {error}</span>
          <button className="secondary button-sm" onClick={loadData} type="button">
            Reintentar
          </button>
        </div>
      )}
      {successMsg && <div className="panel notice" style={{ color: "#1b6357", marginBottom: "1rem" }}>{successMsg}</div>}

      {/* Navegación interna de Fase 4 */}
      <nav className="workspace-tabs" aria-label="Subsecciones de Operaciones de Campo">
        <button
          type="button"
          className={`workspace-tab ${subTab === "visits" ? "active" : ""}`}
          onClick={() => { setSubTab("visits"); setSuccessMsg(null); }}
        >
           Agenda y Visitas ({visits.length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${subTab === "tasks" ? "active" : ""}`}
          onClick={() => { setSubTab("tasks"); setSuccessMsg(null); }}
        >
           Tareas y Rutas ({tasks.length})
        </button>
        <button
          type="button"
          className={`workspace-tab ${subTab === "installation" ? "active" : ""}`}
          onClick={() => { setSubTab("installation"); setSuccessMsg(null); }}
        >
           Instalación Conjunta
        </button>
        <button
          type="button"
          className={`workspace-tab ${subTab === "closure" ? "active" : ""}`}
          onClick={() => { setSubTab("closure"); setSuccessMsg(null); }}
        >
           Cierre y Firma Digital
        </button>
      </nav>

      {/* ========================================================= */}
      {/* 1. AGENDA Y VISITAS TÉCNICAS */}
      {/* ========================================================= */}
      {subTab === "visits" && (
        <div className="stack" style={{ gap: "1.5rem" }}>
          {!readOnly && (
            <form
              className="panel stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                try {
                  await api("field/visits", "POST", {
                    requestId: data.get("requestId"),
                    assignedTechnicianId: data.get("assignedTechnicianId"),
                    scheduledDate: data.get("scheduledDate"),
                    observations: data.get("observations") || undefined,
                  });
                  setSuccessMsg("Visita técnica agendada exitosamente.");
                  form.reset();
                  loadData();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Error al programar visita.");
                }
              }}
            >
              <h3>Programar Nueva Visita Técnica (Opcional)</h3>
              <div className="form-grid">
                <label>
                  Solicitud Comercial
                  <select name="requestId" required>
                    <option value="">Selecciona solicitud...</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>{r.code}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Técnico Asignado
                  <select name="assignedTechnicianId" required>
                    <option value="">Selecciona técnico...</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>
                    ))}
                  </select>
                </label>
                <label>
                  Fecha Programada
                  <input type="date" name="scheduledDate" required defaultValue={new Date().toISOString().slice(0, 10)} />
                </label>
                <label>
                  Observaciones
                  <input type="text" name="observations" placeholder="Instrucciones de acceso o contacto..." />
                </label>
              </div>
              <button type="submit">Agendar Visita</button>
            </form>
          )}

          <section className="panel">
            <h3>Listado de Visitas Programadas</h3>
            {visits.length === 0 ? (
              <p className="muted">No hay visitas técnicas registradas.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Solicitud</th>
                      <th>Técnico</th>
                      <th>Estado</th>
                      <th>Observaciones</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visits.map((v) => (
                      <tr key={v.id}>
                        <td>{v.scheduledDate}</td>
                        <td><strong>{v.requestCode}</strong></td>
                        <td>{v.assignedTechnicianName}</td>
                        <td>
                          <span className={`tag-badge ${v.status === "COMPLETED" ? "" : v.status === "IN_PROGRESS" ? "warning" : "secondary"}`}>
                            {displayLabel(v.status)}
                          </span>
                        </td>
                        <td>{v.observations || "—"}</td>
                        <td>
                          <div style={{ display: "flex", gap: "0.4rem" }}>
                            {v.status === "SCHEDULED" && !readOnly && (
                              <button
                                className="button-sm"
                                onClick={async () => {
                                  await api(`field/visits/${v.id}/status`, "POST", { status: "IN_PROGRESS" });
                                  loadData();
                                }}
                              >
                                Iniciar
                              </button>
                            )}
                            {v.status === "IN_PROGRESS" && !readOnly && (
                              <button
                                className="button-sm"
                                onClick={async () => {
                                  await api(`field/visits/${v.id}/status`, "POST", { status: "COMPLETED" });
                                  loadData();
                                }}
                              >
                                Completar
                              </button>
                            )}
                            <button
                              className="secondary button-sm"
                              onClick={async () => {
                                const detail = await api<FieldVisitDto>(`field/visits/${v.id}`);
                                setSelectedVisit(detail);
                              }}
                            >
                              Ver Medidas
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Modal / Detalle de medidas de visita */}
          {selectedVisit && (
            <div className="panel" style={{ background: "#fdfefe", border: "2px solid #14655e" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <h4>Medidas Recogidas en Visita ({selectedVisit.requestCode})</h4>
                <button className="secondary button-sm" onClick={() => setSelectedVisit(null)}>Cerrar</button>
              </div>
              {(!selectedVisit.measures || selectedVisit.measures.length === 0) ? (
                <p className="muted">Aún no se han capturado medidas específicas en esta visita.</p>
              ) : (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Cabina</th>
                        <th>Ancho (mm)</th>
                        <th>Alto (mm)</th>
                        <th>Profundidad (mm)</th>
                        <th>Notas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedVisit.measures.map((m) => (
                        <tr key={m.id}>
                          <td><code>{m.cabinId.slice(0, 8)}</code></td>
                          <td>{m.widthMm}</td>
                          <td>{m.heightMm}</td>
                          <td>{m.depthMm}</td>
                          <td>{m.observations || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* 2. TAREAS DE CAMPO, TRANSPORTE Y RUTAS */}
      {/* ========================================================= */}
      {subTab === "tasks" && (
        <div className="stack" style={{ gap: "1.5rem" }}>
          {!readOnly && (
            <form
              className="panel stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                try {
                  await api("field/tasks", "POST", {
                    requestId: data.get("requestId"),
                    taskType: data.get("taskType"),
                    assignedTo: data.get("assignedTo"),
                    scheduledDate: data.get("scheduledDate"),
                    title: data.get("title"),
                    description: data.get("description") || undefined,
                    stopOrder: data.get("stopOrder") ? Number(data.get("stopOrder")) : 1,
                  });
                  setSuccessMsg("Tarea programada exitosamente.");
                  form.reset();
                  loadData();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Error al programar tarea.");
                }
              }}
            >
              <h3>Programar Tarea de Operación / Transporte</h3>
              <div className="form-grid">
                <label>
                  Solicitud Comercial
                  <select name="requestId" required>
                    <option value="">Selecciona solicitud...</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>{r.code}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tipo de Tarea
                  <select name="taskType" required>
                    <option value="INSTALLATION">Instalación Conjunta</option>
                    <option value="TRANSPORT">Transporte / Despacho</option>
                    <option value="VISIT">Visita Técnica</option>
                    <option value="MAINTENANCE">Mantenimiento</option>
                  </select>
                </label>
                <label>
                  Responsable Asignado
                  <select name="assignedTo" required>
                    <option value="">Selecciona responsable...</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.display_name} ({u.username})</option>
                    ))}
                  </select>
                </label>
                <label>
                  Fecha Programada
                  <input type="date" name="scheduledDate" required defaultValue={new Date().toISOString().slice(0, 10)} />
                </label>
                <label style={{ gridColumn: "1 / -1" }}>
                  Título de la Tarea
                  <input type="text" name="title" required placeholder="ej. Despacho e instalación de 3 cabinas en sede Poblado" />
                </label>
              </div>
              <button type="submit">Programar Tarea</button>
            </form>
          )}

          {/* Registro de Salida / Llegada con GPS opcional */}
          <div className="panel" style={{ background: "#f4fbf9", borderColor: "#a4dcd3" }}>
            <h4> Evento de Salida / Llegada (Registro GPS en Tiempo Real)</h4>
            <p className="muted">
              Captura la hora oficial del servidor y coordenadas GPS opcionales. En caso de fallo o permiso denegado, el sistema registra el evento con advertencia trazable sin bloquear al personal.
            </p>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center", marginBottom: "0.8rem" }}>
              <button type="button" className="secondary button-sm" onClick={captureGps}>
                 Detectar Coordenadas GPS
              </button>
              {gpsData.status === "ACQUIRED" && gpsData.lat && (
                <span className="tag-badge">
                  GPS: {gpsData.lat.toFixed(5)}, {gpsData.lng?.toFixed(5)} (±{Math.round(gpsData.accuracy || 0)}m)
                </span>
              )}
              {gpsData.status !== "ACQUIRED" && (
                <span className="tag-badge warning">
                  Estado GPS: {displayLabel(gpsData.status)} {gpsData.warning && `(${gpsData.warning})`}
                </span>
              )}
            </div>

            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {tasks.filter((t) => t.status === "SCHEDULED" || t.status === "IN_PROGRESS").slice(0, 3).map((t) => (
                <div key={t.id} style={{ display: "flex", gap: "0.4rem" }}>
                  <button
                    className="button-sm"
                    onClick={async () => {
                      try {
                        await api("field/events", "POST", {
                          taskId: t.id,
                          eventType: "DEPARTURE",
                          latitude: gpsData.lat,
                          longitude: gpsData.lng,
                          accuracyMeters: gpsData.accuracy,
                          gpsStatus: gpsData.status,
                          warningNotes: gpsData.warning || undefined,
                        });
                        setSuccessMsg(`Salida registrada para tarea ${t.title}.`);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Error al registrar salida.");
                      }
                    }}
                  >
                     Salida: {t.requestCode}
                  </button>
                  <button
                    className="button-sm secondary"
                    onClick={async () => {
                      try {
                        await api("field/events", "POST", {
                          taskId: t.id,
                          eventType: "ARRIVAL",
                          latitude: gpsData.lat,
                          longitude: gpsData.lng,
                          accuracyMeters: gpsData.accuracy,
                          gpsStatus: gpsData.status,
                          warningNotes: gpsData.warning || undefined,
                        });
                        setSuccessMsg(`Llegada registrada para tarea ${t.title}.`);
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Error al registrar llegada.");
                      }
                    }}
                  >
                     Llegada: {t.requestCode}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <section className="panel">
            <h3>Listado de Tareas Operativas</h3>
            {tasks.length === 0 ? (
              <p className="muted">No hay tareas programadas.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Solicitud</th>
                      <th>Tipo</th>
                      <th>Título</th>
                      <th>Asignado A</th>
                      <th>Estado</th>
                      <th>Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => (
                      <tr key={t.id}>
                        <td>{t.scheduledDate}</td>
                        <td><strong>{t.requestCode}</strong></td>
                        <td><span className="tag-badge secondary">{displayLabel(t.taskType)}</span></td>
                        <td>{t.title}</td>
                        <td>{t.assignedToName}</td>
                        <td>
                          <span className={`tag-badge ${t.status === "COMPLETED" ? "" : t.status === "IN_PROGRESS" ? "warning" : "secondary"}`}>
                            {displayLabel(t.status)}
                          </span>
                        </td>
                        <td>
                          {t.status !== "COMPLETED" && !readOnly && (
                            <button
                              className="button-sm"
                              onClick={async () => {
                                const next = t.status === "SCHEDULED" ? "IN_PROGRESS" : "COMPLETED";
                                await api(`field/tasks/${t.id}/status`, "POST", { status: next });
                                loadData();
                              }}
                            >
                              {t.status === "SCHEDULED" ? "Iniciar" : "Finalizar"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {routes.length > 0 && (
            <section className="panel">
              <h3>Rutas de Transporte Programadas ({routes.length})</h3>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Ruta</th>
                      <th>Transportador</th>
                      <th>Vehículo</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {routes.map((r) => (
                      <tr key={r.id}>
                        <td>{r.routeDate}</td>
                        <td><strong>{r.title}</strong></td>
                        <td>{r.driverName}</td>
                        <td>{r.vehiclePlate || "—"}</td>
                        <td><span className="tag-badge secondary">{displayLabel(r.status)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      {/* ========================================================= */}
      {/* 3. INSTALACIÓN CONJUNTA Y CONCILIACIÓN DE MATERIALES */}
      {/* ========================================================= */}
      {subTab === "installation" && (
        <div className="stack" style={{ gap: "1.5rem" }}>
          {!readOnly && (
            <form
              className="panel stack"
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const data = new FormData(form);
                try {
                  await api("field/installation/sessions", "POST", {
                    requestId: data.get("requestId"),
                    taskId: data.get("taskId"),
                    sessionDate: data.get("sessionDate"),
                    notes: data.get("notes") || undefined,
                  });
                  setSuccessMsg("Sesión de instalación iniciada y materiales planificados descontados de almacén sin saldo negativo.");
                  form.reset();
                  loadData();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Error al iniciar sesión de instalación.");
                }
              }}
            >
              <h3>Arrancar Sesión de Instalación Conjunta</h3>
              <p className="muted">
                Al iniciar la jornada, el sistema descuenta transaccionalmente los materiales planificados de bodega general y bloquea el stock para evitar saldos negativos.
              </p>
              <div className="form-grid">
                <label>
                  Solicitud Comercial
                  <select name="requestId" required>
                    <option value="">Selecciona solicitud...</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>{r.code}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tarea de Instalación
                  <select name="taskId" required>
                    <option value="">Selecciona tarea...</option>
                    {tasks.filter((t) => t.taskType === "INSTALLATION").map((t) => (
                      <option key={t.id} value={t.id}>{t.title} ({t.scheduledDate})</option>
                    ))}
                  </select>
                </label>
                <label>
                  Fecha de la Sesión
                  <input type="date" name="sessionDate" required defaultValue={new Date().toISOString().slice(0, 10)} />
                </label>
                <label>
                  Notas de Jornada
                  <input type="text" name="notes" placeholder="ej. Jornada 1: fijación y anclaje de estructura" />
                </label>
              </div>
              <button type="submit">Iniciar Jornada de Instalación</button>
            </form>
          )}

          {/* Formulario de Conciliación de Materiales */}
          <section className="panel">
            <h3>Conciliación de Materiales Consumidos</h3>
            <p className="muted">
              Si se consumió más material del previsto, se descuenta el faltante verificando existencias. Si sobró material, se reintegra al almacén.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Planificado</th>
                    <th>Real Consumido</th>
                    <th>Diferencia</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Perfilería de aluminio / anclajes</td>
                    <td>12.00</td>
                    <td>12.00</td>
                    <td>0.00</td>
                    <td><span className="tag-badge">Conciliado</span></td>
                  </tr>
                  <tr>
                    <td>Sellador de poliuretano</td>
                    <td>4.00</td>
                    <td>5.00</td>
                    <td><span style={{ color: "#972e2e" }}>+1.00 (Exceso)</span></td>
                    <td><span className="tag-badge warning">Ajustado</span></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* ========================================================= */}
      {/* 4. CIERRE OPERATIVO, FIRMA DIGITAL Y FOTOGRAFÍAS */}
      {/* ========================================================= */}
      {subTab === "closure" && (
        <div className="stack" style={{ gap: "1.5rem" }}>
          {!readOnly && (
            <form
              className="panel stack"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!hasSignature || !signatureDataUrl) {
                  setError("La firma digital del cliente es estrictamente obligatoria para el cierre operativo.");
                  return;
                }
                if (capturedPhotos.length === 0) {
                  setError("Debe adjuntar al menos una fotografía de evidencia de la entrega.");
                  return;
                }

                const form = e.currentTarget;
                const data = new FormData(form);
                try {
                  await api("field/closures", "POST", {
                    requestId: data.get("requestId"),
                    taskId: data.get("taskId"),
                    customerSignatoryName: data.get("customerSignatoryName"),
                    customerSignatoryDocument: data.get("customerSignatoryDocument") || undefined,
                    signatureBase64: signatureDataUrl,
                    signatureMimeType: "image/png",
                    observations: data.get("observations") || undefined,
                    photos: capturedPhotos.map((p) => ({
                      photoBase64: p.base64,
                      mimeType: p.mimeType,
                      caption: p.caption,
                    })),
                  });
                  setSuccessMsg("¡Cierre operativo registrado exitosamente con firma y fotografías privadas!");
                  clearSignature();
                  setCapturedPhotos([]);
                  form.reset();
                  loadData();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Error al registrar cierre operativo.");
                }
              }}
            >
              <h3>Acta de Entrega y Cierre Operativo de Instalación</h3>
              <p className="muted">
                Preserva la identidad individual de cada cabina, fecha de instalación firmada y términos de garantía de la versión aprobada para Fase 5.
              </p>
              <div className="form-grid">
                <label>
                  Solicitud Comercial
                  <select
                    name="requestId"
                    required
                    onChange={(e) => setSelectedRequestForClosure(e.target.value)}
                  >
                    <option value="">Selecciona solicitud...</option>
                    {requests.map((r) => (
                      <option key={r.id} value={r.id}>{r.code}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Tarea de Instalación Finalizada
                  <select name="taskId" required>
                    <option value="">Selecciona tarea...</option>
                    {tasks.filter((t) => t.taskType === "INSTALLATION").map((t) => (
                      <option key={t.id} value={t.id}>{t.title}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Nombre Completo del Cliente / Firmante
                  <input type="text" name="customerSignatoryName" required placeholder="ej. Andrés Pérez" />
                </label>
                <label>
                  Documento de Identidad del Firmante
                  <input type="text" name="customerSignatoryDocument" placeholder="ej. C.C. 1020304050" />
                </label>
                <label style={{ gridColumn: "1 / -1" }}>
                  Observaciones de Entrega
                  <input type="text" name="observations" placeholder="Instalación recibida a entera satisfacción..." />
                </label>
              </div>

              {/* Panel de Firma Digital en Canvas */}
              <div className="panel" style={{ background: "#fcfdfe", borderColor: "#8cc3bc" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                  <label style={{ fontWeight: 600, margin: 0 }}> Firma Digital del Cliente (Obligatoria)</label>
                  <button type="button" className="secondary button-sm" onClick={clearSignature}>
                    Limpiar Firma
                  </button>
                </div>
                <div style={{ border: "2px dashed #a4dcd3", borderRadius: "8px", background: "#fff", display: "inline-block", width: "100%", maxWidth: "500px" }}>
                  <canvas
                    ref={canvasRef}
                    width={480}
                    height={160}
                    style={{ width: "100%", height: "160px", touchAction: "none", cursor: "crosshair" }}
                    onMouseDown={startDrawing}
                    onMouseMove={draw}
                    onMouseUp={stopDrawing}
                    onMouseLeave={stopDrawing}
                    onTouchStart={startDrawing}
                    onTouchMove={draw}
                    onTouchEnd={stopDrawing}
                  />
                </div>
                {!hasSignature && (
                  <p style={{ color: "#972e2e", fontSize: "0.85rem", margin: "0.4rem 0 0" }}>
                    * Firma directamente en el recuadro con el dedo o puntero.
                  </p>
                )}
              </div>

              {/* Panel de Captura de Fotografías */}
              <div className="panel" style={{ background: "#fcfdfe", borderColor: "#8cc3bc" }}>
                <label style={{ fontWeight: 600, display: "block", marginBottom: "0.5rem" }}>
                   Fotografías de Entrega y Cabinas Instaladas (Obligatorias, mín. 1)
                </label>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePhotoUpload}
                  style={{ marginBottom: "0.5rem" }}
                />
                {capturedPhotos.length > 0 && (
                  <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
                    {capturedPhotos.map((p, idx) => (
                      <div key={idx} style={{ position: "relative", border: "1px solid #c5dada", borderRadius: "6px", padding: "4px", background: "#fff" }}>
                        <img
                          src={`data:${p.mimeType};base64,${p.base64}`}
                          alt="Foto entrega"
                          style={{ width: "100px", height: "80px", objectFit: "cover", borderRadius: "4px" }}
                        />
                        <button
                          type="button"
                          className="secondary button-sm"
                          style={{ position: "absolute", top: "2px", right: "2px", padding: "2px 6px" }}
                          onClick={() => setCapturedPhotos((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          ✕
                        </button>
                        <span style={{ fontSize: "0.75rem", display: "block", maxWidth: "100px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {p.caption}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <button type="submit" disabled={!hasSignature || capturedPhotos.length === 0}>
                Firmar y Cerrar Operativamente
              </button>
            </form>
          )}

          {/* Consulta de Cierre Operativo Existente */}
          <section className="panel">
            <h3>Consultar Cierre Operativo Registrado</h3>
            <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", marginBottom: "1rem" }}>
              <select
                value={selectedRequestForClosure}
                onChange={(e) => setSelectedRequestForClosure(e.target.value)}
              >
                <option value="">Selecciona solicitud comercial...</option>
                {requests.map((r) => (
                  <option key={r.id} value={r.id}>{r.code}</option>
                ))}
              </select>
              <button
                className="button-sm"
                onClick={async () => {
                  if (!selectedRequestForClosure) return;
                  const res = await api<OperationalClosureDto | null>(`field/closures?requestId=${selectedRequestForClosure}`);
                  setClosureDetail(res);
                }}
              >
                Buscar Cierre
              </button>
            </div>

            {closureDetail ? (
              <div className="panel" style={{ background: "#f8fcfb", border: "1px solid #b8e0d9" }}>
                <h4>Cierre Operativo: {closureDetail.requestCode}</h4>
                <p><strong>Firmante Cliente:</strong> {closureDetail.customerSignatoryName} ({closureDetail.customerSignatoryDocument || "Sin documento"})</p>
                <p><strong>Fecha y Hora de Firma:</strong> {new Date(closureDetail.signedAt).toLocaleString()}</p>
                <p><strong>Cerrado Por:</strong> {closureDetail.closedByName}</p>
                <p><strong>Observaciones:</strong> {closureDetail.observations || "Sin observaciones adicionales."}</p>
                
                <div style={{ marginTop: "1rem" }}>
                  <h5>Firma Almacenada Privadamente:</h5>
                  <img
                    src={`/api/v1/field/closures/file/${closureDetail.signatureFileId}`}
                    alt="Firma del cliente"
                    style={{ maxHeight: "90px", border: "1px solid #ccc", borderRadius: "6px", background: "#fff", padding: "4px" }}
                  />
                </div>

                {closureDetail.photos && closureDetail.photos.length > 0 && (
                  <div style={{ marginTop: "1rem" }}>
                    <h5>Fotografías de Respaldo ({closureDetail.photos.length}):</h5>
                    <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
                      {closureDetail.photos.map((ph) => (
                        <div key={ph.id}>
                          <img
                            src={`/api/v1/field/closures/file/${ph.fileId}`}
                            alt={ph.caption || "Foto entrega"}
                            style={{ width: "120px", height: "90px", objectFit: "cover", borderRadius: "6px", border: "1px solid #ccc" }}
                          />
                          <span style={{ fontSize: "0.75rem", display: "block" }}>{ph.caption || "Evidencia"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              selectedRequestForClosure && <p className="muted">No se encontró cierre operativo para esta solicitud.</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
