---
type: concept
title: Native hosts
description: How a pronto app runs on Android, iOS, and Desktop — a headless JS/Rust engine behind native bridges, deterministic DivKit and winio projection from Omnishell screen markup, and native 3D + audio presenters.
---

# Native hosts

The web terminal is a browser host: it owns the DOM, the SES compartments and
the binding vocabulary ([the terminal](terminal.md)). On phone and desktop **a
headless engine runs the app, and deterministic projections of `shell/screens/*.{html,css}`
drive the native UI**:

- **Phone** (`android/`, `ios/`): upstream DivKit (`com.yandex.div:div` `Div2View` on Android, `divkit-ios` `DivView` on iOS) with `DivVariableController` / `DivVariableStorage` for fast scalar updates and `div-custom` (`DivCustomContainerViewAdapter` / `DivCustomBlockFactory`) mounting Filament (`filament-android` Vulkan, iOS Metal) for `data-kinetic` 3D scenes.
- **Desktop** (`desktop/`): Rust [`winio`](https://github.com/compio-rs/winio) (AppKit on macOS, WinUI 3 on Windows, GTK 4 / Qt 6 on Linux) mounting a Bevy `wgpu` 3D child view (`RawWindowHandle`) for `data-kinetic` scenes.

## Deterministic projection from screen markup

`omnishell project native <appDir>` ([`project-native.ts`](../project-native.ts)) parses an app's `shell/screens/*.{html,css}`, `shell/design.css`, and `shell/shell.yaml` once into a bound `NativeScreenIr` and lowers it deterministically to two native back-ends:

1. **Phone (`projectScreenToDivKit`)**: emits a DivKit card JSON with `DivVariableController` variables for every input and `canvas[data-layer]` fast HUD slot, `div-custom` mounts for `data-kinetic="<actor>"` (`custom_type: "kinetic:<actor>"`) and `canvas[data-layer="<layer>"]` (`custom_type: "kinetic-layer:<layer>"`), and touch zone extensions (`data-touch-zone`, `data-touch-tap`), while omitting `.keys-only` nodes.
2. **Desktop (`projectScreenToWinio` / `emitWinioRustSource`)**: emits a Rust `winio` Elm-like (`init` / `update` / `render`) widget specification (`Window`, `StackPanel`, `Label`, `Button`, `Edit`, `Slider`, `LiveRegion`, `KineticSurface`, `HudLayer`) and evaluates CSS `[data-phase="..."]` state rules while omitting `.touch-only` nodes.

Because both native targets are pure functions of the vetted Omnishell screen markup, `realworld` and `apexrun` require no hand-authored per-platform UI trees or post-hoc parity diffing (`test/project-native.test.ts`).

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
server-driven UI format on phone (`OmnishellDivKitHost` in `android/` and `ios/`),
or renders the projected `WinioScreenSpec` on desktop (`omnishell-winio` in `desktop/`).
In-place scalar updates (such as 60–120 Hz HUD values) bypass JSON AST re-parsing
via `DivVariableController` (Android), `DivVariableStorage` (iOS), and direct
`winio` model messages (`DesktopMessage::UpdateScalar`) + orthographic HUD passes.
An interaction comes back as a URI intent, `pronto://event/<ACTION>?<PARAMS>`,
dispatched to the engine.

For `data-kinetic="<actor>"` 3D scenes (`apps/apexrun`), DivKit mounts a
`div-custom` view (`KineticDivCustomAdapter` on Android, `KineticDivCustomBlockFactory`
on iOS) backed by `FilamentKineticPresenter` (Vulkan/Metal), while `winio` mounts
a `KineticSurface` child view backed by `omnishell-bevy-presenter` (`wgpu` Metal/DX12/Vulkan),
driven by the deterministic stage `.glb` builder (`stage_gltf.js`) and C-ABI pose
struct (`pose_buffer.js`).

## Declaring it

An app opts in with `capabilities: native: true` in its program, which the
emitter writes into `shell.yaml` beside `server:`; omitting it makes the app
web-only. `omnishell project native --emit-bundle <appDir>` emits the runtime
bundle (`realworld_bundle.js`) directly from `shell/screens/*.{html,css}`, and
`test/project-native.test.ts` verifies that `apps/realworld` and `apps/apexrun`
project 100% of their inputs, actions, HUD layers, and touch zones with zero
opt-outs.

## Building and testing

- `deno test --config test/deno.json --allow-read test/project-native.test.ts` runs the markup projection suite.
- `./gradlew test` in `android/` and `apps/realworld/android/` runs the Android JUnit suites.
- `swift test` in `ios/` and `apps/realworld/ios/` runs the Swift Package suites.
- `cargo test` in `desktop/` runs the reusable `winio`, Bevy presenter, and synth audio suites, and `cargo test` in `apps/apexrun/desktop/` runs the Apex Run GGRS rollback and headless simulation host suites.

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
