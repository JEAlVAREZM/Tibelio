import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./interface.css";

const geist = localFont({ src: "./fonts/geist-latin.woff2", display: "swap", variable: "--font-ui", weight: "100 900" });

export const metadata: Metadata = {
  title: "Tibelio SaaS",
  description: "Entorno de desarrollo de Tibelio SaaS",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es" className={geist.variable}><body>{children}</body></html>;
}

