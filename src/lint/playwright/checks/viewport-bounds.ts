/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

export async function checkViewportBounds(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []
    const THRESHOLD = 10
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const elements = document.querySelectorAll('button, a[href], input, [role="button"], [data-testid], nav')

    for (const el of elements) {
      const htmlEl = el as HTMLElement
      if (!htmlEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      const rect = htmlEl.getBoundingClientRect()
      if (rect.top > viewportH * 2 || rect.left > viewportW * 2) continue
      if (rect.width < 5 || rect.height < 5) continue

      if (rect.right > viewportW + THRESHOLD && rect.left < viewportW) {
        const id = htmlEl.getAttribute("data-testid") || htmlEl.textContent?.trim().slice(0, 20) || htmlEl.tagName.toLowerCase()
        bugs.push({ rule: "viewport-bounds", description: `"${id}" overflows right edge by ${Math.round(rect.right - viewportW)}px`, severity: "minor", element: id })
      }
    }
    return bugs
  })
}
