import type { Rule } from "eslint"

const APPLY_REGEX = /@apply\s/

export const noApply: Rule.RuleModule = {
  meta: { type: "problem", docs: { description: "Disallow @apply in CSS; use Tailwind utility classes directly" } },
  create(context) {
    return {
      Literal(node: any) {
        if (typeof node.value === "string" && APPLY_REGEX.test(node.value)) {
          context.report({ node, message: "@apply is banned. Use Tailwind utility classes directly in JSX." })
        }
      },
      TemplateLiteral(node: any) {
        for (const quasi of node.quasis) {
          if (quasi.value?.raw && APPLY_REGEX.test(quasi.value.raw)) {
            context.report({ node: quasi, message: "@apply is banned. Use Tailwind utility classes directly in JSX." })
          }
        }
      },
    }
  },
}
