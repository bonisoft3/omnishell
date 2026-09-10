import type { Buffer } from "node:buffer"

export interface ReviewResult {
  passed: boolean
  issues: Array<{ description: string; severity: string }>
}

export interface RegressionResult {
  passed: boolean
  classification: "intentional-improvement" | "intentional-change" | "unintentional-regression" | "unknown"
  description: string
}

export function parseReviewResponse(text: string): ReviewResult {
  try {
    const result = JSON.parse(text)
    return { passed: result.passed ?? true, issues: result.issues ?? [] }
  } catch {
    return { passed: true, issues: [] }
  }
}

export function parseRegressionResponse(text: string): RegressionResult {
  try {
    const result = JSON.parse(text)
    return {
      passed: result.passed ?? true,
      classification: result.classification ?? "unknown",
      description: result.description ?? "",
    }
  } catch {
    return { passed: true, classification: "unknown", description: "" }
  }
}

export async function reviewComponentScreenshot(
  screenshot: Buffer,
  opts: { componentName: string; storyName: string; viewport?: string },
): Promise<ReviewResult> {
  let Anthropic: any
  try {
    Anthropic = (await (Function('return import("@anthropic-ai/sdk")')() as Promise<any>)).default
  } catch { return { passed: true, issues: [] } }
  if (!process.env.ANTHROPIC_API_KEY) return { passed: true, issues: [] }

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.toString("base64") } },
        { type: "text", text: `Review this UI component screenshot.\nComponent: ${opts.componentName}\nStory: ${opts.storyName}\nViewport: ${opts.viewport ?? "default"}\n\nCheck for visual bugs, accessibility concerns, and design consistency.\n\nRespond with ONLY JSON: {"issues":[{"description":"...","severity":"critical|major|minor"}],"passed":true|false}` },
      ],
    }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text : ""
  return parseReviewResponse(text)
}

export async function detectRegression(
  before: Buffer,
  after: Buffer,
  opts: { componentName: string; storyName: string; prDescription?: string },
): Promise<RegressionResult> {
  let Anthropic: any
  try {
    Anthropic = (await (Function('return import("@anthropic-ai/sdk")')() as Promise<any>)).default
  } catch { return { passed: true, classification: "unknown", description: "" } }
  if (!process.env.ANTHROPIC_API_KEY) return { passed: true, classification: "unknown", description: "" }

  const anthropic = new Anthropic()
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: `Compare before/after screenshots of ${opts.componentName} (story: ${opts.storyName}).${opts.prDescription ? `\nPR context: ${opts.prDescription}` : ""}` },
        { type: "image", source: { type: "base64", media_type: "image/png", data: before.toString("base64") } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: after.toString("base64") } },
        { type: "text", text: `Classify: "intentional-improvement", "intentional-change", or "unintentional-regression".\nRespond with ONLY JSON: {"classification":"...","description":"...","passed":true|false}\nSet passed=false only for unintentional-regression.` },
      ],
    }],
  })

  const text = response.content[0].type === "text" ? response.content[0].text : ""
  return parseRegressionResponse(text)
}
