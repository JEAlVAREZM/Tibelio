"use client";
import { useId, useState, type FormEvent } from "react";
import { apiRequest } from "../../shared/client/api-client";
import { MasterPicker } from "./master-picker";

type Field = { key: string; label: string; optional?: boolean; decimal?: boolean; type?: string; options?: string[] };
const definitions: Record<string, { title: string; endpoint: string; method: string; fields: Field[] }> = {
  clients: { title: "Editar cliente", endpoint: "clients", method: "PATCH", fields: [
    { key: "legalName", label: "Nombre o razón social" }, { key: "taxId", label: "Identificación tributaria" },
    { key: "phone", label: "Teléfono" }, { key: "email", label: "Correo electrónico", optional: true, type: "email" },
    { key: "notes", label: "Notas", optional: true },
  ] },
  catalog: { title: "Editar producto", endpoint: "catalog", method: "PATCH", fields: [
    { key: "sku", label: "Código SKU" }, { key: "name", label: "Nombre del producto" },
    { key: "description", label: "Descripción", optional: true },
    { key: "pricingMethod", label: "Método de precio", options: ["CATALOG_PRICE", "COST_MARGIN"] },
    { key: "baseCost", label: "Costo base", decimal: true }, { key: "listPrice", label: "Precio de catálogo", decimal: true },
    { key: "taxRate", label: "Tasa de impuesto (razón decimal)", decimal: true },
  ] },
  zones: { title: "Editar zona", endpoint: "zones", method: "PATCH", fields: [
    { key: "name", label: "Nombre de la zona" }, { key: "transportFee", label: "Flete", decimal: true },
    { key: "installationFee", label: "Instalación", decimal: true },
    { key: "targetMargin", label: "Margen objetivo (razón decimal)", decimal: true },
    { key: "minimumMargin", label: "Margen mínimo (razón decimal)", decimal: true },
  ] },
  suppliers: { title: "Editar proveedor", endpoint: "procurement/suppliers", method: "PUT", fields: [
    { key: "name", label: "Nombre del proveedor" }, { key: "taxId", label: "Identificación tributaria", optional: true },
    { key: "contactName", label: "Contacto", optional: true }, { key: "phone", label: "Teléfono", optional: true },
    { key: "email", label: "Correo electrónico", optional: true, type: "email" }, { key: "notes", label: "Notas", optional: true },
  ] },
};

/** Only ordinary master data. Financial records keep their dedicated audited flows. */
export function MasterEditor({ kind, items, onSaved, loading = false }: { kind: "clients" | "catalog" | "zones" | "suppliers"; items: readonly { id: string }[]; onSaved: () => void | Promise<void>; loading?: boolean }) {
  const id = useId();
  const [selected, setSelected] = useState<({id:string} & Record<string,unknown>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const definition = definitions[kind]!;
  // A null economic field is intentionally redacted; never turn it into a zero.
  const fields = definition.fields.filter((f) => !(selected?.[f.key] === null && ["baseCost", "targetMargin", "minimumMargin"].includes(f.key)));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || busy || loading) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = String(form.get(field.key) ?? "").trim();
      const value = field.decimal ? raw.replace(",", ".") : raw;
      if (value !== String(selected[field.key] ?? "")) body[field.key] = value === "" && kind === "suppliers" ? null : value;
    }
    const active = form.has("active");
    if (active !== selected.active) body.active = active;
    if (!Object.keys(body).length) { setMessage("No hay cambios para guardar."); return; }
    setBusy(true); setError(""); setMessage("");
    try {
      const updated = await apiRequest<{id:string} & Record<string,unknown>>(`${definition.endpoint}/${selected.id}`, definition.method, body);
      setSelected(updated);
      await onSaved();
      setMessage("Cambios guardados.");
    } catch (err) { setError(err instanceof Error ? err.message : "No se pudo guardar. Intenta de nuevo."); }
    finally { setBusy(false); }
  }
  return <section className="panel stack master-editor" aria-label={definition.title}>
    <h2 id={`${id}-heading`}>{definition.title}</h2>
    <MasterPicker endpoint={definition.endpoint} items={items} disabled={busy || loading} onPick={(row) => {setSelected(row);setMessage("");setError("");}} />
    {selected && <form key={JSON.stringify(selected)} className="stack" onSubmit={submit}>
      <fieldset disabled={busy || loading} className="master-editor-fields">
        {fields.map((f) => <label key={f.key}>{f.label}
          {f.options ? <select name={f.key} defaultValue={String(selected[f.key] ?? "")} required>{f.options.map((v) => <option key={v} value={v}>{v === "CATALOG_PRICE" ? "Precio de catálogo" : "Costo y margen"}</option>)}</select>
            : <input name={f.key} type={f.type ?? "text"} inputMode={f.decimal ? "decimal" : undefined} defaultValue={String(selected[f.key] ?? "")} required={!f.optional} />}
        </label>)}
        <label className="check-option"><input name="active" type="checkbox" defaultChecked={selected.active === true} />Registro activo</label>
      </fieldset>
      <p className="muted">Inactivar conserva el registro y su historial.</p>
      <button type="submit" disabled={busy || loading}>{busy ? "Guardando…" : "Guardar cambios"}</button>
    </form>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
