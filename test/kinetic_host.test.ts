import { assertEquals } from "jsr:@std/assert@1";
import { createKineticHost } from "../interpreter/kinetic.js";

const counter = {
  initState: () => ({ n: 0, tick: 0 }),
  advanceFrame: (s: { n: number; tick: number }) => ({ n: s.n + 1, tick: s.tick + 1 }),
  saveState: (s: unknown) => structuredClone(s),
  loadState: (s: unknown) => structuredClone(s),
};

// A commit that paused the host used to leave the pump subtracting the tick
// from the accumulator pause() had zeroed, so the frame drew at alpha -1: the
// presenter interpolated a tick backwards and snapped.
Deno.test("a pause from a commit stops the frames still due and renders at rest", () => {
  const frames: FrameRequestCallback[] = [];
  const alphas: number[] = [];
  const host = createKineticHost({
    engine: counter,
    rateHz: 60,
    schedule: (fn: FrameRequestCallback) => frames.push(fn),
    cancel: () => {},
    onCommit: (_: unknown, tick: number) => tick === 1 && host.pause(),
    onRender: (_prev: unknown, _curr: unknown, alpha: number) => alphas.push(alpha),
  });
  host.start();
  frames.shift()!(0);
  frames.shift()!(50);
  assertEquals(host.getCurrentTick(), 1, "the frames due after the pause wait");
  assertEquals(alphas.at(-1), 0);
});
