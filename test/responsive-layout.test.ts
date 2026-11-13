import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function page(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("responsive page source contracts", () => {
  const pages = [
    { name: "landing page", path: "../public/landing.html", breakpoints: ["900px", "560px", "360px"] },
    { name: "business control", path: "../public/control.html", breakpoints: ["760px", "420px"] },
    { name: "business dashboard", path: "../public/dashboard.html", breakpoints: ["1100px", "900px", "560px", "360px"] },
    { name: "agent console", path: "../public/index.html", breakpoints: ["900px", "640px"] }
  ];

  for (const entry of pages) {
    it(`${entry.name} declares a mobile viewport and its responsive breakpoints`, () => {
      const html = page(entry.path);
      expect(html).toMatch(/<meta[^>]+name=["']viewport["'][^>]+width=device-width/i);
      for (const breakpoint of entry.breakpoints) {
        expect(html).toContain(`max-width:${breakpoint}`);
      }
    });
  }

  it("keeps wide business-dashboard tables inside horizontal scroll containers", () => {
    const html = page("../public/dashboard.html");
    const tables = (html.match(/<table\b/g) ?? []).length;
    const wrappers = (html.match(/class=["']table-wrap["']/g) ?? []).length;
    expect(tables).toBeGreaterThan(0);
    expect(wrappers).toBe(tables);
    expect(html).toMatch(/\.table-wrap\s*\{[^}]*overflow-x\s*:\s*auto/s);
  });

  it("keeps wide agent-console tables inside horizontal scroll containers", () => {
    const html = page("../public/index.html");
    const tables = (html.match(/<table\b/g) ?? []).length;
    const wrappers = (html.match(/class=["']table-wrap["']/g) ?? []).length;
    expect(tables).toBeGreaterThan(0);
    expect(wrappers).toBe(tables);
    expect(html).toMatch(/\.table-wrap\s*\{[^}]*overflow-x\s*:\s*auto/s);
  });

  it("allows long wallet keys and identifiers to wrap in narrow layouts", () => {
    const control = page("../public/control.html");
    const dashboard = page("../public/dashboard.html");
    expect(control).toContain("overflow-wrap:anywhere");
    expect(dashboard).toContain("overflow-wrap:anywhere");
    expect(control).toContain("min-width:0");
  });
});
