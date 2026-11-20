import assert from "node:assert/strict";
import { KEPT, machineEngine } from "./machine-engine.js";

Deno.test("state declarations hide root arrows even when their guards decline", () => {
  const machine = { field: "state", initial: "a", on: { go: "root" }, states: {
    a: { on: { go: { guard: "deny", target: "other" } } }, other: {}, root: {},
  } };
  const engine = machineEngine(machine, { guard: () => false, action() {} });
  const result = engine({ state: "a" }, { type: "go" }, ["go"]);
  assert.equal(result.taken, false);
  assert.equal(result.state, "a");
});

Deno.test("a transient guard reads the entered state and preceding action", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { on: { go: { target: "b", assign: { count: 1 } } } },
    b: { always: { guard: "ready", target: "c" } }, c: {},
  } };
  const engine = machineEngine(machine, {
    action(action: any, run: any) { if (action.assign) run.effective = { ...run.row, ...action.assign }; },
    guard(_ref: any, run: any) { return run.guardState === "b" && run.effective?.count === 1; },
  });
  const result = engine({ state: "a", count: 0 }, { type: "go" }, ["go"]);
  assert.equal(result.state, "c");
  assert.deepEqual(result.exit, ["a", "b"]);
  assert.deepEqual(result.enter, ["b", "c"]);
});

Deno.test("resolving a row and previewing a gesture do not execute actions", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { entry: { assign: { count: 1 } }, on: { go: { target: "b", assign: { count: 2 } } } }, b: {},
  } };
  let calls = 0;
  const engine = machineEngine(machine, { guard: () => true, action() { calls++; } });
  assert.equal(engine({ state: "a" }, { type: "go" }, ["go"], true).taken, true);
  assert.equal(calls, 0);
  engine({ state: "a" }, { type: "go" }, ["go"]);
  assert.equal(calls, 1);
});

Deno.test("eventless cycles fail rather than hanging a screen", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { on: { go: "b" }, always: "b" }, b: { always: "a" },
  } };
  const engine = machineEngine(machine, { guard: () => true, action() {} });
  assert.throws(() => engine({ state: "a" }, { type: "go" }, ["go"]), /eventless transitions did not settle/);
});

Deno.test("a generic event is selected before eligible eventless transitions", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { on: { click: "clicked" }, always: "automatic" }, clicked: {}, automatic: {},
  } };
  const engine = machineEngine(machine, { guard: () => true, action() {} });
  const clicked = engine({ state: "a" }, { type: "click", from: "pick" }, ["click@pick", "click"]);
  assert.equal(clicked.state, "clicked");
  const unknown = engine({ state: "a" }, { type: "unknown" }, ["unknown"]);
  assert.equal(unknown.taken, false);
  assert.equal(unknown.state, "a");
  assert.equal(engine({ state: "a" }, { type: "always" }, ["always"]).state, "automatic");
});

Deno.test("nested arrows resolve sibling and root targets", () => {
  const machine = { field: "state", initial: "parent", states: {
    parent: { initial: "a", states: { a: { on: { root: "done", deep: "other.leaf", local: "b" } }, b: {} } },
    done: {}, other: { initial: "leaf", states: { leaf: {} } },
  } };
  const engine = machineEngine(machine, { guard: () => true, action() {} });
  const fire = (type: string) => engine({ state: "parent.a" }, { type }, [type]).state;
  assert.equal(fire("root"), "done");
  assert.equal(fire("deep"), "other.leaf");
  assert.equal(fire("local"), "parent.b");
});

Deno.test("inherited targets resolve against the active nested state", () => {
  for (const root of [true, false]) {
    for (const collision of [true, false]) {
      const inherited = { go: "b" };
      const machine = { field: "state", initial: "parent", ...(root ? { on: inherited } : {}), states: {
        parent: { initial: "a", ...(!root ? { on: inherited } : {}), states: { a: {}, b: {} } },
        ...(collision ? { b: {} } : {}),
      } };
      const engine = machineEngine(machine, { guard: () => true, action() {} });
      assert.equal(engine({ state: "parent.a" }, { type: "go" }, ["go"]).state, "parent.b");
    }
  }
});

Deno.test("a completed parent resolves a relative onDone target within itself", () => {
  const machine = { field: "state", initial: "parent", states: {
    parent: { initial: "a", onDone: ".b", states: {
      a: { on: { go: "final" } }, final: { type: "final" }, b: {},
    } },
    b: {},
  } };
  const engine = machineEngine(machine, { guard: () => true, action() {} });
  assert.equal(engine({ state: "parent.a" }, { type: "go" }, ["go"]).state, "parent.b");
});

Deno.test("a target invalid for the active state fails instead of selecting a different state", () => {
  const machine = { field: "state", initial: "idle", on: { go: "b" }, states: {
    idle: {}, parent: { initial: "b", states: { b: {} } },
  } };
  const engine = machineEngine(machine, { guard: () => true, action() {} });
  assert.throws(() => engine({ state: "idle" }, { type: "go" }, ["go"]), /Child state 'b' does not exist/);
});

Deno.test("an event no arrow answers asks no eventless guard", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { on: { go: { guard: "deny", target: "b" } }, always: { guard: "ready", target: "b" } }, b: {},
  } };
  const asked: string[] = [];
  const engine = machineEngine(machine, { guard(ref: any) { asked.push(ref); return false; }, action() {} });
  assert.equal(engine({ state: "a" }, { type: "go" }, ["go"]).taken, false);
  assert.equal(engine({ state: "a" }, { type: "other" }, ["other"]).taken, false);
  assert.deepEqual(asked, ["deny"]);
});

Deno.test("the initial state's entry is not run on every step", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { entry: { assign: { seen: 1 } }, on: { go: "b" } }, b: { on: { back: "a" } },
  } };
  const acted: unknown[] = [];
  const engine = machineEngine(machine, { guard: () => true, action(act: unknown) { acted.push(act); } });
  const result = engine({ state: "b" }, { type: "back" }, ["back"]);
  assert.deepEqual(result.enter, ["a"]);
  assert.deepEqual(acted, [{ target: "a" }, { assign: { seen: 1 } }]);
});

Deno.test("XState's actions come back for the host: delays and observers", () => {
  const machine = { field: "state", initial: "a", states: {
    a: { on: { go: "b" } }, b: { after: { 1000: "a" }, invoke: { src: "quote", id: "q" }, on: { stay: "b" } },
  } };
  const engine = machineEngine(machine, { guard: () => true, action() {} }, { ...KEPT, timers: false });
  // A snapshot rebuilt from a row holds no children, so a stop names none.
  const kinds = (row: object, type: string) => engine(row, { type }, [type]).actions.map((a: any) => a.type === "xstate.stopChild" ? a.type : `${a.type} ${a.params?.id ?? a.params?.sendId}`);
  assert.deepEqual(kinds({ state: "a" }, "go"), ["xstate.raise xstate.after.1000.pronto.b", "xstate.spawnChild q"]);
  assert.deepEqual(kinds({ state: "b" }, "stay"), ["xstate.cancel xstate.after.1000.pronto.b", "xstate.stopChild", "xstate.raise xstate.after.1000.pronto.b", "xstate.spawnChild q"]);
  const timer = "xstate.after.1000.pronto.b";
  assert.equal(engine({ state: "b" }, { type: timer }, [timer]).state, "a");
});

Deno.test("each kept rule, switched off, is XState's", () => {
  const off = (rule: keyof typeof KEPT) => ({ ...KEPT, [rule]: false });
  const run = (machine: object, rules: typeof KEPT, row: object, type: string) => machineEngine(machine, { guard: () => false, action(act: any, r: any) { if (act.raise) r.raised = act.raise; } }, rules)(row, { type }, [type]);
  const self = { field: "state", initial: "a", states: { a: { after: { 10: "a" }, on: { again: "a" } } } };
  assert.deepEqual(run(self, KEPT, { state: "a" }, "again").enter, ["a"]);
  assert.deepEqual(run(self, off("reenter"), { state: "a" }, "again").enter, []);
  const shadowed = { field: "state", initial: "a", on: { go: ".root" }, states: { a: { on: { go: { guard: "deny", target: "b" } } }, b: {}, root: {} } };
  assert.equal(run(shadowed, KEPT, { state: "a" }, "go").taken, false);
  assert.equal(run(shadowed, off("shadow"), { state: "a" }, "go").state, "root");
  const nested = { field: "state", initial: "p", states: { p: { initial: "a", states: { a: { on: { go: ".b" } }, b: {} } }, b: {} } };
  assert.throws(() => run(nested, off("targets"), { state: "p.a" }, "go"), /Child state 'b' does not exist/);
  assert.equal(run(nested, KEPT, { state: "p.a" }, "go").state, "p.b");
  const raising = { field: "state", initial: "a", states: { a: { on: { go: { target: "b", raise: "next" } } }, b: { on: { next: "c" } }, c: {} } };
  const kept = run(raising, KEPT, { state: "a" }, "go");
  assert.deepEqual([kept.state, kept.raised], ["b", "next"]);
  const same = run(raising, off("raise"), { state: "a" }, "go");
  assert.deepEqual([same.state, same.raised], ["c", undefined]);
});

Deno.test("an event key XState reads as a wildcard or claims is refused", () => {
  for (const key of ["", "*", "signal:quote.*", "xstate.init"]) {
    const machine = { field: "state", initial: "a", states: { a: { on: { [key]: "b" } }, b: {} } };
    assert.throws(() => machineEngine(machine, { guard: () => true, action() {} })({ state: "a" }, { type: "go" }, ["go"]), /reserves/);
  }
});

Deno.test("building the initial snapshot completes no final state of the step's", () => {
  const machine = { field: "state", initial: "p", states: {
    p: { initial: "f", onDone: { target: "b", assign: { seen: 1 } }, states: { f: { type: "final" } } },
    a: { always: { guard: "deny", target: "b" } }, b: {},
  } };
  const acted: unknown[] = [];
  const engine = machineEngine(machine, { guard: () => false, action(act: unknown) { acted.push(act); } });
  for (const preview of [false, true]) {
    const result = engine({ state: "a" }, { type: "always" }, ["always"], preview);
    assert.deepEqual([result.taken, result.state, result.enter, result.exit], [false, "a", [], []]);
  }
  assert.deepEqual(acted, []);
});

Deno.test("a kept timer fires from the active path as an event of that name", () => {
  const nested = { field: "state", initial: "p", states: { p: { initial: "a", after: { 10: "done" }, states: { a: {} } }, done: {} } };
  const engine = (machine: object) => machineEngine(machine, { guard: () => true, action() {} });
  const fired = engine(nested)({ state: "p.a" }, { type: "after:10" }, ["after:10"]);
  assert.deepEqual([fired.state, fired.exit, fired.enter], ["done", ["p.a", "p"], ["done"]]);
  const root = { field: "state", initial: "a", after: { 10: "b" }, states: { a: {}, b: {} } };
  assert.equal(engine(root)({ state: "a" }, { type: "after:10" }, ["after:10"]).state, "b");
  const named = { field: "state", initial: "a", states: { a: { on: { "after:10": "b" } }, b: {} } };
  assert.equal(engine(named)({ state: "a" }, { type: "after:10" }, ["after:10"]).state, "b");
  const nearer = { field: "state", initial: "p", states: { p: { initial: "a", after: { 10: "done" }, states: { a: { on: { "after:10": "local" } }, local: {} } }, done: {} } };
  assert.equal(engine(nearer)({ state: "p.a" }, { type: "after:10" }, ["after:10"]).state, "p.local");
  const spelled = { field: "state", initial: "a", states: { a: { after: { "01": "b" } }, b: {} } };
  assert.equal(engine(spelled)({ state: "a" }, { type: "after:01" }, ["after:01"]).state, "b");
  const compound = { field: "state", initial: "p", states: { p: { initial: "a", states: { a: { after: { 10: "b" } }, b: {} } } } };
  assert.equal(engine(compound)({ state: "p" }, { type: "after:10" }, ["after:10"]).state, "p.b");
});

Deno.test("only the key always runs eventless arrows unprompted", () => {
  const machine = { field: "state", initial: "a", states: { a: { always: "b" }, b: {} } };
  const engine = machineEngine(machine, { guard: () => true, action() {} });
  assert.deepEqual([engine({ state: "a" }, { type: "onDone" }, ["onDone"]).taken, engine({ state: "a" }, { type: "always" }, ["always"]).state], [false, "b"]);
});

Deno.test("an event may be named for an eventless construct", () => {
  const machine = { field: "state", initial: "p", states: {
    p: { initial: "a", on: { always: "z" }, states: { a: { on: { onDone: "b", always: { guard: "deny", target: "b" } } }, b: {}, z: {} } },
  } };
  const engine = machineEngine(machine, { guard: () => false, action() {} });
  assert.equal(engine({ state: "p.a" }, { type: "onDone" }, ["onDone"]).state, "p.b");
  assert.equal(engine({ state: "p.a" }, { type: "always" }, ["always"]).taken, false);
});
