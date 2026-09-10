import type { ComponentType } from "react"
import { Link, useLocation } from "@tanstack/react-router"
import type { ResolvedLayoutConfig } from "./types"

const BREAKPOINT_CLASSES: Record<string, string> = {
  sm: "hidden sm:flex",
  md: "hidden md:flex",
  lg: "hidden lg:flex",
  xl: "hidden xl:flex",
}

export function createSidebar(config: ResolvedLayoutConfig): ComponentType {
  const showClass = BREAKPOINT_CLASSES[config.mobileBreakpoint] ?? "hidden md:flex"

  return function Sidebar() {
    const location = useLocation()

    return (
      <aside className={`${showClass} w-14 flex-col items-center gap-2 border-r bg-muted/40 py-4`}>
        {config.items.map((item) => {
          const isActive = location.pathname === item.path
          const Icon = item.icon
          return (
            <Link
              key={item.path}
              to={item.path}
              className={[
                "flex h-10 w-10 items-center justify-center rounded-md transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              ].join(" ")}
              aria-label={item.label}
            >
              <Icon className="h-5 w-5" />
            </Link>
          )
        })}
      </aside>
    )
  }
}
