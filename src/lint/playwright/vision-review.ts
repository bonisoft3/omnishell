import type { Page } from "@playwright/test"
import { assertIs } from "./assert"

export async function assertVisionReview(
  page: Page,
  opts: {
    viewport?: string
    context?: string
    failOn?: "critical" | "major" | "minor"
  } = {},
) {
  const { viewport = "unknown", context = "", failOn = "major" } = opts

  let Anthropic: any
  try {
    Anthropic = (await (Function('return import("@anthropic-ai/sdk")')() as Promise<any>)).default
  } catch {
    console.warn("[vision-review] @anthropic-ai/sdk not installed, skipping")
    return
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[vision-review] ANTHROPIC_API_KEY not set, skipping")
    return
  }

  const screenshot = await page.screenshot({ fullPage: true, type: "png" })
  const base64 = screenshot.toString("base64")

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        {
          type: "text",
          text: `You are a senior UI/UX reviewer inspecting a ${viewport} screenshot of a web application.
${context ? `Context: ${context}\n` : ""}
Examine the screenshot and report ANY visual bugs. Focus on issues a human would immediately notice:
- Empty space or wasted whitespace inside cards/containers that looks broken
- Elements that appear misaligned or inconsistently spaced
- Images that appear cropped, stretched, or have wrong aspect ratios
- Text that is truncated, unreadable, or overlapping other content
- Interactive elements that appear obscured or unreachable
- Visual inconsistencies between similar elements
- Layout that looks broken on this viewport size

Do NOT report minor spacing preferences or subjective design opinions.

Respond with ONLY this JSON (no markdown):
{"bugs":[{"description":"...","severity":"critical|major|minor"}],"passed":true|false}

If there are no bugs, return: {"bugs":[],"passed":true}`,
        },
      ],
    }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text : ""
  let result: { bugs: Array<{ description: string; severity: string }>; passed: boolean }

  try {
    result = JSON.parse(text)
  } catch {
    console.warn(`[vision-review] Failed to parse response: ${text.slice(0, 200)}`)
    return
  }

  const severityRank: Record<string, number> = { minor: 0, major: 1, critical: 2 }
  const threshold = severityRank[failOn] ?? 1
  const failingBugs = result.bugs.filter((b) => (severityRank[b.severity] ?? 0) >= threshold)

  if (failingBugs.length > 0) {
    const summary = failingBugs.map((b) => `[${b.severity}] ${b.description}`).join("\n")
    assertIs(failingBugs.length, 0, `Vision review found ${failingBugs.length} bug(s) at ${viewport}:\n${summary}`)
  }
}

export async function assertFeatureParity(
  page: Page,
  path: string,
  opts: {
    viewportA: { name: string; width: number; height: number }
    viewportB: { name: string; width: number; height: number }
    navigate?: (page: Page, path: string) => Promise<void>
  },
) {
  let Anthropic: any
  try {
    Anthropic = (await (Function('return import("@anthropic-ai/sdk")')() as Promise<any>)).default
  } catch {
    console.warn("[feature-parity] @anthropic-ai/sdk not installed, skipping")
    return
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[feature-parity] ANTHROPIC_API_KEY not set, skipping")
    return
  }

  const nav = opts.navigate || (async (p: Page, pt: string) => {
    await p.goto(pt)
    await p.waitForLoadState("domcontentloaded")
  })

  await page.setViewportSize({ width: opts.viewportA.width, height: opts.viewportA.height })
  await nav(page, path)
  await page.waitForTimeout(1000)
  const screenshotA = (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64")

  await page.setViewportSize({ width: opts.viewportB.width, height: opts.viewportB.height })
  await nav(page, path)
  await page.waitForTimeout(1000)
  const screenshotB = (await page.screenshot({ type: "jpeg", quality: 70 })).toString("base64")

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `You are comparing two screenshots of the SAME page at different viewport sizes to check feature parity.\n\nImage 1: "${opts.viewportA.name}" (${opts.viewportA.width}x${opts.viewportA.height})\nImage 2: "${opts.viewportB.name}" (${opts.viewportB.width}x${opts.viewportB.height})` },
        { type: "image", source: { type: "base64", media_type: "image/jpeg" as const, data: screenshotA } },
        { type: "image", source: { type: "base64", media_type: "image/jpeg" as const, data: screenshotB } },
        { type: "text", text: `List all USER ACTIONS available on each screenshot. Then compare: are any actions available on one viewport but MISSING on the other?\n\nLayout differences are expected (sidebar vs bottom nav = SAME feature).\nWhat IS a problem: features/actions present on one but not the other.\n\nRespond with ONLY raw JSON:\n{"viewportA_actions":["action1"],"viewportB_actions":["action1"],"missing_from_A":[],"missing_from_B":[],"passed":true|false}` },
      ],
    }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text : ""
  let result: { missing_from_A: string[]; missing_from_B: string[]; passed: boolean; viewportA_actions: string[]; viewportB_actions: string[] }

  try {
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim()
    result = JSON.parse(cleaned)
  } catch {
    console.warn(`[feature-parity] Failed to parse response: ${text.slice(0, 300)}`)
    return
  }

  const issues: string[] = []
  if (result.missing_from_A.length > 0) issues.push(`Missing from ${opts.viewportA.name}: ${result.missing_from_A.join(", ")}`)
  if (result.missing_from_B.length > 0) issues.push(`Missing from ${opts.viewportB.name}: ${result.missing_from_B.join(", ")}`)

  if (issues.length > 0) {
    assertIs(issues.length, 0, `Feature parity failed:\n${issues.join("\n")}`)
  }
}
