import { describe, expect, it } from "vitest";
import { landingHtml } from "../src/landing";
import { controlHtml } from "../src/control";
import { businessDashboardHtml } from "../src/business-dashboard";
import { dashboardHtml } from "../src/dashboard";

describe("responsive page source contracts", () => {
  const pages = [
    { name: "landing page", html: landingHtml, breakpoints: ["1000px", "720px", "380px"] },
    { name: "business control", html: controlHtml, breakpoints: ["760px", "420px"] },
    { name: "business dashboard", html: businessDashboardHtml, breakpoints: ["1100px", "900px", "560px", "360px"] },
    { name: "agent console", html: dashboardHtml, breakpoints: ["900px", "640px"] }
  ];

  for (const entry of pages) {
    it(`${entry.name} declares a mobile viewport and its responsive breakpoints`, () => {
      expect(entry.html).toMatch(/<meta[^>]+name=["']viewport["'][^>]+width=device-width/i);
      for (const breakpoint of entry.breakpoints) {
        expect(entry.html).toContain(`max-width:${breakpoint}`);
      }
    });
  }

  it("builds the desktop landing hero around the supplied oversized brand mark", () => {
    expect(landingHtml).toContain('class="hero-visual"');
    expect(landingHtml).toContain('class="hero-symbol"');
    expect(landingHtml).toContain('Keep autonomous agents <em>moving.</em>');
    expect(landingHtml).toContain('grid-template-columns:repeat(4,minmax(0,1fr))');
  });

  it("keeps the landing page navigation and content usable on phones", () => {
    expect(landingHtml).toContain('id="mobileMenu"');
    expect(landingHtml).toContain('.mobile-nav.open{display:grid}');
    expect(landingHtml).toContain('@media(max-width:720px)');
    expect(landingHtml).toContain('.hero{display:flex;flex-direction:column');
    expect(landingHtml).toContain('prefers-reduced-motion:reduce');
  });

  it("uses the supplied NERITH mark across all product workspaces", () => {
    for (const entry of pages) {
      expect(entry.html).toContain('viewBox="0 0 652 524"');
      expect(entry.html).toMatch(/fill="(?:#CFF86B|#DFFF00|currentColor)"/);
    }
  });

  it("sets dark browser chrome for the agent console", () => {
    expect(dashboardHtml).toContain('<meta name="color-scheme" content="dark">');
    expect(dashboardHtml).toContain('<meta name="theme-color" content="#0B0B0B">');
  });

  it("keeps wide business-dashboard tables inside horizontal scroll containers", () => {
    const tables = (businessDashboardHtml.match(/<table\b/g) ?? []).length;
    const wrappers = (businessDashboardHtml.match(/class=["']table-wrap["']/g) ?? []).length;
    expect(tables).toBeGreaterThan(0);
    expect(wrappers).toBe(tables);
    expect(businessDashboardHtml).toMatch(/\.table-wrap\s*\{[^}]*overflow-x\s*:\s*auto/s);
  });

  it("keeps wide agent-console tables inside horizontal scroll containers", () => {
    const tables = (dashboardHtml.match(/<table\b/g) ?? []).length;
    const wrappers = (dashboardHtml.match(/class=["']table-wrap["']/g) ?? []).length;
    expect(tables).toBeGreaterThan(0);
    expect(wrappers).toBe(tables);
    expect(dashboardHtml).toMatch(/\.table-wrap\s*\{[^}]*overflow-x\s*:\s*auto/s);
  });

  it("keeps workspace setup on the NERITH dark and lime brand system", () => {
    expect(controlHtml).toContain('color-scheme:dark');
    expect(controlHtml).toContain('--lime:#DFFF00');
    expect(controlHtml).toContain('theme-color" content="#080808"');
  });

  it("allows long wallet keys and identifiers to wrap in narrow layouts", () => {
    expect(controlHtml).toContain("overflow-wrap:anywhere");
    expect(businessDashboardHtml).toContain("overflow-wrap:anywhere");
    expect(controlHtml).toContain("min-width:0");
  });
});
