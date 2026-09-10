import type { LayoutConfig, LayoutComponents, ResolvedLayoutConfig } from "./types"
import { createSidebar } from "./sidebar"
import { createBottomNav } from "./bottom-nav"
import { createAppShell } from "./app-shell"

export function createLayout(config: LayoutConfig): LayoutComponents {
  const resolved: ResolvedLayoutConfig = {
    items: config.items,
    mobileBreakpoint: config.mobileBreakpoint ?? "md",
  }

  const Sidebar = createSidebar(resolved)
  const BottomNav = createBottomNav(resolved)
  const AppShell = createAppShell(Sidebar, BottomNav, resolved.mobileBreakpoint)

  return { AppShell, Sidebar, BottomNav, config: resolved }
}
