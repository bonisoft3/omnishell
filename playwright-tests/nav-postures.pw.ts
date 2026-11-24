// Visual-lint regression coverage for Pronto's four built-in Apple-HIG
// navigation postures (`topbar`, `tabbar`, `sidebar`, `dock`), brand title,
// named route icons, icon-only controls, and `.shell-me` across desktop and
// phone viewports in both light and dark appearances.
import { afterAll, beforeAll, describe, expect, it, withPage, asCheckPage } from "./harness.ts"
import { checkInteractiveOverlap } from "../src/lint/playwright/checks/interactive-overlap.ts"
import { checkHorizontalOverflow } from "../src/lint/playwright/checks/horizontal-overflow.ts"
import { checkClippedContent } from "../src/lint/playwright/checks/clipped-content.ts"
import { checkFocusableInvisible } from "../src/lint/playwright/checks/focusable-invisible.ts"
import { checkConstrainedImages } from "../src/lint/playwright/checks/constrained-images.ts"
import { checkViewportBounds } from "../src/lint/playwright/checks/viewport-bounds.ts"
import { checkTouchTargets } from "../src/lint/playwright/checks/touch-targets.ts"
import { checkFocusOrder } from "../src/lint/playwright/checks/focus-order.ts"
import { checkClippedControls } from "../src/lint/playwright/checks/clipped-controls.ts"
import { checkThemeStability } from "../src/lint/playwright/checks/theme-stability.ts"
import { checkAlignmentDrift } from "../src/lint/playwright/checks/alignment-drift.ts"
import { checkGridBaseline } from "../src/lint/playwright/checks/grid-baseline.ts"
import { checkWhiteSpace } from "../src/lint/playwright/checks/whitespace-balance.ts"
import { checkEmptyStrip } from "../src/lint/playwright/checks/empty-strip.ts"
import { checkContrast } from "../src/lint/playwright/checks/contrast.ts"

type Posture = "topbar" | "tabbar" | "sidebar" | "dock"

const POSTURES: Posture[] = ["topbar", "tabbar", "sidebar", "dock"]
const interpreterDir = new URL("../interpreter/", import.meta.url)
// Self-contained emitted stylesheets so `bonisoft3/omnishell`'s standalone
// mirror runs `pnpm run test:pw` without reaching into sibling `plugins/pronto`;
// `plugins/pronto/login-design.test.ts` holds this fixture equal to `emit.cue`.
const POSTURE_FIXTURES: Record<string, string> = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/nav-postures.json", import.meta.url)),
)

async function runAppVisualBattery(page: Parameters<Parameters<typeof withPage>[0]>[0]) {
  const b = asCheckPage(page)
  const batches = await Promise.all([
    checkInteractiveOverlap(b),
    checkHorizontalOverflow(b),
    checkClippedContent(b),
    checkFocusableInvisible(b),
    checkConstrainedImages(b),
    checkViewportBounds(b),
    checkTouchTargets(b, { minSize: 24 }),
    checkFocusOrder(b),
    checkClippedControls(b),
    checkThemeStability(b),
    checkAlignmentDrift(b),
    checkGridBaseline(b),
    checkWhiteSpace(b),
    checkEmptyStrip(b),
  ])
  const bugs = batches.flat()
  bugs.push(...(await checkContrast(b)))
  return bugs.filter((bug) => bug.severity === "critical" || bug.severity === "major")
}

function designCssFor(nav: Posture, inverted = false): string {
  const key = inverted ? `${nav}:inverted` : nav
  const css = POSTURE_FIXTURES[key]
  if (!css) throw new Error(`missing posture fixture for ${key}`)
  return css
}

const CFG = {
  app: "daily-five",
  brand: { label: "The Daily Five" },
  auth: { required: false, providers: [] },
  routes: [
    { path: "/", screen: "play", nav: { label: "Play", icon: "grid-3x3" }, files: {} },
    { path: "/stats", screen: "stats", nav: { label: "Ledger", icon: "chart-bar" }, files: {} },
    { path: "/archive", screen: "archive", nav: { label: "Archive", icon: "calendar" }, files: {} },
    { path: "/rules", screen: "rules", nav: { label: "Rules", icon: "circle-help", display: "icon-only" }, files: {} },
  ],
}

let currentHtml = ""
let server: Deno.HttpServer<Deno.NetAddr> | null = null
let baseUrl = ""

// `email` is the person signed in, under their chip; "account" is their chip
// with its panel open; null is a visitor, whose Sign in is drawn already open
// onto its ways in; "guest" is a kept guest's open panel, "taken" that panel
// offering the account a guest's sign-in found (shell.js's offerTaken), and
// "name" it asking the name to make the account under (shell.js's nameForm).
async function renderPosturePage(
  page: Parameters<Parameters<typeof withPage>[0]>[0],
  css: string,
  email: string | null,
) {
  currentHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>${css}</style>
  <style>
    main {
      padding: var(--sp-lg, 24px);
      max-width: 72rem;
      margin-inline: auto;
    }
    .card {
      padding: var(--sp-lg, 24px);
      border-radius: var(--r-md, 8px);
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--primary);
    }
    .card h1 {
      margin: 0 0 var(--sp-sm, 8px);
      font-size: 1.5rem;
    }
    .card p {
      margin: 0 0 var(--sp-md, 16px);
      color: var(--secondary);
      line-height: 1.5;
    }
    .cta {
      min-height: 44px;
      padding: 6px 16px;
      border-radius: var(--r-sm, 6px);
      border: 1px solid var(--primary);
      background: var(--primary);
      color: var(--surface);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="app">
    <section data-screen="play">
      <main>
        <article class="card">
          <h1>Daily Edition #042</h1>
          <p>Guess the five-letter word in six tries. Each guess reveals glazed ceramic clues across every column.</p>
          <button type="button" class="cta">Submit Guess</button>
        </article>
      </main>
    </section>
  </div>
  <script type="module">
    import { accountBox, drawStrip, localizeStrip, signinBox } from "/interpreter/chrome.js";
    const cfg = ${JSON.stringify(email === null || email === "guest" || email === "taken" || email === "name" ? { ...CFG, auth: { required: false, providers: ["google"] } } : CFG)};
    const email = ${JSON.stringify(email)};
    const mount = document.getElementById("app");
    const navEl = drawStrip(document, cfg);
    // The panel as the boot leaves it open where the browser asks the device
    // alone (shell.js renderSignin).
    const opened = (guest = null) => {
      const me = signinBox(document, cfg, guest);
      const open = me.querySelector(".shell-signin");
      open.hidden = false;
      open.setAttribute("aria-expanded", "true");
      me.querySelector(".shell-signin-panel").hidden = false;
      me.querySelector(".shell-passkey").hidden = false;
      return me;
    };
    if (email === null) {
      navEl.append(opened());
    } else if (email === "guest") {
      navEl.append(opened({ id: "g1", handle: "sunlit-fox-3fa2", guest: true }));
    } else if (email === "taken") {
      // The shell's offerTaken: a kept guest's sign-in into another account.
      const me = opened({ id: "g1", handle: "sunlit-fox-3fa2", guest: true });
      const feedback = document.createElement("div");
      feedback.className = "shell-auth-feedback";
      feedback.setAttribute("role", "alert");
      const msg = document.createElement("p");
      msg.className = "shell-auth-error";
      msg.textContent = "Already an account";
      const who = document.createElement("p");
      who.className = "shell-auth-taken";
      const handle = document.createElement("span");
      handle.className = "handle";
      handle.textContent = "amber-otter";
      const suffix = document.createElement("span");
      suffix.className = "suffix";
      suffix.textContent = "#77aa";
      handle.append(suffix);
      who.append(handle);
      feedback.append(msg, who);
      for (const [choice, word] of [["switch", "Switch to it"], ["stay", "Stay here"]]) {
        const next = document.createElement("button");
        next.type = "button";
        next.className = "shell-auth-choice";
        next.dataset.authChoice = choice;
        next.textContent = word;
        feedback.append(next);
      }
      const panel = me.querySelector(".shell-signin-panel");
      for (const el of panel.children) el.hidden = true;
      panel.append(feedback);
      navEl.append(me);
    } else if (email === "name") {
      // The shell's nameForm in place of the ways in.
      const me = opened({ id: "g1", handle: "sunlit-fox-3fa2", guest: true });
      const panel = me.querySelector(".shell-signin-panel");
      for (const el of panel.children) el.hidden = true;
      const form = document.createElement("form");
      form.className = "shell-name-form";
      form.innerHTML = '<button type="button" class="shell-name-back" aria-label="Back"><svg class="shell-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>'
        + '<label class="shell-name-label" for="shell-name-input">What should we call you?</label>'
        + '<input id="shell-name-input" name="given-name" autocomplete="given-name" placeholder="Your name">'
        + '<button type="submit" class="shell-name-continue"><svg class="shell-device-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="2.5"/></svg><span>Continue</span></button>';
      panel.append(form);
      navEl.append(me);
    } else {
      // A person's chip, the account's panel open where asked.
      const me = accountBox(document, cfg, { id: "u1", handle: "Alexandra-Christiansen-3fa2" }, email === "account" ? { key: "chrome_device" } : { text: email });
      if (email === "account") {
        me.querySelector(".shell-person").setAttribute("aria-expanded", "true");
        me.querySelector(".shell-signin-panel").hidden = false;
      }
      navEl.append(me);
    }
    localizeStrip(navEl, cfg, { here: "/" });
    document.body.insertBefore(navEl, mount);
    // A reader reaches the control before pressing it: a phone's bar scrolls.
    navEl.querySelector(".shell-me > :is(.shell-signin, .shell-person)")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    document.body.dataset.ready = "1";
  </script>
</body>
</html>`

  await page.goto(baseUrl)
  await page.waitForSelector('body[data-ready="1"]', { timeout: 5000 })
}

describe("shell.nav postures visual lint", () => {
  beforeAll(() => {
    server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/") {
        return new Response(currentHtml, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      if (url.pathname.startsWith("/interpreter/")) {
        const rel = url.pathname.slice("/interpreter/".length)
        const body = await Deno.readTextFile(new URL(rel, interpreterDir))
        return new Response(body, { headers: { "content-type": "text/javascript; charset=utf-8" } })
      }
      return new Response("not found", { status: 404 })
    })
    baseUrl = `http://127.0.0.1:${server.addr.port}/`
  })

  afterAll(async () => {
    await server?.shutdown()
    server = null
  })

  for (const nav of POSTURES) {
    for (const [vpName, viewport] of [
      ["desktop 1440x900", { width: 1440, height: 900 }],
      ["phone 390x844", { width: 390, height: 844 }],
    ] as const) {
      for (const scheme of ["light", "dark"] as const) {
        it(`${nav} passes visual battery on ${vpName} (${scheme})`, () =>
          withPage(
            async (page) => {
              await page.emulateMedia({ colorScheme: scheme })
              const css = await designCssFor(nav)
              await renderPosturePage(page, css, "alexandra.christiansen-longname@example.org")
              expect(await runAppVisualBattery(page)).toEqual([])
              if (nav !== "custom") {
                const iconOnlyBox = await page.evaluate(() => {
                  const el = document.querySelector('body > nav > a[data-display="icon-only"]')!
                  const r = el.getBoundingClientRect()
                  const cs = getComputedStyle(el)
                  return { width: r.width, height: r.height, padStart: parseFloat(cs.paddingInlineStart) }
                })
                expect(iconOnlyBox.padStart).toBe(6)
                expect(Math.abs(iconOnlyBox.width - iconOnlyBox.height)).toBeLessThanOrEqual(4)
              }
            },
            { viewport },
          ))
      }
    }
  }

  // The ways in open in place, inside whatever the posture is: a bar's row, a
  // rail's column, a capsule at the bottom of a phone. A narrow bar scrolls
  // sideways, so a way merely laid out is not one a reader can see: each must
  // sit inside the viewport.
  for (const nav of POSTURES) {
    for (const [vpName, viewport] of [
      ["desktop 1440x900", { width: 1440, height: 900 }],
      ["phone 390x844", { width: 390, height: 844 }],
    ] as const) {
      it(`${nav} keeps an open Sign in's panel in sight on ${vpName}`, () =>
        withPage(
          async (page) => {
            await page.emulateMedia({ colorScheme: "light" })
            await renderPosturePage(page, await designCssFor(nav), null)
            expect(await runAppVisualBattery(page)).toEqual([])
            const seen = await page.evaluate(() =>
              [...document.querySelectorAll("body > nav .shell-me > .shell-signin, body > nav .shell-signin-panel, body > nav .shell-signin-title, body > nav .shell-signin-ways > *")]
                .filter((el) => {
                  const r = el.getBoundingClientRect()
                  return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
                })
                .map((el) => el.className.split(" ")[0])
            )
            expect(seen).toEqual(["shell-signin", "shell-signin-panel", "shell-signin-title", "shell-provider", "shell-passkey"])
          },
          { viewport },
        ))
      it(`${nav} keeps a person's chip and open account panel in sight on ${vpName}`, () =>
        withPage(
          async (page) => {
            await page.emulateMedia({ colorScheme: "light" })
            await renderPosturePage(page, await designCssFor(nav), "account")
            expect(await runAppVisualBattery(page)).toEqual([])
            const seen = await page.evaluate(() =>
              [...document.querySelectorAll("body > nav .shell-me > .shell-person, body > nav .shell-signin-panel, body > nav .shell-signin-panel > *")]
                .filter((el) => {
                  const r = el.getBoundingClientRect()
                  return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
                })
                .map((el) => el.className.split(" ")[0])
            )
            expect(seen).toEqual(["shell-person", "shell-signin-panel", "shell-rename", "shell-signout", "shell-delete"])
          },
          { viewport },
        ))
      it(`${nav} keeps the name asked in place of the ways in, in sight on ${vpName}`, () =>
        withPage(
          async (page) => {
            await page.emulateMedia({ colorScheme: "light" })
            await renderPosturePage(page, await designCssFor(nav), "name")
            expect(await runAppVisualBattery(page)).toEqual([])
            const seen = await page.evaluate(() =>
              [...document.querySelectorAll("body > nav .shell-name-form > *")]
                .filter((el) => {
                  const r = el.getBoundingClientRect()
                  return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
                })
                .map((el) => el.className || el.id)
            )
            expect(seen).toEqual(["shell-name-back", "shell-name-label", "shell-name-input", "shell-name-continue"])
          },
          { viewport },
        ))
      it(`${nav} keeps a kept guest's chip and open panel in sight on ${vpName}`, () =>
        withPage(
          async (page) => {
            await page.emulateMedia({ colorScheme: "light" })
            await renderPosturePage(page, await designCssFor(nav), "guest")
            expect(await runAppVisualBattery(page)).toEqual([])
            const seen = await page.evaluate(() =>
              [...document.querySelectorAll("body > nav .shell-me > .shell-signin, body > nav .shell-signin-panel, body > nav .shell-signin-ways > *, body > nav .shell-guest-signout")]
                .filter((el) => {
                  const r = el.getBoundingClientRect()
                  return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
                })
                .map((el) => el.className.split(" ")[0])
            )
            expect(seen).toEqual(["shell-signin", "shell-signin-panel", "shell-provider", "shell-passkey", "shell-guest-signout"])
          },
          { viewport },
        ))
    }
  }

  for (const nav of POSTURES) {
    for (const [vpName, viewport] of [
      ["desktop 1440x900", { width: 1440, height: 900 }],
      ["phone 390x844", { width: 390, height: 844 }],
    ] as const) {
      it(`${nav} keeps a guest's choice of another account in sight on ${vpName}`, () =>
        withPage(
          async (page) => {
            await page.emulateMedia({ colorScheme: "light" })
            await renderPosturePage(page, await designCssFor(nav), "taken")
            expect(await runAppVisualBattery(page)).toEqual([])
            const seen = await page.evaluate(() =>
              [...document.querySelectorAll("body > nav .shell-signin-panel > .shell-auth-feedback > *")]
                .filter((el) => {
                  const r = el.getBoundingClientRect()
                  return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
                })
                .map((el) => el.textContent)
            )
            expect(seen).toEqual(["Already an account", "amber-otter#77aa", "Switch to it", "Stay here"])
          },
          { viewport },
        ))
    }
  }

  it("inverted chrome on floating tabbar and dock preserves high contrast", () =>
    withPage(
      async (page) => {
        await page.emulateMedia({ colorScheme: "light" })
        for (const nav of ["tabbar", "dock"] as const) {
          const css = await designCssFor(nav, true)
          await renderPosturePage(page, css, "player@example.org")
          expect(await runAppVisualBattery(page)).toEqual([])
        }
      },
      { viewport: { width: 1440, height: 900 } },
    ))

  it("bottom-anchored tabbar and dock reserve clearance so scrolled bottom controls stay above nav", () =>
    withPage(
      async (page) => {
        for (const nav of ["tabbar", "dock"] as const) {
          const rawCss = await designCssFor(nav)
          // Simulate a 34px iPhone home-indicator safe-area inset in headless Chromium.
          const css = rawCss.replaceAll("env(safe-area-inset-bottom, 0px)", "34px")
          await renderPosturePage(page, css, "player@example.org")
          await page.evaluate(() => {
            const main = document.querySelector("main")!
            const filler = document.createElement("div")
            filler.style.height = "1200px"
            const bottomBtn = document.createElement("button")
            bottomBtn.id = "bottom-cta"
            bottomBtn.className = "cta"
            bottomBtn.type = "button"
            bottomBtn.textContent = "Bottom Action"
            main.append(filler, bottomBtn)
            window.scrollTo(0, document.documentElement.scrollHeight)
          })
          const clearance = await page.evaluate(() => {
            const btn = document.getElementById("bottom-cta")!.getBoundingClientRect()
            const bar = document.querySelector("body > nav")!.getBoundingClientRect()
            return bar.top - btn.bottom
          })
          expect(clearance).toBeGreaterThanOrEqual(0)
        }
      },
      { viewport: { width: 390, height: 844 } },
    ))
})
