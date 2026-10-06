import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "IBM Plex Sans", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        nav: { DEFAULT: "#0b1324", hover: "#16203a", active: "#1d2748", border: "#1c2640", text: "#aeb9cc", muted: "#5d6b85" },
        brand: { DEFAULT: "#4f46e5", soft: "#eef0ff", ring: "#c7cbff" },
      },
      boxShadow: { card: "0 1px 2px rgba(15,23,42,0.04)" },
      keyframes: {
        pulsebar: { "0%,100%": { transform: "scaleY(0.35)" }, "50%": { transform: "scaleY(1)" } },
        flash: { "0%": { backgroundColor: "rgb(238 240 255)" }, "100%": { backgroundColor: "transparent" } },
      },
      animation: { pulsebar: "pulsebar 1s ease-in-out infinite", flash: "flash 2.5s ease-out" },
    },
  },
  plugins: [],
};
export default config;
