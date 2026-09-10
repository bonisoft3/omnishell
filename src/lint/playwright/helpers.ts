/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Locator } from "@playwright/test"
import { assertAtMost, assertIs, assertTruthy } from "./assert"

export async function assertNotObscured(locator: Locator, label?: string) {
  const page = locator.page()
  const box = await locator.boundingBox()
  assertTruthy(box, `${label || "element"} should be visible`)
  const center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
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
