import { describe, expect, it } from "vitest";
import { landingHtml } from "../src/landing";
import { controlHtml } from "../src/control";
import { businessDashboardHtml } from "../src/business-dashboard";
import { dashboardHtml } from "../src/dashboard";

describe("responsive page source contracts", () => {
  const pages = [
    { name: "landing page", html: landingHtml, breakpoints: ["900px", "560px", "360px"] },
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

  it("allows long wallet keys and identifiers to wrap in narrow layouts", () => {
    expect(controlHtml).toContain("overflow-wrap:anywhere");
    expect(businessDashboardHtml).toContain("overflow-wrap:anywhere");
    expect(controlHtml).toContain("min-width:0");
  });
});
