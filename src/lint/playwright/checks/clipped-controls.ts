/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * Controls a box clips away, that nothing can bring back.
 *
 * A control pushed under an `overflow: hidden` box is inside the viewport and
 * covered by nothing, so viewport-bounds and interactive-overlap both pass it;
 * it is simply not painted. The clip is measured the way CSS applies it: a
 * scroll container holds its content a scroll away rather than clipping it, an
 * absolutely positioned box is clipped only from its containing block upward,
 * an inline box clips nothing, and the root's overflow is the viewport's.
 *
 * Only a control painted nowhere that no script could scroll into view either
 * — outside the clipper's scrollable overflow, or under `overflow: clip` — is
 * reported, as an error. One inside a hidden box's scrollable overflow is a
 * carousel's next slide as much as a button pushed under a board, and nothing
 * static tells them apart; clipped-content reports the box.
 *
 * Skipped: what no pointer reaches by design — under `inert` or `aria-hidden`,
 * or inside a box of 1px or less that clips, which is the screen-reader idiom
 * and the collapsed panel.
 */
export async function checkClippedControls(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []
    const clippedAway = (el: Element): boolean => {
      for (let a: Element | null = el; a; a = a.parentElement) {
        const box = a.getBoundingClientRect()
        if (box.width > 1 && box.height > 1) continue
        const s = getComputedStyle(a)
        if (s.overflow !== "visible" || s.clipPath !== "none") return true
      }
      return false
    }
    const name = (el: Element) =>
      el.getAttribute("data-testid") || el.getAttribute("aria-label") ||
      el.textContent?.trim().slice(0, 30) || el.tagName.toLowerCase()
    // One axis of a box's overflow applied to an extent. Inside the box's
    // scrollable overflow a scroll brings the extent on screen — a scroll
    // container widens it to its own box — and `clip` has no scrollable
    // overflow at all.
    const clip = (overflow: string, lo: number, hi: number, start: number, size: number, scrolled: number, scrollSize: number) => {
      if (overflow === "visible") return { lo, hi, within: true }
      const within = overflow !== "clip" && lo >= start - scrolled && hi <= start - scrolled + scrollSize
      const scrolls = overflow === "auto" || overflow === "scroll"
      return scrolls && within
        ? { lo: start, hi: start + size, within }
        : { lo: Math.max(lo, start), hi: Math.min(hi, start + size), within }
    }

    for (const el of document.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [tabindex="0"]')) {
      const htmlEl = el as HTMLElement
      if (!htmlEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (htmlEl.closest('[inert],[aria-hidden="true"]') || clippedAway(htmlEl)) continue
      const rect = htmlEl.getBoundingClientRect()
      if (rect.width * rect.height === 0) continue
      const own = getComputedStyle(htmlEl).position
      // A fixed box is laid out against the viewport, which viewport-bounds owns.
      if (own === "fixed") continue

      // The extent a reader can bring on screen. A scroll container widens it
      // to the container's own box on the axis it scrolls.
      let escaping = own === "absolute"
      let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom
      let clipper: HTMLElement | null = null
      let reachable = true
      const extent = () => Math.max(0, right - left) * Math.max(0, bottom - top)
      for (let a = htmlEl.parentElement; a && a !== document.body; a = a.parentElement) {
        const style = getComputedStyle(a)
        const containing = style.position !== "static" || style.transform !== "none" ||
          style.filter !== "none" || style.perspective !== "none"
        if (escaping && !containing) continue
        escaping = false
        if (style.display !== "inline" && style.display !== "contents") {
          // Overflow clips at the padding edge.
          const box = a.getBoundingClientRect()
          const boxLeft = box.left + a.clientLeft
          const boxTop = box.top + a.clientTop
          const before = extent()
          const x = clip(style.overflowX, left, right, boxLeft, a.clientWidth, a.scrollLeft, a.scrollWidth)
          const y = clip(style.overflowY, top, bottom, boxTop, a.clientHeight, a.scrollTop, a.scrollHeight)
          ;[left, right, top, bottom] = [x.lo, x.hi, y.lo, y.hi]
          if (extent() < before) {
            clipper = a
            reachable = reachable && x.within && y.within
          }
          if (extent() === 0) break
        }
        if (style.position === "fixed") break
        // The static boxes above an absolute one do not hold it.
        if (style.position === "absolute") escaping = true
      }
      if (clipper === null || extent() > 0 || reachable) continue

      const id = name(htmlEl)
      const by = clipper.getAttribute("data-testid") || clipper.getAttribute("class")?.slice(0, 40) ||
        clipper.tagName.toLowerCase()
      const at = clipper.getBoundingClientRect()
      bugs.push({
        rule: "clipped-control",
        description: `"${id}" is painted nowhere: "${by}" clips it away and nothing can scroll it into view ` +
          `(${Math.round(rect.top)}..${Math.round(rect.bottom)} against ${Math.round(at.top)}..${Math.round(at.bottom)})`,
        severity: "critical",
        element: id,
      })
    }
    return bugs
  })
}
