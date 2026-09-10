import { RuleTester } from "eslint"
import { noNestedScroll } from "../../src/lint/eslint/rules/no-nested-scroll"
import { requireErrorBoundary } from "../../src/lint/eslint/rules/require-error-boundary"

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
})

ruleTester.run("no-nested-scroll", noNestedScroll, {
  valid: [
    { code: `<div className="overflow-auto"><p>content</p></div>` },
    { code: `<div className="overflow-hidden"><p>content</p></div>` },
    { code: `<div className="p-4"><div className="overflow-auto">list</div></div>` },
  ],
  invalid: [
    { code: `<div className="overflow-auto"><div className="overflow-auto">nested</div></div>`, errors: [{ message: /Nested scrollable container detected/ }] },
    { code: `<div className="overflow-scroll"><div className="overflow-y-auto">nested</div></div>`, errors: [{ message: /Nested scrollable container detected/ }] },
  ],
})

ruleTester.run("require-error-boundary", requireErrorBoundary, {
  valid: [
    { code: `export default function Page() { return <ErrorBoundary><Content /></ErrorBoundary> }`, filename: "routes/home.tsx" },
    { code: `export default function Page() { return <div>hi</div> }`, filename: "components/Card.tsx" },
    { code: `export const Component = () => <ErrorBoundary fallback={<p>err</p>}><App /></ErrorBoundary>`, filename: "routes/index.tsx" },
  ],
  invalid: [
    { code: `export default function Page() { return <div>hi</div> }`, filename: "routes/home.tsx", errors: [{ message: /Route files must include an ErrorBoundary/ }] },
    { code: `export default function Page() { return <Layout><Content /></Layout> }`, filename: "routes/settings.tsx", errors: [{ message: /Route files must include an ErrorBoundary/ }] },
  ],
})
