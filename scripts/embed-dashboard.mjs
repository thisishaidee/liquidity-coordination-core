import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "public/index.html"), "utf8");
const generated = `// Generated from public/index.html by scripts/embed-dashboard.mjs.\nexport const dashboardHtml = ${JSON.stringify(html)};\n`;
writeFileSync(resolve(root, "src/dashboard.ts"), generated);
