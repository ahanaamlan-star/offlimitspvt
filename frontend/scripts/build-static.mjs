// Cross-platform static export (Netlify / any static host). Output: ./out
import { spawnSync } from "node:child_process";
const env = { ...process.env, STATIC_EXPORT: "1", NEXT_PUBLIC_API_MODE: process.env.NEXT_PUBLIC_API_MODE || "local" };
const r = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "build", "--webpack"], { stdio: "inherit", env, shell: process.platform === "win32" });
process.exit(r.status ?? 1);
