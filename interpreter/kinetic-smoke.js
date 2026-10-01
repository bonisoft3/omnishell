// Kinetic Machine Host smoke test: verifies Mulberry32 determinism,
// fixed-step stepping, time-travel seek, rollback branching, and ring buffer eviction.
function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${msg ? msg + ": " : ""}expected ${b} but got ${a}`);
  }
}

function assertThrows(fn, ErrorClass, expectedMsg) {
  let threw = false;
  let caught = null;
  try {
    fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  if (!threw) {
    throw new Error("expected function to throw");
  }
  if (ErrorClass && !(caught instanceof ErrorClass)) {
    throw new Error(`expected error to be instance of ${ErrorClass.name}, got ${caught?.constructor?.name}`);
  }
  if (expectedMsg && !caught?.message?.includes(expectedMsg)) {
    throw new Error(`expected error message to include ${expectedMsg}, got ${caught?.message}`);
  }
}

import { createKineticHost, createPrng, prngStep } from "./kinetic.js";

Deno.test("kinetic: prngStep and createPrng produce bit-exact deterministic sequences", () => {
  const prng1 = createPrng(0x1337);
  const prng2 = createPrng(0x1337);

  const seq1 = Array.from({ length: 10 }, () => prng1());
  const seq2 = Array.from({ length: 10 }, () => prng2());

  assertEquals(seq1, seq2);
  assert(seq1.every(v => v >= 0 && v < 1));

  // Pure prngStep
  const [val1, next1] = prngStep(0x1337);
  const [val2, next2] = prngStep(0x1337);
  assertEquals(val1, val2);
  assertEquals(next1, next2);
});

Deno.test("kinetic: fixed-step advancement and snapshot recording", () => {
  const engine = {
    initState(seed) {
      return { tick: 0, x: 0, seed };
    },
    advanceFrame(state, cmd) {
      const dx = cmd.dx !== undefined ? cmd.dx : 1;
      return {
        tick: state.tick + 1,
        x: state.x + dx,
        seed: state.seed
      };
    },
    saveState(state) {
      return JSON.stringify(state);
    },
    loadState(snapshot) {
      return JSON.parse(snapshot);
    }
  };

  const host = createKineticHost({
    engine,
    rateHz: 35,
    seed: 42,
    historyLimit: 50
  });

  assertEquals(host.getCurrentTick(), 0);
  assertEquals(host.getState().x, 0);

  // Step 10 ticks with dx = 2
  for (let i = 0; i < 10; i++) {
    host.stepTick({ dx: 2 });
  }

  assertEquals(host.getCurrentTick(), 10);
  assertEquals(host.getState().x, 20);

  // Time-travel: seek to Tick 4
  const pastState = host.seek(4);
  assertEquals(pastState.tick, 4);
  assertEquals(pastState.x, 8);
  assertEquals(host.getDisplayTick(), 4);
  assertEquals(host.getCurrentTick(), 10); // Live head remains 10!

  // Step forward in history: from 4 to 5
  const nextHistorical = host.stepForward(1);
  assertEquals(nextHistorical.tick, 5);
  assertEquals(nextHistorical.x, 10);

  // Step backward: from 5 to 3
  const prevHistorical = host.stepBackward(2);
  assertEquals(prevHistorical.tick, 3);
  assertEquals(prevHistorical.x, 6);

  // Branch at Tick 3 with alternate input dx = 100
  const branched = host.branch(3);
  assertEquals(branched.tick, 3);
  assertEquals(host.getCurrentTick(), 3);
  assertEquals(host.getStats().maxTick, 3);

  // Advance on the new timeline
  host.stepTick({ dx: 100 });
  assertEquals(host.getCurrentTick(), 4);
  assertEquals(host.getState().x, 106);
});

Deno.test("kinetic: ring buffer evicts oldest snapshots when exceeding historyLimit", () => {
  const engine = {
    initState: () => ({ v: 0 }),
    advanceFrame: (s) => ({ v: s.v + 1 }),
    saveState: JSON.stringify,
    loadState: JSON.parse
  };

  const host = createKineticHost({
    engine,
    historyLimit: 5
  });

  for (let i = 0; i < 10; i++) {
    host.stepTick();
  }

  assertEquals(host.getCurrentTick(), 10);
  assertEquals(host.getStats().historyCount, 5);
  assertEquals(host.getMinTick(), 6);

  // Seeking before minTick throws RangeError (fail loud, no silent fallback)
  assertThrows(() => host.seek(0), RangeError);
});

Deno.test("kinetic: branch past head or before min throws RangeError", () => {
  const engine = {
    initState: () => ({ tick: 0 }),
    advanceFrame: (s) => ({ tick: s.tick + 1 }),
    saveState: JSON.stringify,
    loadState: JSON.parse
  };

  const host = createKineticHost({ engine, historyLimit: 10 });
  for (let i = 0; i < 4; i++) host.stepTick();

  assertEquals(host.getCurrentTick(), 4);
  assertThrows(() => host.branch(9999), RangeError);
  assertThrows(() => host.branch(-1), RangeError);
  assertEquals(host.getCurrentTick(), 4);
  assertEquals(host.getState().tick, 4);

  host.stepTick();
  assertEquals(host.getCurrentTick(), 5);
  assertEquals(host.getState().tick, 5);
});

Deno.test("kinetic: accumulator pump advances ticks and clamps frame to 250ms", () => {
  let steps = 0;
  const engine = {
    initState: () => ({ tick: 0 }),
    advanceFrame: (s) => ({ tick: s.tick + 1 }),
    saveState: JSON.stringify,
    loadState: JSON.parse
  };

  const host = createKineticHost({
    engine,
    rateHz: 35,
    onStep: () => {
      steps++;
    }
  });

  // At 35Hz, 1 tick = 28.57ms. 100ms should step exactly 3 ticks.
  host.play();
  host.pump(100);
  assertEquals(steps, 3);
  assertEquals(host.getCurrentTick(), 3);

  // Frame of 1000ms should be clamped to 250ms (max 8 ticks at 35Hz)
  let clampSteps = 0;
  const hostClamp = createKineticHost({
    engine,
    rateHz: 35,
    onStep: () => {
      clampSteps++;
    }
  });
  hostClamp.play();
  hostClamp.pump(1000);
  assertEquals(clampSteps, Math.floor(250.0 / (1000.0 / 35)));
});

Deno.test("kinetic: rateHz configuration admits 35, 60, and 120Hz", () => {
  const engine = {
    initState: () => ({}),
    advanceFrame: s => s,
    saveState: JSON.stringify,
    loadState: JSON.parse
  };

  const host = createKineticHost({ engine, rateHz: 60 });
  assertEquals(host.getRateHz(), 60);

  host.setRateHz(120);
  assertEquals(host.getRateHz(), 120);

  host.setRateHz(35);
  assertEquals(host.getRateHz(), 35);
});

Deno.test("kinetic: pause cancels scheduled loop and play resumes scheduling", () => {
  let scheduledFn = null;
  let scheduledId = 0;
  let cancelledId = null;

  const schedule = (fn) => {
    scheduledFn = fn;
    return ++scheduledId;
  };
  const cancel = (id) => {
    cancelledId = id;
    scheduledFn = null;
  };

  const engine = {
    initState: () => ({ tick: 0 }),
    advanceFrame: (s) => ({ tick: s.tick + 1 }),
    saveState: JSON.stringify,
    loadState: JSON.parse
  };

  const host = createKineticHost({
    engine,
    rateHz: 35,
    schedule,
    cancel
  });

  host.start();
  assertEquals(scheduledId, 1);
  assert(scheduledFn !== null);

  // Initial rAF timestamp establishes lastTime
  scheduledFn(100);
  assertEquals(host.getCurrentTick(), 0);

  // Subsequent frame advances tick
  scheduledFn(135);
  assertEquals(host.getCurrentTick(), 1);

  // Pause cancels the scheduled id
  host.pause();
  assertEquals(cancelledId, 3);

  // Play resumes scheduling
  host.play();
  assertEquals(scheduledId, 4);
  assert(scheduledFn !== null);

  // Next frame advances tick
  scheduledFn(200);
  scheduledFn(235);
  assertEquals(host.getCurrentTick(), 2);

  host.stop();
});

