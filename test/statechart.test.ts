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

Deno.test("Statechart bounds host work and rejects actor, timer and executable chart fields", () => {
  const callbacks = {guard: () => true, reduce: (state: any) => state};
  const states = {a: {final: false, on: {GO: {target: "a"}}, always: [{target: "a"}]}};
  const step = Statechart({initial: "a", states}, callbacks);
  assert.throws(() => step({phase: "a"}, {kind: "GO"}), /did not settle/);
  for (const [key, value] of [["invoke", {src: "external"}], ["after", {"1": "a"}], ["entry", () => {}]]) {
    assert.throws(() => Statechart({initial: "a", states: {a: {...states.a, [key as string]: value}}}, callbacks), /unsupported/);
  }
  assert.throws(() => Statechart({initial: "a", states: {a: {final: false, on: {GO: {actions: () => {}}}}}}, callbacks), /unsupported actions/);
  assert.throws(() => Statechart({initial: "a", states: Object.fromEntries(Array.from({length: 1001}, (_, i) => [`s${i}`, {final: true, on: {}}]))}, callbacks), /state count/);
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
