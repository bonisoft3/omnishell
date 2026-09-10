import type { Rule } from "eslint"

/**
 * Check if a string value matches a pattern and report it.
 */
export function checkStringForPattern(
  node: Rule.Node,
  value: string,
  context: Rule.RuleContext,
  pattern: RegExp,
  messageFn: (match: string) => string,
): void {
  const match = value.match(pattern)
  if (match) {
    context.report({ node, message: messageFn(match[0]) })
  }
}

/**
 * Create a visitor that walks JSX className attributes, function call arguments
 * (cn, clsx, twMerge), and template literals looking for strings that match a pattern.
 */
export function createClassNameVisitor(
  context: Rule.RuleContext,
  pattern: RegExp,
  messageFn: (match: string) => string,
): Rule.RuleListener {
  function check(node: Rule.Node, value: string) {
    checkStringForPattern(node, value, context, pattern, messageFn)
  }

  return {
    JSXAttribute(node: any) {
      if (node.name?.name !== "className") return
      if (node.value?.type === "Literal" && typeof node.value.value === "string") {
        check(node.value, node.value.value)
      }
    },

    Literal(node: any) {
      if (typeof node.value !== "string") return
      const parent = node.parent
      if (!parent) return
      if (parent.type === "CallExpression") {
        check(node, node.value)
      }
      if (parent.type === "TemplateLiteral") {
        check(node, node.value)
      }
    },

    TemplateLiteral(node: any) {
      for (const quasi of node.quasis) {
        if (quasi.value?.raw) {
          check(quasi, quasi.value.raw)
        }
      }
    },
  }
}

/**
 * Check if a filename matches any of the given glob patterns.
 */
export function matchesFilePattern(filename: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    // Convert glob to regex in a single pass to avoid re-processing substitutions.
    const escaped = pattern.replace(/\*\*\/|\*\*|\/\*\*|\*|\//g, (token) => {
      if (token === "**/") return "(?:[^/]+/)?"   // optional leading path segment(s)
      if (token === "/**") return "(?:/[^/]+)*"   // optional trailing path segment(s)
      if (token === "**")  return ".*"            // anything
      if (token === "*")   return "[^/]*"         // one segment
      return "\\/"                                // literal /
    })
    const regex = new RegExp("^" + escaped + "$")
    return regex.test(filename)
  })
}

/** Files where layout position classes are allowed */
export const LAYOUT_FILE_PATTERNS = [
  "**/components/layout/**",
  "**/components/ui/sheet*",
  "**/components/ui/tooltip*",
  "**/components/ui/popover*",
  "**/components/ui/dialog*",
  "**/components/ui/dropdown*",
]

/** Files where raw HTML elements and fetch are allowed (shadcn primitives) */
export const UI_PRIMITIVE_PATTERNS = [
  "**/components/ui/**",
]
