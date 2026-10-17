"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const values = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: values.get("username"),
          password: values.get("password"),
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error?.code === "RATE_LIMITED"
            ? "Demasiados intentos. Espera diez minutos."
            : "No fue posible iniciar sesión. Revisa tus datos o contacta a tu administrador.",
        );
      const session = await fetch("/api/v1/auth/session");
      const { data } = await session.json();
      router.replace(data.platformRole === "SUPERADMIN" ? "/platform" : "/app");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No hay conexión. Intenta nuevamente.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="panel stack">
      <label>
        Usuario
        <input
          name="username"
          autoComplete="username"
          required
          maxLength={64}
        />
      </label>
      <label>
        Contraseña
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={busy}>{busy ? "Verificando…" : "Entrar"}</button>
    </form>
  );
}
