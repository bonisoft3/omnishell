import { strict as assert } from "node:assert";
import fc from "npm:fast-check@3.23.2";
import { sharedInputs } from "../battery-inputs.ts";
import { callSites, checkApp, exercise } from "../check-battery.ts";

Deno.test("shared draws preserve seeded coverage and generate each input only once", () => {
  const inputs = fc.array(fc.integer(), { maxLength: 5 }).chain((rows) => fc.record({ rows: fc.constant(rows), extra: fc.integer() }));
  let draws = 0;
  const generate = inputs.generate.bind(inputs);
  inputs.generate = (rng, bias) => { draws++; return generate(rng, bias); };
  const propertyFor = sharedInputs(inputs);
  for (const seed of [0, 42]) {
    const expected: unknown[] = [];
    fc.check(fc.property(inputs, (input) => { expected.push(input); return true; }), { seed, numRuns: 25 });
    const actual: unknown[] = [];
    fc.check(propertyFor((input) => { actual.push(input); return true; }), { seed, numRuns: 25 });
    assert.deepEqual(actual, expected);
    const before = draws;
    const repeated: unknown[] = [];
    fc.check(propertyFor((input) => { repeated.push(input); return true; }), { seed, numRuns: 25 });
    assert.equal(draws, before);
    assert.deepEqual(repeated, expected);
  }
});

Deno.test("shared draws retain shrinking and counterexample replay across predicates", () => {
  const inputs = fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 1, maxLength: 8 })
    .chain((rows) => fc.record({ rows: fc.constant(rows), divisor: fc.integer({ min: 1, max: 10 }) }));
  const propertyFor = sharedInputs(inputs);
  fc.check(propertyFor(() => true), { seed: 0, numRuns: 100 });
  for (const predicate of [
    (input: { rows: number[]; divisor: number }) => input.rows.every((row) => row < 20),
    (input: { rows: number[]; divisor: number }) => input.rows.length < input.divisor,
  ]) {
    const expected = fc.check(fc.property(inputs, predicate), { seed: 0, numRuns: 100 });
    const actual = fc.check(propertyFor(predicate), { seed: 0, numRuns: 100 });
    assert.equal(expected.failed, true);
    assert.notEqual(expected.counterexamplePath, null);
    for (const key of ["failed", "counterexample", "counterexamplePath", "numShrinks", "numRuns", "numSkips"] as const) {
      assert.deepEqual(actual[key], expected[key], key);
    }
    const replay = fc.check(propertyFor(predicate), { seed: 0, path: expected.counterexamplePath!, numRuns: 100 });
    assert.deepEqual(replay.counterexample, expected.counterexample);
  }
});

Deno.test("shared draws retain each property's hooks", () => {
  const previous = fc.readConfigureGlobal();
  let before = 0, after = 0;
  try {
    fc.configureGlobal({ beforeEach: () => { before++; }, afterEach: () => { after++; } });
    const propertyFor = sharedInputs(fc.integer());
    fc.check(propertyFor(() => true), { seed: 0, numRuns: 10 });
    fc.check(propertyFor(() => true), { seed: 0, numRuns: 10 });
    assert.equal(before, 20);
    assert.equal(after, 20);
  } finally {
    fc.resetConfigureGlobal();
    fc.configureGlobal(previous);
  }
});

Deno.test("call sites keep separate compartments, parameters and immutable inputs", async () => {
  const inputs = fc.record({ state: fc.constant({ items: [{ id: "original" }] }), event: fc.constant({ type: "click" }) });
  const propertyFor = sharedInputs(inputs);
  const source = `let calls = 0;
(state, event, params) => {
  calls += 1;
  if (calls > 8) throw new Error("shared compartment");
  if (state.items[0].id !== "original") throw new Error("shared mutation");
  if (params.mutate) state.items[0].id = "changed";
  return {updates: []};
};`;
  const options = { numRuns: 4 };
  const first = await exercise("first", "handler", source, inputs, { params: { mutate: false } }, options, propertyFor);
  const mutating = await exercise("mutating", "handler", source, inputs, { params: { mutate: true } }, options, propertyFor);
  const last = await exercise("last", "handler", source, inputs, { params: { mutate: false } }, options, propertyFor);
  assert.equal(first.error, undefined);
  assert.match(mutating.error ?? "", /read only|readonly|Cannot assign/);
  assert.equal(last.error, undefined);
  assert.equal(last.runs, first.runs);
  assert.equal(last.maxFuel, first.maxFuel);
});

Deno.test("exercise catches a handler that breaks or throws when state.rows order is reversed", async () => {
  const inputs = fc.record({
    state: fc.constant({
      items: [{ id: "1" }],
      rows: { cards: [{ id: "a" }, { id: "b" }] },
    }),
    event: fc.constant({ type: "mutation" }),
  });
  const propertyFor = sharedInputs(inputs);
  const orderFragile = `(state) => {
    if (state.rows.cards[0].id !== "a") return { updates: "bad" };
    return { updates: [] };
  };`;
  const res = await exercise("fragile", "handler", orderFragile, inputs, { params: {} }, { numRuns: 1 }, propertyFor);
  assert.match(res.error ?? "", /on reversed row order/);

  const orderThrow = `(state) => {
    if (state.rows.cards[0].id !== "a") throw new Error("unexpected first row");
    return { updates: [] };
  };`;
  const resThrow = await exercise("thrower", "handler", orderThrow, inputs, { params: {} }, { numRuns: 1 }, propertyFor);
  assert.match(resThrow.error ?? "", /on reversed row order: unexpected first row/);
});

Deno.test("battery honors each module's declared Statechart grant", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/shell/handlers`, { recursive: true });
    await Deno.mkdir(`${dir}/shell/validations`, { recursive: true });
    await Deno.mkdir(`${dir}/shell/screens`, { recursive: true });
    const body = `const step = Statechart({initial: "a", states: {a: {final: false, on: {GO: {target: "b"}}}, b: {final: true, on: {}}}}, {guard: () => true, reduce: (row, arrow) => ({...row, phase: arrow.target})});
      if (step({phase: "a"}, {kind: "GO"}).phase !== "b") throw new Error("wrong phase");`;
    for (const name of ["allowed", "denied"]) await Deno.writeTextFile(`${dir}/shell/handlers/${name}.js`, `(state, event) => { ${body} return {updates: []}; }`);
    await Deno.writeTextFile(`${dir}/shell/validations/allowed.js`, `(state, event) => { ${body} return true; }`);
    await Deno.writeTextFile(`${dir}/shell/screens/home.html`, '<main data-live="note"><button data-on-click="allowed"></button><button data-on-click="denied"></button></main>');
    await Deno.writeTextFile(`${dir}/shell/shell.yaml`, `
schema:
  note:
    durability: device
    fields:
      - {name: id, type: text, pk: true}
routes:
  - files:
      handlers: [shell/handlers/allowed.js, shell/handlers/denied.js]
validations:
  note:
    allowed: {src: shell/validations/allowed.js}
endowments:
  shell/handlers/allowed.js: [Statechart]
  shell/validations/allowed.js: [Statechart]
`);
    const checked = await checkApp(new URL(`file://${dir}/`), { numRuns: 2 });
    const allowed = checked.exercised.find((run) => run.path === "shell/handlers/allowed.js");
    const validation = checked.exercised.find((run) => run.path === "shell/validations/allowed.js");
    const denied = checked.exercised.find((run) => run.path === "shell/handlers/denied.js");
    assert.equal(allowed?.error, undefined);
    assert.ok((allowed?.maxFuel ?? 0) > 0);
    assert.equal(validation?.error, undefined);
    assert.match(denied?.error ?? "", /Statechart is not endowed/);
    assert.equal(checked.findings.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("machine effect inputs retain call-site context throughout nested actions", () => {
  const leaf = (name: string) => ({ type: name, params: { column: "topic" } });
  const effect = (name: string) => ({ op: "create", entity: "job", values: { input: leaf(name), value: { type: "event", params: { field: "value" } } } });
  const chart = { field: "status", initial: "editing", states: { editing: {
    initial: "ready", states: { ready: {
      entry: { effect: effect("entry-input") }, exit: [{ effect: [effect("exit-input")] }],
      on: { submit: { effect: effect("submit-input"), actions: [{ effect: [effect("action-input")] }] } },
      onDone: { effect: effect("done-input") },
    } },
  } } };
  const sites = callSites(`<div data-live="form" data-machine='${JSON.stringify(chart)}'></div>`);
  for (const name of ["entry-input", "exit-input", "submit-input", "action-input", "done-input"]) {
    assert.deepEqual(sites.get(name), [{ table: "form", leaf: true, params: { column: "topic" } }]);
  }
  assert.equal(sites.has("event"), false);
  const shared = { field: "status", initial: "a", states: { a: {
    on: { go: { guard: "shared", target: "a" } }, after: { shared: "a" },
  } } };
  assert.deepEqual(callSites(`<div data-live="form" data-machine='${JSON.stringify(shared)}'></div>`).get("shared"), [
    { table: "form", leaf: true }, { table: "form", delay: true },
  ]);
});

Deno.test("battery exercises a module referenced only by an effect input", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/shell/handlers`, { recursive: true });
    await Deno.mkdir(`${dir}/shell/screens`, { recursive: true });
    await Deno.writeTextFile(`${dir}/shell/handlers/input.js`, `(state, event, params) => {
      if (params.column !== "ready") throw new Error("missing literal parameters");
      if (state.items.length !== 1 || "rows" in state) throw new Error("wrong leaf world");
      for (const row of state.items) if (typeof row[params.column] !== "boolean") throw new Error("wrong row domain");
      return state.items.length;
    }`);
    await Deno.writeTextFile(`${dir}/shell/handlers/world.js`, `(state) => state.rows.form.length`);
    const chart = { field: "status", initial: "editing", states: { editing: { on: { submit: {
      effect: { op: "create", entity: "job", values: { input: { type: "input", params: { column: "ready" } }, invalid: { type: "world" } } },
    } } } } };
    await Deno.writeTextFile(`${dir}/shell/screens/home.html`, `<main data-live="form" data-machine='${JSON.stringify(chart)}'></main>`);
    await Deno.writeTextFile(`${dir}/shell/shell.yaml`, JSON.stringify({
      schema: { form: { durability: "device", fields: [{ name: "id", type: "text", pk: true }, { name: "ready", type: "bool" }] } },
      routes: [{ files: { handlers: ["shell/handlers/input.js", "shell/handlers/world.js"] } }],
    }));
    const checked = await checkApp(new URL(`file://${dir}/`), { numRuns: 10 });
    assert.equal(checked.findings.length, 1);
    assert.equal(checked.findings[0].path, "shell/handlers/world.js");
    assert.equal(checked.exercised.length, 2);
    assert.equal(checked.exercised[0].error, undefined);
    assert.equal(checked.exercised[0].table, "form");
    assert.equal(checked.exercised[0].runs, 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("named delays receive only the held row and after event", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/shell/handlers`, { recursive: true });
    await Deno.mkdir(`${dir}/shell/screens`, { recursive: true });
    await Deno.writeTextFile(`${dir}/shell/handlers/delay.js`, `(state, event) => {
      if ("rows" in state || state.items.length > 1 || event.type !== "after") throw new Error("wrong delay input");
      return 10;
    }`);
    const chart = {field:"phase",initial:"a",states:{a:{after:{delay:"a"}}}};
    await Deno.writeTextFile(`${dir}/shell/screens/home.html`, `<div data-live="form" data-machine='${JSON.stringify(chart)}'></div>`);
    await Deno.writeTextFile(`${dir}/shell/shell.yaml`, JSON.stringify({schema:{form:{durability:"device",fields:[{name:"id",type:"text",pk:true}]}},routes:[{files:{handlers:["shell/handlers/delay.js"]}}]}));
    const result = await checkApp(new URL(`file://${dir}/`), { numRuns: 20 });
    assert.deepEqual(result.findings, []);
    assert.equal(result.exercised[0].delay, true);
  } finally { await Deno.remove(dir, { recursive: true }); }
});
