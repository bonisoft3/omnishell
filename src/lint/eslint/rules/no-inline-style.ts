import type { Rule } from "eslint"

export const noInlineStyle: Rule.RuleModule = {
  meta: { type: "problem", docs: { description: "Disallow inline style attribute; use Tailwind classes" } },
  create(context) {
    return {
      JSXAttribute(node: any) {
        if (node.name?.name === "style") {
          context.report({ node, message: "Inline style attribute is banned. Use Tailwind utility classes instead." })
        }
      },
    }
  },
}
