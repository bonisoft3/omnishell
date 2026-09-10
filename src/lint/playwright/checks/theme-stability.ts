/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * Toggle the dark class on <html>, measure if any visible elements
 * change position or size. Theme switching should only change colors,
 * not layout.
 */
/** Waits for the transitions the toggle started, and nothing longer.
 *
 * A theme change is a repaint, not a mutation, so a MutationObserver sees
 * nothing to settle on and a constant is the only alternative — sized for the
 * slowest screen and paid by every one. `getAnimations()` is the exact answer:
 * the transitions the class change started are objects with a `finished`
 * promise on them.
 *
 * The infinite ones are dropped rather than awaited. A skeleton's pulse never
 * finishes, and a battery that waited for it would hang on every screen that
 * has one. The cap is the backstop for a transition that outlives its own
 * point.
 */
async function settled(page: Page, capMs = 500): Promise<void> {
  await page.evaluate(async (cap: number) => {
    const running = document.getAnimations().filter((a) => {
      const t = a.effect?.getTiming()
      return t !== undefined && t.iterations !== Infinity
    })
    await Promise.race([
      Promise.all(running.map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, cap)),
    ])
  }, capMs)
}

export async function checkThemeStability(page: Page): Promise<VisualBug[]> {
  const bugs: VisualBug[] = []

  // Capture positions before toggle
  const before = await captureElementPositions(page)

  // Toggle dark mode
  await page.evaluate(() => {
    document.documentElement.classList.toggle("dark")
  })
  await settled(page)

  // Capture positions after toggle
  const after = await captureElementPositions(page)

  // Toggle back
  await page.evaluate(() => {
    document.documentElement.classList.toggle("dark")
  })

  // Compare
  const TOLERANCE = 2 // px
  for (const [id, beforePos] of Object.entries(before)) {
    const afterPos = after[id]
    if (!afterPos) continue

    const widthDiff = Math.abs(afterPos.width - beforePos.width)
    const heightDiff = Math.abs(afterPos.height - beforePos.height)
    const topDiff = Math.abs(afterPos.top - beforePos.top)
    const leftDiff = Math.abs(afterPos.left - beforePos.left)

    if (widthDiff > TOLERANCE || heightDiff > TOLERANCE || topDiff > TOLERANCE || leftDiff > TOLERANCE) {
      bugs.push({
        rule: "theme-switch-stability",
        description: `"${id}" moved/resized on theme toggle: Δwidth=${widthDiff.toFixed(0)}px, Δheight=${heightDiff.toFixed(0)}px, Δtop=${topDiff.toFixed(0)}px, Δleft=${leftDiff.toFixed(0)}px`,
        severity: "major",
        element: id,
      })
    }
  }

  return bugs
}

async function captureElementPositions(
  page: Page
): Promise<Record<string, { width: number; height: number; top: number; left: number }>> {
  return page.evaluate(() => {
    const positions: Record<string, { width: number; height: number; top: number; left: number }> = {}
    const elements = document.querySelectorAll("h1, h2, h3, p, button, a, nav, aside, main, [data-testid]")

    for (const el of elements) {
      const htmlEl = el as HTMLElement
      const style = getComputedStyle(htmlEl)
      if (style.display === "none" || style.visibility === "hidden") continue

      const rect = htmlEl.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue

      const id =
        htmlEl.getAttribute("data-testid") ||
        htmlEl.getAttribute("aria-label") ||
        htmlEl.textContent?.trim().slice(0, 30) ||
        `${htmlEl.tagName}-${Array.from(htmlEl.parentElement?.children || []).indexOf(htmlEl)}`
      positions[id] = { width: rect.width, height: rect.height, top: rect.top, left: rect.left }
    }

    return positions
  })
}
