import Link from "next/link";
export default function Home() {
  return (
    <main>
      <p className="brand">TIBELIO <span>SAAS</span></p>
      <section aria-labelledby="title">
        <p className="badge">Entorno de desarrollo</p>
        <h1 id="title">El comienzo de una operación conectada.</h1>
        <p className="description">Administra el acceso de tu empresa y organiza a tu equipo en un espacio seguro.</p>
        <div className="status"><span aria-hidden="true" className="dot" /><Link href="/login">Iniciar sesión</Link></div>
        <p className="note">Los módulos empresariales estarán disponibles en las siguientes etapas.</p>
      </section>
      <footer>Tibelio SaaS <span>Plataforma e identidad</span></footer>
    </main>
  );
}
