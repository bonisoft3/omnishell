import { RuleTester } from "eslint"
import { noRawZindex } from "../../src/lint/eslint/rules/no-raw-zindex"
import { noRawSpacing } from "../../src/lint/eslint/rules/no-raw-spacing"
import { noRawColors } from "../../src/lint/eslint/rules/no-raw-colors"
import { noUnconstrainedPosition } from "../../src/lint/eslint/rules/no-unconstrained-position"

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
})

ruleTester.run("no-raw-zindex", noRawZindex, {
  valid: [
    { code: `<div className="z-[var(--z-nav)]" />` },
    { code: `<div className="bg-red-500" />` },
    { code: `cn("z-[var(--z-overlay)]")` },
  ],
  invalid: [
    { code: `<div className="z-50" />`, errors: [{ message: /Raw z-index class "z-50"/ }] },
    { code: `<div className="z-10 p-4" />`, errors: [{ message: /Raw z-index class "z-10"/ }] },
    { code: `cn("z-auto")`, errors: [{ message: /Raw z-index class "z-auto"/ }] },
    { code: `<div className="z-0" />`, errors: [{ message: /Raw z-index class "z-0"/ }] },
  ],
})

ruleTester.run("no-raw-spacing", noRawSpacing, {
  valid: [
    { code: `<div className="p-4 m-8" />` },
    { code: `<div className="gap-2" />` },
    { code: `cn("px-6")` },
  ],
  invalid: [
    { code: `<div className="p-[13px]" />`, errors: [{ message: /Arbitrary spacing/ }] },
    { code: `<div className="m-[2.5rem]" />`, errors: [{ message: /Arbitrary spacing/ }] },
    { code: `cn("gap-[7px]")`, errors: [{ message: /Arbitrary spacing/ }] },
  ],
})

ruleTester.run("no-raw-colors", noRawColors, {
  valid: [
    { code: `<div className="bg-primary text-muted-foreground" />` },
    { code: `<div className="border-red-500" />` },
    { code: `cn("text-blue-200")` },
  ],
  invalid: [
    { code: `<div className="bg-[#ff00ff]" />`, errors: [{ message: /Raw color value/ }] },
    { code: `<div className="text-[rgb(255,0,0)]" />`, errors: [{ message: /Raw color value/ }] },
    { code: `cn("bg-[hsl(120,100%,50%)]")`, errors: [{ message: /Raw color value/ }] },
  ],
})

ruleTester.run("no-unconstrained-position", noUnconstrainedPosition, {
  valid: [
    { code: `<div className="relative" />` },
    { code: `<div className="absolute" />` },
    { code: `<div className="fixed" />`, filename: "components/layout/Header.tsx" },
    { code: `<div className="sticky" />`, filename: "components/ui/sheet.tsx" },
  ],
  invalid: [
    { code: `<div className="fixed" />`, filename: "components/Card.tsx", errors: [{ message: /Position class "fixed"/ }] },
    { code: `<div className="sticky" />`, filename: "pages/Home.tsx", errors: [{ message: /Position class "sticky"/ }] },
  ],
})
