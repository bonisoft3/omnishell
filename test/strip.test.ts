// A guest the app offers no sign-in to gets no strip: signing out only mints
// another. Declaring auth is offering one, a provider's or a passkey's alike:
// counting only some ways in once took the strip, and the only way to sign in,
// from an app whose one route signs in through Google.
import { describe, expect, it } from "@test/harness";
import { parseHTML } from "npm:linkedom@0.18.4";
import { CHROME_ICONS, drawStrip, hasStrip, localizeStrip, signinBox, syncStripVisibility } from "../interpreter/chrome.js";
import { checkChrome } from "../check-i18n.ts";

const routes = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/r${i}`, screen: `r${i}`, nav: { label: `R${i}` } }));
const guest = { user: { guest: true } };

describe("hasStrip", () => {
  it("leaves a guest no strip when there is nothing to gain", () => {
    expect(hasStrip({ routes: routes(1) }, guest)).toBe(false);
  });
  it("gives a guest the strip wherever the app declares auth", () => {
    expect(hasStrip({ routes: routes(1), auth: {} }, guest)).toBe(true);
    expect(hasStrip({ routes: routes(1), auth: { providers: ["google"] } }, guest)).toBe(true);
    expect(hasStrip({ routes: routes(1), auth: { providers: ["google"] } }, null, true)).toBe(true);
  });
  it("always shows a person who they are, two links as a choice, or an explicit brand title", () => {
    expect(hasStrip({ routes: routes(1), auth: {} }, { user: { guest: false } })).toBe(true);
    expect(hasStrip({ routes: routes(2), auth: {} }, null)).toBe(true);
    expect(hasStrip({ routes: routes(1), brand: { label: "Daily Five" }, auth: {} }, null)).toBe(true);
  });
  it("never shows a strip when shell.nav is none", () => {
    expect(hasStrip({ nav: "none", routes: routes(2), brand: { label: "App" }, auth: { providers: ["google"] } }, { user: { guest: false } })).toBe(false);
    expect(hasStrip({ nav: "none", routes: routes(1), auth: {} }, null, true)).toBe(false);
  });
});

describe("syncStripVisibility", () => {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");

  it("hides empty or passkey-only SSR strips and unhides when visible content is present", () => {
    const empty = drawStrip(document, { routes: routes(1).map((r) => ({ ...r, nav: { ...r.nav, strip: false } })) });
    syncStripVisibility(empty);
    expect(empty.hasAttribute("hidden")).toBe(true);

    // Regression: guest auth without OIDC providers draws `.shell-signin` hidden on SSR.
    const passkeySsr = drawStrip(document, { routes: [] });
    passkeySsr.append(signinBox(document, { auth: { providers: [] } }));
    syncStripVisibility(passkeySsr);
    expect(passkeySsr.hasAttribute("hidden")).toBe(true);

    passkeySsr.querySelector(".shell-signin")!.removeAttribute("hidden");
    syncStripVisibility(passkeySsr);
    expect(passkeySsr.hasAttribute("hidden")).toBe(false);

    const singleLinkHiddenMe = drawStrip(document, { routes: routes(1) });
    singleLinkHiddenMe.append(signinBox(document, { auth: { providers: [] } }));
    syncStripVisibility(singleLinkHiddenMe);
    expect(singleLinkHiddenMe.hasAttribute("hidden")).toBe(true);

    const branded = drawStrip(document, { brand: { label: "Apex" }, routes: [] });
    syncStripVisibility(branded);
    expect(branded.hasAttribute("hidden")).toBe(false);

    const twoLinks = drawStrip(document, { routes: routes(2) });
    syncStripVisibility(twoLinks);
    expect(twoLinks.hasAttribute("hidden")).toBe(false);
  });
});

describe("drawStrip icons and brand title", () => {
  const { document } = parseHTML("<!doctype html><html><body></body></html>");

  it("renders named Lucide icons via createElementNS, preserves textContent, and localizes brand + icon-only labels", () => {
    const cfg = {
      brand: { label: "The Daily Five", key: "app_brand" },
      i18n: { default: "en", locales: { en: { path: "en" }, es: { path: "es" } } },
      routes: [
        { path: "/", screen: "play", nav: { label: "Play", key: "nav_play", icon: "grid-3x3" } },
        { path: "/ledger", screen: "ledger", nav: { label: "Stats", key: "nav_stats", icon: "chart-bar", display: "icon-only" } },
        { path: "/rules", screen: "rules", nav: { label: "Rules", key: "nav_rules", icon: "circle-help", display: "icon-only" } },
      ],
    };
    const nav = drawStrip(document, cfg);
    const brand = nav.querySelector(":scope > .shell-brand");
    expect(brand?.textContent).toBe("The Daily Five");

    const links = [...nav.querySelectorAll(":scope > a[data-route]")];
    expect(links.map((a) => a.textContent)).toEqual(["Play", "Stats", "Rules"]);
    expect(links[0].getAttribute("data-icon")).toBe("grid-3x3");
    expect(links[0].getAttribute("data-display")).toBe(null);
    expect(links[0].querySelector("svg.shell-nav-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(links[1].getAttribute("data-display")).toBe("icon-only");
    expect(links[1].getAttribute("aria-label")).toBe("Stats");
    expect(links[1].getAttribute("title")).toBe("Stats");

    const messages = {
      en: { app_brand: "The Daily Five", nav_play: "Play", nav_stats: "Stats", nav_rules: "Rules" },
      es: { app_brand: "Cinco Diario", nav_play: "Jugar", nav_stats: "Estadísticas", nav_rules: "Reglas" },
    };
    localizeStrip(nav, cfg, { locale: "es", here: "/es", messages });
    expect(brand?.textContent).toBe("Cinco Diario");
    expect(links.map((a) => a.textContent)).toEqual(["Jugar", "Estadísticas", "Reglas"]);
    expect(links[0].querySelector("svg.shell-nav-icon")).not.toBe(null);
    expect(links[1].querySelector("svg.shell-nav-icon")).not.toBe(null);
    expect(links[1].getAttribute("aria-label")).toBe("Estadísticas");
    expect(links[1].getAttribute("title")).toBe("Estadísticas");
  });

  it("refreshes unlocalized brand and route labels when adopting a cached strip across deploys", () => {
    const oldCfg = {
      brand: { label: "Draft Title" },
      routes: [
        { path: "/", screen: "play", nav: { label: "Draft Play", icon: "grid-3x3" } },
        { path: "/rules", screen: "rules", nav: { label: "Old Rules", icon: "circle-help", display: "icon-only" } },
      ],
    };
    const nav = drawStrip(document, oldCfg);
    const nextCfg = {
      brand: { label: "The Daily Five" },
      routes: [
        { path: "/", screen: "play", nav: { label: "Play", icon: "grid-3x3" } },
        { path: "/rules", screen: "rules", nav: { label: "Rules", icon: "circle-help", display: "icon-only" } },
      ],
    };
    localizeStrip(nav, nextCfg, { here: "/" });
    expect(nav.querySelector(":scope > .shell-brand")?.textContent).toBe("The Daily Five");
    const links = [...nav.querySelectorAll(":scope > a[data-route]")];
    expect(links.map((a) => a.textContent)).toEqual(["Play", "Rules"]);
    expect(links[1].getAttribute("aria-label")).toBe("Rules");
    expect(links[1].getAttribute("title")).toBe("Rules");
  });

  it("constructs valid SVG geometry for every icon in CHROME_ICONS", () => {
    expect(Object.keys(CHROME_ICONS).length).toBeGreaterThanOrEqual(50);
    for (const icon of Object.keys(CHROME_ICONS)) {
      const nav = drawStrip(document, {
        routes: [{ path: "/", screen: "home", nav: { label: "Home", icon } }],
      });
      const svg = nav.querySelector("svg.shell-nav-icon");
      expect(svg).not.toBe(null);
      expect(svg!.children.length).toBeGreaterThan(0);
    }
  });

  it("checks i18n keys for shell.brand when i18n is declared", () => {
    const baseShell = {
      brand: { label: "Daily Five" },
      i18n: { default: "en", locales: { en: { path: "en" }, es: { path: "es" } } },
      routes: [{ path: "/", screen: "play", nav: { label: "Play", key: "nav_play" }, files: { html: "a.html", css: "a.css" } }],
    };
    const missingKey = checkChrome(baseShell, { en: { nav_play: "Play" }, es: { nav_play: "Jugar" } });
    expect(missingKey.some((f) => f.message.includes("brand wears the strip title"))).toBe(true);

    const withKey = { ...baseShell, brand: { label: "Daily Five", key: "app_brand" } };
    const missingTranslation = checkChrome(withKey, {
      en: { app_brand: "Daily Five", nav_play: "Play" },
      es: { nav_play: "Jugar" },
    });
    expect(missingTranslation.some((f) => f.path === "messages/es.json" && f.message.includes("app_brand"))).toBe(true);

    const complete = checkChrome(withKey, {
      en: { app_brand: "Daily Five", nav_play: "Play" },
      es: { app_brand: "Cinco Diario", nav_play: "Jugar" },
    });
    expect(complete).toEqual([]);

    const navNone = checkChrome(
      { nav: "none", ...baseShell, brand: undefined, routes: [...baseShell.routes, { path: "/two", screen: "two", nav: { label: "Two" }, files: { html: "b.html", css: "b.css" } }] },
      { en: {}, es: {} },
    );
    expect(navNone).toEqual([]);
  });
});
