"use client";
import { useEffect, useId, useState } from "react";
import { apiRequest } from "../../shared/client/api-client";
type RecordRow = { id: string } & Record<string, unknown>;

export function MasterPicker({ endpoint, items, disabled, onPick }: { endpoint: string; items: readonly { id: string }[]; disabled: boolean; onPick: (row: RecordRow) => void }) {
  const id = useId();
  const [query,setQuery] = useState(""); const [page,setPage] = useState(1); const [visible,setVisible] = useState(20);
  const [remote,setRemote] = useState<RecordRow[] | null>(null); const [loading,setLoading] = useState(false); const [error,setError] = useState(""); const [retry,setRetry] = useState(0);
  useEffect(() => {
    if (!query.trim() && page === 1) return;
    const controller = new AbortController(); let active = true;
    const timer = setTimeout(async () => {
      setLoading(true); setError("");
      try {
        const rows = await apiRequest<RecordRow[]>(`${endpoint}?search=${encodeURIComponent(query.trim())}&page=${page}&activeOnly=false`,"GET",undefined,{signal:controller.signal});
        if (active) setRemote(rows);
      } catch (err) { if(active) { setRemote([]); setError(err instanceof Error ? err.message : "No se pudo buscar."); } }
      finally { if(active) setLoading(false); }
    },250);
    return () => { active=false;clearTimeout(timer);controller.abort(); };
  },[query,page,endpoint,retry,items]);
  const rows = query.trim() || page>1 ? remote ?? [] : items as RecordRow[];
  return <div className="master-picker stack">
    <label htmlFor={id}>Buscar registro para editar</label>
    <input id={id} type="search" value={query} disabled={disabled} placeholder="Nombre, identificación o código…" onChange={(e) => {setQuery(e.target.value);setPage(1);setVisible(20);setRemote(null);setLoading(!!e.target.value.trim());}} />
    <p className="muted">Busca y pulsa el registro que quieras editar.</p>
    {error && <p role="alert">{error} <button type="button" className="secondary" onClick={()=>setRetry(r=>r+1)}>Reintentar búsqueda</button></p>}
    {loading ? <p role="status">Buscando registros…</p> : <ul className="master-results" aria-label="Resultados para editar">
      {rows.slice(0,visible).map(row=><li key={row.id}><button type="button" className="secondary" disabled={disabled} data-record-id={row.id} onClick={()=>onPick(row)}>
        <strong>{String(row.legalName ?? row.name)}</strong><span className="muted">{String(row.taxId ?? row.sku ?? "")}{row.active === false ? " · Inactivo" : ""}</span><span>Editar</span>
      </button></li>)}
    </ul>}
    {!loading && !rows.length && <p className="muted">No hay registros que coincidan con la búsqueda.</p>}
    {rows.length>visible && <button type="button" className="secondary" onClick={()=>setVisible(n=>n+20)}>Mostrar más resultados</button>}
    {(page>1 || rows.length===200) && <div className="picker-pages"><button type="button" className="secondary" disabled={loading || page===1} onClick={()=>{setPage(p=>p-1);setVisible(20);setLoading(page>2 || !!query.trim());setRemote(null);}}>Anterior</button><span>Página {page}</span><button type="button" className="secondary" disabled={loading || rows.length<200} onClick={()=>{setPage(p=>p+1);setVisible(20);setLoading(true);setRemote(null);}}>Siguiente</button></div>}
  </div>;
}
