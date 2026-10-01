---
type: concept
title: Kinetic host
description: "Fixed-step tick engine, snapshot ring buffer, and time-travel controller for high-frequency interactive simulations."
---

# Kinetic host

The relational plane of Pronto handles durable entities (`tab`, `device`, `server`) through transactional events. The kinetic plane handles high-frequency states living below `tab` (e.g. 35Hz, 60Hz, 120Hz physics loops and interactive simulations).

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
- **Rollback invariance**: Rewinding to tick $T$ and re-simulating inputs $c_T \dots c_{T+k}$ produces a bit-exact identical state to the forward run within the runtime.

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

