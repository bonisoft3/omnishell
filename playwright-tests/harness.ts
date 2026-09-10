// The browser-test harness, so no spec names a runtime.
//
// Playwright drives the browser here directly rather than through
// @playwright/test: the runner is deno's, and the checks under
// src/lint/playwright/ type their page as @playwright/test's `Page` while
// being the same object at runtime.
//
// ONE BROWSER PER BLOCK, and a fresh context per page. The context is the
// isolation boundary — storage, cookies and `window` are per-context, measured
// rather than assumed — so a browser held across the tests of one block
// isolates exactly what a browser held across one test did. What it does not
// isolate is the browser process, which nothing here tests.
//
// THE SANITISER STAYS ON, and the shape of bdd is why it can. A `describe` is
// one Deno.test whose steps are its tests, so a browser the first step opens
// and `afterAll` closes never outlives the test that owns it — the check is
// satisfied by construction rather than waived. A leaked browser is therefore
// a red run and not a hung one, which is the opposite of what sharing was once
// expected to cost.
//
// The teardown is this file's rather than each spec's, so no spec can forget.
// `describe` closes the browser its block opened; a test declared OUTSIDE a
// block closes its own, because there is no block to close it and the
// sanitiser fails it if nothing does — harness-teardown.pw.ts is that path
// under test, and removing the fallback turns it red.
//
// What the sharing is worth, measured on this suite: six trivial tests take
// 0.96s against 1.52s, and the whole browser suite 16.2s against 17.1s. It
// removes a fixed cost per test; it does not transform the tier.
import { type Browser, chromium, type Page } from "npm:playwright@1.59.1"
import { afterAll as bddAfterAll, describe as bddDescribe, it as bddIt } from "jsr:@std/testing@1/bdd"

export { afterAll, afterEach, beforeAll, beforeEach } from "jsr:@std/testing@1/bdd"
export { expect } from "jsr:@std/expect@1"
export type { Page }

export type PageOptions = { viewport?: { width: number; height: number } }

let shared: Browser | null = null

/** Launched on the first page that wants one, so a block that opens none pays
 * nothing. */
async function browser(): Promise<Browser> {
  if (shared === null) shared = await chromium.launch()
  return shared
}

/** Idempotent: a block that never opened a page closes nothing. */
export async function closeBrowser(): Promise<void> {
  const b = shared
  shared = null
  await b?.close()
}

// Set while a `describe` callback is collecting, so each test records at
// declaration time whether a block will close the browser for it.
let collecting = false

/** A block of browser tests. The browser they share is closed when the block
 * is, whether its tests passed or threw. */
export function describe(name: string, fn: () => void): void {
  bddDescribe({
    name,
    fn() {
      const outer = collecting
      collecting = true
      // Registered even if collecting the block throws: a spec that fails to
      // declare its tests still has to give the browser back.
      try {
        fn()
      } finally {
        collecting = outer
        bddAfterAll(closeBrowser)
      }
    },
  })
}

// deno-lint-ignore no-explicit-any
type TestFn = (...args: any[]) => unknown | Promise<unknown>

/** One browser test. Outside a `describe` it closes the browser after itself:
 * no block will, and the sanitiser fails the test if nothing does. */
export function it(name: string, fn: TestFn): void {
  const inBlock = collecting
  bddIt({
    name,
    // deno-lint-ignore no-explicit-any
    async fn(...args: any[]) {
      try {
        await fn(...args)
      } finally {
        if (!inBlock) await closeBrowser()
      }
    },
  })
}

export { it as test }

/** Run `body` against a fresh page, tearing the CONTEXT down either way. */
export async function withPage<T>(
  body: (page: Page) => Promise<T>,
  opts: PageOptions = {},
): Promise<T> {
  const context = await (await browser()).newContext(opts)
  try {
    return await body(await context.newPage())
  } finally {
    await context.close()
  }
}

/** The checks take @playwright/test's Page; this is the same object. */
// deno-lint-ignore no-explicit-any
export const asCheckPage = (page: Page): any => page
