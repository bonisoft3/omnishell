# omnishell

Two halves live in this directory, and which one you want depends on what you
are building.

**The interpreter** (`interpreter/`) runs a pronto app's screens: a screen is
HTML, a `data-live` region is a standing query in PostgREST's filter grammar, a
form is the only way to change data, and a Jessie reduce is a pure function from
rows to writes. Nothing here is React.

> **Writing an app? Start with [GUIDE.md](GUIDE.md).** It covers the
> reduce contract, what wakes it and what it receives, the rules that bite, and
> the mappings to Elm/TEA, Datalog, htmx and Datomic. `apps/shadcnui` is the
> worked gallery for the presentation vocabulary; `apps/chess` is the reference
> for the data plane.

**The React library** (`src/`, published as `@omnishell/core`) is a frontend
framework that makes UI bugs harder to introduce: fewer patterns, stricter
types, architectural rails over flexibility. Auth, layout, and the lint presets
are documented below.

## The interpreter

| Concern | Where |
|---|---|
| Writing a screen — the contracts, in one page | [GUIDE.md](GUIDE.md) |
| Region grammar, bindings, forms, clicks | `interpreter/screen.js` (the comments are the spec) |
| The reduce sandbox and its denylist | `plugins/pronto/jessie.ts` |
| What may be declared: entities, screens, forms, seeds | `plugins/pronto/schema.cue` |
| Emission — markup, `shell.yaml`, compose, docker | `plugins/pronto/write.ts` |
| Design tokens and presets | `plugins/pronto/styles.ts`, `apps/shadcnui` |
| Terminal doctrine, the event surface, the arguments | [`docs/`](docs/) |
| Every `data-*`, with its meaning | [`docs/2026-07-30-the-binding-vocabulary.md`](docs/2026-07-30-the-binding-vocabulary.md) |
| Changing the interpreter itself | [CONTRIBUTING.md](CONTRIBUTING.md) |

The interpreter is loaded by `interpreter/shell.js` at runtime; it is plain ES
modules and takes no build step.

## The React library

### Auth

Pluggable biometric-first authentication with WebAuthn as the default.

```typescript
import { createAuth, WebAuthnAdapter, MemoryStorage } from "@omnishell/core"

const auth = createAuth({
  biometric: new WebAuthnAdapter({ rpName: "My App", rpID: "myapp.com", origin: "https://myapp.com" }),
  storage: new MemoryStorage(),
  secret: process.env.AUTH_SECRET,
})
```

Browser-only mode (no server):

```typescript
import { LocalStorageAdapter, createBrowserSessionManager } from "@omnishell/core"
```

### Firebase adapter

Snapcards (and any mecha-v2 app using Firebase Auth) can plug `FirebaseAdapter` in as the omnishell biometric adapter. The adapter treats a Firebase ID token as the "biometric response" — server-side verification is delegated to `firebase-admin`.

#### Server wiring

```ts
import { createAuth, FirebaseAdapter, MemoryStorage } from "@omnishell/core"
import { initializeApp, cert } from "firebase-admin/app"
import { getAuth } from "firebase-admin/auth"

const app = initializeApp({ credential: cert(serviceAccountJson) })

export const auth = createAuth({
  biometric: new FirebaseAdapter({ auth: getAuth(app) }),
  storage: new MemoryStorage(),
  secret: process.env.OMNISHELL_SESSION_SECRET!,
})
```

#### Client wiring

The UI obtains a Firebase ID token using the Firebase Web SDK directly — anonymous sign-in, email/password, Google popup, or phone are all supported as long as they produce a `firebase.User` whose `getIdToken()` method works. The `exchangeFirebaseToken` helper exchanges that token for an omnishell session cookie:

```ts
import { getAuth, signInAnonymously } from "firebase/auth"
import { exchangeFirebaseToken } from "@omnishell/core"

async function continueAsGuest() {
  const cred = await signInAnonymously(getAuth())
  const idToken = await cred.user.getIdToken()
  const { userId } = await exchangeFirebaseToken(idToken)
  // omnishell session cookie is now set; userId matches cred.user.uid
}
```

The same helper is used for every Firebase sign-in method — `signInWithEmailAndPassword`, `signInWithPopup(new GoogleAuthProvider())`, phone auth, etc. Only the Firebase Web SDK call differs; the exchange step is identical.

### Layout

Config-driven sidebar/bottom-nav with responsive breakpoints.

```typescript
import { createLayout } from "@omnishell/core"
import { Home, Settings } from "lucide-react"

const { AppShell } = createLayout({
  items: [
    { path: "/", label: "Home", icon: Home },
    { path: "/settings", label: "Settings", icon: Settings },
  ],
})
```

### Lint

10 ESLint rules enforcing architectural rails + Tailwind preset.

```typescript
// eslint.config.mjs
import { omnishellLint } from "@omnishell/core/lint/eslint"
export default [...omnishellLint]
```

### Visual Lint (Playwright)

Deterministic layout checks + AI vision review.

```typescript
import { visualLint, assertVisualLint } from "@omnishell/core/lint/playwright/visual-lint"
import { assertVisionReview } from "@omnishell/core/lint/playwright/vision-review"
```

### Storybook

AI component review + regression gate.

```typescript
import { reviewComponentScreenshot, detectRegression } from "@omnishell/core/lint/storybook/ai-review"
```

### Distribution

Omnishell is consumed as TypeScript source, which is what makes HMR work — edit a lint rule, see the change immediately. The cost is that ESLint under Node ESM cannot resolve extensionless `.ts` inter-module imports, so a consumer either builds a bundle on demand and loses HMR, or runs ESLint under a resolver that handles `.ts`.

Resolving it means making omnishell a **workspace package**, so bun and pnpm resolve the imports natively. Neither path below is built.

**Monorepo (bun workspace):**
1. Add omnishell to the root `package.json` workspaces: `"plugins/omnishell"`
2. Consumers depend on `"@omnishell/core": "workspace:*"`
3. Import directly from source: `import { omnishellLint } from "@omnishell/core/lint/eslint"`
4. Bun resolves `.ts` imports natively — no build step, full HMR
5. ESLint must run via `bun eslint` (not `npx eslint`) so bun's resolver handles `.ts`
6. Add proper `"exports"` field to package.json mapping subpath patterns to source files

**External (copybara-published repo):**
1. Copybara syncs omnishell to its own repo
2. CI runs `tsup` or `bun build` to produce ESM+CJS bundles
3. Publish to npm as `@omnishell/core`
4. External consumers install from npm — same import paths, built output

**Also affected:** `createLayout` and `createAuth` — any consumer reaching them via relative paths (`../../../src/...`) breaks in worktrees. With workspace linking, these become `@omnishell/core/layout` and `@omnishell/core/auth`.

## Development

```bash
just setup     # install bun via mise
just build     # typecheck (tsc --noEmit)
just test      # the deno unit suite over test/
just integrate # Docker build, then that suite plus this target's share of the smokes
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers which test tier can see which kind of
change, and the two invariants to preserve when touching the interpreter.
