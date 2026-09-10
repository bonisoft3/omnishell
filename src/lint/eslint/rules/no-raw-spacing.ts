import type { Rule } from "eslint"
import { createClassNameVisitor } from "../utils"

const ARBITRARY_SPACING_REGEX = /\b(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y|inset|top|right|bottom|left|w|h|min-w|min-h|max-w|max-h)-\[\d/

export const noRawSpacing: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow arbitrary spacing values; require token scale" },
  },
  create(context) {
    return createClassNameVisitor(context, ARBITRARY_SPACING_REGEX, (match) =>
      `Arbitrary spacing "${match}..." is banned. Use the design token scale (0-64) instead.`,
    )
  },
}
