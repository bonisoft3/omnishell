import assert from "node:assert/strict";
import { Statechart } from "../interpreter/statechart.js";
import { evaluateHandler } from "../interpreter/jessie.js";

Deno.test("the Statechart endowment is opt-in and cannot carry properties between cages", async () => {
  const source = "() => Statechart";
  const absent = await evaluateHandler(source);
  assert.throws(() => absent(), /Statechart is not endowed/);
  const writer = await evaluateHandler("value => { Statechart.saved = value; }", ["Statechart"]);
  assert.throws(() => writer("other cage"), TypeError);
  const reader = await evaluateHandler("() => Statechart.saved", ["Statechart"]);
  assert.equal(reader(), undefined);
});

Deno.test("Statechart bounds host work and rejects actor and executable chart fields", () => {
  const callbacks = {guard: () => true, reduce: (state: any) => state};
  const states = {a: {final: false, on: {GO: {target: "a"}}, always: [{target: "a"}]}};
  const step = Statechart({initial: "a", states}, callbacks);
  assert.throws(() => step({phase: "a"}, {kind: "GO"}), /did not settle/);
  for (const [key, value] of [["invoke", {src: "external"}], ["entry", () => {}]]) {
    assert.throws(() => Statechart({initial: "a", states: {a: {...states.a, [key as string]: value}}}, callbacks), /unsupported/);
  }
  assert.throws(() => Statechart({initial: "a", states: {a: {final: false, on: {GO: {actions: () => {}}}}}}, callbacks), /unsupported actions/);
  assert.throws(() => Statechart({initial: "a", states: Object.fromEntries(Array.from({length: 1001}, (_, i) => [`s${i}`, {final: true, on: {}}]))}, callbacks), /state count/);
  // A timer is its host's to arm, and a named delay its host's to resolve.
  assert.throws(() => Statechart({initial: "a", states: {a: {...states.a, after: {"1": [{target: "a"}]}}}}, callbacks), /schedule callback/);
  assert.throws(() => Statechart({initial: "a", states: {a: {...states.a, after: {turn: [{target: "a"}]}}}}, {...callbacks, schedule: () => {}}), /delay callback/);
  assert.throws(() => Statechart({initial: "a", states: {a: {...states.a, after: {"1.5": [{target: "a"}]}}}}, {...callbacks, schedule: () => {}}), /invalid delay/);
  assert.throws(() => Statechart({initial: "a", states: {a: {final: true, on: {}, after: {"1": [{target: "a"}]}}}}, {...callbacks, schedule: () => {}}), /final state has transitions/);
});

// XState v5's own `after`: entering a state raises its delayed events,
// leaving it cancels them, and only re-entering it starts them again.
Deno.test("Statechart leaves XState's timers to its host as the chart enters and exits states", () => {
  let actions: unknown[] = [];
  const raise = (delay: string, state: string, ms: number) => ({type: "xstate.raise", params: {event: {type: `xstate.after.${delay}.${state}`}, id: `xstate.after.${delay}.${state}`, delay: ms}});
  const cancel = (delay: string, state: string) => ({type: "xstate.cancel", params: {sendId: `xstate.after.${delay}.${state}`}});
  const step = Statechart({initial: "running", states: {
    running: {final: false, on: {nudge: {reduce: "count"}, stay: {target: "running", reduce: "count"}, restart: {target: "running", reenter: true, reduce: "count"}, stop: {target: "idle"}},
      after: {turn: [{guard: "never", target: "idle"}, {target: "expired", reduce: "expire"}]}},
    idle: {final: false, on: {start: {target: "running"}}},
    expired: {final: true, on: {}},
  }}, {
    guard: () => false,
    reduce: (row: {phase: string; count: number}, arrow: {target?: string; reduce?: string}) => ({...row, phase: arrow.target ?? row.phase, count: row.count + 1}),
    delay: (row: {turn_ms: number}) => row.turn_ms,
    schedule: (action: unknown) => { actions.push(action); },
  });
  const row = {phase: "running", count: 0, turn_ms: 20000};
  const taken = (kind: string, from = row) => {
    actions = [];
    return step(from, {kind});
  };
  step.start(row);
  assert.deepEqual(actions, [raise("turn", "running", 20000)], "creation enters the initial state");
  for (const kind of ["nudge", "stay"]) {
    assert.equal(taken(kind).count, 1);
    assert.deepEqual(actions, [], `${kind} stays without re-entering, and the timer runs on`);
  }
  assert.equal(taken("restart").count, 1);
  assert.deepEqual(actions, [cancel("turn", "running"), raise("turn", "running", 20000)], "reenter: true starts it again");
  assert.deepEqual(taken("restart", {...row, turn_ms: 5}).count, 1);
  assert.deepEqual(actions[1], raise("turn", "running", 5), "the delay is read when the state is entered");
  assert.equal(taken("stop").phase, "idle");
  assert.deepEqual(actions, [cancel("turn", "running")], "exit cancels it");
  assert.equal(taken("start", {...row, phase: "idle"}).phase, "running");
  assert.deepEqual(actions, [raise("turn", "running", 20000)], "entry starts it");
  // The timer's event takes the delay's first arrow whose guard holds.
  assert.deepEqual(taken("xstate.after.turn.running"), {...row, phase: "expired", count: 1});
  assert.deepEqual(actions, [cancel("turn", "running")]);
  assert.throws(() => taken("xstate.after.turn.idle", {...row, phase: "idle"}), /invalid state or event/);
  assert.throws(() => taken("restart", {...row, turn_ms: -1}), /not a duration/);
});

Deno.test("Statechart callbacks receive only caller data and literal event keys", () => {
  const seen: unknown[] = [];
  const states = {a: {final: false, on: {"*": {guard: "yes", reduce: "star"}, "foo.*": {guard: "yes", reduce: "prefix"}, "xstate.stop": {guard: "yes", reduce: "stop"}}}};
  const step = Statechart({initial: "a", states}, {
    guard: (row: unknown, name: string, event: unknown, automatic: boolean) => { seen.push([row, name, event, automatic]); return true; },
    reduce: (row: object, arrow: {reduce: string}) => ({...row, seen: arrow.reduce}),
  });
  for (const [kind, name] of [["*", "star"], ["foo.*", "prefix"], ["xstate.stop", "stop"]]) {
    assert.deepEqual(step({phase: "a"}, {kind}), {phase: "a", seen: name});
  }
  assert.deepEqual(seen, ["*", "foo.*", "xstate.stop"].map(kind => [{phase: "a"}, "yes", {kind}, false]));
  assert.throws(() => step({phase: "a"}, {kind: "foo.bar"}), /invalid state or event/);
});
