import type { Rule } from "eslint"
import { matchesFilePattern } from "../utils"

const ROUTE_PATTERNS = ["**/routes/**", "**/app/**/page.*"]

export const requireErrorBoundary: Rule.RuleModule = {
  meta: { type: "problem", docs: { description: "Require ErrorBoundary in route files" } },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (!matchesFilePattern(filename, ROUTE_PATTERNS)) return {}
    let hasErrorBoundary = false
    return {
      JSXOpeningElement(node: any) {
        const name = node.name?.name
        if (typeof name === "string" && name === "ErrorBoundary") {
          hasErrorBoundary = true
        }
      },
      "Program:exit"(node: any) {
        if (!hasErrorBoundary) {
          context.report({ node, message: "Route files must include an ErrorBoundary. Wrap your route content in <ErrorBoundary>." })
        }
      },
    }
  },
}
