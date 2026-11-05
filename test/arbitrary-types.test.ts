import assert from "node:assert/strict";
import fc from "npm:fast-check@3.23.2";
import { arbitraryField, type FieldDef } from "../arbitrary.ts";
import { boundTypes } from "./type-table.ts";

type TypeField = FieldDef & { type: string };

const { normalizeValue } = boundTypes;

Deno.test("type arbitraries produce canonical values within their field profiles", () => {
  const types: TypeField["type"][] = [
    "string", "bool", "int32", "int64", "double", "bytes", "uuid", "timestamp",
    "date", "time", "timezone", "duration", "decimal", "json", "geojson",
  ];
  for (const type of types) {
    for (const scale of type === "decimal" ? [0, 2, 6, 18] : [0]) {
      const field: TypeField = { name: "value", type, precision: 18, scale };
      fc.assert(fc.property(arbitraryField(field, {}), (value) => {
        const normalized = normalizeValue(field, value);
        if (JSON.stringify(normalized) !== JSON.stringify(value)) throw new Error(`${type} drew a noncanonical value`);
      }), { seed: 20260921, numRuns: 100 });
    }
  }
});

Deno.test("int32 inputs exercise carrier limits and intersect field constraints", () => {
  const field = { name: "value", type: "int32" };
  const samples = fc.sample(arbitraryField(field, {}), { seed: 20261104, numRuns: 500 });
  for (const boundary of [-2147483648, -2147483647, -1, 0, 1, 2147483646, 2147483647]) {
    assert.ok(samples.includes(boundary), `missing input boundary ${boundary}`);
  }
  for (const bounds of [{ intMin: 7 }, { intMax: -7 }, { intMin: -1e12, intMax: 1e12 }, { intMin: 0.5, intMax: 1.5 }]) {
    fc.assert(fc.property(arbitraryField(field, bounds), value => {
      assert.equal(boundTypes.normalizeValue(field, value), value);
      assert.ok(Number(value) >= (bounds.intMin ?? -Infinity));
      assert.ok(Number(value) <= (bounds.intMax ?? Infinity));
    }), { seed: 20261104, numRuns: 100 });
  }
  assert.throws(() => arbitraryField(field, { intMin: 2147483648 }), /admit no int32/);
  assert.throws(() => arbitraryField(field, { intMin: 0.2, intMax: 0.8 }), /admit no int32/);
});

Deno.test("int64 boundaries remain exact strings across constrained domains", () => {
  const field = { name: "value", type: "int64" };
  const samples = fc.sample(arbitraryField(field, {}), { seed: 20261104, numRuns: 500 });
  for (const value of ["-9223372036854775808", "-9223372036854775807", "-1", "0", "1", "9223372036854775806", "9223372036854775807"]) {
    assert.ok(samples.includes(value), `missing int64 boundary ${value}`);
  }
  for (const bounds of [{ intMin: -3, intMax: 3 }, { intMin: 2147483648, intMax: 2147483650 }]) {
    fc.assert(fc.property(arbitraryField(field, bounds), value => {
      assert.equal(typeof value, "string");
      assert.equal(boundTypes.normalizeValue(field, value), value);
      assert.ok(BigInt(value as string) >= BigInt(bounds.intMin));
      assert.ok(BigInt(value as string) <= BigInt(bounds.intMax));
    }), { seed: 20261104, numRuns: 100 });
  }
  assert.throws(() => arbitraryField(field, { intMax: Number.MAX_SAFE_INTEGER + 1 }), /exact safe integer/);
});
