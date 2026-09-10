import { describe, test, expect } from "@test/harness"

describe("vision review response parsing", () => {
  test("parses valid JSON response with bugs", () => {
    const text = '{"bugs":[{"description":"Misaligned card","severity":"major"}],"passed":false}'
    const result = JSON.parse(text)
    expect(result.passed).toBe(false)
    expect(result.bugs).toHaveLength(1)
    expect(result.bugs[0].severity).toBe("major")
  })

  test("parses clean response", () => {
    const text = '{"bugs":[],"passed":true}'
    const result = JSON.parse(text)
    expect(result.passed).toBe(true)
    expect(result.bugs).toHaveLength(0)
  })

  test("severity filtering works", () => {
    const bugs = [
      { description: "Minor spacing", severity: "minor" },
      { description: "Misaligned card", severity: "major" },
      { description: "Button hidden", severity: "critical" },
    ]
    const severityRank: Record<string, number> = { minor: 0, major: 1, critical: 2 }
    const threshold = severityRank["major"]!
    const failing = bugs.filter((b) => (severityRank[b.severity] ?? 0) >= threshold)
    expect(failing).toHaveLength(2)
    expect(failing.map((b) => b.severity)).toEqual(["major", "critical"])
  })

  test("feature parity response parsing", () => {
    const text = '{"viewportA_actions":["Home","Settings"],"viewportB_actions":["Home"],"missing_from_A":[],"missing_from_B":["Settings"],"passed":false}'
    const result = JSON.parse(text)
    expect(result.passed).toBe(false)
    expect(result.missing_from_B).toContain("Settings")
  })
})
