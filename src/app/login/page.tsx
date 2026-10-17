import { LoginForm } from "./form";
export default function LoginPage() {
  return (
    <main className="workspace narrow">
      <p className="eyebrow">TIBELIO</p>
      <h1>Iniciar sesión</h1>
      <p>Ingresa con tu usuario y contraseña.</p>
      <LoginForm />
      <p className="muted">
        Si necesitas recuperar el acceso, contacta al administrador de tu
        empresa.
      </p>
    </main>
  );
}
