import { describe, test, expect } from "@test/harness"
import { omnishellLint } from "../../src/lint/eslint/index"

describe("omnishellLint config", () => {
  test("exports an array of ESLint flat configs", () => {
    expect(Array.isArray(omnishellLint)).toBe(true)
    expect(omnishellLint.length).toBeGreaterThan(0)
  })

  test("each config has a name", () => {
    for (const config of omnishellLint) {
      expect(config.name).toBeTruthy()
    }
  })

  test("includes all rule categories", () => {
    const names = omnishellLint.map((c: any) => c.name)
    expect(names).toContain("@omnishell/rails/locked-tokens")
    expect(names).toContain("@omnishell/rails/ui-primitives")
    expect(names).toContain("@omnishell/rails/logic-separation")
    expect(names).toContain("@omnishell/lint/structural")
  })

  test("all configs target tsx/jsx/ts/js files", () => {
    for (const config of omnishellLint) {
      if (config.files) {
        const filesStr = JSON.stringify(config.files)
        expect(filesStr).toContain("ts")
      }
    }
  })
})
