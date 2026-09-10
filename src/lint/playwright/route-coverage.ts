/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// Crawl-based vision review with route coverage for TanStack Router apps.
import type { Page } from "@playwright/test"
import { assertAtLeast, assertIs } from "./assert"
import { readdirSync } from "node:fs"
import { assertVisionReview } from "./vision-review"

export interface CrawlAndReviewOptions {
  routesDir: string
  baseUrl?: string
  failOn?: "critical" | "major" | "minor"
  minCoverage?: number
}

const SKIP_FILES = new Set(["__root"])

function fileToPattern(file: string): string {
  if (file === "index") return "/"
  return "/" + file.replace(/\./g, "/").replace(/\$(\w+)/g, ":$1")
}

function matchPattern(url: string, pattern: string): boolean {
  const urlParts = url.split("/").filter(Boolean)
  const patternParts = pattern.split("/").filter(Boolean)
  if (urlParts.length !== patternParts.length) return false
  return patternParts.every((p, i) => p.startsWith(":") || p === urlParts[i])
}

function getRouteManifest(routesDir: string): Array<{ file: string; pattern: string }> {
  return readdirSync(routesDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => f.replace(".tsx", ""))
    .filter((f) => !SKIP_FILES.has(f))
    .map((file) => ({ file, pattern: fileToPattern(file) }))
}

async function extractInternalLinks(
  page: Page,
  manifest: Array<{ pattern: string }>,
): Promise<string[]> {
  const hrefs = await page.evaluate(() => {
    const links = new Set<string>()
    for (const a of document.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href")
      if (href && href.startsWith("/") && !href.startsWith("//")) {
        links.add(href.split("?")[0]!.split("#")[0]!)
      }
    }
    return [...links]
  })
  return hrefs.filter((href) => manifest.some((r) => matchPattern(href, r.pattern)))
}

export async function crawlAndReview(page: Page, options: CrawlAndReviewOptions): Promise<void> {
  const {
    routesDir,
    baseUrl = process.env.SNAPCARDS_BASE_URL ?? process.env.BASE_URL ?? "http://localhost:8080",
    failOn = "major",
    minCoverage = 80,
  } = options

  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("[route-coverage] ANTHROPIC_API_KEY not set, skipping")
    return
  }

  const manifest = getRouteManifest(routesDir)
  const visited = new Set<string>()
  const queue: string[] = ["/"]
  const routeHits = new Map<string, string>() // pattern → first concrete URL that matched

  await page.goto(`${baseUrl}/login`, { waitUntil: "load" })
  await page.waitForTimeout(1000)
  const guestBtn = page.getByRole("button", { name: /continue as guest/i })
  if (await guestBtn.isVisible()) {
    await guestBtn.click()
    await page.waitForTimeout(2000)
  }

  while (queue.length > 0) {
    const url = queue.shift()!
    if (visited.has(url)) continue
    visited.add(url)

    const response = await page.goto(`${baseUrl}${url}`, { waitUntil: "load" })
    if (!response || response.status() >= 400) continue
    if (page.url().includes("/login")) continue

    await page.waitForTimeout(2000)

    for (const route of manifest) {
      if (!routeHits.has(route.pattern) && matchPattern(url, route.pattern)) {
        routeHits.set(route.pattern, url)
      }
    }

    const links = await extractInternalLinks(page, manifest)
    for (const link of links) {
      if (!visited.has(link)) queue.push(link)
    }
  }

  const results: Array<{
    pattern: string
    url: string
    status: "pass" | "fail" | "missed"
    error?: string
  }> = []

  for (const route of manifest) {
    // Skip login — auth gate, not content
    if (route.file === "login") {
      results.push({ pattern: route.pattern, url: "/login", status: "pass" })
      continue
    }

    const url = routeHits.get(route.pattern)
    if (!url) {
      results.push({ pattern: route.pattern, url: "", status: "missed" })
      continue
    }

    try {
      await page.goto(`${baseUrl}${url}`, { waitUntil: "load" })
      await page.waitForTimeout(2000)

      const bodyText = await page.textContent("body")
      if (!bodyText || bodyText.trim().length < 20) {
        results.push({ pattern: route.pattern, url, status: "fail", error: "empty page" })
        continue
      }

      await assertVisionReview(page, {
        viewport: "desktop",
        context: `Route: ${route.pattern}. Report broken layouts, missing content, overlapping elements, broken images.`,
        failOn,
      })
      results.push({ pattern: route.pattern, url, status: "pass" })
    } catch (e) {
      results.push({
        pattern: route.pattern,
        url,
        status: "fail",
        error: String(e).slice(0, 150),
      })
    }
  }

  const total = manifest.length
  const hit = results.filter((r) => r.status !== "missed").length
  const passed = results.filter((r) => r.status === "pass").length
  const failed = results.filter((r) => r.status === "fail").length
  const missed = results.filter((r) => r.status === "missed").length
  const pct = Math.round((hit / total) * 100)

  console.log("\n╔══════════════════════════════════════════════════════╗")
  console.log("║              ROUTE COVERAGE REPORT                   ║")
  console.log("╠══════════════════════════════════════════════════════╣")
  for (const r of results) {
    const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "○"
    const url = r.url || "(not discovered)"
    console.log(`║ ${icon} ${r.pattern.padEnd(22)} → ${url.padEnd(26)} ║`)
    if (r.error) console.log(`║   └─ ${r.error.slice(0, 47).padEnd(47)} ║`)
  }
  console.log("╠══════════════════════════════════════════════════════╣")
  console.log(
    `║ Coverage: ${hit}/${total} routes (${pct}%) · ${passed} pass · ${failed} fail · ${missed} missed ║`,
  )
  console.log(`║ Crawled:  ${visited.size} unique URLs visited                      ║`)
  console.log("╚══════════════════════════════════════════════════════╝\n")

  assertIs(failed, 0, `${failed} route(s) failed vision review`)
  assertAtLeast(pct, minCoverage, `Route coverage ${pct}% is below ${minCoverage}%`)
}
