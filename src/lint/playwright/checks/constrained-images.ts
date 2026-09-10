/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

export async function checkConstrainedImages(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor"; element?: string }> = []

    const containers = document.querySelectorAll("[data-constrained-image]")
    for (const container of containers) {
      const el = container as HTMLElement
      const style = getComputedStyle(el)
      const testId = el.getAttribute("data-testid") || "unnamed-image"
      const isFillMode = el.getAttribute("data-constrained-ratio") === "fill"

      if (!isFillMode && (style.aspectRatio === "auto" || !style.aspectRatio)) {
        bugs.push({ rule: "constrained-image-ratio", description: `Image "${testId}" container missing aspect-ratio`, severity: "major", element: testId })
      }
      if (style.overflow !== "hidden") {
        bugs.push({ rule: "constrained-image-overflow", description: `Image "${testId}" container missing overflow:hidden`, severity: "minor", element: testId })
      }
      const img = el.querySelector("img")
      if (img) {
        const imgStyle = getComputedStyle(img)
        if (imgStyle.position !== "absolute") {
          bugs.push({ rule: "constrained-image-position", description: `Image "${testId}" <img> should be position:absolute, got ${imgStyle.position}`, severity: "major", element: testId })
        }
      }
    }

    const images = document.querySelectorAll("img")
    for (const img of images) {
      const imgStyle = getComputedStyle(img)
      if (imgStyle.objectFit !== "cover") continue
      if (!img.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (img.offsetWidth === 0 || img.offsetHeight === 0) continue

      // The walk starts at the image, not its parent: an aspect-ratio set on
      // the <img> itself constrains the box just as well as one on a wrapper.
      let container: Element | null = img
      let foundAspect = false
      let depth = 0
      while (container && depth < 4) {
        const containerStyle = getComputedStyle(container)
        if ((containerStyle.aspectRatio && containerStyle.aspectRatio !== "auto") || container.hasAttribute("data-constrained-image")) {
          foundAspect = true
          break
        }
        container = container.parentElement
        depth++
      }

      // object-fit:cover crops unpredictably only when the box's own ratio can
      // move — a percentage width against a variable container changes the
      // ratio and with it the crop. Both dimensions being absolute lengths
      // pins the box, so there is nothing to warn about. Computed values
      // absolutize em/rem but leave percentages as percentages, which is
      // exactly the distinction that matters, so read the computed value
      // rather than the resolved one getComputedStyle would report in px.
      if (!foundAspect) {
        const box = (img as unknown as { computedStyleMap(): StylePropertyMapReadOnly }).computedStyleMap()
        const w = box.get("width") as CSSUnitValue | undefined
        const h = box.get("height") as CSSUnitValue | undefined
        if (w?.unit === "px" && h?.unit === "px") foundAspect = true
      }

      if (!foundAspect) {
        const alt = img.getAttribute("alt") || ""
        const src = img.getAttribute("src") || ""
        const identifier = alt || src.slice(-30)
        bugs.push({ rule: "unconstrained-object-cover", description: `<img> with object-cover "${identifier}" has no aspect-ratio container within 3 ancestors`, severity: "major", element: identifier })
      }
    }

    return bugs
  })
}
