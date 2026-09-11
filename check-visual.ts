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
import { checkClippedContent } from "./src/lint/playwright/checks/clipped-content.ts"
import { checkFocusableInvisible } from "./src/lint/playwright/checks/focusable-invisible.ts"
import { checkHorizontalOverflow } from "./src/lint/playwright/checks/horizontal-overflow.ts"
import { checkConstrainedImages } from "./src/lint/playwright/checks/constrained-images.ts"
import { checkViewportBounds } from "./src/lint/playwright/checks/viewport-bounds.ts"
import { checkTouchTargets } from "./src/lint/playwright/checks/touch-targets.ts"
import { checkFocusOrder } from "./src/lint/playwright/checks/focus-order.ts"
import { armCLS, checkCLS } from "./src/lint/playwright/checks/cls.ts"
import { captureConsole, analyzeConsole } from "./src/lint/playwright/checks/console-messages.ts"
import type { VisualBug } from "./src/lint/playwright/types.ts"
import { type ParamPlan, paramPlans } from "./interpreter/lint.ts"
import { parseFilter, parseFilterSpec, PLACEHOLDERS } from "./interpreter/fragment.js"

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

/** shell.yaml, parsed once by main and handed to each reader; a reader given
 * text parses it itself, which is what the unit tests do. */
type ShellDoc = Record<string, unknown>
const shellDoc = (yaml: string | ShellDoc): ShellDoc => typeof yaml === "string" ? (parseYaml(yaml) as ShellDoc) ?? {} : yaml

/** An emitted key the battery cannot do without: pronto always writes it, so
 * its absence is a file that is not a shell.yaml, never a default. */
function emitted<T>(doc: ShellDoc, key: string, is: (v: unknown) => v is T): T {
  const v = doc[key]
  if (!is(v)) throw new Error(`no ${key}: in shell.yaml; run plugins/pronto/write.ts`)
  return v
}

export function routesFrom(yaml: string | ShellDoc): Route[] {
  return emitted(shellDoc(yaml), "routes", (v): v is Route[] => Array.isArray(v) && v.length > 0)
}

/**
 * The terminal's measured floors, in device px, off the emitted shell.yaml.
 * The terminal declares them, and
 * omnishell.#Terminal.capabilities.floors argues why it is one declaration. A
 * file without them raises: a default here would be a second number.
 */
export function floorsFrom(yaml: string | ShellDoc): Record<string, number> {
  const doc = shellDoc(yaml) as { floors?: Record<string, number> }
  if (typeof doc.floors?.touch !== "number") throw new Error("no floors.touch in shell.yaml; run plugins/pronto/write.ts")
  return doc.floors
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

type Row = Record<string, unknown>
/** Where each table's rows live, off the emitted shell.yaml. `local:` names
 * the browser tiers (tab, device) the store builds from a local factory and
 * fills from `seed:`; every other table is a server one the store reads
 * through /crud. pronto emits either key only when it is non-empty, so a file
 * carrying neither is the emitted statement that every table is a server one.
 * `server` is whether the cluster runs an auth and a crud service at all,
 * emitted from the predicate that runs them (pronto's #serverOn). */
export type Tiers = { local: Record<string, string>; seed: Record<string, Row[]>; server: boolean }
/** One /crud query, answered as rows. Injected so the resolver can be held to
 * WHICH reads it makes without a cluster. */
export type Reader = (query: string) => Promise<Row[]>

export function tiersFrom(yaml: string | ShellDoc): Tiers {
  const doc = shellDoc(yaml) as { local?: Record<string, string>; seed?: Record<string, Row[]> }
  const server = emitted(doc, "server", (v): v is boolean => typeof v === "boolean")
  return { local: doc.local ?? {}, seed: doc.seed ?? {}, server }
}

/**
 * Whether the terminal answers this read from the collection it seeded, or
 * through /crud: a table named in `local:` reads locally exactly when the
 * store can translate the region's WHOLE filter, which is fragment.js's own
 * predicate over every clause — one fts expression, embed path or `in` list
 * sends the read to the server whatever the tier. The store parses the filter
 * with its params filled, so each binding is filled here with `true`, a value
 * every operator accepts, `is` included.
 */
function onDevice(plan: ParamPlan, tiers: Tiers): boolean {
  return tiers.local[plan.table] !== undefined && parseFilterSpec(plan.filter.replace(PLACEHOLDERS, "true")) !== null
}

/** A guest is a real row, so it needs no signing key and no seeded handle.
 * The whole response is the session: the shell stores it as such, and the
 * store reads the user's id off it to scope owned rows. */
type Session = { token: string; user: { id: string; handle: string } }
async function guestSession(base: string): Promise<Session> {
  const r = await fetch(`${base}/auth/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!r.ok) throw new Error(`POST /auth/guest -> ${r.status} ${await r.text()}`)
  return (await r.json()) as Session
}

/**
 * The cluster's /crud as the guest. No token means no cluster runs one: a
 * device-tier app has no crud service behind caddy, so a read that reaches
 * here is a plan the seed cannot answer, and it says so instead of 502-ing.
 */
function crudReader(base: string, token: string | undefined): Reader {
  return async (q) => {
    if (token === undefined) {
      throw new Error(`GET /crud/${q}: shell.yaml says server: false, so no crud service answers it`)
    }
    const r = await fetch(`${base}/crud/${q}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`GET /crud/${q} -> ${r.status} ${await r.text()}`)
    return r.json() as Promise<Row[]>
  }
}

/** PostgREST nests a select the way the filter nests the path, at any depth:
 * `article_tag.tag` selects `article_tag(tag)`, `a.b.name` selects `a(b(name))`. */
export function embedSelect(column: string): string {
  const path = column.split(".")
  const leaf = path.pop() as string
  return path.reduceRight((inner, rel) => `${rel}(${inner})`, leaf)
}

/** One hop of an embed walk: the first row of a to-many relation, or a to-one
 * as it is; an empty relation of either kind is null, and not a row that lacks
 * the key. */
const hop = (c: unknown) => Array.isArray(c) ? (c.length === 0 ? null : c[0]) : c

/** The same path walked back out. Which hops answer with an array is the
 * relation's business and unreadable off the filter, so take the first either
 * way. An EMPTY relation on the way is null — the row has the column and
 * nothing behind it, a hole — where a key the row lacks stays undefined. */
export function embedValue(row: Record<string, unknown>, column: string): unknown {
  let cursor: unknown = row
  for (const step of column.split(".")) {
    cursor = hop(cursor)
    if (cursor === null) return null
    cursor = (cursor as Record<string, unknown> | undefined)?.[step]
  }
  return hop(cursor)
}

/**
 * Words the full-text index will answer, read off the indexed column itself
 * rather than a `title` every table is presumed to have. A tsvector prints as
 * `'lexeme':pos …`, so its lexemes are the words; a plain text column is
 * split into its own words. Either is queried back with the plan's operator.
 */
export function ftsWords(values: unknown[]): string[] {
  const words = values.flatMap((v) => {
    const text = String(v ?? "")
    const lexemes = [...text.matchAll(/'([^']+)':\d/g)].map((m) => m[1])
    return lexemes.length > 0 ? lexemes : text.toLowerCase().split(/[^a-z0-9]+/)
  })
  // Words only, in any script: the `simple` dictionary keeps accents, so a
  // Portuguese index prints `'farmácia':1`, and one such word is a fair probe.
  return [...new Set(words.filter((w) => w.length >= 4 && /^[\p{L}\p{N}]+$/u.test(w)))]
}

/**
 * A value that makes each parametrized route paint, from wherever the app put
 * the entity's rows: the seed for a device table, the running cluster for a
 * server one. `lt`/`gt` cursors take the extreme so the rest of the set
 * remains; full-text search samples a word the index actually matches.
 *
 * A read the API refuses, or answers with a row lacking a column the read
 * selected, raises: the battery's report is only as true as its fixtures, and
 * a hole that was really a broken cluster would be muted as coverage advice.
 * A table with no row carrying a value for the column is a hole, on either
 * tier: nothing was there to match. A seed row that omits the column is such a
 * row, since a seed is an open map and the store reads what it omits as null.
 *
 * Answers per route, because a plan is one: two routes spelling `:id` over
 * different tables want different rows, and a single answer held under the name
 * fills the second route with the first one's value.
 */
export async function resolveParams(
  plans: ParamPlan[],
  tiers: Tiers,
  api: Reader,
): Promise<{ params: Map<string, Record<string, string>>; unresolved: { route: string; param: string }[] }> {
  const params = new Map<string, Record<string, string>>()
  const unresolved: { route: string; param: string }[] = []
  const keep = (plan: ParamPlan, value: string) => {
    const held = params.get(plan.route) ?? {}
    held[plan.param] = value
    params.set(plan.route, held)
  }
  const hole = (plan: ParamPlan) => unresolved.push({ route: plan.route, param: plan.param })
  for (const plan of plans) {
    const table = plan.table
    if (onDevice(plan, tiers)) {
      // The seeded values, and for a cursor the one whose own predicate admits
      // the most other rows: the interpreter's parseFilter orders the rows, so
      // the battery never carries a comparison of its own that could disagree
      // with it. Any read a value answers by itself takes the first.
      const rows = tiers.seed[table] ?? []
      const values = rows
        .map((r) => r[plan.column] as number | string | null | undefined)
        .filter((v): v is number | string => v !== undefined && v !== null)
      if (values.length === 0) { hole(plan); continue }
      const admits = (v: number | string) => {
        const preds = parseFilter(`${plan.column}=${plan.op}.${v}`) as ((row: Row) => boolean)[] | null
        return preds === null ? -1 : rows.filter((r) => preds.every((p) => p(r))).length
      }
      const best = plan.op === "eq" ? values[0] : [...new Set(values)].reduce((a, b) => (admits(b) > admits(a) ? b : a))
      keep(plan, String(best))
      continue
    }
    if (plan.op.startsWith("plfts")) {
      const rows = await api(`${table}?select=${plan.column}&limit=40`)
      const words = ftsWords(rows.map((r) => r[plan.column]))
      let hit: string | undefined
      for (const w of words) {
        const got = await api(`${table}?select=id&${plan.column}=${plan.op}.${encodeURIComponent(w)}&limit=1`)
        if (got.length) { hit = w; break }
      }
      if (hit) keep(plan, hit)
      else hole(plan)
      continue
    }
    const select = embedSelect(plan.column)
    const order = plan.op === "lt" ? `&order=${plan.column}.desc` : plan.op === "gt" ? `&order=${plan.column}.asc` : ""
    const rows = await api(`${table}?select=${select}${order}&limit=1`)
    const row = rows[0]
    if (!row) { hole(plan); continue }
    const raw = embedValue(row, plan.column)
    if (raw === undefined) {
      throw new Error(`/crud/${table} answered a row without ${plan.column}, which ${plan.route} filters on: ${JSON.stringify(row)}`)
    }
    if (raw === null) hole(plan)
    else keep(plan, String(raw))
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
  const shell = shellDoc(await Deno.readTextFile(`${appDir}/shell/shell.yaml`))
  const routes = routesFrom(shell)
  const floors = floorsFrom(shell)
  const tiers = tiersFrom(shell)
  // One guest for the resolver's reads and the browser's session alike,
  // minted only where a cluster runs the auth service that mints it.
  const session = tiers.server ? await guestSession(base) : undefined

  // Keyed by route path, because that is what paramPlans walks. A route whose
  // html is missing reads as empty markup and its params come back unplanned,
  // which is the finding either way.
  const markup: Record<string, string> = {}
  for (const route of routes) {
    if (!route.path.includes("/:") || !route.files?.html) continue
    markup[route.path] = await Deno.readTextFile(`${appDir}/${route.files.html}`).catch(() => "")
  }
  const { plans, unplanned } = paramPlans(routes, markup)
  const { params, unresolved } = await resolveParams(plans, tiers, crudReader(base, session?.token))
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
      // The binding grammar is the renderer's, handed in as the source and
      // flags of the whole-text regex fragment.js exports, since an init
      // script cannot import.
      await (page as { addInitScript?: (fn: (arg: [string, string]) => void, arg: [string, string]) => Promise<void> })
        .addInitScript?.(([source, flags]: [string, string]) => {
        const BRACES = new RegExp(source, flags)
        const leaks = new Set<string>()
        // The brace spellings painted on the page that no `data-verbatim` region
        // accounts for. One scan, installed on the window so the settled read
        // below runs the very same one: a rule the sampler honours and the read
        // does not is a rule an app cannot satisfy. A region that declares its
        // braces is subtracted by COUNT, not by spelling — a leak spelling the
        // same binding elsewhere is one brace more than the declaration
        // encloses, and stays a leak — and only while it is rendered, since an
        // unrendered element's innerText is its textContent, which the body's
        // projection never counted. Outermost regions only, so a nested one is
        // not subtracted twice. An authored attribute arrives with its stamped
        // item and a template's content is not in innerText, so there is no
        // window in which text is painted and its declaration is not yet on it.
        const standing = (text: string): string[] => {
          const count = (s: string) => {
            const c = new Map<string, number>()
            for (const m of s.match(BRACES) ?? []) c.set(m, (c.get(m) ?? 0) + 1)
            return c
          }
          const found = count(text)
          if (found.size > 0) {
            for (const el of document.querySelectorAll<HTMLElement>("[data-verbatim]")) {
              if (el.parentElement?.closest("[data-verbatim]")) continue
              // A `display: contents` region has no box of its own and answers
              // checkVisibility() false while its text is painted; its parent
              // holds the answer.
              const rendered = el.checkVisibility() ||
                (getComputedStyle(el).display === "contents" && (el.parentElement?.checkVisibility() ?? false))
              if (!rendered) continue
              for (const [m, n] of count(el.innerText ?? "")) found.set(m, (found.get(m) ?? 0) - n)
            }
          }
          return [...found].filter(([, n]) => n > 0).map(([m]) => m)
        }
        const w = window as unknown as { __placeholderLeaks: Set<string>; __standingBraces: () => string[] }
        w.__placeholderLeaks = leaks
        w.__standingBraces = () => standing(document.body?.innerText ?? "")
        const tick = () => {
          const t = document.body?.innerText
          if (t !== undefined && t !== "") {
            for (const m of standing(t)) leaks.add(m)
          }
          if (leaks.size < 20) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }, [PLACEHOLDERS.source, PLACEHOLDERS.flags])
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
          checkClippedContent(p),
          checkFocusableInvisible(p),
          checkConstrainedImages(p),
          checkViewportBounds(p),
          checkTouchTargets(p, { minSize: floors.touch }),
          checkFocusOrder(p),
          checkCLS(p),
        ])
      ).flat()
      bugs.push(...analyzeConsole(console_, { ignore: IGNORE }))
      // The sampler above and this settled read are one scan over one projection,
      // taken at two times: it catches braces painted during hydration, this
      // catches braces still standing. Neither can tell a leak from an app that
      // renders braces ON PURPOSE, and one does — a screen quoting a vendor's
      // token-naming convention spells a binding without being one — so
      // `data-verbatim` subtracts what it encloses from both, through the one
      // scan the init script installed on the window.
      const leaked = (await page.evaluate(() => {
        const w = window as unknown as { __placeholderLeaks?: Set<string>; __standingBraces?: () => string[] }
        return [...new Set([...(w.__placeholderLeaks ?? []), ...(w.__standingBraces?.() ?? [])])]
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
          // The shell reads its session only behind `auth.required`, which a
          // device-tier app never declares, so it is written only where minted.
          if (session !== undefined) {
            await context.addInitScript((s) => sessionStorage.setItem("pronto-token", JSON.stringify(s)), session)
          }
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
  // The floors ride the same file. Pinned here because the number is one
  // declaration shared with #scale's --min-* rungs, and a battery that fell back to its own constant would let the two drift apart.
  const floors = floorsFrom("floors:\n  touch: 24\n" + yaml)
  if (floors.touch !== 24) throw new Error(`floors.touch: got ${floors.touch}, want 24`)
  let raised = ""
  try {
    floorsFrom(yaml)
  } catch (e) {
    raised = (e as Error).message
  }
  if (raised !== "no floors.touch in shell.yaml; run plugins/pronto/write.ts") {
    throw new Error(`a shell.yaml with no floors must raise, got ${JSON.stringify(raised)}`)
  }
  const { plans, unplanned } = paramPlans(routes, markup)
  const by = Object.fromEntries(plans.map((p) => [p.route, p]))
  const eq = (got: unknown, want: unknown, what: string) => {
    const g = JSON.stringify(got), w = JSON.stringify(want)
    if (g !== w) throw new Error(`${what}: got ${g}, want ${w}`)
  }
  eq(routes.length, 8, "route count")
  // A plan carries its region's whole filter; a case whose region says more
  // than the one clause spells it.
  const plan = (route: string, rest: Record<string, string>) => ({
    route,
    ...rest,
    filter: rest.filter ?? `${rest.column}=${rest.op}.{param.${rest.param}}`,
  })
  eq(by["/article/:slug"], plan("/article/:slug", { param: "slug", table: "article", column: "slug", op: "eq" }), "slug plan")
  eq(
    by["/tag/:name"],
    plan("/tag/:name", { param: "name", table: "article", column: "article_tag.tag", op: "eq", filter: "article_tag.tag=eq.{param.name}&limit=20" }),
    "embedded column plan",
  )
  eq(
    by["/older/:when"],
    plan("/older/:when", { param: "when", table: "article_stats", column: "created_at", op: "lt", filter: "created_at=lt.{param.when}&limit=20" }),
    "cursor plan",
  )
  eq(
    by["/search/:q"],
    plan("/search/:q", { param: "q", table: "article", column: "search", op: "plfts(simple)", filter: "search=plfts(simple).{param.q}&limit=20" }),
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
  const [arg] = Deno.args
  if (arg === "--self-test") {
    selfTest()
    Deno.exit(0)
  }
  if (arg === undefined) {
    console.error("usage: check-visual.ts <app dir> | --self-test")
    Deno.exit(1)
  }
  Deno.exit(await main(arg))
}
