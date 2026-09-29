/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/**
 * White space balance (AIM m22 / Miniukovich & De Angeli 2015) uses a 2D binary
 * occupancy grid to measure true unoccupied canvas without double counting
 * overlapping or nested DOM elements.
 * - Under 15% white space signals an overcrowded, claustrophobic layout.
 * - Over 85% white space on a populated state signals barren or deserted UI.
 */
export async function checkWhiteSpace(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: VisualBug[] = []
    const root = (
      document.querySelector('.frame .screen[data-state="populated"]') ||
      document.querySelector('.frame .screen:not([data-state="loading"]):not([data-state="empty"])') ||
      document.querySelector('.frame .screen') ||
      document.querySelector('.screen') ||
      document.body
    ) as HTMLElement

    const rootRect = root.getBoundingClientRect()
    const w = Math.min(Math.round(rootRect.width > 50 ? rootRect.width : window.innerWidth), 1280)
    const h = Math.min(Math.round(rootRect.height > 50 ? rootRect.height : window.innerHeight), 1200)

    if (w <= 50 || h <= 50) return bugs

    // Downsampled occupancy grid: step by 4px for high precision with low memory
    const step = 4
    const cols = Math.ceil(w / step)
    const rows = Math.ceil(h / step)
    const grid = new Uint8Array(cols * rows)

    const elements = Array.from(
      root.querySelectorAll("h1, h2, h3, h4, p, button, input, select, textarea, a, .card, table, img, svg, nav, header, footer"),
    ) as HTMLElement[]

    for (const el of elements) {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue
      if (el.closest("[inert]")) continue

      const r = el.getBoundingClientRect()
      if (r.width <= 2 || r.height <= 2) continue

      const relLeft = r.left - rootRect.left
      const relTop = r.top - rootRect.top

      const c0 = Math.max(0, Math.floor(relLeft / step))
      const c1 = Math.min(cols, Math.ceil((relLeft + r.width) / step))
      const r0 = Math.max(0, Math.floor(relTop / step))
      const r1 = Math.min(rows, Math.ceil((relTop + r.height) / step))

      for (let row = r0; row < r1; row++) {
        const offset = row * cols
        grid.fill(1, offset + c0, offset + c1)
      }
    }

    let occupied = 0
    const totalCells = cols * rows
    for (let i = 0; i < totalCells; i++) {
      if (grid[i] === 1) occupied++
    }

    const whiteSpaceRatio = totalCells > 0 ? 1 - occupied / totalCells : 1
    const whiteSpacePercent = Math.round(whiteSpaceRatio * 1000) / 10

    if (whiteSpaceRatio < 0.15) {
      bugs.push({
        rule: "whitespace-balance",
        description: `Screen is overcrowded: only ${whiteSpacePercent}% white space remaining`,
        severity: "minor",
      })
    } else if (whiteSpaceRatio > 0.88 && (root.getAttribute("data-state") === "populated" || root.dataset.state === "populated")) {
      bugs.push({
        rule: "whitespace-balance",
        description: `Populated screen is sparse: ${whiteSpacePercent}% white space with low content density`,
        severity: "minor",
      })
    }

    return bugs
  })
}
