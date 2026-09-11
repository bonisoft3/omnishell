/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * A control a reader cannot see that a keyboard still lands on.
 *
 * The geometry checks here skip what `checkVisibility` calls invisible, which is right
 * — a control inside a collapsed `<details>` is not on screen and measuring it
 * would report a bug nobody can see. But it makes invisibility the cheapest way
 * to satisfy all of them at once, and the browser does not agree that every
 * invisible element is out of reach: `display: none` and `visibility: hidden`
 * leave the tab order, and `opacity: 0` does not. So an author under a target,
 * over an edge or under a neighbour can silence three rules with one
 * declaration and leave a focus stop the reader cannot find.
 *
 * Measured from the two properties that decide it rather than by calling
 * `focus()`, which would move the caret and fire handlers inside a lint.
 */
export async function checkFocusableInvisible(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []
    const focusable = document.querySelectorAll<HTMLElement>(
      'a[href], button, input, textarea, select, [role="button"], [tabindex]:not([tabindex="-1"])',
    )
    for (const el of focusable) {
      if ((el as HTMLInputElement).disabled === true) continue
      // Not contentVisibilityAuto: a control inside a `content-visibility: auto`
      // subtree the browser has skipped is offscreen, not invisible, and would
      // fall into the check below as a false stop.
      if (el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
      // The two that take an element out of the tab order on their own: a
      // display:none box or ancestor fails the bare checkVisibility(), and
      // visibility inherits, so the element's own computed value is the answer
      // (a visible child of a hidden parent is focusable). What is left is
      // invisible AND reachable.
      if (!el.checkVisibility()) continue
      const { visibility } = getComputedStyle(el)
      if (visibility === "hidden" || visibility === "collapse") continue
      const id = el.getAttribute("data-testid") || el.getAttribute("aria-label") ||
        el.textContent?.trim().slice(0, 20) || el.tagName.toLowerCase()
      bugs.push({
        rule: "focusable-but-invisible",
        description: `"${id}" is in the tab order and cannot be seen`,
        severity: "major",
        element: id,
      })
    }
    return bugs
  })
}
