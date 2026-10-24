// How the kinetic plane reaches rows (pronto's kinetic-machine record): the
// engine names its milestones — the moments an app gives meaning to, seconds
// to minutes apart — and each is lifted once its frame is confirmed, with
// every seat's commands since the milestone before it. Confirmation is the
// condition and the milestone the trigger, so a lifted milestone is never
// rolled back and nothing is lifted per frame.
//
// The engine names them with `milestones(state)`, the kinds a frame's state
// reaches (`[{kind, ...detail}]`). A frame's commands are the bytes its host
// encodes them as — every seat's, a fixed `width` each frame — and a lifted
// milestone carries them as one base64 string, about 3.6 KB a byte of width
// a minute, which is what a row can hold.
import { canonical, checksum } from "./kinetic.js";

/** Frames' command bytes, `width` each, as the base64 a row carries. */
export function packInputs(frames, width) {
  const bytes = new Uint8Array(frames.length * width);
  frames.forEach((frame, i) => {
    if (frame.length !== width) throw new Error(`milestones: a frame's commands are ${frame.length} bytes, not ${width}`);
    bytes.set(frame, i * width);
  });
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** The frames `packInputs` packed. */
export function unpackInputs(packed, width) {
  const text = atob(packed);
  if (text.length % width !== 0) throw new Error(`milestones: ${text.length} bytes are no whole frames of ${width}`);
  return Array.from({ length: text.length / width }, (_, i) => Uint8Array.from(text.slice(i * width, (i + 1) * width), (c) => c.charCodeAt(0)));
}

/**
 * `observe(frame, state, commands)` records a simulated frame — a forward
 * one, or a rollback's re-simulation of it, which replaces what it had —
 * with every seat's command bytes; `rewind(frame)` forgets what came after a
 * frame a rollback loaded; `confirm(frame)` lifts every milestone at or before
 * it, in order, through `onLift`. `snapshots` names the kinds whose row also
 * carries the state, so loading one does not replay; `from` is the frame of
 * the milestone a race was loaded at. A frame at or before the last lifted
 * milestone is the row's and is not simulated again.
 */
export function createMilestoneLift({ engine, width, onLift, snapshots = [], from = 0 }) {
  if (typeof engine.milestones !== "function") throw new Error("milestones: the engine names none (milestones(state))");
  const withState = new Set(snapshots);
  const commands = new Map();
  const pending = new Map();
  let lifted = from;
  let confirmed = from;

  return {
    observe(frame, state, bytes) {
      if (frame <= lifted) throw new Error(`milestones: frame ${frame} simulated again after the milestone at ${lifted} was lifted`);
      commands.set(frame, bytes);
      pending.delete(frame);
      const reached = engine.milestones(state);
      if (reached.length === 0) return;
      const snapshot = engine.saveState(state);
      pending.set(frame, reached.map(({ kind, ...detail }) => ({
        frame,
        kind,
        detail,
        checksum: checksum(canonical(snapshot)),
        ...(withState.has(kind) ? { snapshot: structuredClone(snapshot) } : {}),
      })));
    },
    rewind(frame) {
      if (frame < lifted) throw new Error(`milestones: a rewind to ${frame} crosses the milestone lifted at ${lifted}`);
      for (const at of [...commands.keys()]) if (at > frame) commands.delete(at);
      for (const at of [...pending.keys()]) if (at > frame) pending.delete(at);
      confirmed = Math.min(confirmed, frame);
    },
    confirm(frame) {
      if (frame <= confirmed) return;
      confirmed = frame;
      for (const at of [...pending.keys()].sort((a, b) => a - b)) {
        if (at > frame) break;
        const inputs = [];
        for (let t = lifted + 1; t <= at; t++) {
          if (!commands.has(t)) throw new Error(`milestones: no commands for frame ${t}`);
          inputs.push(commands.get(t));
          commands.delete(t);
        }
        // Milestones of one frame share its commands: the first carries them,
        // and a replay through the rest adds none.
        pending.get(at).forEach((milestone, k) => {
          onLift({ ...milestone, from: k === 0 ? lifted : at, width, inputs: packInputs(k === 0 ? inputs : [], width) });
        });
        pending.delete(at);
        lifted = at;
      }
    },
  };
}

/**
 * The state at milestone `rows[i]`: its snapshot where it carries one, else
 * the race replayed from `seed` through every milestone's commands up to it.
 * Either is held to the row's checksum, so a row the engine no longer agrees
 * with fails here rather than loading something else. `decode` is the host's
 * inverse of the bytes it encoded a frame's commands as.
 */
export function loadMilestone(engine, { seed, initOptions, decode }, rows, i) {
  const row = rows[i];
  let state;
  if (row.snapshot !== undefined) state = engine.loadState(row.snapshot);
  else {
    state = engine.initState(seed, initOptions);
    let frame = 0;
    for (const at of rows.slice(0, i + 1)) {
      if (at.from !== frame) throw new Error(`milestones: ${at.kind} at ${at.frame} starts at ${at.from}, after ${frame}`);
      for (const bytes of unpackInputs(at.inputs, at.width)) state = engine.advanceFrame(state, decode(bytes));
      frame = at.frame;
    }
  }
  const sum = checksum(canonical(engine.saveState(state)));
  if (sum !== row.checksum) throw new Error(`milestones: ${row.kind} at frame ${row.frame} loads with checksum ${sum}; the row says ${row.checksum}`);
  return state;
}
