/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

export async function checkInteractiveOverlap(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []
    const interactives = document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [tabindex="0"]')

    for (const el of interactives) {
      const htmlEl = el as HTMLElement
      // Computed style is not enough to know whether a reader can see this.
      // Content inside a collapsed <details> keeps display:block, visibility
      // visible, opacity 1 and a non-zero box, so every hand-rolled test
      // passes while nothing is on screen — and elementFromPoint then reports
      // whatever genuinely occupies that space as an obscuring blocker.
      if (!htmlEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (htmlEl.offsetWidth === 0 || htmlEl.offsetHeight === 0) continue

      const rect = htmlEl.getBoundingClientRect()
      if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue

      const insetX = rect.width * 0.25
      const insetY = rect.height * 0.25
      const hitPoints = [
        { label: "center", px: rect.left + rect.width / 2, py: rect.top + rect.height / 2 },
        { label: "top-center", px: rect.left + rect.width / 2, py: rect.top + insetY },
        { label: "bottom-center", px: rect.left + rect.width / 2, py: rect.bottom - insetY },
        { label: "left-center", px: rect.left + insetX, py: rect.top + rect.height / 2 },
        { label: "right-center", px: rect.right - insetX, py: rect.top + rect.height / 2 },
      ]

      for (const { label: pointLabel, px, py } of hitPoints) {
        if (px < 0 || px >= window.innerWidth || py < 0 || py >= window.innerHeight) continue
        const x = Math.max(0, Math.min(px, window.innerWidth - 1))
        const y = Math.max(0, Math.min(py, window.innerHeight - 1))
        const topElement = document.elementFromPoint(x, y)

        if (topElement && !htmlEl.contains(topElement) && !topElement.contains(htmlEl)) {
          const id = htmlEl.getAttribute("data-testid") || htmlEl.getAttribute("aria-label") || htmlEl.textContent?.trim().slice(0, 30) || htmlEl.tagName.toLowerCase()
          const blockerId = (topElement as HTMLElement).getAttribute("data-testid") || (topElement as HTMLElement).className?.toString().slice(0, 40) || topElement.tagName.toLowerCase()
          bugs.push({ rule: "no-interactive-overlap", description: `"${id}" is obscured by "${blockerId}" at ${pointLabel} (${Math.round(x)}, ${Math.round(y)})`, severity: "critical", element: id })
          break
        }
      }
    }
    return bugs
  })
}
