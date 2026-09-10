import { describe, test, expect } from "@test/harness"
import { omnishellPreset } from "../../src/lint/eslint/tailwind-preset"

describe("omnishellPreset", () => {
  test("exports a valid Tailwind preset object", () => {
    expect(omnishellPreset).toBeDefined()
    expect(omnishellPreset.theme).toBeDefined()
  })

  test("defines z-index tokens", () => {
    const zIndex = omnishellPreset.theme?.zIndex
    expect(zIndex).toBeDefined()
    expect(zIndex!.bleed).toBe("var(--z-bleed)")
    expect(zIndex!.nav).toBe("var(--z-nav)")
    expect(zIndex!.overlay).toBe("var(--z-overlay)")
  })

  test("defines spacing token scale", () => {
    const spacing = omnishellPreset.theme?.spacing
    expect(spacing).toBeDefined()
    expect(spacing!["4"]).toBe("1rem")
    expect(spacing!["8"]).toBe("2rem")
  })

  test("disables arbitrary values via a flag", () => {
    expect(omnishellPreset.disableArbitraryValues).toBe(true)
  })
})
