/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * Alignment drift catches near-miss keyline misalignments (1px to 3px) between
 * sibling or vertically neighboring block elements. An intentional layout
 * offset is typically >= 8px (a token step); 1px-3px offsets are almost
 * always accidental margins, borders, or unaligned wrappers that introduce
 * visible jitter down a reading column.
 */
export async function checkAlignmentDrift(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: VisualBug[] = []
    const targets = Array.from(
      document.querySelectorAll('button, input, select, textarea, [role="button"], .card, header, nav, li, a.grow'),
    ) as HTMLElement[]

    type Box = { id: string; x: number; y: number; w: number; h: number }
    const items: Box[] = []

    for (const el of targets) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (el.offsetWidth < 20 || el.offsetHeight < 10) continue
      if (el.closest("[inert]")) continue

      const r = el.getBoundingClientRect()
      if (r.bottom < 0 || r.top > window.innerHeight) continue

      const id = el.getAttribute("aria-label") || el.className?.toString().trim().slice(0, 30) || el.tagName.toLowerCase()
      items.push({
        id,
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      })
    }

    const reportedPairs = new Set<string>()

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]
        const b = items[j]
        const dx = Math.abs(a.x - b.x)
        const dy = Math.abs(a.y - b.y)

        // Only compare elements in proximity down the vertical column (dy < 250px)
        if (dx >= 1 && dx <= 3 && dy > 0 && dy < 250) {
          const key = a.x < b.x ? `${a.x}:${b.x}` : `${b.x}:${a.x}`
          if (reportedPairs.has(key)) continue
          reportedPairs.add(key)

          bugs.push({
            rule: "alignment-drift",
            description: `"${a.id}" (x=${a.x}px) and "${b.id}" (x=${b.x}px) drift by ${dx}px on the vertical column`,
            severity: "major",
            element: a.id,
          })
        }
      }
    }

    return bugs
  })
}
