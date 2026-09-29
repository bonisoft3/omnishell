/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * Catches interactive controls whose height breaks the 4px baseline grid.
 * Heights like 41px, 43px, or 47px indicate non-tokenized padding, ad-hoc
 * line-heights, or uncalculated borders.
 */
export async function checkGridBaseline(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: VisualBug[] = []
    const targets = Array.from(
      document.querySelectorAll('button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]'),
    ) as HTMLElement[]

    for (const el of targets) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (el.offsetWidth === 0 || el.offsetHeight === 0) continue
      if (el.closest("[inert]")) continue
      if (el.getAttribute("aria-hidden") === "true" || el.closest('[aria-hidden="true"]')) continue

      // Ignore inline elements whose height is driven purely by wrapped inline text
      const style = getComputedStyle(el)
      if (style.display === "inline") continue

      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) continue

      const h = el.offsetHeight
      if (h > 4 && h % 4 !== 0) {
        const id = el.getAttribute("aria-label") || el.getAttribute("data-testid") || el.textContent?.trim().slice(0, 20) || el.tagName.toLowerCase()
        bugs.push({
          rule: "grid-baseline",
          description: `"${id}" height (${h}px) is not a multiple of the 4px baseline grid`,
          severity: "minor",
          element: id,
        })
      }
    }

    return bugs
  })
}
