// Copies pdf.js (used for in-browser PDF text + page count) into public/vendor/pdfjs.
import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("public/vendor/pdfjs", { recursive: true });
for (const f of ["pdf.min.mjs", "pdf.worker.min.mjs"]) copyFileSync(`node_modules/pdfjs-dist/build/${f}`, `public/vendor/pdfjs/${f}`);
console.log("pdf.js copied to public/vendor/pdfjs");
