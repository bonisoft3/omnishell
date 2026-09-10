/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

export async function checkHorizontalOverflow(page: Page): Promise<VisualBug[]> {
  return page.evaluate(() => {
    const bugs: Array<{ rule: string; description: string; severity: "critical" | "major" | "minor" }> = []
    const docWidth = document.documentElement.scrollWidth
    const viewportWidth = window.innerWidth
    if (docWidth > viewportWidth + 1) {
      bugs.push({ rule: "no-horizontal-overflow", description: `Document width (${docWidth}px) exceeds viewport (${viewportWidth}px) by ${docWidth - viewportWidth}px`, severity: "major" })
    }
    return bugs
  })
}
