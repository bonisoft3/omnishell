import type { LayoutConfig, LayoutComponents, ResolvedLayoutConfig } from "./types"

export function createLayout(config: LayoutConfig): LayoutComponents {
  const resolved: ResolvedLayoutConfig = {
    items: config.items,
    mobileBreakpoint: config.mobileBreakpoint ?? "md",
  }

  // Placeholder components — consumers replace these with their own implementations.
  // createLayout returns the resolved config so consumers can build their own shell components.
  const AppShell = ({ children }: { children: import("react").ReactNode }) => children as import("react").ReactElement
  const Sidebar = () => null as unknown as import("react").ReactElement
  const BottomNav = () => null as unknown as import("react").ReactElement

  return { AppShell, Sidebar, BottomNav, config: resolved }
}
