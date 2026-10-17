"use client";
import { useEffect, useState, type FormEvent } from "react";
type Payment = { id: string; label: string; amount: string; currency: string };
export function AnnulPayment({
  payments,
  reload,
}: {
  payments: Payment[];
  reload: () => void;
}) {
  const [payment, setPayment] = useState("");
  const [reason, setReason] = useState("");
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const selected = payments.find((p) => p.id === payment);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !reason.trim()) return;
    if (!review) {
      setReview(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/v1/platform/subscriptions/${payment}/annul`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "No se pudo anular el pago.");
      setMessage("Pago anulado. La vigencia de la licencia se conserva.");
      setPayment("");
      setReason("");
      setReview(false);
      reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Revisa la conexión.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Anular pago SaaS</h2>
      <p>
        Conserva el pago y sus soportes, y registra una corrección por el
        importe completo. No cambia el vencimiento ni registra una devolución
        bancaria.
      </p>
      <fieldset disabled={busy || review}>
        <label>
          Pago a anular
          <select
            value={payment}
            required
            onChange={(e) => {
              setPayment(e.target.value);
              setMessage("");
            }}
          >
            <option value="">Selecciona…</option>
            {payments.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} · {p.amount} {p.currency}
              </option>
            ))}
          </select>
        </label>
        <label>
          Motivo de anulación
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={1000}
          />
        </label>
      </fieldset>
      {review && selected && (
        <div className="notice">
          <h3>Confirmar anulación</h3>
          <p>
            {selected.label} · {selected.amount} {selected.currency}
          </p>
          <p>Motivo: {reason}</p>
          <p>
            La corrección deja este pago con importe neto cero. Se conserva la
            licencia actual.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => setReview(false)}
          >
            Volver a editar
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || !selected}>
        {busy
          ? "Guardando…"
          : review
            ? "Confirmar anulación"
            : "Revisar anulación"}
      </button>
    </form>
  );
}

export function CompanyLogo({
  companies,
  reload,
}: {
  companies: { id: string; label: string; hasLogo: boolean }[];
  reload: () => void;
}) {
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("logo");
    if (!(file instanceof File) || !file.size || !company) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch(`/api/v1/platform/tenants/${company}/logo`, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "No se pudo guardar el logo.");
      form.reset();
      setMessage("Logo guardado.");
      reload();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Revisa la conexión.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel stack" onSubmit={upload}>
      <h2>Logo de empresa</h2>
      <fieldset disabled={busy}>
        <label>
          Empresa del logo
          <select
            value={company}
            onChange={(e) => {
              setCompany(e.target.value);
              setMessage("");
              setError("");
            }}
            required
          >
            <option value="">Selecciona…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Archivo del logo (PNG o JPEG)
          <input
            type="file"
            name="logo"
            accept="image/png,image/jpeg"
            required
          />
        </label>
      </fieldset>
      {companies.find((c) => c.id === company)?.hasLogo && (
        <a href={`/api/v1/platform/tenants/${company}/logo`} download>
          Descargar logo actual
        </a>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? "Guardando…" : "Guardar logo"}</button>
    </form>
  );
}

type Summary = {
  companies: number;
  active_companies: number;
  seats: string;
  active_users: string;
  current: number;
  grace: number;
  read_only: number;
  collections: {
    currency: string;
    original: string;
    corrections: string;
    net: string;
  }[];
};
type Profile = {
  id: string;
  legal_name: string;
  tax_id: string;
  logo_id: string | null;
};
export function WorkspaceOverview({ platform }: { platform: boolean }) {
  const [data, setData] = useState<Summary | Profile | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/v1/${platform ? "platform/summary" : "company"}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message);
        if (!controller.signal.aborted) {
          setData(result.data);
          setError("");
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e.message ?? "No se pudo consultar el resumen.");
      });
    return () => controller.abort();
  }, [platform, revision]);
  return (
    <section className="panel">
      <h2>{platform ? "Resumen SaaS" : "Datos de tu empresa"}</h2>
      {error ? (
        <p role="alert">
          {error}{" "}
          <button
            className="secondary"
            onClick={() => setRevision((v) => v + 1)}
          >
            Reintentar
          </button>
        </p>
      ) : !data ? (
        <p role="status">Cargando resumen…</p>
      ) : "companies" in data ? (
        <>
          <p>
            {data.companies} empresas · {data.active_companies} activas ·{" "}
            {data.active_users} usuarios activos / {data.seats} cupos
          </p>
          <p>
            Licencias de empresas activas: {data.current} vigentes ·{" "}
            {data.grace} en gracia · {data.read_only} en solo lectura
          </p>
          {data.collections.map((c) => (
            <p key={c.currency}>
              Recaudo SaaS {c.currency}: {c.original} original · {c.corrections}{" "}
              correcciones · {c.net} neto
            </p>
          ))}
        </>
      ) : (
        <>
          <p>
            {data.legal_name} · Identificación tributaria: {data.tax_id}
          </p>
          {data.logo_id && (
            <a href={`/api/v1/company/${data.id}/logo`} download>
              Descargar logo de tu empresa
            </a>
          )}
        </>
      )}
    </section>
  );
}
