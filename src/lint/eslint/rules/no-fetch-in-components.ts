import type { Rule } from "eslint"
import { matchesFilePattern, UI_PRIMITIVE_PATTERNS } from "../utils"

const COMPONENT_PATTERNS = ["**/components/**"]
const BANNED_IMPORTS: Record<string, string> = {
  axios: "axios is banned in components. Move data fetching to actions/.",
  "@tanstack/react-query": "react-query is banned in components. Use TanStack DB instead.",
  zustand: "zustand is banned in components. Use TanStack DB instead.",
  jotai: "jotai is banned in components. Use TanStack DB instead.",
  redux: "redux is banned in components. Use TanStack DB instead.",
  "@reduxjs/toolkit": "redux is banned in components. Use TanStack DB instead.",
}

export const noFetchInComponents: Rule.RuleModule = {
  meta: { type: "problem", docs: { description: "Ban fetch, useEffect with deps, and state libraries in components" } },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!matchesFilePattern(filename, COMPONENT_PATTERNS)) return {}
    if (matchesFilePattern(filename, UI_PRIMITIVE_PATTERNS)) return {}
    return {
      CallExpression(node: any) {
        const callee = node.callee
        if (callee.type === "Identifier" && callee.name === "fetch") {
          context.report({ node, message: "fetch() is banned in components. Move data fetching to actions/." })
        }
        if (callee.type === "Identifier" && callee.name === "useEffect") {
          if (node.arguments.length >= 2) {
            const deps = node.arguments[1]
            if (deps?.type === "ArrayExpression" && deps.elements.length > 0) {
              context.report({ node, message: "useEffect with dependencies is banned in components. Move side effects to actions/." })
            }
          }
        }
      },
      ImportDeclaration(node: any) {
        const source = node.source?.value
        if (typeof source === "string") {
          for (const [pkg, message] of Object.entries(BANNED_IMPORTS)) {
            if (source === pkg || source.startsWith(pkg + "/")) {
              context.report({ node, message })
            }
          }
        }
      },
    }
  },
}
