/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { Page } from "@playwright/test"
import type { VisualBug } from "../types"

/** Where the accumulating total lives on the page under test. */
const TOTAL = "__prontoCLS"

/**
 * Arm the layout-shift observer. MUST be called before the navigation whose
 * shifts are measured — `addInitScript` is not retroactive, so armed after a
 * `goto` it installs nothing into the document already loaded and every read
 * is a clean zero off a screen that reflowed.
 *
 * Observing after load with `buffered: true` does recover the shifts, but only
 * by holding a window open for the first callback — wall clock spent on every
 * page of every viewport. Arming first is what makes the read free.
 *
 * `hadRecentInput` drops shifts within 500ms of a gesture, which is the
 * reader's own doing rather than the screen's.
 */
export async function armCLS(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    const win = window as unknown as Record<string, number>
    win[key] = 0
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & { hadRecentInput: boolean; value: number }
        if (!shift.hadRecentInput) win[key] = (win[key] ?? 0) + shift.value
      }
    }).observe({ type: "layout-shift", buffered: true })
  }, TOTAL)
}

/**
 * Read what shifted. No wait: the driver settles the screen before calling
 * this, so one here would measure the harness's pacing instead. 0.1 is Core
 * Web Vitals' "good" boundary.
 */
export async function checkCLS(page: Page): Promise<VisualBug[]> {
  const cls = await page.evaluate(
    (key: string) => (window as unknown as Record<string, number>)[key] ?? 0,
    TOTAL,
  )
  return cls > 0.1
    ? [{
      rule: "cls-threshold",
      description: `layout shifted ${cls.toFixed(3)} after first paint, over the 0.1 "good" boundary`,
      severity: "major",
    }]
    : []
}
