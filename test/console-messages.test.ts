// Regression rationale: golaberto's integrate failed on "Failed to load
// resource: … 401" for /electric/v1/shape. The mecha client treats that 401 as
// its shape token's expiry, re-mints and resumes, but the browser logs the
// refused request anyway; the URL lives in the message's location, not its text.
import { describe, expect, it } from "@test/harness"
import { analyzeConsole } from "../src/lint/playwright/checks/console-messages.ts"

const refused = (location: string) => ({
  messages: [{ type: "error" as const, text: "Failed to load resource: the server responded with a status of 401 ()", location }],
  dispose: () => {},
})

describe("analyzeConsole", () => {
  it("ignores a shape request the auth gate refused, which the client recovers from", () => {
    expect(analyzeConsole(refused("https://caddy:8443/electric/v1/shape?table=team&where=x:0"))).toEqual([])
  })

  it("still reports any other refused request", () => {
    expect(analyzeConsole(refused("https://caddy:8443/crud/team?select=*:0")).map((b) => b.severity)).toEqual(["critical"])
  })
})
