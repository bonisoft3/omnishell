// The rollback host (interpreter/kinetic-session.js) over GGRS's Wasm build:
// GGRS's own sync test holds a deterministic engine and refuses one that is
// not, and two peers joined by a lossy, late channel agree on every frame
// both have confirmed, each having predicted the other's input and rolled
// back when it came.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { createRollbackHost } from "../interpreter/kinetic-session.js";

const module = await Deno.readFile(new URL("../interpreter/vendor/ggrs/ggrs_wasm_bg.wasm", import.meta.url));

// Two cars on a line: each input byte moves its seat's car, and every frame
// mixes both positions into a third value, so a frame advanced with the
// wrong input stays wrong.
type Toy = { tick: number; x: number[]; mix: number };
const engine = {
  initState: (): Toy => ({ tick: 0, x: [0, 0], mix: 1 }),
  advanceFrame: (s: Toy, cmd: number[]): Toy => {
    const x = s.x.map((v, seat) => v + (cmd[seat] & 1) - ((cmd[seat] >> 1) & 1));
    return { tick: s.tick + 1, x, mix: (s.mix * 31 + x[0] * 7 + x[1] * 13) % 1000003 };
  },
  saveState: (s: unknown) => structuredClone(s),
  loadState: (s: unknown) => structuredClone(s),
};
const encode = (input: number) => input;
const decode = (inputs: Uint8Array) => [...inputs];
const script = (seat: number, t: number) => ((t * (seat + 3)) >> 4) % 3;

Deno.test("GGRS's sync test holds a deterministic engine through rollbacks", async () => {
  const host = await createRollbackHost({ engine, encode, decode, session: "synctest", checkDistance: 7, module, seed: 0 });
  for (let t = 0; t < 300; t++) host.step([script(0, t), script(1, t)]);
  assertEquals(host.getFrame(), 300);
  host.dispose();
});

Deno.test("GGRS's sync test refuses an engine whose re-simulation differs", async () => {
  let drift = 0;
  const leaky = { ...engine, advanceFrame: (s: Toy, cmd: number[]) => ({ ...engine.advanceFrame(s, cmd), mix: drift++ }) };
  const host = await createRollbackHost({ engine: leaky, encode, decode, session: "synctest", checkDistance: 7, module, seed: 0 });
  await assertRejects(async () => {
    for (let t = 0; t < 60; t++) host.step([script(0, t), script(1, t)]);
  }, Error, "checksum");
});

Deno.test("two peers over a late, lossy channel agree on every confirmed frame", async () => {
  // Each message waits `delay` ticks, and one in seven is lost.
  const delay = 5;
  const wires = [[], []] as { at: number; bytes: Uint8Array }[][];
  const handlers: ((bytes: Uint8Array) => void)[] = [];
  let now = 0;
  let sent = 0;
  const channel = (from: number) => ({
    send: (bytes: Uint8Array) => {
      if (++sent % 7 !== 0) wires[1 - from].push({ at: now + delay, bytes: bytes.slice() });
    },
    onMessage: (handler: (bytes: Uint8Array) => void) => {
      handlers[from] = handler;
    },
  });
  // Every frame each peer last advanced to, re-simulations included.
  const seen = [new Map<number, string>(), new Map<number, string>()];
  let rollbacks = 0;
  const recording = (seat: number) => ({
    ...engine,
    loadState: (s: unknown) => {
      rollbacks++;
      return engine.loadState(s);
    },
    advanceFrame: (s: Toy, cmd: number[]) => {
      const next = engine.advanceFrame(s, cmd);
      seen[seat].set(next.tick, JSON.stringify(next));
      return next;
    },
  });
  const peers = await Promise.all([0, 1].map((seat) =>
    createRollbackHost({ engine: recording(seat), encode, decode, module, seed: 0, seat, inputDelay: 1, maxPrediction: 8, channel: channel(seat) })
  ));
  let synchronised = false;
  for (now = 0; now < 1500; now++) {
    for (const seat of [0, 1]) {
      const due = wires[seat].filter((m) => m.at <= now);
      wires[seat] = wires[seat].filter((m) => m.at > now);
      for (const m of due) handlers[seat](m.bytes);
    }
    for (const seat of [0, 1]) peers[seat].step(script(seat, peers[seat].getFrame()));
    // GGRS resends a lost synchronisation request on the wall clock.
    await new Promise((r) => setTimeout(r, 2));
    synchronised ||= peers.every((p) => p.events().includes("synchronized"));
  }
  assert(synchronised, "the peers synchronised");
  assert(rollbacks > 50, `the peers rolled back (${rollbacks} times)`);
  const confirmed = Math.min(peers[0].getFrame(), peers[1].getFrame()) - 20;
  assert(confirmed > 600, `the peers raced ${confirmed} frames`);
  for (let frame = 1; frame <= confirmed; frame++) assertEquals(seen[0].get(frame), seen[1].get(frame), `frame ${frame}`);
  for (const p of peers) p.dispose();
});

// A hold is a stop from inside a step's commit (kinetic-mount.js, a stage's
// art arriving): the frame loop that ran the step used to take the frames
// still due and schedule itself again, so the race never held.
Deno.test("a stop from a step's commit holds the session at that frame", async () => {
  const queued: FrameRequestCallback[] = [];
  const host = await createRollbackHost({
    engine, encode, decode, module, seed: 0, session: "synctest", checkDistance: 2,
    getInput: () => [0, 0],
    schedule: (fn: FrameRequestCallback) => queued.push(fn),
    cancel: () => {},
    onCommit: (_: unknown, frame: number) => {
      if (frame === 1) host.stop();
    },
  });
  host.start();
  queued.shift()!(0);
  queued.shift()!(100);
  assertEquals(host.getFrame(), 1);
  assertEquals(queued.length, 0, "a held session schedules no frame");
  host.dispose();
});
