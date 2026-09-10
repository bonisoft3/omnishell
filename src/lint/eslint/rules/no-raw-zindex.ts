import type { Rule } from "eslint"
import { createClassNameVisitor } from "../utils"

const RAW_Z_REGEX = /\bz-(?:0|10|20|30|40|50|auto)\b/

export const noRawZindex: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow raw z-index Tailwind classes; require z-[var(--z-*)] tokens" },
  },
  create(context) {
    return createClassNameVisitor(context, RAW_Z_REGEX, (match) =>
      `Raw z-index class "${match}" is banned. Use z-[var(--z-*)] tokens instead. Valid: --z-bleed, --z-sticky, --z-panel, --z-nav, --z-fab, --z-dropdown, --z-overlay, --z-flash.`,
    )
  },
}
