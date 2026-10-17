"use client";
import { useEffect, useState, type FormEvent } from "react";

type Receipt = {
  id: string;
  mime: string;
  byte_size: number;
  created_at: string;
};
export function PaymentReceipts({
  payments,
}: {
  payments: { id: string; label: string }[];
}) {
  const [payment, setPayment] = useState("");
  return (
    <section className="panel stack">
      <h2>Comprobantes de pagos SaaS</h2>
      <label>
        Pago confirmado
        <select value={payment} onChange={(e) => setPayment(e.target.value)}>
          <option value="">Selecciona un pago…</option>
          {payments.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {payment && payments.some((p) => p.id === payment) ? (
        <ReceiptFiles key={payment} payment={payment} />
      ) : (
        <p className="muted">
          Selecciona un pago del listado para consultar o adjuntar sus soportes.
        </p>
      )}
    </section>
  );
}
function ReceiptFiles({ payment }: { payment: string }) {
  const [files, setFiles] = useState<Receipt[]>([]);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const path = `/api/v1/platform/subscriptions/${payment}/receipts`;
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${path}?page=${page}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok)
          throw new Error(
            result.error?.message ??
              "No se pudieron consultar los comprobantes.",
          );
        if (!controller.signal.aborted) {
          setFiles(result.data);
          setError("");
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, revision, page]);
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = new FormData(form).get("receipt");
    if (!(file instanceof File) || !file.size) {
      setError("Selecciona un archivo PDF, PNG o JPEG.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error?.message ?? "No se pudo guardar el comprobante.",
        );
      setMessage("Comprobante guardado.");
      form.reset();
      setPage(1);
      setRevision((v) => v + 1);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Revisa la conexión e intenta nuevamente.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <form onSubmit={upload} className="stack">
        <label>
          Archivo del comprobante (PDF, PNG o JPEG)
          <input
            type="file"
            name="receipt"
            accept="application/pdf,image/png,image/jpeg"
            required
            disabled={busy}
          />
        </label>
        <button disabled={busy}>
          {busy ? "Adjuntando…" : "Adjuntar comprobante"}
        </button>
      </form>
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            className="secondary"
            onClick={() => setRevision((v) => v + 1)}
          >
            Reintentar consulta
          </button>
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {loading ? (
        <p role="status">Cargando comprobantes…</p>
      ) : files.length ? (
        <ul>
          {files.map((file) => (
            <li key={file.id}>
              <a href={`/api/v1/platform/receipts/${file.id}`} download>
                Descargar comprobante · {file.mime.split("/")[1]?.toUpperCase()}{" "}
                · {Math.ceil(file.byte_size / 1024)} KB ·{" "}
                {new Date(file.created_at).toLocaleString("es-CO")}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        !error && (
          <p className="muted">
            Este pago todavía no tiene comprobantes adjuntos.
          </p>
        )
      )}
      {(page > 1 || files.length === 200) && (
        <nav aria-label="Páginas de comprobantes">
          <button
            className="secondary"
            disabled={page === 1}
            onClick={() => {
              setLoading(true);
              setPage((p) => p - 1);
            }}
          >
            Comprobantes anteriores
          </button>
          <span> Página {page} </span>
          <button
            className="secondary"
            disabled={files.length < 200}
            onClick={() => {
              setLoading(true);
              setPage((p) => p + 1);
            }}
          >
            Más comprobantes
          </button>
        </nav>
      )}
    </div>
  );
}
