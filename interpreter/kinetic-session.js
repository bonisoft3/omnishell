// A kinetic engine raced by two seats over a channel: GGRS (GGPO's rollback,
// vendor/ggrs, built by tools/ggrs-wasm) predicts the peer's input, and when
// the real one arrives late, loads the frame it diverged at and re-simulates
// forward. The session asks; this host answers with the engine — save a
// frame, load a frame, advance one with every seat's input — and carries the
// session's bytes over `channel`, which is all it reaches.
//
// `channel` is `{send(bytes), onMessage(handler)}`; an unordered, unreliable
// RTCDataChannel is the datagram GGRS's protocol expects (rtc-channel.js),
// and a test's queue does as well. `encode` turns the engine's input for a
// seat into the byte that crosses, `decode` turns every seat's bytes into
// the engine's command.
import { canonical, checksum } from "./kinetic.js";
import { createMilestoneLift } from "./kinetic-milestones.js";
import init, { Rollback } from "./vendor/ggrs/ggrs_wasm.js";

let ready = null;
/** Loads GGRS's module once; `module` is its bytes or URL, for a host without fetch. */
export function loadRollback(module) {
  ready ??= init({ module_or_path: module ?? new URL("./vendor/ggrs/ggrs_wasm_bg.wasm", import.meta.url) });
  return ready;
}

const TICK_MS = 1000 / 60;
const MAX_FRAME_MS = 250;
// A peer silent this long is dropped: longer than a stage's art takes to
// load behind a hold, shorter than a player waits for one who left.
const DISCONNECT_MS = 10_000;
// How often a held session still answers its peer.
const HOLD_POLL_MS = 50;

/**
 * `session` is "p2p" (this side is `seat`, the peer is over `channel`) or
 * "synctest" (both seats here, every frame rolled back `checkDistance` and
 * re-simulated, checksums held equal, GGRS's own SyncTestSession).
 */
export async function createRollbackHost(options) {
  const { engine, seed, initOptions, encode, decode } = options;
  const session = options.session ?? "p2p";
  await loadRollback(options.module);
  const rollback = session === "synctest"
    ? Rollback.sync_test(options.checkDistance ?? 7)
    : Rollback.p2p(options.seat, options.inputDelay ?? 2, options.maxPrediction ?? 8, 60, options.disconnectMs ?? DISCONNECT_MS);
  if (session === "p2p") options.channel.onMessage((bytes) => rollback.receive(bytes));

  // `milestones: {onLift, snapshots}` lifts the engine's milestones once GGRS
  // has every seat's input for their frame, each with both seats' bytes.
  const lifter = options.milestones
    ? createMilestoneLift({ engine, width: 2, onLift: options.milestones.onLift, snapshots: options.milestones.snapshots })
    : null;
  let state = engine.initState(seed, initOptions);
  let previous = state;
  let frame = 0;
  const snapshots = new Map();
  const keep = (options.maxPrediction ?? 8) + (options.checkDistance ?? 7) + 2;
  const flush = () => {
    if (session !== "p2p") return;
    for (const bytes of rollback.outgoing()) options.channel.send(bytes);
  };
  const save = (at) => {
    const snapshot = engine.saveState(state);
    snapshots.set(at, snapshot);
    snapshots.delete(at - keep);
    return checksum(canonical(snapshot));
  };
  const load = (at) => {
    const snapshot = snapshots.get(at);
    if (!snapshot) throw new Error(`rollback: no snapshot of frame ${at}`);
    state = engine.loadState(snapshot);
    frame = at;
    lifter?.rewind(at);
  };
  const advance = (inputs, gone) => {
    state = engine.advanceFrame(state, decode(inputs, gone));
    frame++;
    lifter?.observe(frame, state, Uint8Array.from(inputs));
  };

  const events = [];
  let skip = 0;
  /** One tick: what the peer sent read, this side's input added, a frame taken. */
  function step(input) {
    rollback.poll();
    for (const event of rollback.events()) {
      events.push(event);
      const wait = /^wait (\d+)$/.exec(event);
      if (wait) skip += Number(wait[1]);
      if (event.startsWith("desync")) throw new Error(`rollback: the peers' states differ: ${event}`);
    }
    let taken = false;
    if (rollback.running() && skip > 0) skip--;
    else if (rollback.running()) {
      const seats = session === "synctest" ? [0, 1] : [options.seat];
      for (const seat of seats) rollback.add_local_input(seat, encode(session === "synctest" ? input[seat] : input));
      previous = state;
      taken = rollback.advance_frame(save, load, advance);
      // GGRS's confirmed frame is the last whose inputs every seat has sent;
      // the state those inputs advance to is this host's next frame. A sync
      // test has every input here and re-simulates `checkDistance` back, so
      // what lies past that is settled.
      const settled = session === "synctest" ? frame - (options.checkDistance ?? 7) : rollback.confirmed_frame() + 1;
      if (taken) lifter?.confirm(Math.min(frame, settled));
      if (taken) options.onCommit?.(state, frame);
    }
    flush();
    return taken;
  }

  // A host stepped by hand (a test's) never schedules.
  const schedule = options.schedule ?? globalThis.requestAnimationFrame;
  const cancel = options.cancel ?? globalThis.cancelAnimationFrame;
  let animId = null;
  let last = null;
  let accumulator = 0;
  function loop(now) {
    accumulator += Math.min(MAX_FRAME_MS, now - (last ?? now));
    last = now;
    // A step's commit may hold the session (`stop`); the frames still due wait.
    while (animId !== null && accumulator >= TICK_MS) {
      step(options.getInput());
      accumulator -= TICK_MS;
    }
    if (animId === null) return;
    options.onRender?.(previous, state, accumulator / TICK_MS, frame, false);
    animId = schedule(loop);
  }

  // A held session takes no frame and still answers its peer, so a hold —
  // a stage's art arriving — is a wait the peer sees and not a disconnection.
  let held = null;
  const answer = () => {
    rollback.poll();
    flush();
  };

  return {
    step,
    start() {
      if (held !== null) clearInterval(held);
      held = null;
      if (animId === null) animId = schedule(loop);
    },
    /** Holds the race; the session keeps answering its peer until `start`. */
    stop() {
      if (animId !== null) cancel(animId);
      animId = null;
      last = null;
      if (session === "p2p" && held === null) held = setInterval(answer, HOLD_POLL_MS);
    },
    getState: () => state,
    getFrame: () => frame,
    running: () => rollback.running(),
    framesAhead: () => rollback.frames_ahead(),
    /** The session's events so far, synchronisation to waits. */
    events: () => events.slice(),
    dispose() {
      if (animId !== null) cancel(animId);
      animId = null;
      if (held !== null) clearInterval(held);
      rollback.free();
    },
  };
}
