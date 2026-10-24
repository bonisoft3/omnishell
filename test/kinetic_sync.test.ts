import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { canonical, checksum, createKineticHost } from "../interpreter/kinetic.js";

// A counter that steps by its command, and a variant that also reads state it
// does not own: the forward run and a re-simulation see that state differ.
const counter = {
  initState: () => ({ n: 0, tick: 0 }),
  advanceFrame: (s: { n: number; tick: number }, c: { by?: number }) => ({ n: s.n + (c.by ?? 1), tick: s.tick + 1 }),
  saveState: (s: unknown) => JSON.parse(JSON.stringify(s)),
  loadState: (s: unknown) => JSON.parse(JSON.stringify(s)),
};
let leaked = 0;
const leaky = { ...counter, advanceFrame: (s: { n: number; tick: number }, c: { by?: number }) => ({ n: s.n + (c.by ?? 1) + (leaked++ === 20 ? 1 : 0), tick: s.tick + 1 }) };

Deno.test("sync test: a deterministic engine re-simulates every frame to the forward run's checksum", () => {
  const host = createKineticHost({ engine: counter, syncTest: 8, historyLimit: 32 });
  for (let i = 0; i < 100; i++) host.stepTick({ by: i % 3 });
  assertEquals(host.getState().tick, 100);
});

Deno.test("sync test: a frame whose re-simulation disagrees fails, naming it", () => {
  leaked = 0;
  const host = createKineticHost({ engine: leaky, syncTest: 4, historyLimit: 32 });
  // The 21st advance is the re-simulation of frame 5 in tick 7's window, and
  // adds one the forward run never did.
  assertThrows(() => {
    for (let i = 0; i < 40; i++) host.stepTick({ by: 1 });
  }, Error, "kinetic sync test: frame 5, re-simulated from 3,");
});

Deno.test("sync test: a window the history cannot hold is refused", () => {
  assertThrows(() => createKineticHost({ engine: counter, syncTest: 32, historyLimit: 32 }), RangeError, "syncTest");
});

Deno.test("sync test: the checksum reads a state, not the order its keys were built in", () => {
  assertEquals(checksum(canonical({ a: 1, b: [{ y: 2, x: 1 }] })), checksum(canonical({ b: [{ x: 1, y: 2 }], a: 1 })));
});
