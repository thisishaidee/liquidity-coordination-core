import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(root, "public/dashboard.html"), "utf8");
const connector = await build({
  entryPoints: [resolve(root, "scripts/okx-wallet-connector.js")],
  bundle: true,
  write: false,
  format: "iife",
  target: ["es2020"],
  platform: "browser",
  minify: true
});
const bundledConnector = connector.outputFiles[0]?.text;
if (!bundledConnector) throw new Error("OKX wallet connector bundle was not generated.");
if (!html.includes("<script>")) throw new Error("Business dashboard inline script was not found.");
// Prevent a dependency string from terminating the surrounding HTML script element.
const htmlSafeConnector = bundledConnector.replace(/<\\/script/gi, "<\\\\/script");
const htmlWithWalletSdk = html.replace("<script>", "<script>\n" + htmlSafeConnector + "\n");
const generated = `// Generated from public/dashboard.html by scripts/embed-business-dashboard.mjs.\nexport const businessDashboardHtml = ${JSON.stringify(htmlWithWalletSdk)};\n`;
writeFileSync(resolve(root, "src/business-dashboard.ts"), generated);
