import type { ComponentType, ReactNode } from "react"

export interface NavItem {
  path: string
  label: string
  icon: ComponentType<{ className?: string }>
}

export interface LayoutConfig {
  items: NavItem[]
  mobileBreakpoint?: "sm" | "md" | "lg" | "xl"
}

export interface ResolvedLayoutConfig {
  items: NavItem[]
  mobileBreakpoint: "sm" | "md" | "lg" | "xl"
}

export interface LayoutComponents {
  AppShell: ComponentType<{ children: ReactNode }>
  Sidebar: ComponentType
  BottomNav: ComponentType
  config: ResolvedLayoutConfig
}
