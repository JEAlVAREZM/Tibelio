"use client";

import { useEffect, useState, type FormEvent } from "react";
import { parsePercentageRatio, type CommercialSettingsDto } from "../../shared/contracts/commercial";

interface ApiError extends Error {
  code?: string;
  status?: number;
}

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const isMutating = method !== "GET" && method !== "HEAD";
  const response = await fetch(`/api/v1/${path}`, {
    method,
    headers: isMutating || body !== undefined ? { "Content-Type": "application/json" } : {},
    body: isMutating ? JSON.stringify(body ?? {}) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error?.message ?? "Error en la operación comercial.") as ApiError;
    error.code = result.error?.code ?? (response.status === 403 ? "FORBIDDEN" : "ERROR");
    error.status = response.status;
    throw error;
  }
  return result.data as T;
}

export function CommercialSettingsView({
  readOnly,
  canManage,
}: {
  readOnly: boolean;
  canManage: boolean;
}) {
  const [settings, setSettings] = useState<CommercialSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Form inputs
  const [currency, setCurrency] = useState("COP");
  const [taxRate, setTaxRate] = useState("");
  const [taxIncluded, setTaxIncluded] = useState(false);
  const [defaultValidityDays, setDefaultValidityDays] = useState(15);
  const [targetMargin, setTargetMargin] = useState("");
  const [minMargin, setMinMargin] = useState("");
  const [defaultPaymentTerms, setDefaultPaymentTerms] = useState("");
  const [notes, setNotes] = useState("");

  const applySettings = (data: CommercialSettingsDto) => {
    setSettings(data);
    setCurrency(data.currency);
    setTaxRate(data.taxRate);
    setTaxIncluded(data.taxIncluded);
    setDefaultValidityDays(data.defaultValidityDays);
    setTargetMargin(data.targetMargin ?? "");
    setMinMargin(data.minMargin ?? "");
    setDefaultPaymentTerms(data.defaultPaymentTerms ?? "");
    setNotes(data.notes ?? "");
  };

  const resetUnconfigured = () => {
    setSettings(null);
    setCurrency("COP");
    setTaxRate("");
    setTaxIncluded(false);
    setDefaultValidityDays(15);
    setTargetMargin("");
    setMinMargin("");
    setDefaultPaymentTerms("");
    setNotes("");
  };

  const loadSettings = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<CommercialSettingsDto>("commercial/settings");
      applySettings(data);
    } catch (err: unknown) {
      const e = err as ApiError;
      if (e.code === "FORBIDDEN" || e.status === 403) {
        setForbidden(true);
      } else if (e.code === "NOT_FOUND" || e.status === 404) {
        resetUnconfigured();
      } else {
        setError(e.message || "Error al cargar la configuración comercial.");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    api<CommercialSettingsDto>("commercial/settings")
      .then((data) => {
        if (cancelled) return;
        applySettings(data);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const e = err as ApiError;
        if (e.code === "FORBIDDEN" || e.status === 403) {
          setForbidden(true);
        } else if (e.code === "NOT_FOUND" || e.status === 404) {
          resetUnconfigured();
        } else {
          setError(e.message || "Error al cargar la configuración comercial.");
        }
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (readOnly || !canManage) return;

    const parsedTax = parsePercentageRatio(taxRate);
    if (parsedTax === null) {
      setError("La tarifa de impuesto (IVA) no es válida. Ingrese ej. 0,19 o 19 (sin símbolo %).");
      return;
    }
    const tMargin = parsePercentageRatio(targetMargin);
    if (tMargin === null) {
      setError("El margen objetivo no es válido. Ingrese ej. 0,35 o 35 (sin símbolo %).");
      return;
    }
    const mMargin = parsePercentageRatio(minMargin);
    if (mMargin === null) {
      setError("El margen mínimo no es válido. Ingrese ej. 0,20 o 20 (sin símbolo %).");
      return;
    }
    if (tMargin < mMargin) {
      setError("El margen objetivo no puede ser menor que el margen mínimo de seguridad.");
      return;
    }

    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await api<CommercialSettingsDto>("commercial/settings", "PUT", {
        currency: currency.trim().toUpperCase(),
        taxRate: parsedTax,
        taxIncluded,
        defaultValidityDays: Number(defaultValidityDays),
        targetMargin: tMargin,
        minMargin: mMargin,
        defaultPaymentTerms: defaultPaymentTerms.trim() || null,
        notes: notes.trim() || null,
      });
      applySettings(updated);
      setMessage("Configuración comercial actualizada correctamente.");
    } catch (err: unknown) {
      const e = err as ApiError;
      setError(e.message || "No se pudo guardar la configuración.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="panel" data-testid="settings-loading">
        <p className="muted">Cargando configuración comercial institucional...</p>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="panel" data-testid="settings-forbidden">
        <p role="alert">🔒 No tienes permisos para consultar o modificar la configuración comercial.</p>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="commercial-settings-container">
      <div className="panel">
        <div className="workspace-header" style={{ marginBottom: "1rem" }}>
          <div>
            <span className="eyebrow">POLÍTICAS COMERCIALES Y RENTABILIDAD</span>
            <h2>Parámetros Maestros de Cotización</h2>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {settings?.updatedAt && (
              <span className="tag-badge secondary">
                Última actualización: {new Date(settings.updatedAt).toLocaleDateString()}
              </span>
            )}
            <button
              type="button"
              className="secondary button-sm"
              onClick={() => void loadSettings()}
              data-testid="button-refresh-settings"
            >
              Recargar
            </button>
          </div>
        </div>

        {error && <p role="alert" style={{ marginBottom: "1rem" }}>{error}</p>}
        {message && <p style={{ color: "#1b6357", fontWeight: 600, marginBottom: "1rem" }}>{message}</p>}
        {!settings && (
          <div
            className="panel"
            style={{ background: "#fff9e6", border: "1px solid #dfc46d", marginBottom: "1rem" }}
            data-testid="settings-unconfigured-banner"
          >
            <p>
              <strong>Configuración Pendiente:</strong> Esta empresa aún no tiene registrados sus parámetros comerciales maestros. Por favor defínalos para habilitar la liquidación formal de cotizaciones.
            </p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="stack" data-testid="settings-form">
          <div className="form-grid">
            <label>
              Moneda Canónica
              <input
                type="text"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                maxLength={3}
                disabled={!canManage || readOnly || busy}
                required
                data-testid="input-settings-currency"
              />
              <span className="muted">Moneda obligatoria de liquidación (ej. COP).</span>
            </label>

            <label>
              Tasa de Impuesto / IVA (Decimal)
              <input
                type="text"
                inputMode="decimal"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
                disabled={!canManage || readOnly || busy}
                required
                data-testid="input-settings-tax-rate"
              />
              <span className="muted">Ej. 0.19 o 0,19 para 19% IVA Colombia.</span>
            </label>
          </div>

          <div className="form-grid">
            <label>
              Margen Objetivo Institucional
              <input
                type="text"
                inputMode="decimal"
                value={targetMargin}
                onChange={(e) => setTargetMargin(e.target.value)}
                disabled={!canManage || readOnly || busy}
                required
                data-testid="input-settings-target-margin"
              />
              <span className="muted">Margen comercial sugerido al calcular por costo (ej. 0.35 o 0,35 para 35%).</span>
            </label>

            <label>
              Margen Mínimo de Seguridad
              <input
                type="text"
                inputMode="decimal"
                value={minMargin}
                onChange={(e) => setMinMargin(e.target.value)}
                disabled={!canManage || readOnly || busy}
                required
                data-testid="input-settings-min-margin"
              />
              <span className="muted">Límite mínimo por debajo del cual no se autoriza cotizar (ej. 0.20 o 0,20 para 20%).</span>
            </label>
          </div>

          <div className="form-grid">
            <label>
              Días de Validez Predeterminados
              <input
                type="number"
                min="1"
                max="365"
                value={defaultValidityDays}
                onChange={(e) => setDefaultValidityDays(Number(e.target.value))}
                disabled={!canManage || readOnly || busy}
                required
                data-testid="input-settings-validity-days"
              />
              <span className="muted">Vigencia que se aplicará por defecto a cotizaciones nuevas.</span>
            </label>

            <div style={{ paddingTop: "1.8rem" }}>
              <label className="check-option">
                <input
                  type="checkbox"
                  checked={taxIncluded}
                  onChange={(e) => setTaxIncluded(e.target.checked)}
                  disabled={!canManage || readOnly || busy}
                  data-testid="checkbox-settings-tax-included"
                />
                Impuesto ya incluido en precios de lista del catálogo
              </label>
            </div>
          </div>

          <label>
            Términos y Condiciones de Pago por Defecto
            <input
              type="text"
              value={defaultPaymentTerms}
              onChange={(e) => setDefaultPaymentTerms(e.target.value)}
              placeholder="Ej. 50% anticipo al ordenar, 50% contra entrega"
              disabled={!canManage || readOnly || busy}
              maxLength={255}
              data-testid="input-settings-payment-terms"
            />
            <span className="muted">Aparece predeterminado en el documento PDF para el comprador final.</span>
          </label>

          <label>
            Notas Institucionales
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Políticas internas o especificaciones de garantía para el equipo comercial"
              disabled={!canManage || readOnly || busy}
              maxLength={1000}
              rows={3}
              style={{
                width: "100%",
                borderRadius: "7px",
                border: "1px solid #adbec4",
                padding: "0.7rem",
                font: "inherit",
              }}
              data-testid="textarea-settings-notes"
            />
          </label>

          {canManage && !readOnly && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "1rem" }}>
              <button
                type="submit"
                disabled={busy}
                data-testid="button-save-settings"
              >
                {busy ? "Guardando..." : "Guardar Configuración Comercial"}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
