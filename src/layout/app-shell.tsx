import type { ComponentType, ReactNode } from "react"

const PADDING_CLASSES: Record<string, string> = {
  sm: "pb-16 sm:pb-0",
  md: "pb-16 md:pb-0",
  lg: "pb-16 lg:pb-0",
  xl: "pb-16 xl:pb-0",
}

export function createAppShell(
  Sidebar: ComponentType,
  BottomNav: ComponentType,
  mobileBreakpoint: string = "md",
): ComponentType<{ children: ReactNode }> {
  const paddingClass = PADDING_CLASSES[mobileBreakpoint] ?? "pb-16 md:pb-0"

  return function AppShell({ children }) {
    return (
      <div className="flex min-h-screen">
        <Sidebar />
        <main className={`flex-1 ${paddingClass}`}>{children}</main>
        <BottomNav />
      </div>
    )
  }
}
