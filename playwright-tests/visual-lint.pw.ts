// The battery's own regression guard: a deliberately bad fixture must keep
// firing every rule, and a good one must stay silent. Every relaxation to a
// check is answerable here — the constrained-image rule's fixture is
// `width: 100%; height: 200px`, so "the image sets both dimensions" is not a
// safe reason to call a box constrained.
import { describe, expect, it, withPage, asCheckPage } from "./harness.ts"
import { assertVisualLint, visualLint } from "../src/lint/playwright/visual-lint.ts"
import { checkClippedControls } from "../src/lint/playwright/checks/clipped-controls.ts"
import { checkContrast } from "../src/lint/playwright/checks/contrast.ts"
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

const CLIPPED = `${fixtures}contrast-clipping.html`

describe("checkClippedControls", () => {
  it("reports only a control nothing can bring back", () =>
    withPage(async (page) => {
      await page.goto(CLIPPED)
      const bugs = await checkClippedControls(asCheckPage(page))
      // The silent ones pin the rule's edges: a control inside a hidden box's
      // scrollable overflow, or cut in part, is not decided; a scroll container
      // holds its content a scroll away, even inside a board; a static box is
      // not the containing block of an absolute inside it, nor of an absolute
      // wrapper inside it; an inline box clips nothing; the screen-reader idiom
      // is not on the screen by design.
      expect(Object.fromEntries(bugs.map((b) => [b.element, b.severity]))).toEqual({
        "above the board": "critical",
        "behind the wall": "critical",
      })
    }))
})

describe("checkContrast", () => {
  it("holds every decidable pair to the floor, in each appearance", () =>
    withPage(async (page) => {
      await page.goto(CLIPPED)
      const bugs = await checkContrast(asCheckPage(page))
      // `veiled text` sits under a translucent layer, composited to the flat
      // colour it makes; `mixed text` is a colour the browser computes in
      // oklch; `twin text` fails in dark alone, and says so; `eased text` is
      // read once the transition the flip starts has ended, where it passes;
      // `outlined text` is read by its stroke, which passes on both grounds.
      expect([...new Set(bugs.map((b) => b.element?.split(",")[0]))].sort()).toEqual(
        ["dim text", "ghost text", "invisible text", "mixed text", "near text", "twin text", "veiled text"],
      )
      const twin = bugs.filter((b) => b.element?.startsWith("twin text"))
      expect(twin.map((b) => b.description.endsWith("(dark)"))).toEqual([true])
      expect(bugs.every((b) => b.severity === "critical")).toBe(true)
    }))

  it("skips a backdrop it cannot decide", () =>
    withPage(async (page) => {
      await page.goto(CLIPPED)
      await page.evaluate(() => {
        (document.querySelector("#ok") as HTMLElement).style.backgroundImage =
          "linear-gradient(#2b2b2b, #2b2b2b)"
      })
      const bugs = await checkContrast(asCheckPage(page))
      expect(bugs.filter((b) => b.element?.startsWith("ok text"))).toEqual([])
    }))

  it("reads only the dialog while one is modal", () =>
    withPage(async (page) => {
      await page.goto(CLIPPED)
      await page.evaluate(() => (document.querySelector("#modal") as HTMLDialogElement).showModal())
      expect(await checkContrast(asCheckPage(page))).toEqual([])
    }))

  it("leaves the page where it found it", () =>
    withPage(async (page) => {
      await page.goto(CLIPPED)
      await page.evaluate(() => {
        document.body.style.minHeight = "300vh"
        scrollTo(0, 40)
      })
      const state = () => page.evaluate(() => [scrollY, matchMedia("(prefers-color-scheme: dark)").matches])
      const before = await state()
      await checkContrast(asCheckPage(page))
      expect(await state()).toEqual(before)
      expect(before[0]).toBe(40)
    }))
})
