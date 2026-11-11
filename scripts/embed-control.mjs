import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "public/control.html"), "utf8");
const generated = `// Generated from public/control.html by scripts/embed-control.mjs.\nexport const controlHtml = ${JSON.stringify(html)};\n`;
writeFileSync(resolve(root, "src/control.ts"), generated);
