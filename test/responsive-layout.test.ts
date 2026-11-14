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

  it("provides responsive business wallet role controls without implying signing authority", () => {
    expect(businessDashboardHtml).toContain('id="walletRolesList"');
    expect(businessDashboardHtml).toContain('data-wallet-role-form');
    expect(businessDashboardHtml).toContain('wallet-role-form{grid-template-columns:repeat(2,minmax(0,1fr))}');
    expect(businessDashboardHtml).toContain('@media(max-width:560px){.wallet-role-form{grid-template-columns:1fr}');
    expect(businessDashboardHtml).toContain("A wallet role does not grant signing authority.");
    expect(businessDashboardHtml).toContain('/v1/admin/wallet-roles?businessId=');
  });

  it("declares business-dashboard action buttons as non-submit controls", () => {
    expect(businessDashboardHtml).not.toMatch(/<button\b(?![^>]*\btype\s*=)[^>]*>/i);
  });

  it("provides a persistent dashboard walkthrough and mobile layout", () => {
    expect(businessDashboardHtml).toContain('id="tourLaunch"');
    expect(businessDashboardHtml).toContain('role="dialog" aria-modal="true"');
    expect(businessDashboardHtml).toContain('nerith_dashboard_tour_v1_');
    expect(businessDashboardHtml).toContain('id="tourBanner"');
    expect(businessDashboardHtml).toContain('@media(max-width:560px)');
  });
  it("explains workspace setup and business-controlled custody", () => {
    expect(controlHtml).toContain('id="quickStartTitle"');
    expect(controlHtml).toContain("Register a wallet");
    expect(controlHtml).toContain("Copy the first agent API key");
    expect(controlHtml).toContain("Your business retains control of its wallets and transaction signing.");
    expect(controlHtml).toContain('@media(max-width:420px)');
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


describe("Telegram dashboard sign-in experience", () => {
  it("replaces business-id entry with private Telegram authentication", () => {
    expect(businessDashboardHtml).toContain("Secure team sign-in");
    expect(businessDashboardHtml).toContain("https://t.me/NerithLiquidityBot");
    expect(businessDashboardHtml).toContain("send <strong>/login</strong>");
    expect(businessDashboardHtml).toContain("/v1/auth/telegram/consume");
    expect(businessDashboardHtml).toContain("login_ticket");
    expect(businessDashboardHtml).toContain('location.hash.replace(/^#/,"")');
    expect(businessDashboardHtml).toContain("dashboardLogout");
    expect(businessDashboardHtml).toContain("dashboardLogoutMobile");
    expect(businessDashboardHtml).toContain("sessionRoleMobile");
    expect(businessDashboardHtml.indexOf('id="dashboardLogoutMobile"')).toBeGreaterThan(businessDashboardHtml.indexOf('id="mobileDrawer"'));
    expect(businessDashboardHtml).toContain("Telegram-linked business access");
    expect(businessDashboardHtml).toContain("analysts have read-only access");
    expect(businessDashboardHtml).not.toContain("operator-managed preview, not customer sign-in");
  });
  it("lets workspace owners choose dashboard access on invitations", () => {
    expect(controlHtml).toContain('id="inviteDashboardRole"');
    expect(controlHtml).toContain('value="admin"');
    expect(controlHtml).toContain('value="analyst"');
    expect(controlHtml).toContain("dashboardRole:byId(\"inviteDashboardRole\").value");
  });
});
