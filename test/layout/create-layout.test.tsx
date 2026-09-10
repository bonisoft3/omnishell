import { describe, test, expect } from "@test/harness"
import { createLayout } from "../../src/layout/create-layout"
import type { NavItem } from "../../src/layout/types"

const testItems: NavItem[] = [
  { path: "/", label: "Home", icon: () => null },
  { path: "/settings", label: "Settings", icon: () => null },
]

describe("createLayout", () => {
  test("returns AppShell, Sidebar, and BottomNav components", () => {
    const layout = createLayout({ items: testItems })
    expect(layout.AppShell).toBeDefined()
    expect(layout.Sidebar).toBeDefined()
    expect(layout.BottomNav).toBeDefined()
    expect(typeof layout.AppShell).toBe("function")
    expect(typeof layout.Sidebar).toBe("function")
    expect(typeof layout.BottomNav).toBe("function")
  })

  test("stores config accessible via config property", () => {
    const layout = createLayout({ items: testItems })
    expect(layout.config.items).toHaveLength(2)
    expect(layout.config.items[0]!.path).toBe("/")
  })

  test("accepts optional breakpoint override", () => {
    const layout = createLayout({ items: testItems, mobileBreakpoint: "lg" })
    expect(layout.config.mobileBreakpoint).toBe("lg")
  })

  test("defaults mobileBreakpoint to md", () => {
    const layout = createLayout({ items: testItems })
    expect(layout.config.mobileBreakpoint).toBe("md")
  })
})
