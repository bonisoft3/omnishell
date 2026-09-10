import type { Rule } from "eslint"

const SCROLL_REGEX = /\boverflow-(?:auto|scroll|x-auto|y-auto|x-scroll|y-scroll)\b/

export const noNestedScroll: Rule.RuleModule = {
  meta: { type: "problem", docs: { description: "Disallow nested scrollable containers" } },
  create(context) {
    let scrollableAncestorDepth = 0
    return {
      JSXOpeningElement(node: any) {
        const classAttr = node.attributes?.find(
          (attr: any) => attr.type === "JSXAttribute" && attr.name?.name === "className",
        )
        if (!classAttr) return
        const value = classAttr.value
        let className = ""
        if (value?.type === "Literal" && typeof value.value === "string") {
          className = value.value
        }
        if (SCROLL_REGEX.test(className)) {
          if (scrollableAncestorDepth > 0) {
            context.report({ node, message: "Nested scrollable container detected. Avoid overflow-auto/scroll inside a scrollable ancestor." })
          }
          scrollableAncestorDepth++
        }
      },
      "JSXClosingElement:exit"(node: any) {
        const opening = node.parent?.openingElement
        if (!opening) return
        const classAttr = opening.attributes?.find(
          (attr: any) => attr.type === "JSXAttribute" && attr.name?.name === "className",
        )
        if (!classAttr) return
        const value = classAttr.value
        let className = ""
        if (value?.type === "Literal" && typeof value.value === "string") {
          className = value.value
        }
        if (SCROLL_REGEX.test(className)) {
          scrollableAncestorDepth--
        }
      },
    }
  },
}
