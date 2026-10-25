import { strict as assert } from "node:assert";
import fc from "npm:fast-check@3.23.2";
import { sharedInputs } from "../battery-inputs.ts";
import { exercise } from "../check-battery.ts";

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
