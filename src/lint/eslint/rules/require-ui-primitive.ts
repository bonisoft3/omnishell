import type { Rule } from "eslint"
import { matchesFilePattern, UI_PRIMITIVE_PATTERNS } from "../utils"

const BANNED_ELEMENTS: Record<string, string> = {
  button: "Button", input: "Input", select: "Select", textarea: "Textarea", dialog: "Dialog",
  datalist: "Combobox", meter: "Progress", progress: "Progress",
}

/** Attributes on otherwise-allowed elements that imply native browser widgets */
const BANNED_ATTRIBUTES: Record<string, { attr: string; message: string }[]> = {
  input: [
    { attr: "list", message: "Raw <input list> (datalist) is banned. Use <Combobox> from ui/ instead." },
  ],
}

export const requireUiPrimitive: Rule.RuleModule = {
  meta: { type: "problem", docs: { description: "Require shadcn/ui primitives instead of raw HTML interactive elements" } },
  create(context) {
    const filename = context.filename ?? context.getFilename()
    if (matchesFilePattern(filename, UI_PRIMITIVE_PATTERNS)) return {}
    return {
      JSXOpeningElement(node: any) {
        const name = node.name?.name
        if (typeof name !== "string") return
        if (name in BANNED_ELEMENTS) {
          context.report({ node, message: `Raw <${name}> is banned. Use <${BANNED_ELEMENTS[name]!}> from shadcn/ui instead.` })
        }
        const bannedAttrs = BANNED_ATTRIBUTES[name]
        if (bannedAttrs) {
          for (const { attr, message } of bannedAttrs) {
            const hasAttr = node.attributes?.some((a: any) => a.type === "JSXAttribute" && a.name?.name === attr)
            if (hasAttr) {
              context.report({ node, message })
            }
          }
        }
      },
    }
  },
}
