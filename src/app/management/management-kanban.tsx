"use client";
import { displayLabel } from "../../shared/contracts/ui-labels";

import { useEffect, useState, useMemo } from "react";
import { apiRequest as api } from "../../shared/client/api-client";
import type { CommercialRequestDto } from "../../shared/contracts/commercial";
import type { WarrantyDto, OperationalIssueDto } from "../../shared/contracts/post-sale";

type BoardMode = "OPERATIONS" | "WARRANTIES";

interface KanbanCard {
  id: string;
  code: string;
  title: string;
  subtitle: string;
  status: string;
  columnId: string;
  badgeText?: string;
  badgeType?: "info" | "warning" | "success" | "danger";
  date: string;
  extraInfo?: string;
}

interface KanbanColumn {
  id: string;
  title: string;
  color: string;
  statuses: string[];
}

const OPERATION_COLUMNS: KanbanColumn[] = [
  { id: "registered", title: "Registradas / Borrador", color: "#64748b", statuses: ["DRAFT", "REGISTERED"] },
  { id: "quoted", title: "Cotizadas / En Negociación", color: "#0284c7", statuses: ["QUOTED", "SENT"] },
  { id: "approved", title: "Aprobadas para Obra", color: "#0d9488", statuses: ["APPROVED"] },
  { id: "dispatched", title: "Despachadas / En Instalación", color: "#d97706", statuses: ["DISPATCHED", "IN_PROGRESS"] },
  { id: "closed", title: "Cerradas / Entregadas", color: "#16a34a", statuses: ["COMPLETED", "CLOSED"] },
];

const WARRANTY_COLUMNS: KanbanColumn[] = [
  { id: "registered", title: "Radicadas / Nuevas", color: "#64748b", statuses: ["REGISTERED", "OPEN"] },
  { id: "in_review", title: "En Revisión / Asignadas", color: "#0284c7", statuses: ["IN_REVIEW"] },
  { id: "in_progress", title: "En Atención Técnica", color: "#d97706", statuses: ["IN_PROGRESS", "ACCEPTED"] },
  { id: "resolved", title: "Resueltas con Notas", color: "#0d9488", statuses: ["RESOLVED"] },
  { id: "closed", title: "Cerradas / Finalizadas", color: "#16a34a", statuses: ["CLOSED", "REJECTED"] },
];

export function ManagementKanban() {
  const [mode, setMode] = useState<BoardMode>("OPERATIONS");
  const [requests, setRequests] = useState<CommercialRequestDto[]>([]);
  const [warranties, setWarranties] = useState<WarrantyDto[]>([]);
  const [issues, setIssues] = useState<OperationalIssueDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      setLoading(true);
      setError(null);
      try {
        if (mode === "OPERATIONS") {
          const res = await api<{ items: CommercialRequestDto[] }>("commercial/requests?limit=100");
          if (active) setRequests(res.items || []);
        } else {
          const [warRes, issRes] = await Promise.allSettled([
            api<WarrantyDto[]>("warranties"),
            api<OperationalIssueDto[]>("issues"),
          ]);
          if (!active) return;
          if (warRes.status === "fulfilled" && Array.isArray(warRes.value)) {
            setWarranties(warRes.value);
          }
          if (issRes.status === "fulfilled" && Array.isArray(issRes.value)) {
            setIssues(issRes.value);
          }
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Error al cargar datos del tablero.");
      } finally {
        if (active) setLoading(false);
      }
    });

    return () => {
      active = false;
    };
  }, [mode]);

  const columns = mode === "OPERATIONS" ? OPERATION_COLUMNS : WARRANTY_COLUMNS;

  // Mapear elementos a tarjetas Kanban
  const cards: KanbanCard[] = useMemo(() => {
    const list: KanbanCard[] = [];

    if (mode === "OPERATIONS") {
      for (const req of requests) {
        // Encontrar columna correspondiente
        let colId = "registered";
        for (const col of OPERATION_COLUMNS) {
          if (col.statuses.includes(req.status)) {
            colId = col.id;
            break;
          }
        }

        list.push({
          id: req.id,
          code: req.code,
          title: req.clientLegalName || "Cliente",
          subtitle: `Zona: ${req.zoneName || "Sin zona"} · ${req.cabinsCount || 1} cabina(s)`,
          status: req.status,
          columnId: colId,
          badgeText: req.priority || "NORMAL",
          badgeType: req.priority === "URGENT" || req.priority === "HIGH" ? "danger" : "info",
          date: req.createdAt ? new Date(req.createdAt).toLocaleDateString() : "",
          extraInfo: req.notes || undefined,
        });
      }
    } else {
      for (const w of warranties) {
        let colId = "registered";
        for (const col of WARRANTY_COLUMNS) {
          if (col.statuses.includes(w.status)) {
            colId = col.id;
            break;
          }
        }

        list.push({
          id: w.id,
          code: w.code,
          title: `Garantía: ${displayLabel(w.claimType)}`,
          subtitle: w.description.slice(0, 60),
          status: w.status,
          columnId: colId,
          badgeText: w.status,
          badgeType: w.status === "RESOLVED" || w.status === "CLOSED" ? "success" : "warning",
          date: w.createdAt ? new Date(w.createdAt).toLocaleDateString() : "",
          extraInfo: w.assignedToName ? `Técnico: ${w.assignedToName}` : "Sin asignar",
        });
      }

      for (const iss of issues) {
        let colId = "registered";
        for (const col of WARRANTY_COLUMNS) {
          if (col.statuses.includes(iss.status)) {
            colId = col.id;
            break;
          }
        }

        list.push({
          id: iss.id,
          code: `NOV-${iss.id.slice(0, 6).toUpperCase()}`,
          title: `Novedad: ${iss.title}`,
          subtitle: `Etapa: ${displayLabel(iss.stage)} · ${iss.description.slice(0, 50)}`,
          status: iss.status,
          columnId: colId,
          badgeText: iss.severity,
          badgeType: iss.severity === "BLOCKING" ? "danger" : "warning",
          date: iss.createdAt ? new Date(iss.createdAt).toLocaleDateString() : "",
          extraInfo: iss.requestCode ? `Sol: ${iss.requestCode}` : undefined,
        });
      }
    }

    return list;
  }, [mode, requests, warranties, issues]);

  // Filtrar tarjetas por búsqueda
  const filteredCards = useMemo(() => {
    if (!search.trim()) return cards;
    const q = search.toLowerCase();
    return cards.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        c.title.toLowerCase().includes(q) ||
        c.subtitle.toLowerCase().includes(q) ||
        (c.extraInfo && c.extraInfo.toLowerCase().includes(q))
    );
  }, [cards, search]);

  return (
    <div className="management-kanban-view stack">
      <div className="panel" style={{ padding: "1.25rem" }}>
        {/* Cabecera y conmutador */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem", marginBottom: "1rem" }}>
          <div>
            <h2 style={{ margin: 0 }}>📊 Tablero Kanban Operativo</h2>
            <p className="muted" style={{ margin: "0.25rem 0 0" }}>
              Seguimiento visual del flujo de trabajo por estados y prioridades
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <button
              type="button"
              className={mode === "OPERATIONS" ? "primary button-sm" : "secondary button-sm"}
              onClick={() => setMode("OPERATIONS")}
            >
              Flujo de Solicitudes y Obra
            </button>
            <button
              type="button"
              className={mode === "WARRANTIES" ? "primary button-sm" : "secondary button-sm"}
              onClick={() => setMode("WARRANTIES")}
            >
              Garantías y Novedades
            </button>
          </div>
        </div>

        {/* Buscador */}
        <div style={{ maxWidth: "400px", marginBottom: "1rem" }}>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrar tarjetas por código, cliente o texto..."
            style={{ width: "100%" }}
          />
        </div>

        {error && (
          <div className="panel notice alert-danger" role="alert" style={{ marginBottom: "1rem" }}>
            {error}
          </div>
        )}

        {loading ? (
          <p className="muted" role="status">Cargando tarjetas del tablero…</p>
        ) : (
          <div className="kanban-columns-container">
            {columns.map((col) => {
              const colCards = filteredCards.filter((c) => c.columnId === col.id);

              return (
                <div key={col.id} className="kanban-column">
                  <div className="kanban-column-header" style={{ borderTop: `3px solid ${col.color}` }}>
                    <span className="column-title">{col.title}</span>
                    <span className="column-count">{colCards.length}</span>
                  </div>

                  <div className="kanban-column-cards">
                    {colCards.length === 0 ? (
                      <div className="kanban-empty-column">Sin elementos</div>
                    ) : (
                      colCards.map((card) => (
                        <div key={card.id} className="kanban-card">
                          <div className="card-top-row">
                            <span className="card-code"><strong>{card.code}</strong></span>
                            {card.badgeText && (
                              <span className={`tag-badge ${card.badgeType === "danger" ? "alert-danger" : card.badgeType === "warning" ? "warning" : card.badgeType === "success" ? "success" : "info"}`}>
                                {displayLabel(card.badgeText)}
                              </span>
                            )}
                          </div>
                          <div className="card-title">{card.title}</div>
                          <div className="card-subtitle muted">{card.subtitle}</div>
                          {card.extraInfo && (
                            <div className="card-extra muted" style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
                              {card.extraInfo}
                            </div>
                          )}
                          <div className="card-footer muted">
                            <span>{card.date}</span>
                            <span className="card-status-pill">{displayLabel(card.status)}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
