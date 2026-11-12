import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(resolve(root, "public/pixel-field.svg"), "utf8");
const generated = `// Generated from public/pixel-field.svg by scripts/embed-pixel-field.mjs.\nexport const pixelFieldSvg = ${JSON.stringify(svg)};\n`;
writeFileSync(resolve(root, "src/pixel-field.ts"), generated);
