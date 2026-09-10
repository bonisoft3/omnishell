import { RuleTester } from "eslint"
import { noInlineStyle } from "../../src/lint/eslint/rules/no-inline-style"
import { requireUiPrimitive } from "../../src/lint/eslint/rules/require-ui-primitive"

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
})

ruleTester.run("no-inline-style", noInlineStyle, {
  valid: [
    { code: `<div className="p-4" />` },
    { code: `<div data-style="custom" />` },
  ],
  invalid: [
    { code: `<div style={{ color: "red" }} />`, errors: [{ message: /Inline style attribute is banned/ }] },
    { code: `<div style="color: red" />`, errors: [{ message: /Inline style attribute is banned/ }] },
  ],
})

ruleTester.run("require-ui-primitive", requireUiPrimitive, {
  valid: [
    { code: `<Button onClick={fn}>Click</Button>` },
    { code: `<Input value={v} />` },
    { code: `<div>text</div>` },
    { code: `<button>ok</button>`, filename: "components/ui/button.tsx" },
    { code: `<input type="text" />`, filename: "components/ui/input.tsx" },
  ],
  invalid: [
    { code: `<button onClick={fn}>Click</button>`, filename: "components/Card.tsx", errors: [{ message: /Raw <button> is banned/ }] },
    { code: `<input type="text" />`, filename: "pages/Home.tsx", errors: [{ message: /Raw <input> is banned/ }] },
    { code: `<select><option>A</option></select>`, filename: "components/Form.tsx", errors: [{ message: /Raw <select> is banned/ }] },
    { code: `<textarea rows={3} />`, filename: "components/Comment.tsx", errors: [{ message: /Raw <textarea> is banned/ }] },
    { code: `<dialog open>Hi</dialog>`, filename: "components/Modal.tsx", errors: [{ message: /Raw <dialog> is banned/ }] },
  ],
})
