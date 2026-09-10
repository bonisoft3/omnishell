import type { ComponentType } from "react"
import { Link, useLocation } from "@tanstack/react-router"
import type { ResolvedLayoutConfig } from "./types"

const HIDE_CLASSES: Record<string, string> = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden",
  xl: "xl:hidden",
}

export function createBottomNav(config: ResolvedLayoutConfig): ComponentType {
  const hideClass = HIDE_CLASSES[config.mobileBreakpoint] ?? "md:hidden"

  return function BottomNav() {
    const location = useLocation()

    return (
      <nav className={`fixed bottom-0 left-0 right-0 z-[var(--z-nav)] flex h-16 items-center justify-around border-t bg-background ${hideClass}`}>
        {config.items.map((item) => {
          const isActive = location.pathname === item.path
          const Icon = item.icon
          return (
            <Link
              key={item.path}
              to={item.path}
              className={[
                "flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors",
                isActive ? "text-primary" : "text-muted-foreground",
              ].join(" ")}
            >
              <Icon className="h-5 w-5" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>
    )
  }
}
