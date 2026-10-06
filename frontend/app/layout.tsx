import "./globals.css";
import { AppShell } from "@/components/layout/app-shell";

// Head tags are written by hand instead of the `metadata` export: Next 15 streams metadata into a hidden
// Suspense boundary, which in static exports (Netlify) intermittently triggers a hydration mismatch (React #418).
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <title>OFFLIMITS — Merchant Intelligence Loop</title>
        <meta name="description" content="From messy merchant activity to business action. SEE → THINK → ACT → UPDATED STATE." />
        <meta name="theme-color" content="#0b1324" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
