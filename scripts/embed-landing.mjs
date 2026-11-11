import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "public/landing.html"), "utf8");
const generated = `// Generated from public/landing.html by scripts/embed-landing.mjs.\nexport const landingHtml = ${JSON.stringify(html)};\n`;
writeFileSync(resolve(root, "src/landing.ts"), generated);
