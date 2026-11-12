import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "public/dashboard.html"), "utf8");
const generated = `// Generated from public/dashboard.html by scripts/embed-business-dashboard.mjs.\nexport const businessDashboardHtml = ${JSON.stringify(html)};\n`;
writeFileSync(resolve(root, "src/business-dashboard.ts"), generated);
