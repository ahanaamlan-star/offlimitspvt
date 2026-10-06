/**
 * Two build targets:
 *  - default (`npm run build`/`npm run dev`): Next server, /api proxied to FastAPI (BACKEND_URL).
 *  - static  (`npm run build:static`, used by Netlify): `output: "export"` → ./out, the API runs in the browser.
 * @type {import('next').NextConfig}
 */
const BACKEND_URL = process.env.BACKEND_URL || "http://127.0.0.1:8000";
const STATIC = process.env.STATIC_EXPORT === "1" || process.env.STATIC_EXPORT === "true";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "microphone=(self), camera=()" },
];

const nextConfig = STATIC
  ? {
      reactStrictMode: true,
      output: "export",
      images: { unoptimized: true },
      env: {
        NEXT_PUBLIC_API_MODE: process.env.NEXT_PUBLIC_API_MODE || "local",
        // Boolean only — the key itself is never exposed. "1" when the Netlify Function can call Gemini.
        NEXT_PUBLIC_AI_PROXY: process.env.NEXT_PUBLIC_AI_PROXY || (process.env.NETLIFY && process.env.GEMINI_API_KEY ? "1" : "0"),
      },
    }
  : {
      reactStrictMode: true,
      async rewrites() {
        return [{ source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` }];
      },
      experimental: { proxyTimeout: 60_000 },
      async headers() {
        return [{ source: "/(.*)", headers: securityHeaders }];
      },
    };

export default nextConfig;
