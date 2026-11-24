/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/** Flags a rendered `body > nav` that occupies space on screen while carrying
 * no visible brand label, interactive control, media, or SVG — e.g. when a
 * screen stylesheet hides `.shell-me` without suppressing `<nav>` itself. */
export async function checkEmptyStrip(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const nav = document.querySelector("body > nav") as HTMLElement | null
    if (!nav) return []
    const visibleOpts = { checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true } as const
    if (!nav.checkVisibility(visibleOpts)) return []
    const navRect = nav.getBoundingClientRect()
    if (navRect.width <= 1 || navRect.height <= 1) return []

    for (const el of nav.querySelectorAll("*")) {
      const node = el as HTMLElement | SVGElement
      if (!node.checkVisibility(visibleOpts)) continue
      const r = node.getBoundingClientRect()
      if (r.width <= 1 || r.height <= 1) continue
      if (node instanceof SVGElement || node.matches("a, button, input, select, img, canvas")) return []
      for (const child of node.childNodes) {
        if (child.nodeType === 3 && (child.nodeValue ?? "").trim().length > 0) return []
      }
    }

    return [{
      rule: "empty-strip",
      severity: "critical",
      element: "body > nav",
      description: `body > nav rendered ${Math.round(navRect.width)}x${Math.round(navRect.height)}px with no visible brand, link, or control`,
    }]
  })
}
