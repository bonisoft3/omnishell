# Native and Server-Driven UI (SDUI) Hosts

The web virtual terminal ([`terminal-doctrine`](2026-08-02-terminal-doctrine.md)) is a browser host:
it owns the DOM window, SES compartments, LinkeDOM static evaluation, and the
binding vocabulary (`data-live`, `data-filter`, `data-machine`).

On mobile platforms (Android and iOS), running a full browser engine inside an
opaque webview defeats the performance and feel of local applications: touch
responsiveness lags, memory footprints bloat, and gesture-driven scrolling
stutters. Conversely, authoring independent native applications per platform
destroys the Pronto doctrine of compile-time invariant checking and declarative
single-source architecture.

The native host resolves this dilemma through a decoupled **headless engine +
declarative SDUI renderer** architecture, verified by compile-time semantic parity.

---

## 1. The Headless Engine and SDUI Host Architecture

The native tier splits into two decoupled planes:

```
┌──────────────────────────────────────────────────────────┐
│                   Native Platform Host                   │
│                                                          │
│  ┌─────────────────────────┐   pronto://event/ACTION     │
│  │   Declarative UI View   │ ─────────────────────────┐  │
│  │      (DivKit SDUI)      │                          │  │
│  │   • Jetpack Compose     │ ◄─────────────────────┐  │  │
│  │   • SwiftUI             │       emitUiAst()     │  │  │
│  └─────────────────────────┘      (JSON tree)      │  │  │
│                                                    │  │  │
│  ┌─────────────────────────────────────────────────┼──┼──┤
│  │   Headless JS Engine                            │  │  │
│  │   (QuickJS / JavaScriptCore)                    │  │  │
│  │                                                 │  │  │
│  │   • App Bundle (Compiled Pronto Screen State)   │  │  │
│  │   • ElectricSQL / SQLite Sync Client            │  │  │
│  │   • Machine Transition Evaluator                │  │  │
│  │                                                 │  │  │
│  │   Native Bridges:                               │  │  │
│  │   ┌─────────────────────┐ ┌──────────────────┐  │  │  │
│  │   │    StorageBridge    │ │  NetworkBridge   │  │  │  │
│  │   │  • SQLite / KV      │ │  • Fetch / SSE   │  │  │  │
│  │   └─────────────────────┘ └──────────────────┘  │  │  │
│  └─────────────────────────────────────────────────┘──┘──┘
└──────────────────────────────────────────────────────────┘
```

### The Headless Engine Runtime
The application's state machines, row binders, and client sync loop execute
inside a light, standalone JavaScript runtime:
- **Android**: [`QuickJsOmnishellEngine`](../android/src/main/kotlin/com/pronto/omnishell/QuickJsOmnishellEngine.kt) via embedded QuickJS.
- **iOS**: [`JavaScriptCoreOmnishellEngine`](../ios/Sources/Omnishell/JavaScriptCoreOmnishellEngine.swift) via system `JSContext`.

The engine has no DOM, no window object, and no CSS parser. It is provided with
two platform-native capability bridges:
1. **[`StorageBridge`](../android/src/main/kotlin/com/pronto/omnishell/bridge/StorageBridge.kt)**:
   Exposes native SQLite databases ([`JdbcSqliteDatabase`](../android/src/main/kotlin/com/pronto/omnishell/storage/JdbcSqliteDatabase.kt) on Android,
   [`CSystemSqliteDatabase`](../ios/Sources/Omnishell/storage/CSystemSqliteDatabase.swift) on iOS) and key-value storage.
2. **[`NetworkBridge`](../android/src/main/kotlin/com/pronto/omnishell/bridge/NetworkBridge.kt)**:
   Exposes HTTP request/response handling and streaming Server-Sent Events (SSE) via
   [`OkHttpFetchClient`](../android/src/main/kotlin/com/pronto/omnishell/network/OkHttpFetchClient.kt) and
   [`URLSessionFetchClient`](../ios/Sources/Omnishell/network/URLSessionFetchClient.swift).

### The Declarative Renderer (DivKit SDUI)
Instead of HTML/CSS, the engine evaluates screen state and calls `emitUiAst(jsonString)`.
The emitted JSON conforms to the DivKit Server-Driven UI specification.
Platform-native hosts render this JSON directly into native UI primitives:
- On Android, [`DivKitAndroidViewRenderer`](../../apps/realworld/android/app/src/main/kotlin/com/pronto/realworld/DivKitAndroidViewRenderer.kt) mounts `Div2View` inside Jetpack Compose.
- On iOS, [`DivKitSwiftUIRenderer`](../../apps/realworld/ios/Sources/RealWorld/DivKitSwiftUIRenderer.swift) mounts `DivViewProvider` into SwiftUI via `UIViewRepresentable`.

UI interactions emit standard URI intents (`pronto://event/<ACTION>?<PARAMS>`)
dispatched back to the engine via `onAction`.

---

## 2. Target Symmetry: `server: true` and `native: true`

Just as Pronto programs declare backend tier durability through `server: true`
in `shell.yaml` (omission indicates device-local / tab-local operation), an app
declares whether it targets native mobile shells through `native: true`:

```yaml
# apps/realworld/shell/shell.yaml
server: true
native: true
routes:
  - path: /
    screen: home
```

When `native` is omitted or set to `false`, the app is designated web-only.
Tooling and CI checks skip native requirements with an advisory notice without
failing the verification pipeline.

---

## 3. Semantic Parity Verification ([`check-parity.ts`](../check-parity.ts))

To ensure web markup and native SDUI representations never drift, Omnishell
implements compile-time semantic parity checking:

```
                  ┌──────────────────────┐
                  │   App Screen HTML    │
                  └──────────┬───────────┘
                             │ linkedom AST extraction
                             ▼
┌────────────────────────────────────────────────────────┐
│               Semantic Affordance Model                │
│ • Inputs (text, textarea, select, checkbox)            │
│ • Action Triggers (links, buttons, commands)           │
│ • State Machine Selectors & Identifiers                │
└────────────────────────────┬───────────────────────────┘
                             ▲
                             │ DivKit JSON traversal
                  ┌──────────┴───────────┐
                  │    Native UI AST     │
                  └──────────────────────┘
```

`check-parity` evaluates the app's native bundle, intercepts the emitted SDUI
tree across all declared routes, and verifies that:
1. Every input, select, and form element in the HTML screen exists in the native AST with matching names.
2. Every interactive button or navigation link has a corresponding native action affordance.
3. Machine-driven controls (`commandfor`, `data-action`) preserve their target states across both tiers.

Any drift fails compile-time verification before native binaries are packaged.

---

## 4. Animation and Non-CRUD Applications (The Truco Doctrine)

Applications like [`apps/truco`](../../apps/truco) rely heavily on 2D motion:
card deals, score chip animations, speech bubbles, and phase transitions.

A common question is whether dynamic or animated applications require an entirely
different platform (such as a canvas or game engine). Within Omnishell, they do not.
Truco is fundamentally a declarative turn-based game whose animations fall into
standard motion primitives supported by DivKit:

1. **State Transitions (`div-state`)**:
   Phase changes (e.g. `data-phase="raised"` or card resolution) map to `div-state`
   transitions, which execute hardware-accelerated translations, scales, and fades
   directly on the OS render thread.
2. **Property Animators (`div-animator`)**:
   Card movements and score indicators translate across coordinates ($X, Y$, rotation,
   alpha) declaratively without continuous imperative tick loops.
3. **Micro-Effects (Lottie)**:
   Vector celebrations and ambient effects run via DivKit's first-class Lottie extension.
4. **Escape Hatch (`div-custom`)**:
   If an application ever requires continuous gesture physics (e.g. throwing cards
   with inertia), DivKit allows embedding a `div-custom` block. This mounts a focused
   native Compose or SwiftUI canvas view within the DivKit layout tree without abandoning
   the platform model for the rest of the application.

---

## 5. Toolchain & Test Portability (`mise` + `dax`)

Native SDKs (Gradle, Android SDK, Xcode, Swift) are heavy and platform-dependent.
To keep testing portable and isolated:
- **Deno + `dax` runner**: Native engine test suites run through a Deno script
  using `@david/dax`, ensuring cross-platform directory navigation and execution
  across macOS, Linux, and Windows without relying on raw POSIX shell shims.
- **Mise Toolchain Management**: Gradle and Java are managed via `.mise.toml`
  (contributed by CUE definitions during project scaffolding). This eliminates
  the need to check in binary `.jar` wrappers (`gradle-wrapper.jar`) or script files
  inside application repositories.
- **Opt-in Gate**: Native builds and tests do not execute by default in root
  smokes; they are triggered via `say: test-native:` or when `OMNISHELL_NATIVE=1` is set.

---

## 6. Future Expansion: Desktop and Tauri

While DivKit provides high fidelity on mobile devices, desktop distribution
presents distinct trade-offs:
- **Tauri / WRY Integration**: For desktop distribution (macOS, Windows, Linux),
  Tauri provides a tiny binary footprint by pairing a Rust host runtime with the
  operating system's native webview (WebKit on macOS, WebKitGTK on Linux, WebView2 on Windows).
- **Architecture Reuse**: A Tauri host can mount the existing web virtual terminal
  directly while bridging filesystem, SQLite, and system notifications via Tauri's
  Rust IPC commands, mirroring the `StorageBridge` and `NetworkBridge` contracts.
- **Unified Distribution Ladder**:
  - **Browser**: Web Virtual Terminal (HTML + CSS + SES).
  - **Mobile**: Headless JS Engine + DivKit SDUI (Jetpack Compose / SwiftUI).
  - **Desktop**: Tauri + Rust Host (Local Web Terminal + Native IPC).
