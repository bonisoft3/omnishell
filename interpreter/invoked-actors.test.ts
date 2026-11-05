import assert from "node:assert/strict";
import { createActor, createMachine, fromCallback } from "npm:xstate@5.32.6";
import { canonical } from "../test/canonical.ts";
import { invokedActors, invocationSpecs } from "./invoked-actors.js";
import { machineEngine } from "./machine-engine.js";

Deno.test("invocation lifetime agrees with XState on entry, retained self-target, explicit reentry and exit", () => {
  const machine = { field: "status", initial: "idle", states: {
    idle: { on: { start: "active" } },
    active: { invoke: { id: "watch", src: "watch" }, on: { retain: { target: "active", reenter: false }, restart: { target: "active", reenter: true }, legacy: "active", leave: "idle" } },
  } };
  const actual: string[] = [], reference: string[] = [];
  const running = invokedActors(machine, { watch: {} }, () => {
    actual.push("start");
    return { update() {}, stop() { actual.push("stop"); } };
  });
  const actor = createActor(createMachine(canonical(machine) as never, { actors: { watch: fromCallback(() => {
    reference.push("start");
    return () => { reference.push("stop"); };
  }) } }));
  actor.start();
  const transition = machineEngine(machine, { guard: () => true, action() {} });
  let state = "idle";
  running.sync(state);
  for (const type of ["start", "retain", "restart", "legacy", "leave", "start"]) {
    const result = transition({ status: state }, { type }, [type]);
    running.exit(result.exit);
    running.sync(result.state);
    state = result.state;
    actor.send({ type });
    assert.deepEqual(actual, reference, type);
  }
  running.stop(); actor.stop();
  assert.deepEqual(actual, reference);
});

Deno.test("parent invocation survives child transitions and restarts when its owning parent reenters", () => {
  const machine = { field: "status", initial: "parent", states: {
    parent: { initial: "a", invoke: { id: "parent-watch", src: "watch" }, on: { restart: { target: "parent", reenter: true } }, states: {
      a: { on: { next: "b" } }, b: { on: { next: "a" } },
    } },
  } };
  const actual: string[] = [], reference: string[] = [];
  const running = invokedActors(machine, { watch: {} }, () => { actual.push("start"); return { update() {}, stop() { actual.push("stop"); } }; });
  const actor = createActor(createMachine(canonical(machine) as never, { actors: { watch: fromCallback(() => { reference.push("start"); return () => { reference.push("stop"); }; }) } }));
  actor.start();
  const transition = machineEngine(machine, { guard: () => true, action() {} });
  running.sync("parent.a");
  const next = transition({ status: "parent.a" }, { type: "next" }, ["next"]);
  running.exit(next.exit);
  running.sync(next.state);
  actor.send({ type: "next" });
  assert.deepEqual(actual, reference);
  const restart = transition({ status: next.state }, { type: "restart" }, ["restart"]);
  running.exit(restart.exit);
  running.sync(restart.state);
  actor.send({ type: "restart" });
  assert.deepEqual(actual, reference);
  running.stop(); actor.stop();
});

Deno.test("unsupported invoke constructs and missing implementations fail explicitly", () => {
  assert.throws(() => invocationSpecs({ states: { active: { invoke: { src: "watch", input: {} } } } }, "active"), /supports only/);
  assert.throws(() => invokedActors({ states: { active: { invoke: { src: "unknown" } } } }, {}, () => {}).sync("active"), /undeclared actor/);
  assert.throws(() => invocationSpecs({ invoke: { id: "same", src: "a" }, states: { active: { invoke: { id: "same", src: "b" } } } }, "active"), /duplicate active/);
});

Deno.test("markup lint resolves invoked adapters and their source and context columns", async () => {
  const { machineLint } = await import("./lint.ts");
  const machine = { field: "status", initial: "watching", states: { watching: { invoke: { src: "watch" } } } };
  const reach = { table: "form", durabilityOf: () => "tab", columnsOf: (table: string) => table === "form" ? ["id", "status", "set_id", "run"] : table === "progress" ? ["id", "status", "run"] : undefined };
  assert.match(machineLint(machine, new Set(), { ...reach, actors: {} })!, /undeclared actor/);
  const watch = { via: "observe", table: "progress", field: "status", match: { id: "set_id", run: "run" } };
  assert.equal(machineLint(machine, new Set(), { ...reach, actors: { watch } }), null);
  assert.match(machineLint(machine, new Set(), { ...reach, actors: { watch: { ...watch, match: { id: "missing" } } } })!, /undeclared field "form.missing"/);
});

Deno.test("an observer cleanup failure still stops every exiting observer", () => {
  const machine = { initial: "active", states: { active: { invoke: [{ src: "bad" }, { src: "good" }] }, idle: {} } };
  const stopped: string[] = [];
  const running = invokedActors(machine, { bad: { name: "bad" }, good: { name: "good" } }, (binding: { name: string }) => ({
    update() {},
    stop() { stopped.push(binding.name); if (binding.name === "bad") throw new Error("unsubscribe failed"); },
  }));
  running.sync("active");
  assert.throws(() => running.exit(["active"]), /unsubscribe failed/);
  assert.deepEqual(stopped, ["bad", "good"]);
  running.stop();
});
