import type { Page, ConsoleMessage } from "@playwright/test"
import type { VisualBug } from "../types"

export interface ConsoleCapture {
  messages: Array<{ type: "error" | "warning"; text: string; location: string }>
  dispose: () => void
}

/**
 * Ignore patterns that produce noise but aren't actionable bugs:
 * - React DevTools hint (info-level reminder)
 * - Next.js/Vite HMR runtime chatter
 * - Asset preload warnings that don't fire errors
 * - Known third-party notices that apps can't silence
 */
const DEFAULT_IGNORES: RegExp[] = [
  /React DevTools/i,
  /Download the React DevTools/i,
  /\[vite\] (connected|connecting|hot updated)/i,
  /\[HMR\]/i,
  /preloaded using link preload but not used/i,
  /was preloaded using link preload but not used within a few seconds/i,
  /Failed to load resource.*favicon/i,
  /apple-mobile-web-app-capable.*deprecated/i,
]

/**
 * Attach listeners to the page BEFORE navigation.
 * Returns a capture object with the accumulated messages and a dispose function.
 * Typical usage:
 *   const capture = captureConsole(page)
 *   await page.goto(url)
 *   await page.waitForTimeout(3000)
 *   const bugs = analyzeConsole(capture, { ignore: [/extra pattern/] })
 *   capture.dispose()
 */
export function captureConsole(page: Page): ConsoleCapture {
  const messages: ConsoleCapture["messages"] = []

  const onConsole = (msg: ConsoleMessage) => {
    const type = msg.type()
    if (type !== "error" && type !== "warning") return
    const loc = msg.location()
    const locStr = loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : ""
    messages.push({ type, text: msg.text(), location: locStr })
  }

  const onPageError = (err: Error) => {
    messages.push({ type: "error", text: err.message, location: err.stack?.split("\n")[1]?.trim() ?? "" })
  }

  page.on("console", onConsole)
  page.on("pageerror", onPageError)

  return {
    messages,
    dispose: () => {
      page.off("console", onConsole)
      page.off("pageerror", onPageError)
    },
  }
}

/**
 * Turn captured console messages into VisualBug entries.
 * Errors → critical. Warnings → minor (not actionable as hard failures,
 * but useful to log and surface in reports).
 */
export function analyzeConsole(
  capture: ConsoleCapture,
  opts: { ignore?: RegExp[]; warningSeverity?: "minor" | "major" } = {},
): VisualBug[] {
  const ignore = [...DEFAULT_IGNORES, ...(opts.ignore ?? [])]
  const warningSeverity = opts.warningSeverity ?? "minor"
  const bugs: VisualBug[] = []

  for (const msg of capture.messages) {
    if (ignore.some((re) => re.test(msg.text))) continue
    const shortText = msg.text.length > 300 ? msg.text.slice(0, 300) + "…" : msg.text
    bugs.push({
      rule: msg.type === "error" ? "console-error" : "console-warning",
      description: msg.location
        ? `${shortText} (${msg.location})`
        : shortText,
      severity: msg.type === "error" ? "critical" : warningSeverity,
    })
  }

  return bugs
}

/**
 * Convenience wrapper that captures + waits + analyzes in a single call.
 * Use when you already have a loaded page and want a one-shot snapshot
 * of the current console state (post-load, no pre-navigation hooks).
 *
 * NOTE: this cannot retroactively capture messages fired before the call.
 * Prefer captureConsole(page) + analyzeConsole() for full coverage.
 */
export async function checkConsoleMessages(
  page: Page,
  opts: { ignore?: RegExp[]; warningSeverity?: "minor" | "major" } = {},
): Promise<VisualBug[]> {
  const capture = captureConsole(page)
  // Allow a tick so any pending microtasks flush
  await page.waitForTimeout(100)
  const bugs = analyzeConsole(capture, opts)
  capture.dispose()
  return bugs
}
