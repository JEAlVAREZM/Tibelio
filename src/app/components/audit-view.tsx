"use client";
import { useEffect, useState } from "react";
import { apiRequest } from "../../shared/client/api-client";
import { AUDIT_ENTITIES, auditFieldLabel, type AuditEvent } from "../../shared/contracts/audit";
import { displayLabel } from "../../shared/contracts/ui-labels";

function valueLabel(field: string, value: unknown) {
  if (value === undefined || value === null) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (["status","kind","priority","authority","pricing_method"].includes(field)) return displayLabel(String(value));
  return Array.isArray(value) ? value.join(", ") : String(value);
}
export function AuditView() {
  const [search,setSearch] = useState(""); const [entity,setEntity] = useState("");
  const [from,setFrom] = useState(""); const [to,setTo] = useState(""); const [page,setPage] = useState(1);
  const [data,setData] = useState<{items:AuditEvent[];total:number}>({items:[],total:0});
  const [loading,setLoading] = useState(true); const [error,setError] = useState(""); const [retry,setRetry] = useState(0);
  useEffect(()=>{
    const controller=new AbortController(); let active=true;
    const timer=setTimeout(async()=>{
      setLoading(true); setError("");
      const params=new URLSearchParams({search,page:String(page)});
      if(entity) params.set("entity",entity); if(from) params.set("from",from); if(to) params.set("to",to);
      try { const result=await apiRequest<{items:AuditEvent[];total:number}>(`audit?${params}`,"GET",undefined,{signal:controller.signal}); if(active) setData(result); }
      catch(err) { if(active) { setData({items:[],total:0}); setError(err instanceof Error ? err.message : "No se pudo cargar el historial."); } }
      finally { if(active) setLoading(false); }
    },250);
    return ()=>{active=false;clearTimeout(timer);controller.abort();};
  },[search,entity,from,to,page,retry]);
  return <section className="panel stack audit-view" aria-label="Historial de auditoría">
    <h2>Historial de auditoría</h2>
    <p className="muted">Consulta quién cambió cada registro y cuándo. El historial comienza con la activación de esta función; no reconstruye cambios anteriores. Los valores financieros y las credenciales permanecen protegidos en sus módulos.</p>
    <div className="form-grid">
      <label>Buscar en el historial<input type="search" value={search} maxLength={160} placeholder="Registro o responsable…" onChange={e=>{setSearch(e.target.value);setPage(1);}} /></label>
      <label>Módulo del historial<select value={entity} onChange={e=>{setEntity(e.target.value);setPage(1);}}><option value="">Todos los módulos permitidos</option>{Object.entries(AUDIT_ENTITIES).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      <label>Desde<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setPage(1);}} /></label>
      <label>Hasta<input type="date" value={to} min={from || undefined} onChange={e=>{setTo(e.target.value);setPage(1);}} /></label>
    </div>
    {error && <p role="alert">{error} <button type="button" className="secondary" onClick={()=>setRetry(v=>v+1)}>Reintentar</button></p>}
    {loading ? <p role="status">Cargando historial…</p> : !data.items.length ? <p className="muted">No hay cambios que coincidan con los filtros.</p> : <div className="table-responsive"><table>
      <thead><tr><th>Fecha (Bogotá)</th><th>Responsable</th><th>Módulo y registro</th><th>Operación</th><th>Cambios</th></tr></thead>
      <tbody>{data.items.map(event=><tr key={event.id}>
        <td>{new Date(event.occurredAt).toLocaleString("es-CO",{timeZone:"America/Bogota"})}</td><td>{event.actorLabel}</td>
        <td><strong>{AUDIT_ENTITIES[event.entity] ?? "Registro empresarial"}</strong><br/>{event.recordLabel}</td><td>{displayLabel(event.operation)}</td>
        <td><details><summary>Ver cambios ({event.changedFields.length})</summary><ul>{event.changedFields.map(field=><li key={field}><strong>{auditFieldLabel(field)}: </strong>{Object.hasOwn(event.beforeValues,field) || Object.hasOwn(event.afterValues,field) ? <>{valueLabel(field,event.beforeValues[field])} → {valueLabel(field,event.afterValues[field])}</> : "Cambio registrado; consulta el detalle en su módulo."}</li>)}</ul></details></td>
      </tr>)}</tbody></table></div>}
    <div className="picker-pages"><button type="button" className="secondary" disabled={loading || page===1} onClick={()=>setPage(p=>p-1)}>Anterior</button><span>Página {page} · {data.total} cambios</span><button type="button" className="secondary" disabled={loading || page*25>=data.total} onClick={()=>setPage(p=>p+1)}>Siguiente</button></div>
  </section>;
}
