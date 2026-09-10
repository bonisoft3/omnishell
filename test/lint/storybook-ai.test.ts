import { describe, test, expect } from "@test/harness"
import { parseReviewResponse, parseRegressionResponse } from "../../src/lint/storybook/ai-review"

describe("AI component review parsing", () => {
  test("parses clean review", () => {
    const result = parseReviewResponse('{"issues":[],"passed":true}')
    expect(result.passed).toBe(true)
    expect(result.issues).toHaveLength(0)
  })

  test("parses review with issues", () => {
    const result = parseReviewResponse('{"issues":[{"description":"Button too small","severity":"major"}],"passed":false}')
    expect(result.passed).toBe(false)
    expect(result.issues).toHaveLength(1)
  })

  test("handles malformed JSON gracefully", () => {
    const result = parseReviewResponse("not json")
    expect(result.passed).toBe(true)
    expect(result.issues).toHaveLength(0)
  })
})

describe("AI regression gate parsing", () => {
  test("parses intentional improvement", () => {
    const result = parseRegressionResponse('{"classification":"intentional-improvement","description":"Better spacing","passed":true}')
    expect(result.passed).toBe(true)
    expect(result.classification).toBe("intentional-improvement")
  })

  test("parses unintentional regression", () => {
    const result = parseRegressionResponse('{"classification":"unintentional-regression","description":"Button disappeared","passed":false}')
    expect(result.passed).toBe(false)
    expect(result.classification).toBe("unintentional-regression")
  })

  test("handles malformed JSON gracefully", () => {
    const result = parseRegressionResponse("garbage")
    expect(result.passed).toBe(true)
    expect(result.classification).toBe("unknown")
  })
})
