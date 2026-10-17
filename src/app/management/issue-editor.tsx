"use client";
import { useId, useState, type FormEvent } from "react";
import type { OperationalIssueDto } from "../../shared/contracts/post-sale";
import { apiRequest } from "../../shared/client/api-client";

export function IssueEditor({ issues, onSaved }: { issues: OperationalIssueDto[]; onSaved: () => Promise<void> }) {
  const id = useId();
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const open = issues.filter((i) => ["OPEN", "IN_PROGRESS"].includes(i.status));
  const selected = open.find((i) => i.id === selectedId);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy) return;
    const data = new FormData(event.currentTarget);
    const status = String(data.get("status"));
    const notes = String(data.get("notes") ?? "").trim();
    if (["RESOLVED", "CANCELLED"].includes(status) && notes.length < 5) { setError("Escribe una resolución o motivo de al menos 5 caracteres."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      await apiRequest(`issues/${selected.id}/status`, "POST", { status, ...(notes ? { resolutionNotes: notes } : {}) });
      await onSaved(); setMessage("Estado de la novedad actualizado.");
    } catch (err) { setError(err instanceof Error ? err.message : "No se pudo actualizar la novedad."); }
    finally { setBusy(false); }
  }
  return <section className="panel stack" aria-label="Gestionar novedad">
    <h2 id={`${id}-heading`}>Gestionar novedad</h2>
    <label htmlFor={`${id}-record`}>Novedad abierta</label>
    <select id={`${id}-record`} value={selectedId} disabled={busy || !open.length} onChange={(e) => { setSelectedId(e.target.value); setError(""); setMessage(""); }}>
      <option value="">{open.length ? "Selecciona una novedad…" : "No hay novedades abiertas"}</option>
      {open.map((i) => <option key={i.id} value={i.id}>{i.title} · {i.requestCode}</option>)}
    </select>
    {selected && <form key={selected.id} className="stack" onSubmit={submit}>
      <p>{selected.description}</p>
      <fieldset disabled={busy}>
        <label htmlFor={`${id}-status`}>Nuevo estado</label><select id={`${id}-status`} name="status" defaultValue={selected.status}>
          <option value="OPEN">Abierta</option><option value="IN_PROGRESS">En atención</option>
          <option value="RESOLVED">Resuelta</option><option value="CANCELLED">Cancelada</option>
        </select>
        <label htmlFor={`${id}-notes`}>Resolución o motivo</label><textarea id={`${id}-notes`} name="notes" maxLength={2000} defaultValue={selected.resolutionNotes ?? ""} />
      </fieldset>
      <button type="submit" disabled={busy}>{busy ? "Guardando…" : "Actualizar novedad"}</button>
    </form>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
