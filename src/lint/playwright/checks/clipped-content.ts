/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * Content a box is hiding, measured rather than inferred.
 *
 * `no-horizontal-overflow` asks whether the document is wider than the
 * viewport, and the cheapest way to satisfy it is `overflow: hidden` — which
 * makes the document narrow by making its content unreachable, so the metric
 * moves the opposite way from its own intent. This asks the question that
 * survives that fix: is there content inside a clipping box that the box does
 * not show and offers no way to reach?
 *
 * A clip with `text-overflow: ellipsis` is truncation an author chose and a
 * reader can see; a clip that scrolls is reachable; a zero-sized box is the
 * screen-reader idiom, where invisibility is the point. What is left is content
 * that is simply gone.
 */
export async function checkClippedContent(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue
      const cs = getComputedStyle(el)
      if (cs.overflowX !== "hidden" && cs.overflowY !== "hidden") continue
      if (cs.textOverflow === "ellipsis") continue
      if (cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== "none") continue
      // The screen-reader idiom and anything else the reader was never shown.
      if (el.clientWidth <= 1 || el.clientHeight <= 1) continue
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      const overX = cs.overflowX === "hidden" && el.scrollWidth > el.clientWidth + 1
      const overY = cs.overflowY === "hidden" && el.scrollHeight > el.clientHeight + 1
      if (!overX && !overY) continue
      const id = el.getAttribute("data-testid") || el.className.toString().trim().split(/\s+/)[0] ||
        el.tagName.toLowerCase()
      const lost = overX
        ? `${el.scrollWidth - el.clientWidth}px of width`
        : `${el.scrollHeight - el.clientHeight}px of height`
      bugs.push({
        rule: "clipped-content",
        description: `"${id}" hides ${lost} with no ellipsis and no way to scroll to it`,
        severity: "major",
        element: id,
      })
    }
    return bugs
  })
}
