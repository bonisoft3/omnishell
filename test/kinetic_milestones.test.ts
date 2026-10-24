// Milestones lift the kinetic plane into rows (interpreter/kinetic-milestones.js):
// only at the engine's own moments, only once their frame is confirmed, each
// with the commands since the last, so the rows alone replay the race and a
// lifted one is never rolled back.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createKineticHost } from "../interpreter/kinetic.js";
import { createRollbackHost } from "../interpreter/kinetic-session.js";
import { loadMilestone, unpackInputs } from "../interpreter/kinetic-milestones.js";

const module = await Deno.readFile(new URL("../interpreter/vendor/ggrs/ggrs_wasm_bg.wasm", import.meta.url));

// Two cars on a line, as the rollback test's; a lap every 40 of the first
// car's steps is the milestone, so it falls where the inputs put it.
type Toy = { tick: number; x: number[]; mix: number; laps: number };
const engine = {
  initState: (): Toy => ({ tick: 0, x: [0, 0], mix: 1, laps: 0 }),
  advanceFrame: (s: Toy, cmd: number[]): Toy => {
    const x = s.x.map((v, seat) => v + (cmd[seat] & 1) - ((cmd[seat] >> 1) & 1));
    return { tick: s.tick + 1, x, mix: (s.mix * 31 + x[0] * 7 + x[1] * 13) % 1000003, laps: Math.floor(Math.abs(x[0]) / 40) };
  },
  saveState: (s: unknown) => structuredClone(s),
  loadState: (s: unknown) => structuredClone(s),
  milestones: (s: Toy) => (s.laps > 0 && Math.abs(s.x[0]) % 40 === 0 ? [{ kind: "lap", lap: s.laps }] : []),
};
const script = (seat: number, t: number) => (t % 11 === 0 ? 0 : seat === 0 ? 1 : ((t * (seat + 3)) >> 4) % 3);
// One host steps both seats, its command the two bytes.
const both = { width: 2, encode: (cmd: number[]) => Uint8Array.from(cmd), decode: (bytes: Uint8Array) => [...bytes] };

Deno.test("a solo host lifts each milestone once, at its frame, with the commands since the last", () => {
  const rows: any[] = [];
  const host = createKineticHost({ engine, historyLimit: 400, schedule: () => 0, cancel: () => {}, milestones: { ...both, onLift: (m: any) => rows.push(m) } });
  for (let t = 1; t <= 300; t++) host.stepTick([script(0, t), script(1, t)]);
  assert(rows.length >= 3, `${rows.length} laps in 300 frames`);
  assertEquals(rows.map((r) => r.kind), rows.map(() => "lap"));
  // Contiguous: each starts where the last ended, and carries one frame's
  // commands for every frame between.
  rows.forEach((r, i) => {
    assertEquals(r.from, i === 0 ? 0 : rows[i - 1].frame);
    assertEquals(unpackInputs(r.inputs, 2).length, r.frame - r.from);
  });
  // The seek the record names: back to a milestone, the host equals the
  // forward run at that frame.
  for (let i = 0; i < rows.length; i++) {
    const forward = createKineticHost({ engine, historyLimit: 400, schedule: () => 0, cancel: () => {} });
    for (let t = 1; t <= rows[i].frame; t++) forward.stepTick([script(0, t), script(1, t)]);
    const loaded = host.loadMilestone(rows, i);
    assertEquals(loaded, forward.getState());
    assertEquals(host.getCurrentTick(), rows[i].frame);
  }
});

Deno.test("a row's snapshot loads without replay, and a row the engine disagrees with fails", () => {
  const rows: any[] = [];
  const host = createKineticHost({ engine, historyLimit: 400, schedule: () => 0, cancel: () => {}, milestones: { ...both, snapshots: ["lap"], onLift: (m: any) => rows.push(m) } });
  for (let t = 1; t <= 200; t++) host.stepTick([script(0, t), script(1, t)]);
  const last = rows.length - 1;
  assertEquals(loadMilestone(engine, { seed: 0, initOptions: {}, decode: both.decode }, rows, last), rows[last].snapshot);
  const forged = rows.map((r, i) => (i === last ? { ...r, checksum: r.checksum + 1 } : r));
  assertThrows(() => host.loadMilestone(forged, last), Error, "the row says");
});

// Authority runs one way: a branch inside the current segment re-simulates,
// one behind a lifted milestone would rewrite a row.
Deno.test("a branch never crosses a lifted milestone", () => {
  const rows: any[] = [];
  const host = createKineticHost({ engine, historyLimit: 400, schedule: () => 0, cancel: () => {}, milestones: { ...both, onLift: (m: any) => rows.push(m) } });
  for (let t = 1; t <= 120; t++) host.stepTick([script(0, t), script(1, t)]);
  const lifted = rows.at(-1).frame;
  host.branch(lifted + 1);
  host.stepTick([1, 1]);
  assertThrows(() => host.branch(lifted - 1), Error, "crosses the milestone");
});

Deno.test("peers over a late, lossy channel lift the same milestones, only once confirmed", async () => {
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
  const lifted = [[], []] as any[][];
  const peers = await Promise.all([0, 1].map((seat) =>
    createRollbackHost({
      engine, module, seed: 0, seat, inputDelay: 1, maxPrediction: 8, channel: channel(seat),
      encode: (input: number) => input, decode: (inputs: Uint8Array) => [...inputs],
      milestones: { onLift: (m: any) => lifted[seat].push(m) },
    })
  ));
  for (now = 0; now < 1500; now++) {
    for (const seat of [0, 1]) {
      const due = wires[seat].filter((m) => m.at <= now);
      wires[seat] = wires[seat].filter((m) => m.at > now);
      for (const m of due) handlers[seat](m.bytes);
    }
    for (const seat of [0, 1]) peers[seat].step(script(seat, peers[seat].getFrame()));
    // GGRS resends a lost synchronisation request on the wall clock.
    await new Promise((r) => setTimeout(r, 2));
  }
  assert(lifted[0].length >= 3, `${lifted[0].length} laps lifted`);
  const common = Math.min(lifted[0].length, lifted[1].length);
  const strip = (m: any) => ({ frame: m.frame, kind: m.kind, checksum: m.checksum, inputs: m.inputs, from: m.from });
  assertEquals(lifted[0].slice(0, common).map(strip), lifted[1].slice(0, common).map(strip));
  // Lifted rows replay the race both peers raced.
  const decode = (bytes: Uint8Array) => [...bytes];
  const replayed = loadMilestone(engine, { seed: 0, initOptions: undefined, decode }, lifted[0], common - 1);
  assertEquals(replayed.tick, lifted[0][common - 1].frame);
  for (const p of peers) p.dispose();
});
