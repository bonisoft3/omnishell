import assert from "node:assert/strict";
import { machineEngine } from "./machine-engine.js";

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
