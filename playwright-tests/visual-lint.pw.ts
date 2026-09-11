// The battery's own regression guard: a deliberately bad fixture must keep
// firing every rule, and a good one must stay silent. Every relaxation to a
// check is answerable here — the constrained-image rule's fixture is
// `width: 100%; height: 200px`, so "the image sets both dimensions" is not a
// safe reason to call a box constrained.
import { describe, expect, it, withPage, asCheckPage } from "./harness.ts"
import { assertVisualLint, visualLint } from "../src/lint/playwright/visual-lint.ts"
import { checkFocusOrder } from "../src/lint/playwright/checks/focus-order.ts"
import { checkInteractiveOverlap } from "../src/lint/playwright/checks/interactive-overlap.ts"
import { checkThemeStability } from "../src/lint/playwright/checks/theme-stability.ts"
import { checkTouchTargets } from "../src/lint/playwright/checks/touch-targets.ts"

const fixtures = new URL("../test/lint/fixtures/", import.meta.url).href
const BAD = `${fixtures}bad-page.html`
const GOOD = `${fixtures}good-page.html`
const HIDDEN = `${fixtures}hidden-controls.html`

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

  // Tab skips a negative tabIndex and anything inert; an aria-hidden control
  // with neither is still a stop.
  it("leaves unreachable controls out of the sequence", () =>
    withPage(async (page) => {
      await page.goto(HIDDEN)
      const bugs = await checkFocusOrder(asCheckPage(page))
      expect(bugs.map((b) => b.element)).toEqual(["aria-hidden-ancestor", "reachable-covered"])
    }))
})

// A pointer reaches no control that is clipped to nothing or inert; an
// aria-hidden control with neither is still a target.
describe("hidden controls", () => {
  it("are not touch targets", () =>
    withPage(
      async (page) => {
        await page.goto(HIDDEN)
        const bugs = await checkTouchTargets(asCheckPage(page))
        expect(bugs.map((b) => b.element)).toEqual(["reachable-small", "visible-aria-hidden"])
      },
      { viewport: { width: 375, height: 812 } },
    ))

  it("are not obscured", () =>
    withPage(
      async (page) => {
        await page.goto(HIDDEN)
        const bugs = await checkInteractiveOverlap(asCheckPage(page))
        expect(bugs.map((b) => b.element)).toEqual(["reachable-covered"])
      },
      { viewport: { width: 375, height: 812 } },
    ))
})

describe("checkThemeStability", () => {
  it("runs on good page without throwing", () =>
    withPage(async (page) => {
      await page.goto(GOOD)
      expect(Array.isArray(await checkThemeStability(asCheckPage(page)))).toBe(true)
    }))
})

// The two cheapest ways to turn this battery green while leaving the page
// worse. The first assertion in each case records WHICH rule stays silent:
// that silence is the blind spot the second rule answers, not a defect to fix
// in the first.
describe("visualLint - the cheapest fix", () => {
  const CHEAP = `${fixtures}cheapest-fix.html`

  it("catches content a box hides, which the document's own width cannot see", () =>
    withPage(async (page) => {
      await page.goto(CHEAP)
      const bugs = (await visualLint(asCheckPage(page))).bugs
      // `overflow-x: hidden` on the document is what makes this rule quiet: the
      // metric moves the right way and the intent moves the wrong way.
      expect(bugs.filter((b) => b.rule === "no-horizontal-overflow")).toHaveLength(0)
      expect(bugs.filter((b) => b.rule === "clipped-content").length).toBeGreaterThan(0)
    }))

  it("catches a control that dodges three rules by becoming invisible", () =>
    withPage(async (page) => {
      await page.goto(CHEAP)
      const bugs = (await visualLint(asCheckPage(page))).bugs
      // Out of bounds, under the target floor, and over its neighbour — all
      // three skip what `checkVisibility` calls invisible, and `opacity: 0`
      // leaves the control in the tab order.
      const dodged = ["viewport-bounds", "touch-target-size", "interactive-overlap"]
      expect(bugs.filter((b) => dodged.includes(b.rule))).toHaveLength(0)
      expect(bugs.filter((b) => b.rule === "focusable-but-invisible").length).toBeGreaterThan(0)
    }))
})
