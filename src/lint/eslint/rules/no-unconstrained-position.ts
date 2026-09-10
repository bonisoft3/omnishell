import type { Rule } from "eslint"
import { createClassNameVisitor, matchesFilePattern, LAYOUT_FILE_PATTERNS } from "../utils"

const POSITION_REGEX = /\b(?:fixed|sticky)\b/

export const noUnconstrainedPosition: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow fixed/sticky positioning outside layout components" },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (matchesFilePattern(filename, LAYOUT_FILE_PATTERNS)) {
      return {}
    }
    return createClassNameVisitor(context, POSITION_REGEX, (match) =>
      `Position class "${match}" is only allowed in layout components (components/layout/*, components/ui/sheet|tooltip|popover|dialog|dropdown).`,
    )
  },
}
