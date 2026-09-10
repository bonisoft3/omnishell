import type { Rule } from "eslint"
import { createClassNameVisitor } from "../utils"

const RAW_COLOR_REGEX = /\b(?:bg|text|border|ring|outline|shadow|accent|fill|stroke|decoration)-\[(?:#[0-9a-fA-F]|rgb|hsl|rgba|hsla)/

export const noRawColors: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow raw color values in className; require design tokens" },
  },
  create(context) {
    return createClassNameVisitor(context, RAW_COLOR_REGEX, (match) =>
      `Raw color value "${match}..." is banned. Use design system color tokens instead.`,
    )
  },
}
