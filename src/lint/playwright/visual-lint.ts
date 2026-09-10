/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page, Locator } from "@playwright/test"
import { assertAtMost, assertIs, assertTruthy } from "./assert"
import type { VisualLintResult } from "./types"
import { checkInteractiveOverlap } from "./checks/interactive-overlap"
import { checkHorizontalOverflow } from "./checks/horizontal-overflow"
import { checkConstrainedImages } from "./checks/constrained-images"
import { checkViewportBounds } from "./checks/viewport-bounds"
import { checkTouchTargets } from "./checks/touch-targets"
import { checkFocusOrder } from "./checks/focus-order"
import { checkThemeStability } from "./checks/theme-stability"
import type { ConsoleCapture } from "./checks/console-messages"
import { analyzeConsole } from "./checks/console-messages"

export type { VisualBug, VisualLintResult } from "./types"
export { armCLS, checkCLS } from "./checks/cls"
export {
  captureConsole,
  analyzeConsole,
  checkConsoleMessages,
  type ConsoleCapture,
} from "./checks/console-messages"

export async function visualLint(
  page: Page,
  consoleCapture?: ConsoleCapture,
): Promise<VisualLintResult> {
  const results = await Promise.all([
    checkInteractiveOverlap(page),
    checkHorizontalOverflow(page),
    checkConstrainedImages(page),
    checkViewportBounds(page),
    checkTouchTargets(page),
    checkFocusOrder(page),
    checkThemeStability(page),
    // CLS is not in this battery: it is the one check that has to be armed
    // before its own navigation, which this entry point does not own. A caller
    // that wants it runs armCLS(page) before goto and checkCLS(page) after.
  ])
  const bugs = results.flat()
  if (consoleCapture) {
    bugs.push(...analyzeConsole(consoleCapture))
  }
  return { passed: bugs.length === 0, bugs }
}

export async function assertVisualLint(page: Page) {
  const result = await visualLint(page)
  if (!result.passed) {
    const summary = result.bugs
      .map((b) => `[${b.severity}] ${b.rule}: ${b.description}`)
      .join("\n")
    assertIs(result.passed, true, `Visual lint failed:\n${summary}`)
  }
}

export async function assertNotObscured(locator: Locator, label?: string) {
  const page = locator.page()
  const box = await locator.boundingBox()
  assertTruthy(box, `${label || "element"} should be visible`)

  const center = {
    x: box!.x + box!.width / 2,
    y: box!.y + box!.height / 2,
  }

  const isClickable = await locator.evaluate(
    (el, { x, y }) => {
      const top = document.elementFromPoint(x, y)
      return top !== null && (el.contains(top) || top.contains(el))
    },
    { x: center.x, y: center.y },
  )

  assertIs(isClickable, true, `${label || "element"} is obscured at center (${Math.round(center.x)}, ${Math.round(center.y)})`)
}

export async function assertDimensionStability(
  locator: Locator,
  trigger: () => Promise<void>,
  opts: { tolerance?: number; waitMs?: number } = {},
) {
  const { tolerance = 2, waitMs = 500 } = opts

  const before = await locator.boundingBox()
  assertTruthy(before, "element should be visible before trigger")

  await trigger()
  await locator.page().waitForTimeout(waitMs)

  const after = await locator.boundingBox()
  assertTruthy(after, "element should be visible after trigger")

  assertAtMost(Math.abs(after!.width - before!.width), tolerance, `Width changed from ${before!.width} to ${after!.width}`)

  assertAtMost(Math.abs(after!.height - before!.height), tolerance, `Height changed from ${before!.height} to ${after!.height}`)
}

export { assertVisionReview, assertFeatureParity } from "./vision-review"
