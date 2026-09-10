// pronto visual lint: the terminal's own rendering invariants, measured
// against a running app.
//
//   deno run -A ../../plugins/omnishell/check-visual.ts .
//   deno run ../../plugins/omnishell/check-visual.ts --self-test
//
// The DOM checks under src/lint/playwright/ describe omnishell's rendering
// surface rather than any one app's, which is why the terminal declares them
// and no app restates them. They need a laid-out page over real content, so
// this runs at integrate with the cluster up. The fixture storybook cannot
// host them: there a screen is a 360px frame on a flex board, so every
// geometry check resolves against the board instead of the screen.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format).
// Only `critical` exits non-zero. A rendered-page battery reports genuine but
// advisory design findings at major/minor — tap targets below the AAA size,
// focus-order nits — and a gate that fails on advice is muted within a week,
// taking the criticals with it.
import { parse as parseYaml } from "jsr:@std/yaml@1.0.5"
import { checkInteractiveOverlap } from "./src/lint/playwright/checks/interactive-overlap.ts"
import { checkHorizontalOverflow } from "./src/lint/playwright/checks/horizontal-overflow.ts"
import { checkConstrainedImages } from "./src/lint/playwright/checks/constrained-images.ts"
import { checkViewportBounds } from "./src/lint/playwright/checks/viewport-bounds.ts"
import { checkTouchTargets } from "./src/lint/playwright/checks/touch-targets.ts"
import { checkFocusOrder } from "./src/lint/playwright/checks/focus-order.ts"
import { armCLS, checkCLS } from "./src/lint/playwright/checks/cls.ts"
import { captureConsole, analyzeConsole } from "./src/lint/playwright/checks/console-messages.ts"
import type { VisualBug } from "./src/lint/playwright/types.ts"
import { type ParamPlan, paramPlans } from "./interpreter/lint.ts"

type Finding = { severity: string; path: string; message: string }
/** Only what this driver drives; the checks take @playwright/test's Page, which is the same object. */
type PageLike = {
  goto(url: string, opts?: unknown): Promise<unknown>
  waitForFunction(fn: unknown, arg?: unknown, opts?: unknown): Promise<{ jsonValue(): Promise<unknown> }>
  evaluate(fn: unknown, arg?: unknown): Promise<unknown>
  close(): Promise<void>
}
/** Likewise: the one method a lane calls on a viewport's context. */
type ContextLike = { newPage(): Promise<PageLike> }
type Route = { path: string; files?: { html?: string } }

type Viewport = { name: string; width: number; height: number }
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "narrow", width: 400, height: 900 },
]

// Routes in flight per viewport. The two viewports already run as separate
// contexts, so the browser holds up to twice this many live pages. Past four
// the wall clock flattens: what the battery spends is round trips to one
// browser, not CPU it could spread wider.
const LANES = 4

// WCAG 2.5.8 (AA). The battery's own default is 2.5.5's 44px, which on a
// content surface reports every article title and byline — real advice, but
// not a gate. See checks/touch-targets.ts.
const TOUCH_MIN = 24

// A screen is ready to measure when it stops changing. This long without a
// mutation, a moved box or a loading image means it has; past the cap it is
// still changing and says so. A constant wait instead of a predicate would
// have to be sized for the slowest screen, be paid by every screen, and still
// be a guess on the slowest one.
const SETTLE_STABLE_MS = 100
const SETTLE_CAP_MS = 2500

/** Electric announces its transport once per boot; a property of the dev cluster, not a screen. */
// SES announces every intrinsic it removes when a compartment is first built.
// That is the terminal's own vendored runtime talking, and it says the same
// dozen lines for every app that evaluates a Jessie module — it is not the
// app's console and must not spend the app's advisory budget.
const IGNORE = [
  /\[Electric\] Using HTTP \(not HTTPS\)/,
  /ERR_NETWORK_IO_SUSPENDED/,
  /^Removing intrinsics\./,
]

export function routesFrom(yamlText: string): Route[] {
  const doc = parseYaml(yamlText) as { routes?: Route[] }
  if (!doc?.routes?.length) throw new Error("no routes: block in shell.yaml")
  return doc.routes
}

/** Substitute resolved values for `:param` segments. */
export function fillRoute(pattern: string, params: Record<string, string>): string {
  return pattern
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg
      const v = params[seg.slice(1)]
      if (v === undefined) throw new Error(`no fixture value for :${seg.slice(1)}`)
      return encodeURIComponent(v)
    })
    .join("/")
}

async function crud<T>(base: string, q: string, token: string): Promise<T> {
  const r = await fetch(`${base}/crud/${q}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) throw new Error(`GET /crud/${q} -> ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

/** PostgREST nests a select the way the filter nests the path, at any depth:
 * `article_tag.tag` selects `article_tag(tag)`, `a.b.name` selects `a(b(name))`. */
export function embedSelect(column: string): string {
  const path = column.split(".")
  return path.slice(0, -1).reduceRight((inner, rel) => `${rel}(${inner})`, path[path.length - 1])
}

/** The same path walked back out. Which hops answer with an array is the
 * relation's business and unreadable off the filter, so take the first either way. */
export function embedValue(row: Record<string, unknown>, column: string): unknown {
  let cursor: unknown = row
  for (const step of column.split(".")) {
    if (Array.isArray(cursor)) cursor = cursor[0]
    cursor = (cursor as Record<string, unknown> | undefined)?.[step]
  }
  return Array.isArray(cursor) ? cursor[0] : cursor
}

/**
 * Ask the running cluster for a value that makes each parametrized route
 * paint. `lt`/`gt` cursors take the extreme so the rest of the set remains;
 * full-text search samples a word the index actually matches.
 *
 * Answers per route, because a plan is one: two routes spelling `:id` over
 * different tables want different rows, and a single answer held under the name
 * fills the second route with the first one's value.
 */
async function resolveParams(
  base: string,
  token: string,
  plans: ParamPlan[],
): Promise<{ params: Map<string, Record<string, string>>; unresolved: { route: string; param: string }[] }> {
  const params = new Map<string, Record<string, string>>()
  const unresolved: { route: string; param: string }[] = []
  const keep = (plan: ParamPlan, value: string) => {
    const held = params.get(plan.route) ?? {}
    held[plan.param] = value
    params.set(plan.route, held)
  }
  for (const plan of plans) {
    const table = plan.table
    const select = embedSelect(plan.column)
    try {
      if (plan.op.startsWith("plfts")) {
        const rows = await crud<Record<string, unknown>[]>(
          base,
          `${table}?select=title&limit=40`,
          token,
        )
        const words = [
          ...new Set(
            rows.flatMap((r) => String(r.title ?? "").toLowerCase().split(/[^a-z]+/)).filter((w) => w.length >= 4),
          ),
        ]
        let hit: string | undefined
        for (const w of words) {
          const got = await crud<unknown[]>(base, `${table}?select=id&${plan.column}=${plan.op}.${w}&limit=1`, token)
          if (got.length) { hit = w; break }
        }
        if (hit) keep(plan, hit)
        else unresolved.push(plan)
        continue
      }
      const order = plan.op === "lt" ? `&order=${plan.column}.desc` : plan.op === "gt" ? `&order=${plan.column}.asc` : ""
      const rows = await crud<Record<string, unknown>[]>(
        base,
        `${table}?select=${select}${order}&limit=1`,
        token,
      )
      const row = rows[0]
      if (!row) { unresolved.push(plan); continue }
      const raw = embedValue(row, plan.column)
      if (raw === undefined || raw === null) unresolved.push(plan)
      else keep(plan, String(raw))
    } catch {
      unresolved.push(plan)
    }
  }
  return { params, unresolved }
}

/**
 * Never wait for networkidle: Electric holds its shape connections open, so
 * that state never arrives and the wait consumes the whole timeout.
 */
async function openRoute(
  page: PageLike,
  base: string,
  url: string,
): Promise<{ state: string; settled: boolean }> {
  await page.goto(`${base}/shell/#${url}`, { waitUntil: "domcontentloaded" })
  const state = await page
    .waitForFunction(
      () => {
        const el = document.querySelector("#app .shell-screen:not([hidden]) .screen")
        const s = el?.getAttribute("data-state")
        return s && s !== "loading" ? s : null
      },
      undefined,
      { timeout: 20_000 },
    )
    .then((h) => h.jsonValue() as Promise<string>)
  return { state, settled: await settle(page) }
}

/**
 * Hold until the screen stops becoming itself: no DOM mutation, no geometry
 * change, no image still loading, for one quiet interval.
 *
 * Mutation matters as much as motion: a machine writes `data-state` without
 * moving a box, and a predicate watching only geometry would clear the screen
 * before the state a check reads has landed.
 *
 * Console messages need no separate window: measured across two apps, every
 * error and warning arrived before this predicate cleared, because what logs
 * during boot is what mutates the DOM. An error with no DOM effect at all
 * could still outrun it, and always could.
 *
 * Sampling runs in the page — one round trip for the whole wait, and the
 * geometry never crosses the wire. False means the cap came first, which the
 * caller reports. The cap is armed before anything else is awaited:
 * `page.evaluate` takes no timeout, so a promise that never settles in here
 * would hang the run with no output at all.
 */
export async function settle(
  page: PageLike,
  // Overridable for the one kind of caller that exists to REACH the cap rather
  // than to stay under it. No production caller passes either.
  opts: { capMs?: number; stableMs?: number } = {},
): Promise<boolean> {
  const { capMs = SETTLE_CAP_MS, stableMs = SETTLE_STABLE_MS } = opts
  return await page.evaluate(
    ({ stableMs, capMs }: { stableMs: number; capMs: number }) =>
      new Promise<boolean>((resolve) => {
        let done = false
        const finish = (quiet: boolean) => {
          if (done) return
          done = true
          observer.disconnect()
          resolve(quiet)
        }
        const cap = setTimeout(() => finish(false), capMs)

        let mutated = true
        const observer = new MutationObserver(() => {
          mutated = true
        })
        observer.observe(document.documentElement, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        })

        const fingerprint = () => {
          let h = 0
          for (const el of document.querySelectorAll("*")) {
            const r = el.getBoundingClientRect()
            const s = `${r.x},${r.y},${r.width},${r.height}`
            for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
          }
          return h
        }
        // Read fresh each sample: an image the second shape inserts is not in
        // any list taken earlier. `complete` covers errored images too, where
        // awaiting decode() would wait on a promise that never settles.
        const loading = () => [...document.images].some((img) => !img.complete)

        let previous = fingerprint()
        let stableSince = performance.now()
        const sample = () => {
          if (done) return
          const now = performance.now()
          const current = fingerprint()
          if (mutated || current !== previous || loading()) {
            mutated = false
            previous = current
            stableSince = now
          } else if (now - stableSince >= stableMs) {
            clearTimeout(cap)
            return finish(true)
          }
          setTimeout(sample, 50)
        }
        setTimeout(sample, 50)
      }),
    { stableMs, capMs },
  ) as boolean
}

/** The host port compose actually published, rather than the compose default. */
async function baseUrl(appDir: string): Promise<string> {
  const fromEnv = Deno.env.get("APP_URL")
  if (fromEnv) return fromEnv
  const out = await new Deno.Command("docker", {
    args: ["compose", "port", "caddy", "8443"],
    cwd: appDir,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const text = new TextDecoder().decode(out.stdout).trim()
  const port = text.split("\n")[0]?.split(":").pop()
  if (!out.success || !port) {
    throw new Error(`could not read the published caddy port: ${new TextDecoder().decode(out.stderr).trim()}`)
  }
  return `https://localhost:${port}`
}

async function main(appDir: string): Promise<number> {
  // Lazily, because playwright touches the environment at module scope and
  // --self-test must stay runnable with no permissions.
  const { chromium } = await import("npm:playwright@1.59.1")
  const base = await baseUrl(appDir)
  const routes = routesFrom(await Deno.readTextFile(`${appDir}/shell/shell.yaml`))

  // A guest is a real row, so it needs no signing key and no seeded handle.
  const session = await fetch(`${base}/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }).then((r) => (r.ok ? (r.json() as Promise<{ token: string }>) : { token: "" })).catch(() => ({ token: "" }))

  // Keyed by route path, because that is what paramPlans walks. A route whose
  // html is missing reads as empty markup and its params come back unplanned,
  // which is the finding either way.
  const markup: Record<string, string> = {}
  for (const route of routes) {
    if (!route.path.includes("/:") || !route.files?.html) continue
    markup[route.path] = await Deno.readTextFile(`${appDir}/${route.files.html}`).catch(() => "")
  }
  const { plans, unplanned } = paramPlans(routes, markup)
  const { params, unresolved } = await resolveParams(base, session.token, plans)
  const findings: Finding[] = []

  // A route whose param never resolved is a coverage hole, not a pass, and a
  // param nothing plans for is that hole one step earlier.
  for (const hole of unplanned) {
    findings.push({
      severity: "major",
      path: hole.route,
      message: `no read filters on :${hole.param}, so no fixture can be resolved and this route went unlinted. Give the screen a region whose data-filter pins the param.`,
    })
  }
  for (const hole of unresolved) {
    findings.push({
      severity: "major",
      path: hole.route,
      message: `no fixture value for :${hole.param} — this route went unlinted. Seed a row the param's read can match.`,
    })
  }

  // A route whose param never resolved was already reported above; linting it
  // would measure the gone state.
  const live = routes.filter(
    (route) =>
      !route.path.split("/").some(
        (s) => s.startsWith(":") && params.get(route.path)?.[s.slice(1)] === undefined,
      ),
  )

  const lintRoute = async (context: ContextLike, viewport: Viewport, route: Route, out: Finding[]) => {
    const url = fillRoute(route.path, params.get(route.path) ?? {})
    const where = `${viewport.name} ${route.path}`
    // Opening the page is inside the report: at eight pages in flight the
    // browser can refuse one, and a lane that threw would take every finding
    // both boards had collected with it.
    let page: PageLike
    let console_: ReturnType<typeof captureConsole>
    try {
      page = await context.newPage()
      // Armed before navigation: the leak this hunts is transient by nature —
      // a binding's brace text painted during the hydration window — so the
      // sampler must be watching from the first frame. innerText is the
      // rendered projection: it never sees a <template>'s content, script or
      // style text (an inline script templating {dx} is not a leak), or the
      // data-* attributes the binder consumes — so anything matched was
      // really painted. The runtime twin of the typechecker's R5.
      await (page as { addInitScript?: (fn: () => void) => Promise<void> }).addInitScript?.(() => {
        const leaks = new Set<string>()
        ;(window as unknown as { __placeholderLeaks: Set<string> }).__placeholderLeaks = leaks
        const tick = () => {
          const t = document.body?.innerText
          if (t) for (const m of t.match(/\{[\w.]+\}/g) ?? []) leaks.add(m)
          if (leaks.size < 20) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      // Before navigation for the same reason as the sampler above; armCLS
      // states why it cannot be anywhere else.
      await armCLS(page as never)
      console_ = captureConsole(page as never)
    } catch (err) {
      out.push({
        severity: "critical",
        path: url,
        message: `${where}: no page to lint in — ${err instanceof Error ? err.message : String(err)}`,
      })
      // The page is open whenever newPage was what succeeded, and the lanes
      // reach browser.close() only after every route: leaving it would hold
      // one per failure for the rest of the run.
      await page!?.close().catch(() => {})
      return
    }
    try {
      const { state, settled } = await openRoute(page, base, url)
      if (state === "gone") {
        out.push({
          severity: "major",
          path: url,
          message: `${where}: rendered the gone state, so nothing below was measured — the fixture value is stale.`,
        })
        return
      }
      if (!settled) {
        out.push({
          severity: "major",
          path: url,
          message: `${where}: still moving after ${SETTLE_CAP_MS}ms, so everything below measured a moving screen.`,
        })
      }
      const p = page as never
      // theme-stability is absent by design: it toggles a `.dark` class,
      // and pronto themes through prefers-color-scheme plus a `-dark`
      // state suffix, so the toggle changes no computed colour and the
      // check passes without measuring.
      const bugs: VisualBug[] = (
        await Promise.all([
          checkInteractiveOverlap(p),
          checkHorizontalOverflow(p),
          checkConstrainedImages(p),
          checkViewportBounds(p),
          checkTouchTargets(p, { minSize: TOUCH_MIN }),
          checkFocusOrder(p),
          checkCLS(p),
        ])
      ).flat()
      bugs.push(...analyzeConsole(console_, { ignore: IGNORE }))
      const leaked = (await page.evaluate(() => {
        const w = window as unknown as { __placeholderLeaks?: Set<string> }
        const now = document.body?.innerText?.match(/\{[\w.]+\}/g) ?? []
        return [...new Set([...(w.__placeholderLeaks ?? []), ...now])]
      })) as string[]
      if (leaked.length > 0) {
        bugs.push({
          severity: "critical",
          rule: "placeholder-leak",
          description: `rendered binding text reached the screen: ${leaked.slice(0, 5).join(", ")}` +
            (leaked.length > 5 ? ` (+${leaked.length - 5} more)` : ""),
        })
      }
      for (const b of bugs) {
        out.push({
          severity: b.severity,
          path: url,
          message: `${where} [${b.rule}] ${b.description}`,
        })
      }
    } catch (err) {
      out.push({
        severity: "critical",
        path: url,
        message: `${where}: could not be linted — ${err instanceof Error ? err.message : String(err)}`,
      })
    } finally {
      console_.dispose()
      // A page whose browser already died throws on close; the findings this
      // route produced are worth more than the tidy teardown.
      await page.close().catch(() => {})
    }
  }

  // Each job owns the findings it produces. The lanes finish in whatever order
  // they finish, and the output stays in viewport-then-route order — so the
  // order is stable run to run even though the set need not be: a console
  // message or a screen that misses the settle cap is wall-clock dependent.
  const boards = VIEWPORTS.map((viewport) => ({
    viewport,
    failure: [] as Finding[],
    jobs: live.map((route) => ({ route, out: [] as Finding[] })),
  }))

  const browser = await chromium.launch()
  try {
    // Never rejects: a board that fails records why and lets its sibling
    // finish, rather than reaching the browser.close() below while the other
    // board still has pages open on it.
    await Promise.all(
      boards.map(async ({ viewport, failure, jobs }) => {
        // The door is TLS on a certificate mkcert issued for the developer's own
        // trust store, which this browser does not share. Ignoring it is the
        // whole reason the battery can drive h2 without a per-CI trust install.
        const context = await browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width: viewport.width, height: viewport.height },
        })
        try {
          await context.addInitScript((s) => sessionStorage.setItem("pronto-token", JSON.stringify(s)), session)
          let next = 0
          const lane = async () => {
            for (;;) {
              const job = jobs[next++]
              if (!job) return
              await lintRoute(context, viewport, job.route, job.out)
            }
          }
          await Promise.all(Array.from({ length: Math.min(LANES, jobs.length) }, lane))
        } catch (err) {
          failure.push({
            severity: "critical",
            path: "shell/shell.yaml",
            message: `${viewport.name}: the viewport went unlinted — ${err instanceof Error ? err.message : String(err)}`,
          })
        } finally {
          await context.close().catch(() => {})
        }
      }),
    )
  } finally {
    await browser.close()
  }
  findings.push(...boards.flatMap((b) => [...b.failure, ...b.jobs.flatMap((j) => j.out)]))

  console.log(JSON.stringify(findings, null, 2))
  const critical = findings.filter((f) => f.severity === "critical")
  if (critical.length) {
    console.error(`\ncheck-visual: ${critical.length} critical finding(s); ${findings.length - critical.length} advisory.`)
    return 1
  }
  console.error(`check-visual: no critical findings; ${findings.length} advisory.`)
  return 0
}

function selfTest() {
  // Shaped like a real emitted shell.yaml: routes carry `files`, never
  // `reads`. A fixture shaped the other way lets paramPlans pass here while
  // planning nothing for any app, which is a green self-test over a battery
  // that opens no parametrized route.
  const yaml = [
    "routes:",
    "  - path: /",
    "    files:",
    "      html: shell/screens/home.html",
    "  - path: '/article/:slug'",
    "    files:",
    "      html: shell/screens/article.html",
    "  - path: '/tag/:name'",
    "    files:",
    "      html: shell/screens/tag.html",
    "  - path: '/older/:when'",
    "    files:",
    "      html: shell/screens/older.html",
    "  - path: '/search/:q'",
    "    files:",
    "      html: shell/screens/search.html",
    "  - path: '/profile/:handle'",
    "    files:",
    "      html: shell/screens/profile.html",
    "  - path: '/category/:id'",
    "    files:",
    "      html: shell/screens/category.html",
    "  - path: '/entry/:id'",
    "    files:",
    "      html: shell/screens/entry.html",
  ].join("\n")
  const markup: Record<string, string> = {
    "/article/:slug": `<div data-live="article" data-filter="slug=eq.{param.slug}"></div>`,
    "/tag/:name": `<div data-live="article" data-filter="article_tag.tag=eq.{param.name}&amp;limit=20"></div>`,
    "/older/:when": `<div data-live="article_stats" data-filter="created_at=lt.{param.when}&amp;limit=20"></div>`,
    "/search/:q": `<div data-live="article" data-filter="search=plfts(simple).{param.q}&amp;limit=20"></div>`,
    // Printed, never filtered on — the shape no fixture can come from.
    "/profile/:handle": `<h1 data-text="{param.handle}"></h1><div data-live="article"></div>`,
    // One name, two tables. Both plans must survive.
    "/category/:id": `<div data-live="category" data-filter="id=eq.{param.id}"></div>`,
    "/entry/:id": `<div data-live="expense" data-filter="id=eq.{param.id}"></div>`,
  }
  const routes = routesFrom(yaml)
  const { plans, unplanned } = paramPlans(routes, markup)
  const by = Object.fromEntries(plans.map((p) => [p.route, p]))
  const eq = (got: unknown, want: unknown, what: string) => {
    const g = JSON.stringify(got), w = JSON.stringify(want)
    if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`)
  }
  eq(routes.length, 8, "route count")
  const plan = (route: string, rest: Record<string, string>) => ({ route, ...rest })
  eq(by["/article/:slug"], plan("/article/:slug", { param: "slug", table: "article", column: "slug", op: "eq" }), "slug plan")
  eq(
    by["/tag/:name"],
    plan("/tag/:name", { param: "name", table: "article", column: "article_tag.tag", op: "eq" }),
    "embedded column plan",
  )
  eq(
    by["/older/:when"],
    plan("/older/:when", { param: "when", table: "article_stats", column: "created_at", op: "lt" }),
    "cursor plan",
  )
  eq(
    by["/search/:q"],
    plan("/search/:q", { param: "q", table: "article", column: "search", op: "plfts(simple)" }),
    "full-text plan",
  )
  // The regression: one `:id` over two tables. Keyed by the name alone, the
  // second route is filled with the first route's row and lints the gone
  // state — clean, and measuring nothing.
  eq(by["/category/:id"]?.table, "category", "a shared param name keeps its own route's table")
  eq(by["/entry/:id"]?.table, "expense", "and the second route is not answered by the first")
  // The regression: a param only ever printed plans nothing, and saying so is
  // the difference between a reported hole and a silent pass.
  eq(
    unplanned,
    [{ route: "/profile/:handle", param: "handle" }],
    "a param nothing filters on is reported, not dropped",
  )
  eq(fillRoute("/article/:slug", { slug: "a b" }), "/article/a%20b", "fillRoute encodes")
  eq(embedSelect("slug"), "slug", "plain column selects itself")
  eq(embedSelect("article_tag.tag"), "article_tag(tag)", "one hop")
  // Truncating this to two segments selects a relation instead of a column and
  // resolves the fixture to "[object Object]", which fills a route that then
  // lints an empty screen — clean, and measuring nothing.
  eq(embedSelect("note_label.label.name"), "note_label(label(name))", "two hops")
  eq(embedValue({ slug: "s" }, "slug"), "s", "plain value")
  eq(embedValue({ article_tag: [{ tag: "t" }] }, "article_tag.tag"), "t", "through a to-many hop")
  eq(
    embedValue({ note_label: [{ label: { name: "n" } }] }, "note_label.label.name"),
    "n",
    "through two hops, the second to-one",
  )
  console.log("check-visual: self-test ok")
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    selfTest()
    Deno.exit(0)
  }
  if (Deno.args.length === 0) {
    console.error("usage: check-visual.ts <app dir> | --self-test")
    Deno.exit(1)
  }
  Deno.exit(await main(Deno.args[0]))
}
