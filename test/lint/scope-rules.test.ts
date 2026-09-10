import { RuleTester } from "eslint"
import { noFetchInComponents } from "../../src/lint/eslint/rules/no-fetch-in-components"
import { noApply } from "../../src/lint/eslint/rules/no-apply"

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
})

ruleTester.run("no-fetch-in-components", noFetchInComponents, {
  valid: [
    { code: `fetch("/api/data")`, filename: "actions/submit.ts" },
    { code: `useEffect(() => {}, [dep])`, filename: "actions/load.ts" },
    { code: `fetch("/api")`, filename: "components/ui/combobox.tsx" },
    { code: `const x = useState(false)`, filename: "components/Card.tsx" },
    { code: `useEffect(() => {})`, filename: "components/Card.tsx" },
  ],
  invalid: [
    { code: `fetch("/api/data")`, filename: "components/Card.tsx", errors: [{ message: /fetch\(\) is banned in components/ }] },
    { code: `useEffect(() => {}, [userId])`, filename: "components/Profile.tsx", errors: [{ message: /useEffect with dependencies is banned in components/ }] },
    { code: `import axios from "axios"`, filename: "components/Form.tsx", errors: [{ message: /axios is banned in components/ }] },
    { code: `import { useQuery } from "@tanstack/react-query"`, filename: "components/List.tsx", errors: [{ message: /react-query is banned in components/ }] },
    { code: `import { create } from "zustand"`, filename: "components/Store.tsx", errors: [{ message: /zustand is banned in components/ }] },
  ],
})

ruleTester.run("no-apply", noApply, {
  valid: [
    { code: `const x = "bg-red-500"` },
    { code: `const css = ".foo { color: red; }"` },
  ],
  invalid: [
    { code: `const css = "@apply bg-red-500"`, errors: [{ message: /@apply is banned/ }] },
    { code: 'const x = `@apply flex items-center`', errors: [{ message: /@apply is banned/ }] },
  ],
})
