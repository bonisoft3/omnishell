// The battery's own regression guard: a deliberately bad fixture must keep
// firing every rule, and a good one must stay silent. Every relaxation to a
// check is answerable here — the constrained-image rule's fixture is
// `width: 100%; height: 200px`, so "the image sets both dimensions" is not a
// safe reason to call a box constrained.
import { describe, expect, it, withPage, asCheckPage } from "./harness.ts"
import { assertVisualLint, visualLint } from "../src/lint/playwright/visual-lint.ts"
import { checkFocusOrder } from "../src/lint/playwright/checks/focus-order.ts"
import { checkThemeStability } from "../src/lint/playwright/checks/theme-stability.ts"

const fixtures = new URL("../test/lint/fixtures/", import.meta.url).href
const BAD = `${fixtures}bad-page.html`
const GOOD = `${fixtures}good-page.html`

describe("visualLint - good page", () => {
  it("passes with no bugs", () =>
    withPage(async (page) => {
      await page.goto(GOOD)
      const result = await visualLint(asCheckPage(page))
      expect(result.passed).toBe(true)
      expect(result.bugs).toHaveLength(0)
    }))
})

describe("visualLint - bad page", () => {
  it("detects horizontal overflow", () =>
    withPage(async (page) => {
      await page.goto(BAD)
      const result = await visualLint(asCheckPage(page))
      expect(result.passed).toBe(false)
      expect(result.bugs.filter((b) => b.rule === "no-horizontal-overflow").length).toBeGreaterThan(0)
    }))

  it("detects unconstrained object-cover images", () =>
    withPage(async (page) => {
      await page.goto(BAD)
      const result = await visualLint(asCheckPage(page))
      expect(result.bugs.filter((b) => b.rule === "unconstrained-object-cover").length).toBeGreaterThan(0)
    }))

  it("detects constrained image missing aspect-ratio", () =>
    withPage(async (page) => {
      await page.goto(BAD)
      const result = await visualLint(asCheckPage(page))
      expect(result.bugs.filter((b) => b.rule === "constrained-image-ratio").length).toBeGreaterThan(0)
    }))

  it("detects small touch targets at mobile viewport", () =>
    withPage(
      async (page) => {
        await page.goto(BAD)
        const result = await visualLint(asCheckPage(page))
        expect(result.bugs.filter((b) => b.rule === "touch-target-size").length).toBeGreaterThan(0)
      },
      { viewport: { width: 375, height: 812 } },
    ))
})

describe("assertVisualLint", () => {
  it("throws on bad page", () =>
    withPage(async (page) => {
      await page.goto(BAD)
      let threw = false
      try {
        await assertVisualLint(asCheckPage(page))
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
    }))

  it("passes on good page", () =>
    withPage(async (page) => {
      await page.goto(GOOD)
      await assertVisualLint(asCheckPage(page))
    }))
})

describe("checkFocusOrder", () => {
  it("runs on good page without throwing", () =>
    withPage(async (page) => {
      await page.goto(GOOD)
      expect(Array.isArray(await checkFocusOrder(asCheckPage(page)))).toBe(true)
    }))

  // Fixed containers are independent focus sequences: a bottom-anchored rail
  // button before top-of-page flow content is fine, and a focusable that is
  // itself fixed is its own sequence — while out-of-order pairs WITHIN one
  // sequence must still be flagged.
  it("groups focus sequences per fixed container", () =>
    withPage(async (page) => {
      await page.goto(`${fixtures}focus-order.html`)
      const bugs = await checkFocusOrder(asCheckPage(page))
      expect(bugs.map((b) => b.element).sort()).toEqual(["flow-upper", "rail-upper"])
    }))
})

describe("checkThemeStability", () => {
  it("runs on good page without throwing", () =>
    withPage(async (page) => {
      await page.goto(GOOD)
      expect(Array.isArray(await checkThemeStability(asCheckPage(page)))).toBe(true)
    }))
})
