"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useEffect, useState, useMemo } from "react";
import { apiRequest as api } from "../../shared/client/api-client";
import type { FieldVisitDto, FieldTaskDto, FieldRouteDto } from "../../shared/contracts/field-operations";
import type { WarrantyDto } from "../../shared/contracts/post-sale";

type CalendarEventType = "VISIT" | "INSTALLATION" | "TRANSPORT" | "WARRANTY";

interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  date: string; // YYYY-MM-DD
  title: string;
  code?: string;
  status: string;
  responsible?: string;
  details?: string;
}

const MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

const DAY_NAMES = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

export function ManagementCalendar() {
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<"ALL" | CalendarEventType>("ALL");
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed

  // Carga de eventos de campo y posventa
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      setLoading(true);
      setError(null);
      try {
        const [visitsRes, tasksRes, routesRes, warrantiesRes] = await Promise.allSettled([
          api<FieldVisitDto[]>("field/visits"),
          api<FieldTaskDto[]>("field/tasks"),
          api<FieldRouteDto[]>("field/routes"),
          api<WarrantyDto[]>("warranties"),
        ]);

        if (!active) return;

        const collected: CalendarEvent[] = [];

        if (visitsRes.status === "fulfilled" && Array.isArray(visitsRes.value)) {
          for (const v of visitsRes.value) {
            collected.push({
              id: `visit-${v.id}`,
              type: "VISIT",
              date: v.scheduledDate,
              title: `Visita Técnica`,
              code: v.requestCode,
              status: v.status,
              responsible: v.assignedTechnicianName,
              details: v.observations || undefined,
            });
          }
        }

        if (tasksRes.status === "fulfilled" && Array.isArray(tasksRes.value)) {
          for (const t of tasksRes.value) {
            collected.push({
              id: `task-${t.id}`,
              type: t.taskType === "INSTALLATION" ? "INSTALLATION" : "TRANSPORT",
              date: t.scheduledDate,
              title: t.title,
              code: t.requestCode,
              status: t.status,
              responsible: t.assignedToName,
              details: t.notes || t.description || undefined,
            });
          }
        }

        if (routesRes.status === "fulfilled" && Array.isArray(routesRes.value)) {
          for (const r of routesRes.value) {
            collected.push({
              id: `route-${r.id}`,
              type: "TRANSPORT",
              date: r.routeDate,
              title: `Ruta de Despacho (${r.title})`,
              code: r.vehiclePlate ? `Placa: ${r.vehiclePlate}` : undefined,
              status: r.status,
              responsible: r.driverName,
              details: r.notes || undefined,
            });
          }
        }

        if (warrantiesRes.status === "fulfilled" && Array.isArray(warrantiesRes.value)) {
          for (const w of warrantiesRes.value) {
            // Extraer YYYY-MM-DD de w.createdAt o w.resolvedAt
            const dateStr = (w.resolvedAt || w.createdAt || "").split("T")[0] || "";
            if (dateStr) {
              collected.push({
                id: `warranty-${w.id}`,
                type: "WARRANTY",
                date: dateStr,
                title: `Garantía ${w.code}`,
                code: w.claimType,
                status: w.status,
                responsible: w.assignedToName,
                details: w.description,
              });
            }
          }
        }

        setEvents(collected);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Error al cargar eventos del calendario.");
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  // Navegación de mes
  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
    setSelectedDateStr(null);
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
    setSelectedDateStr(null);
  };

  const handleToday = () => {
    setCurrentDate(new Date());
    setSelectedDateStr(null);
  };

  // Cuadrícula del mes
  const calendarDays = useMemo(() => {
    const firstDayOfMonth = new Date(year, month, 1);
    const lastDayOfMonth = new Date(year, month + 1, 0);
    const totalDays = lastDayOfMonth.getDate();

    // En JS getDay(): 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
    // Ajustar para que 0 sea Lunes y 6 sea Domingo
    let startDayIndex = firstDayOfMonth.getDay() - 1;
    if (startDayIndex === -1) startDayIndex = 6;

    const days: Array<{ dayNumber: number; dateStr: string; isCurrentMonth: boolean }> = [];

    // Rellenar días del mes anterior
    const prevMonthLastDay = new Date(year, month, 0).getDate();
    for (let i = startDayIndex - 1; i >= 0; i--) {
      const d = prevMonthLastDay - i;
      const prevDate = new Date(year, month - 1, d);
      const str = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({ dayNumber: d, dateStr: str, isCurrentMonth: false });
    }

    // Días del mes actual
    for (let d = 1; d <= totalDays; d++) {
      const str = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      days.push({ dayNumber: d, dateStr: str, isCurrentMonth: true });
    }

    // Completar última semana hasta múltiplo de 7
    let nextMonthDay = 1;
    while (days.length % 7 !== 0) {
      const nextDate = new Date(year, month + 1, nextMonthDay);
      const str = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, "0")}-${String(nextMonthDay).padStart(2, "0")}`;
      days.push({ dayNumber: nextMonthDay, dateStr: str, isCurrentMonth: false });
      nextMonthDay++;
    }

    return days;
  }, [year, month]);

  // Filtrar eventos
  const filteredEvents = useMemo(() => {
    if (filterType === "ALL") return events;
    return events.filter((e) => e.type === filterType);
  }, [events, filterType]);

  // Agrupar eventos por fecha
  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of filteredEvents) {
      const list = map.get(e.date) || [];
      list.push(e);
      map.set(e.date, list);
    }
    return map;
  }, [filteredEvents]);

  // Eventos del día seleccionado
  const selectedDayEvents = selectedDateStr ? eventsByDate.get(selectedDateStr) || [] : [];

  const getTypeBadgeClass = (type: CalendarEventType) => {
    switch (type) {
      case "VISIT": return "badge-visit";
      case "INSTALLATION": return "badge-installation";
      case "TRANSPORT": return "badge-transport";
      case "WARRANTY": return "badge-warranty";
    }
  };

  const getStatusBadge = (status: string) => {
    if (["COMPLETED", "RESOLVED", "CLOSED"].includes(status)) return "status-done";
    if (["IN_PROGRESS", "ACCEPTED"].includes(status)) return "status-active";
    if (status === "CANCELLED" || status === "REJECTED") return "status-cancelled";
    return "status-pending";
  };

  return (
    <div className="management-calendar-view stack">
      <div className="panel" style={{ padding: "1.25rem" }}>
        {/* Cabecera y controles */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ margin: 0 }}>
              📅 {MONTH_NAMES[month]} de {year}
            </h2>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              Agenda integral de visitas técnicas, transporte, instalación y posventa
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button type="button" className="secondary" onClick={handlePrevMonth} aria-label="Mes anterior">
              &lt; Mes Anterior
            </button>
            <button type="button" className="secondary" onClick={handleToday}>
              Hoy
            </button>
            <button type="button" className="secondary" onClick={handleNextMonth} aria-label="Mes siguiente">
              Mes Siguiente &gt;
            </button>
          </div>
        </div>

        {/* Filtros de Tipo de Evento */}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "1rem" }}>
          <button
            type="button"
            className={`button-sm ${filterType === "ALL" ? "primary" : "secondary"}`}
            onClick={() => setFilterType("ALL")}
          >
            Todos ({events.length})
          </button>
          <button
            type="button"
            className={`button-sm ${filterType === "VISIT" ? "primary" : "secondary"}`}
            onClick={() => setFilterType("VISIT")}
          >
            Visitas ({events.filter((e) => e.type === "VISIT").length})
          </button>
          <button
            type="button"
            className={`button-sm ${filterType === "INSTALLATION" ? "primary" : "secondary"}`}
            onClick={() => setFilterType("INSTALLATION")}
          >
            Instalaciones ({events.filter((e) => e.type === "INSTALLATION").length})
          </button>
          <button
            type="button"
            className={`button-sm ${filterType === "TRANSPORT" ? "primary" : "secondary"}`}
            onClick={() => setFilterType("TRANSPORT")}
          >
            Transporte ({events.filter((e) => e.type === "TRANSPORT").length})
          </button>
          <button
            type="button"
            className={`button-sm ${filterType === "WARRANTY" ? "primary" : "secondary"}`}
            onClick={() => setFilterType("WARRANTY")}
          >
            Garantías ({events.filter((e) => e.type === "WARRANTY").length})
          </button>
        </div>

        {error && (
          <div className="panel notice alert-danger" role="alert" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {loading ? (
          <p className="muted" role="status">Cargando eventos de agenda…</p>
        ) : (
          <div className="calendar-grid-container">
            {/* Cabecera de días de la semana */}
            <div className="calendar-weekdays-row">
              {DAY_NAMES.map((name) => (
                <div key={name} className="calendar-weekday-header">
                  {name}
                </div>
              ))}
            </div>

            {/* Días del mes */}
            <div className="calendar-days-grid">
              {calendarDays.map((cd) => {
                const dayEvents = eventsByDate.get(cd.dateStr) || [];
                const isSelected = selectedDateStr === cd.dateStr;
                const isToday = cd.dateStr === new Date().toISOString().split("T")[0];

                return (
                  <div
                    key={cd.dateStr}
                    className={`calendar-day-cell ${!cd.isCurrentMonth ? "day-outside" : ""} ${isSelected ? "day-selected" : ""} ${isToday ? "day-today" : ""}`}
                    onClick={() => setSelectedDateStr(cd.dateStr)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        setSelectedDateStr(cd.dateStr);
                      }
                    }}
                    aria-label={`Día ${cd.dayNumber}, ${dayEvents.length} eventos`}
                  >
                    <div className="day-cell-header">
                      <span className={`day-number ${isToday ? "today-badge" : ""}`}>{cd.dayNumber}</span>
                      {dayEvents.length > 0 && (
                        <span className="events-count-pill">{dayEvents.length}</span>
                      )}
                    </div>

                    <div className="day-events-list">
                      {dayEvents.slice(0, 3).map((ev) => (
                        <div key={ev.id} className={`calendar-event-chip ${getTypeBadgeClass(ev.type)}`} title={`${ev.title} (${displayLabel(ev.status)})`}>
                          <span className="chip-bullet">•</span>
                          <span className="chip-text">{ev.title}</span>
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <div className="calendar-event-more">+{dayEvents.length - 3} más</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Detalle del Día Seleccionado */}
      {selectedDateStr && (
        <div className="panel stack" style={{ background: "#f8fafc", border: "1px solid #cbd5e1" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3>
              Detalle de Agenda — {selectedDateStr}
            </h3>
            <button type="button" className="secondary button-sm" onClick={() => setSelectedDateStr(null)}>
              Cerrar Detalle
            </button>
          </div>

          {selectedDayEvents.length === 0 ? (
            <p className="muted">No hay eventos programados para este día.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.75rem" }}>
              {selectedDayEvents.map((ev) => (
                <div
                  key={ev.id}
                  style={{
                    padding: "0.75rem 1rem",
                    borderRadius: "6px",
                    background: "#ffffff",
                    border: "1px solid #e2e8f0",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "0.5rem",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.25rem" }}>
                      <span className={`tag-badge ${getTypeBadgeClass(ev.type)}`}>{displayLabel(ev.type)}</span>
                      <strong>{ev.title}</strong>
                      {ev.code && <span className="muted">({ev.code})</span>}
                    </div>
                    {ev.responsible && (
                      <div className="muted" style={{ fontSize: "0.85rem" }}>
                        👤 Asignado a: <strong>{ev.responsible}</strong>
                      </div>
                    )}
                    {ev.details && (
                      <div className="muted" style={{ fontSize: "0.85rem", marginTop: "0.25rem" }}>
                        📝 {ev.details}
                      </div>
                    )}
                  </div>
                  <div>
                    <span className={`tag-badge ${getStatusBadge(ev.status)}`}>{displayLabel(ev.status)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
