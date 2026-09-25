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
