/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * WCAG target-size minimums are two: 2.5.5 (AAA) asks 44px, 2.5.8 (AA) asks
 * 24px. 44 is the default here, but a content surface whose links are sized by
 * their line box reports every title and byline against it — so a caller
 * gating a whole app rather than a control panel passes `minSize: 24`.
 */
export async function checkTouchTargets(
  page: Page,
  opts: { minSize?: number } = {},
): Promise<VisualBug[]> {
  return page.evaluate((MIN_SIZE) => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []
    if (window.innerWidth > 768) return bugs

    const interactives = document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [tabindex="0"]')

    for (const el of interactives) {
      const htmlEl = el as HTMLElement
      if (!htmlEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (htmlEl.offsetWidth === 0 || htmlEl.offsetHeight === 0) continue
      const rect = htmlEl.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue

      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        const id = htmlEl.getAttribute("data-testid") || htmlEl.getAttribute("aria-label") || htmlEl.textContent?.trim().slice(0, 20) || htmlEl.tagName.toLowerCase()
        bugs.push({ rule: "touch-target-size", description: `"${id}" is ${Math.round(rect.width)}x${Math.round(rect.height)}px, minimum is ${MIN_SIZE}x${MIN_SIZE}px`, severity: "major", element: id })
      }
    }
    return bugs
  }, opts.minSize ?? 44)
}
