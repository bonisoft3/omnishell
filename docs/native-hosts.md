---
type: concept
title: Native hosts
description: How a pronto app runs on Android and iOS — a headless JS engine behind native bridges, a DivKit SDUI renderer, and realworld's parity check against the web screens.
---

# Native hosts

The web terminal is a browser host: it owns the DOM, the SES compartments and
the binding vocabulary ([the terminal](terminal.md)). On Android and iOS **a
headless JS engine runs the app, and a declarative server-driven UI renderer
draws it**, held to the web screens by a parity check. `android/` is the
Android host and `ios/` the iOS one, with the same shape.

## The headless engine

The app's state machines, row binders and sync client run in a standalone
engine with no DOM, no window and no CSS parser:

- **Android**: [`QuickJsOmnishellEngine`](../android/src/main/kotlin/com/pronto/omnishell/QuickJsOmnishellEngine.kt), embedded QuickJS.
- **iOS**: [`JavaScriptCoreOmnishellEngine`](../ios/Sources/Omnishell/JavaScriptCoreOmnishellEngine.swift), the system `JSContext`.

Both implement one contract — `start()`, `dispatchAction(action)`, and the UI
tree as a stream — and are handed two native bridges:

1. **[`StorageBridge`](../android/src/main/kotlin/com/pronto/omnishell/bridge/StorageBridge.kt)**:
   SQLite ([`JdbcSqliteDatabase`](../android/src/main/kotlin/com/pronto/omnishell/storage/JdbcSqliteDatabase.kt) on Android,
   [`CSystemSqliteDatabase`](../ios/Sources/Omnishell/storage/CSystemSqliteDatabase.swift) on iOS) and key-value storage.
2. **[`NetworkBridge`](../android/src/main/kotlin/com/pronto/omnishell/bridge/NetworkBridge.kt)**:
   HTTP and Server-Sent Events through
   [`OkHttpFetchClient`](../android/src/main/kotlin/com/pronto/omnishell/network/OkHttpFetchClient.kt) and
   [`URLSessionFetchClient`](../ios/Sources/Omnishell/network/URLSessionFetchClient.swift).

## The renderer

Instead of HTML, the engine calls `emitUiAst(json)` with a tree in DivKit's
server-driven UI format, and the platform renders it natively —
[`DivKitAndroidViewRenderer`](../../../apps/realworld/android/app/src/main/kotlin/com/pronto/realworld/DivKitAndroidViewRenderer.kt)
mounts a `Div2View` in Jetpack Compose,
[`DivKitSwiftUIRenderer`](../../../apps/realworld/ios/Sources/RealWorld/DivKitSwiftUIRenderer.swift)
a `DivViewProvider` in SwiftUI. An interaction comes back as a URI intent,
`pronto://event/<ACTION>?<PARAMS>`, dispatched to the engine.

`apps/truco`'s motion would map onto DivKit's primitives: phase changes onto
`div-state` transitions run on the OS render thread, card and score movement
onto `div-animator`, celebrations onto the Lottie extension, and continuous
gesture physics onto a `div-custom` block mounting a native canvas inside the
layout tree.

## Declaring it, and holding it to the web

An app opts in with `capabilities: native: true` in its program, which the
emitter writes into `shell.yaml` beside `server:`; omitting it makes the app
web-only. `omnishell check parity <appDir>` (`check-parity.ts`) compares each
declared route's DivKit tree with the web screen's affordances: every input
with the same name and input mode, every action or navigation trigger with a
native peer. An app declaring no native target gets an advisory finding rather
than a failure.

The check is realworld's, not general. It evaluates
`ios/bundle/realworld_bundle.js`, else `android/bundle/realworld_bundle.js`,
unless `shell.yaml`'s `native` names a `bundle`, which the emitter never
writes; it reaches each route by dispatching realworld's own events; a route
the bundle did not draw falls back to static JSON (`shell/native/<screen>.json`,
`screens/<screen>.json`); and `normalizeTarget` knows realworld's routes and
actions by name. `test/check-parity.test.ts` runs it over realworld, and no
app's verbs run it ([pronto's pending](../../pronto/PENDING.md#screens)).

## Building and testing

`just test` in `android/` or `ios/` runs that platform's suite, `./gradlew test`
or `swift test`, through the directory's own `.vscode/tasks.json` test task. In
`plugins/omnishell`, `.say.yaml`'s `native` rule names both, but it ties
`builtin` at priority 0 and sorts after it by name, and `builtin`'s default
`stop` ends the verb, so `just test` there never reaches them.

## Rejected

- **A webview on Android and iOS** — a full browser engine inside one costs
  touch latency, memory and scroll smoothness.
- **A hand-written app per platform** — gives up the single declared source
  every compile-time check reads.
- **A canvas or game engine for an animated app** — a turn-based game's motion
  is state transitions, property animators and vector effects, which DivKit
  draws on the OS render thread, and `div-custom` holds the one native canvas
  continuous physics would need without leaving the platform model for the
  rest of the app.
