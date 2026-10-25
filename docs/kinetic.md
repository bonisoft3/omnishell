---
type: concept
title: Kinetic host
description: "Fixed-step tick engine, snapshot ring buffer, and time-travel controller for high-frequency interactive simulations."
---

# Kinetic host

Pronto's state lives in two planes ([[../../pronto/docs/component-contracts#Dual planes and the kinetic contract|dual planes]]). The DOM plane moves durable rows by IVM and presents them with HTML and CSS, one to many at a round trip per change. The kinetic plane moves a deterministic engine's frames below `tab` (35Hz, 60Hz, 120Hz physics loops) by rollback with prediction and presents them on canvas, few to few with no latency felt. The DOM plane composes the kinetic one, which reaches rows only through the milestones its child lifts ([[../../pronto/docs/decisions/2026-10-23-kinetic-machine|the kinetic-machine record]]).

Omnishell's `createKineticHost` provides a fixed-step tick engine that decouples physical simulation from variable display refresh rates, maintains an in-memory snapshot ring buffer, and exposes frame-accurate bidirectional time-travel.

## The engine contract

A kinetic simulation conforms to the pure engine interface:

```typescript
export interface KineticEngine<S, C, B, O = any> {
  rateHz?: number;
  initState(seed: number, options?: O): S;
  advanceFrame(state: S, cmd: C): S;
  saveState(state: S): B;
  loadState(snapshot: B): S;
}
```

The engine must satisfy algebraic isomorphism and determinism:
- **Algebraic isomorphism**: $\text{loadState}(\text{saveState}(s)) \equiv s$.
- **Referential transparency**: $\text{advanceFrame}(s, c) = \text{advanceFrame}(s, c)$ for all valid inputs.
- **Rollback invariance**: Rewinding to tick $T$ and re-simulating inputs $c_T \dots c_{T+k}$ produces a bit-exact identical state to the forward run within the runtime, which the sync test below checks frame by frame.

## A Jessie engine

An app declares an engine in its program, `surface.engines.<name>: {src, note}`.
`src` is the entry of a module graph that exports the four functions above;
`rateHz` stays the host's option.

- **The modules import each other.** Imports are static declarations
  (`import {step} from "./step.js"`) of relative literal paths to the app's
  own `.js` files.
- **pronto's derive links the graph** (`engine-link.ts`). Endo's ModuleSource
  precompiles each module the entry reaches. Each module is scanned on its
  own in the `engine` role, which is endowed with nothing. The graph is
  written to `shell/engines/<name>.json`, which the terminal serves.
- **The link refuses**, naming the module:
  - a denied name, `import()` or `import.meta`;
  - a package or URL specifier;
  - a path out of the app, or one that is no Jessie module path;
  - a missing file.

  Cycles link as ES modules do.
- **The terminal loads it.** `evaluateEngine(graph)` (`interpreter/jessie.js`)
  imports the graph in one Compartment. Each module evaluates once, under
  the lockdown, with no endowments. The engine reaching one throws, saying
  it is endowed with nothing.
- **The result** is the entry's module namespace, refused unless it exports
  the contract. It is what `createKineticHost` takes as its `engine`.

Why the link is Endo's and happens at build time is
[[../../pronto/docs/archive/2026-10-23-jessie-import|pronto's record]].

## Sync test

GGPO's SyncTestSession, inside one host: `createKineticHost({syncTest: N})`
re-checks rollback invariance on every tick instead of trusting it. After
committing tick $T$ it loads the snapshot at $T-N$, re-simulates the logged
commands $c_{T-N+1} \dots c_T$, and holds each re-simulated frame's checksum
to the forward run's: `checksum(canonical(saveState(s)))`, where `canonical`
sorts object keys so construction order does not count, and `checksum` is a
53-bit hash, a check and not a defence. The first frame that disagrees throws,
naming itself and where its window started, through `onFault`. `N` must be
below `historyLimit`; 0 is off. It costs `N + 1` advances a tick, so it runs in
tests over recorded command logs (Apex Run's `tests/sync.test.ts`, eight frames
back) and in a development launch on request (a kinetic child's page with
`?synctest=8`), never in a release.

A renderer is a view of the host's frames, not a peer: what it draws never
returns as state or input, so the sync test checks the engine alone, and a
renderer only has to survive the frames running backwards (the presenter in
[[terminal#The seats|the seats]]).

## A rollback session

Two seats raced over a channel are GGPO's peer-to-peer session, not a host's
loop: `createRollbackHost` (`interpreter/kinetic-session.js`) runs GGRS 0.13
([gschup/ggrs](https://github.com/gschup/ggrs)), built to Wasm from
`tools/ggrs-wasm` into `interpreter/vendor/ggrs`, whose socket is two queues
the host fills and drains, so the session reaches nothing itself. Each tick
the host polls the session, adds this seat's input as the byte the engine's
`encodeInput` makes, and answers the session's requests in order: save a frame
(`saveState`, its checksum as the sync test's), load one, advance one with
every seat's bytes through the engine's `decodeInputs`. A late input loads the
frame it changed and advances again to the present; the peers compare their
checksums every ten frames, and a difference throws. `session: "synctest"`
runs GGRS's own sync test with both seats here.

The channel is `{send(bytes), onMessage(handler)}`. `rtc-channel.js` makes one
from an unordered, never-retransmitted `RTCDataChannel` — the datagram GGRS
expects — out of two descriptions its caller signals, each sent once ICE
gathering completes, over the `iceServers` its caller hands
`RTCPeerConnection`. The kinetic child hands the terminal config's
(`shell.json`'s `iceServers`), which the release target writes and an app
never declares ([pronto's release targets](../../pronto/docs/release-targets.md#ice-servers)):
none in a dev or CI stack, where peers share a machine or a network, and a
STUN server in a release, so two behind NATs find each other. A config
without the list is refused when a race goes online.
`stop()` holds the race and keeps the session answering its peer, which GGRS
otherwise drops after `disconnectMs` (ten seconds).

## Milestones

A host lifts the engine's milestones into the DOM plane
(`interpreter/kinetic-milestones.js`). The engine names them:
`milestones(state)` returns the kinds a frame's state reaches,
`[{kind, ...detail}]` — Apex Run's start, checkpoint, time over, finish and
duel finish, read off the frame's events. A milestone lifts only once its
frame is confirmed, and is then `{frame, kind, detail, checksum, from,
width, inputs}`: `inputs` is every frame's commands since the milestone at
`from`, `width` bytes a frame, as one base64 string, and `checksum` is the
sync test's over the frame's `saveState`. A kind named in `snapshots` also
carries that state.

- `createKineticHost({milestones: {width, encode, decode, onLift, snapshots}})`
  steps one seat holding all its input, so each frame it commits is
  confirmed as it is taken; `encode` makes a frame's command its bytes and
  `decode` undoes it.
- `createRollbackHost({milestones: {onLift, snapshots}})` lifts at GGRS's
  confirmed frame (`Rollback.confirmed_frame`, the last frame every seat's
  input has arrived for), both seats' bytes a frame; a milestone reached at
  a predicted frame waits, and a rollback before it is confirmed takes it
  back unlifted. Both peers lift the same rows.
- `host.loadMilestone(rows, i)` makes milestone `i` the head: its snapshot,
  or the race replayed from the seed through every row's inputs, held to
  the row's checksum. It is how scrubbing the rows' history reaches the
  kinetic plane.
- A branch or a rollback never crosses a lifted milestone: a frame at or
  before one is the row's, and simulating it again throws.

Apex Run's `tests/milestones.test.ts` lifts its recorded runs and loads each
milestone back to the forward run's checksum; omnishell's
`test/kinetic_milestones.test.ts` holds two peers over a lossy channel to
the same rows.

## The kinetic child

A screen hosts a race as a Cortex `via: "kinetic"` child
([[../../pronto/docs/cortex#Kinetic|pronto's Cortex]]): shell.json's
`kinetic.<actor>` names the linked engine and sound graphs, the presenter unit
and the input bindings, and the screen's `data-kinetic="<actor>"` mount is
where the terminal starts it (`interpreter/kinetic-mount.js`). No app script
starts a race. The mount sits in a slot region, whose row is its input:

- **In, as the mount's `data-prop-*`.** A new `seed` is a new race,
  `engine.optionsOf(props)` its options; `input` is `car` while the car reads
  the keys and `menu` otherwise; `clock` is `play` or `hold`, acted on when it
  turns. Every prop also reaches the sound role's `props`.
- **Out, as events on the mount** the region's `data-on-*` hands its reduce:
  `milestone`, each lifted row with the `race` (seed) it belongs to;
  `menu`, `{action, n}`, each press of the actor's `menu` bindings while the
  row holds the input, and of its `pause` bindings always; and for an online
  race `describe`, `{race, description}`, this side's session description.
  A gamepad's menu is polled every animation frame, held race or none.
- **Online, a rollback session.** `mode: online` races the row's `seat` (0
  or 1) as GGRS's peer (`createRollbackHost`) over an `rtc-channel.js`
  channel, seat 0 the initiator: the mount raises its description once ICE
  gathering completes and takes the peer's as the `peer` prop, so the row's
  machine signals the channel. The grid stands drawn until the channel
  opens; the session then plays on its own clock, which `clock` does not
  hold. Its milestones lift at GGRS's confirmed frame, both seats' bytes a
  frame, and the engine exports `encodeInput` and `decodeInputs` for it.
- **The car reads nothing it is not handed.** Under `menu` the engine gets a
  released stick (`engine.commandOf({})`), and what was pressed meanwhile is
  dropped before the car reads again. A hot-seat race (`mode: hotseat`) reads
  each of the actor's `seats` bindings.

Past the host's four functions a child's engine exports `optionsOf(props)`,
`viewOf(state, props)` (what is drawn and heard), `commandOf(poll)` (a mapper's
poll as a frame's command), and `commandWidth`, `encodeCommand`,
`decodeCommand` and `milestones` for the lift. Its sound role's `createSound`
answers `frame(state)` each committed frame (and the last one, again, while
the race is held), `props(props)`, `levels()` for the presenter and `resume()`
at a gesture. While the presenter reads a stage's art the race holds and the
mount wears `data-kinetic-loading`; once frames draw with nothing loading it
wears `data-kinetic-ready`. A `[data-kinetic-controls="<actor>"]` on the screen
gets the host's `mountControls`.

## Touch

Touch is the input mapper's third source, beside the keyboard and a gamepad
(`attachTouch` in `interpreter/kinetic.js`, and `createKineticInput`'s
`touch`): an element's `data-touch-zone` names zones, and zone `z` is the key
`touch:z` an action's bindings list, so a touch makes the same command bits
a key does and the sync test, the milestones, a rollback duel and a replay
see nothing new. The app lays its zones out in its markup and styles them;
the platform reads them.

- **One tracker a root.** `attachTouch(root)` follows the root's pointers
  once, and every mapper `listen`s to it, so a move hit-tests once however
  many mappers read the zones.
- **A pointer holds the zones under it.** An element may name several
  (`data-touch-zone="drive left"`), and the finger follows as it slides: the
  zone it enters is held before the one it leaves is let go, so two halves of
  a pad sharing a zone keep it held across. A zone stays held while any
  pointer is on it.
- **A pointer is followed from a zone until it lifts.** One that goes down
  on a zone is captured to the root and followed wherever it goes: off every
  zone it holds none, and sliding back onto one holds it again. Lifting, a
  cancel, a lost capture, the window's blur or the document going hidden lets
  go, as GameInputs lets go of its keys. A finger that goes down off every
  zone is the page's, and never becomes a press by sliding onto one. A zone
  marked `data-touch-tap` (a pause, a menu key) is held only by a finger
  that goes down on it, never by one sliding onto it from another.
- **A zone is a key to the browser.** The tracker adopts one stylesheet a
  document that gives every zone `touch-action: none` (what stops a pan or a
  zoom, which a pointerdown's `preventDefault` does not) and no selection,
  callout or tap highlight; a zone's pointerdown is also prevented, so no
  mouse is emulated.
- **What is held is shown.** The root wears the held zones, space-separated,
  as `data-touch-held`, written when it changes, so the app's controls light
  up under a thumb.
- **The kinetic child's zones are its screen's.** The mount tracks its closest
  `[data-screen]` (a mount outside one is refused), so a car, each hot seat
  and the menu read their own zones from one layout, and the menu's `touch:`
  presses reach the row as its keys do. The screen wears
  `data-kinetic-touch` on a coarse-pointer device, and on any other once a
  finger touches it: the one switch the app's touch controls and touch layout
  key on, by device class rather than by user agent.
- **A held finger after the race is a held key.** Under `menu` the car's
  mapper is cleared each frame, so a thumb left on the pad, or a tap then,
  reaches neither the race's last frames nor the next race
  (`test/kinetic_touch.test.ts`).
- **Sound starts on a touch's end.** The mount resumes the sound role on a
  key, a pointer's down and up, and a click: WebKit grants a gesture at a
  touch's end, not its start.

## Fixed-step accumulator and clock clamp

Variable display refresh rates (`requestAnimationFrame`) produce non-uniform time deltas. The kinetic host buffers elapsed real time in a millisecond accumulator:

$$\text{accumulator} \mathrel{+}= \min(250\,\text{ms}, \Delta t)$$

While $\text{accumulator} \ge \frac{1000}{\text{rateHz}}$, the engine steps forward by one tick and commits a snapshot to the ring buffer. When backgrounded or stalled, the accumulator clamps to 250ms to prevent the "spiral of death" burst of catch-up ticks.

## Host API

The host manages playback and timeline navigation:
- **`start()` / `stop()`**: Starts the animation loop via injected or platform `schedule` (e.g. `requestAnimationFrame`) and tears it down via `cancel`.
- **`pause()` / `play()` / `togglePlay()`**: Toggles active tick advancement.
- **`pump(elapsedMs)`**: Drives fixed-step simulation explicitly with an elapsed millisecond delta.
- **`stepTick(cmd?)`**: Pauses and advances exactly one tick forward with given or polled input.
- **`seek(tick)`**: Validates $tick \in [\text{minTick}, \text{currentTick}]$ (throwing `RangeError` if out of bounds), loads the historical snapshot, and triggers render with `isHistorical = true`.
- **`branch(tick)`**: Seeks to $tick$, sets the live head to $tick$, and evicts all future history ($> tick$), opening an alternate timeline.
- **`stepBackward(n)` / `stepForward(n)`**: Frame-accurate single-step navigation.
- **`reset(newSeed?, newOptions?)`**: Resets the engine and clears snapshot history.
- **`getInputLog(tick)`**: Returns the input command associated with a past tick.
- **`setRateHz(rateHz)`**: Adjusts simulation rate dynamically.
- **`mountControls(container)`**: Mounts an interactive scrubber bar and playback controls, returning a teardown function.

## Hooks

The host provides staging, commitment, and guard hooks:
- **`onStep(candidate, tick)`**: Validates candidate tick state before snapshot commitment; throwing rejects the tick without modifying history.
- **`onCommit(state, tick)`**: Executes side-effects (e.g. sound effects, relational milestone promotion) exclusively on accepted, committed ticks.
- **`onFault(err)`**: Notified on loop and frame advancement exceptions.
- **`onBranch(tick)` / `onReset()`**: Lifecycle guard hooks called before branching or resetting; throwing aborts the transition before state modification.

