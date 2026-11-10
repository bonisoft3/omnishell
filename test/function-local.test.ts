import { strict as assert } from "node:assert";
import { instrument } from "../instrument.ts";
import { executeFunction } from "./function-local.ts";

// A module as pronto emits one: its statements, then its arrow completion.
const DOUBLE = instrument(`const double = (n) => n * 2;
((input) => ({ doubled: input.values.map(double) }))`);

Deno.test("the function answers over a detached argument, and its steps are counted the same every call", async () => {
  const input = { values: [1, 2, 3] };
  const first = await executeFunction(DOUBLE, 1000, input);
  assert.deepEqual(first.answer, { doubled: [2, 4, 6] });
  assert.ok(first.spent > 0);
  assert.equal((await executeFunction(DOUBLE, 1000, input)).spent, first.spent);
  assert.ok((await executeFunction(DOUBLE, 1000, { values: [1, 2, 3, 4, 5, 6] })).spent > first.spent);
});

// Every call starts with its whole budget, as in plv8: a call that ran out
// does not leave the next one short.
Deno.test("a call runs out of fuel alone, and the module is refused what is not plain JSON", async () => {
  const spin = instrument(`((input) => { while (true) {} })`);
  await assert.rejects(() => executeFunction(spin, 50, {}), { name: "RangeError", message: /fuel exhausted \(50 steps\)/ });
  await assert.rejects(() => executeFunction(DOUBLE, 3, { values: [1, 2, 3] }), RangeError);
  assert.deepEqual((await executeFunction(DOUBLE, 1000, { values: [1] })).answer, { doubled: [2] });
  const loose = instrument(`((input) => ({ value: input.n / 0 }))`);
  await assert.rejects(() => executeFunction(loose, 100, { n: 1 }), { name: "TypeError", message: "answer.value is not a finite number" });
  const mutate = instrument(`((input) => { input.events.push(1); return input; })`);
  await assert.rejects(() => executeFunction(mutate, 100, { events: [] }), TypeError);
});
