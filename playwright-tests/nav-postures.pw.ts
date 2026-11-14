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

async function renderPosturePage(
  page: Parameters<Parameters<typeof withPage>[0]>[0],
  css: string,
  email: string,
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
    import { drawStrip, localizeStrip } from "/interpreter/chrome.js";
    const cfg = ${JSON.stringify(CFG)};
    const mount = document.getElementById("app");
    const navEl = drawStrip(document, cfg);
    const me = document.createElement("span");
    me.className = "shell-me";
    const who = document.createElement("span");
    who.className = "shell-who";
    who.textContent = ${JSON.stringify(email)};
    const signOut = document.createElement("button");
    signOut.type = "button";
    signOut.className = "shell-signout";
    signOut.textContent = "sign out";
    me.append(who, signOut);
    navEl.append(me);
    localizeStrip(navEl, cfg, { here: "/" });
    document.body.insertBefore(navEl, mount);
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
