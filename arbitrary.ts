// The values a Jessie module is exercised on, as fast-check arbitraries.
//
// What a row may hold is the program's to say and this plugin's to obey. The
// emitted shell.yaml says it per column under `schema:` — the type, the closed
// set a constraint admits (`enum`), and what an open one still admits
// (`bounds`: a range, a length, a pattern). All of it names a value domain and
// no constraint language, which is the whole reason the terminal can generate
// rows for an app whose constraints it cannot parse.
//
// Generation is boundary-biased by construction rather than by rejection: a
// column's arbitrary is built from its domain, so every sample is a row the
// program would accept and no run is spent discarding ones it would not.

import fc from "npm:fast-check@3.23.2";

/** A column's value domain, as shell.yaml states it. */
export type FieldBounds = {
  enumValues?: string[];
  intMin?: number;
  intMax?: number;
  sizeMin?: number;
  sizeMax?: number;
  regex?: string;
};

export type FieldDef = {
  name: string;
  type?: string;
  required?: boolean;
  precision?: number;
  scale?: number;
  enum?: string[];
  bounds?: FieldBounds;
};

export type EntityDef = {
  table: string;
  durability: string;
  fields?: FieldDef[];
  seed?: Record<string, unknown>[];
};

/** One column's domain, assembled from the two keys the emitted schema states
 * it in: the closed set under `enum`, where the markup rules read it too, and
 * everything else under `bounds`. */
export function boundsOf(field: FieldDef): FieldBounds {
  return field.enum === undefined ? field.bounds ?? {} : { ...field.bounds, enumValues: field.enum };
}

export function arbitraryField(field: FieldDef, bounds: FieldBounds): fc.Arbitrary<unknown> {
  if (bounds.enumValues && bounds.enumValues.length > 0) {
    const enumArb = fc.constantFrom(...bounds.enumValues);
    if (field.required === false && !bounds.enumValues.includes("")) {
      return fc.oneof({ arbitrary: enumArb, weight: 4 }, { arbitrary: fc.constant(""), weight: 1 });
    }
    return enumArb;
  }

  if (field.type === "int" || field.type === "int32" || bounds.intMin !== undefined || bounds.intMax !== undefined) {
    const min = bounds.intMin !== undefined && bounds.intMin !== -Infinity ? bounds.intMin : -1000;
    const max = bounds.intMax !== undefined && bounds.intMax !== Infinity ? bounds.intMax : 1000;
    const intArb = fc.integer({ min, max });
    if (field.required === false) {
      return fc.option(intArb, { nil: null });
    }
    return intArb;
  }

  if (field.type === "uuid") {
    return fc.uuid();
  }

  if (field.type === "timestamptz") {
    return fc.date().map((d) => d.toISOString());
  }

  if (field.type === "timestamp") {
    return fc.date({ min: new Date("0001-01-01"), max: new Date("9999-12-31") })
      .map((d) => d.toISOString().replace("Z", "000Z"));
  }
  if (field.type === "int64") return fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n }).map(String);
  if (field.type === "double") return fc.double({ noNaN: true, noDefaultInfinity: true });
  if (field.type === "bytes") return fc.uint8Array().map((bytes) => btoa(String.fromCharCode(...bytes)));
  if (field.type === "time") {
    return fc.tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }))
      .map((parts) => `${parts.map((p) => String(p).padStart(2, "0")).join(":")}.000000`);
  }
  if (field.type === "timezone") return fc.constantFrom("UTC", "America/Sao_Paulo", "Europe/Paris", "Asia/Tokyo");
  if (field.type === "json") return fc.jsonValue();
  if (field.type === "geojson") {
    return fc.tuple(fc.integer({ min: -180, max: 180 }), fc.integer({ min: -90, max: 90 }))
      .map((coordinates) => ({ type: "Point", coordinates }));
  }

  // The carriers, drawn in canonical form: a value proposed in any other
  // spelling would be refused by the carrier before it met the handler.
  if (field.type === "duration") {
    return fc.integer({ min: 0, max: 86_400_000 }).map((ms) => `PT${String(ms / 1000)}S`);
  }
  if (field.type === "decimal") {
    const precision = field.precision ?? 18, scale = field.scale ?? 6;
    const limit = 10n ** BigInt(precision) - 1n;
    return fc.bigInt({ min: -limit, max: limit }).map((n) => {
      const digits = (n < 0n ? -n : n).toString().padStart(scale + 1, "0");
      const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
      return `${n < 0n ? "-" : ""}${scale === 0 ? digits : digits.slice(0, -scale)}${fraction ? `.${fraction}` : ""}`;
    });
  }
  if (field.type === "date") {
    return fc.date({ min: new Date("1970-01-01"), max: new Date("2099-12-31") }).map((d) => d.toISOString().slice(0, 10));
  }

  if (field.type === "bool") {
    return fc.boolean();
  }

  if (bounds.regex) {
    const shaped = fc.stringMatching(new RegExp(bounds.regex));
    const lo = bounds.sizeMin;
    const hi = bounds.sizeMax !== undefined && bounds.sizeMax !== Infinity ? bounds.sizeMax : undefined;
    // A pattern states a shape and a size states a length, and a column
    // carrying both is answered only by a string that satisfies each. The
    // pattern alone does not bound the length: matches() is a partial match,
    // so an unanchored one admits any string with a conforming run inside it.
    const sized = lo === undefined && hi === undefined
      ? shaped
      : shaped.filter((v) => (lo === undefined || v.length >= lo) && (hi === undefined || v.length <= hi));
    // A column that may be absent is absent as the empty string, which is what
    // the store writes into one and therefore a value a handler is owed a draw
    // of. A pattern demanding content never spells it, so it is offered beside
    // the pattern rather than left to it.
    if (field.required === false) {
      return fc.oneof({ arbitrary: sized, weight: 4 }, { arbitrary: fc.constant(""), weight: 1 });
    }
    return sized;
  }

  const minLen = bounds.sizeMin ?? 0;
  const maxLen = bounds.sizeMax !== undefined && bounds.sizeMax !== Infinity
    ? bounds.sizeMax
    : (minLen === 0 ? 32 : minLen + 32);

  const strArb = fc.string({ minLength: minLen, maxLength: maxLen });
  if (field.required === false && minLen > 0) {
    return fc.oneof({ arbitrary: strArb, weight: 4 }, { arbitrary: fc.constant(""), weight: 1 });
  }
  return strArb;
}

export function arbitraryRow(entity: EntityDef): fc.Arbitrary<Record<string, unknown>> {
  const fields = entity.fields ?? [];
  const fieldArbs: Record<string, fc.Arbitrary<unknown>> = {};

  for (const f of fields) {
    fieldArbs[f.name] = arbitraryField(f, boundsOf(f));
  }

  const generatedRecord = fc.record(fieldArbs);
  const seeds = entity.seed ?? [];

  if (seeds.length === 0) {
    return generatedRecord;
  }

  const seedArb = fc.constantFrom(...seeds);
  // Which column of a seed row is disturbed is drawn like every other value,
  // never off a clock or a host random: a property run is replayable from its
  // seed, and a generator with a source of its own would report failures
  // nobody could reproduce.
  const mutatedSeedArb = fc.tuple(seedArb, generatedRecord, fc.nat()).map(([seed, gen, pick]) => {
    const keys = Object.keys(seed);
    if (keys.length === 0) return { ...seed };
    const mutateKey = keys[pick % keys.length];
    return { ...seed, [mutateKey]: gen[mutateKey] };
  });

  return fc.oneof(
    { arbitrary: seedArb, weight: 3 },
    { arbitrary: mutatedSeedArb, weight: 2 },
    { arbitrary: generatedRecord, weight: 5 },
  );
}

/** The event types the terminal itself dispatches into a reduce. A gesture's
 * own name reaches a module unchanged, so the list is open — these are the
 * ones the terminal produces without an author naming them. */
const TERMINAL_EVENTS = ["click", "input", "change", "submit", "mutation", "focusin", "keydown", "drop"];

/**
 * The world a region's module is handed: `items`, the rows of the region it is
 * bound to, and `rows`, every collection the screen reads.
 *
 * `region` names that region where the call site says which it is — a chart
 * states its own `data-live` — and is drawn over every collection where it
 * does not, so a module is exercised against each of them in turn rather than
 * against one guessed for it.
 *
 * `items` is never empty. The terminal calls a leaf over `{items: [row]}` and
 * a reduce over the rows its region is standing on, and it holds a machine
 * back entirely while that row is undefined — so an empty `items` is a world
 * to draw only where the check knows the module sits somewhere that produces
 * one, which no call site says.
 */
export function arbitraryHandlerInput(
  entities: Record<string, EntityDef>,
  region?: string,
): fc.Arbitrary<{ state: { rows: Record<string, unknown[]>; items: unknown[] }; event: Record<string, unknown> }> {
  const tables = Object.values(entities).map((e) => e.table);
  if (tables.length === 0) throw new Error("no entity to draw a module's world from");
  if (region !== undefined && entities[region] === undefined) {
    throw new Error(`the region "${region}" is not a table the emitted schema declares`);
  }

  const rowArbs: Record<string, fc.Arbitrary<unknown[]>> = {};
  for (const def of Object.values(entities)) {
    rowArbs[def.table] = fc.array(arbitraryRow(def), { minLength: 0, maxLength: 4 });
  }

  const regionArb = region === undefined ? fc.constantFrom(...tables) : fc.constant(region);
  return fc.record(rowArbs).chain((world) =>
    regionArb.chain((region) =>
      fc.array(arbitraryRow(entities[region]), { minLength: 1, maxLength: 4 }).chain((items) => {
        const rows = { ...world, [region]: items };
        // Half the events name a row that is standing and half name one that
        // is not: a module that looks its subject up has to answer both, and
        // only correlated ids reach the branch where it found one.
        const standing = items
          .map((r) => (r as { id?: unknown }).id)
          .filter((id): id is string => typeof id === "string");
        const idArb = standing.length === 0 ? fc.string({ minLength: 0, maxLength: 8 }) : fc.oneof(
          fc.constantFrom(...standing),
          fc.string({ minLength: 0, maxLength: 8 }),
        );
        const eventArb = fc.record({ id: idArb, type: fc.constantFrom(...TERMINAL_EVENTS) });
        return eventArb.map((event) => ({ state: { rows, items }, event }));
      })
    )
  );
}

/**
 * The world a validation is handed (interpreter/validate.js): the row being
 * written as `event.row`, the rows each declared edge walks to under `rows`,
 * and `items` carrying the row this one replaces — empty on an insert, one row
 * on an update, which is why both are drawn.
 */
export function arbitraryValidationInput(
  targetEntity: EntityDef,
  edges: { table: string; key: string; from: string }[],
  allEntities: Record<string, EntityDef>,
): fc.Arbitrary<
  { state: { rows: Record<string, unknown[]>; items: unknown[] }; event: { type: string; row: Record<string, unknown> } }
> {
  const targetRowArb = arbitraryRow(targetEntity);

  return targetRowArb.chain((row) => {
    const edgeRowArbs: Record<string, fc.Arbitrary<unknown[]>> = {};

    for (const edge of edges) {
      const entity = Object.values(allEntities).find((e) => e.table === edge.table);
      if (entity) {
        const baseArb = arbitraryRow(entity);
        // Correlate the edge key with target row field 50% of the time
        const correlatedArb = baseArb.map((r) => {
          const fromVal = row[edge.from];
          return fromVal !== undefined ? { ...r, [edge.key]: fromVal } : r;
        });

        edgeRowArbs[edge.table] = fc.oneof(
          { arbitrary: fc.array(correlatedArb, { minLength: 1, maxLength: 3 }), weight: 5 },
          { arbitrary: fc.array(baseArb, { minLength: 0, maxLength: 3 }), weight: 5 },
        );
      } else {
        edgeRowArbs[edge.table] = fc.constant([]);
      }
    }

    return fc.record(edgeRowArbs).chain((edgeRows) =>
      fc.oneof(
        fc.record({ type: fc.constant("insert"), held: fc.constant<unknown[]>([]) }),
        fc.record({ type: fc.constant("update"), held: targetRowArb.map((held) => [held]) }),
      ).map(({ type, held }) => ({
        state: { rows: edgeRows, items: held },
        event: { type, row },
      }))
    );
  });
}

/**
 * The generator's own claims, as sentences; empty is a pass. Returned rather
 * than printed so the caller owns the stream, as the checkers' are.
 */
export function selfTest(): { failures: string[] } {
  const failures: string[] = [];

  const check = (name: string, ok: boolean, detail: string) => {
    if (!ok) failures.push(`arbitrary ${name}: ${detail}`);
  };

  // Regression: every sample obeys every domain the schema states — the closed
  // set, the length, the range — which is what "by construction" has to mean
  // for a run that never discards a sample.
  const demo: EntityDef = {
    table: "demo",
    durability: "device",
    fields: [
      { name: "id", type: "text", bounds: { sizeMax: 8 } },
      { name: "mode", type: "text", enum: ["fast", "slow"] },
      { name: "val", type: "int", bounds: { intMin: 0, intMax: 100 } },
      { name: "code", type: "text", bounds: { regex: "^[a-f]{3}$" } },
      { name: "tag", type: "text", bounds: { regex: "[a-z]+", sizeMax: 4 } },
    ],
    seed: [{ id: "seed1", mode: "fast", val: 42, code: "abc", tag: "ab" }],
  };

  for (const s of fc.sample(arbitraryRow(demo), 40)) {
    const id = String(s.id);
    const mode = String(s.mode);
    const val = Number(s.val);
    if (id.length > 8) check("id length <= 8", false, `id=${id}`);
    if (mode !== "fast" && mode !== "slow") check("mode enum", false, `mode=${mode}`);
    if (val < 0 || val > 100) check("val in [0, 100]", false, `val=${val}`);
    if (!/^[a-f]{3}$/.test(String(s.code))) check("code matches its pattern", false, `code=${s.code}`);
    // An unanchored pattern beside a length: matches() is a partial match, so
    // the shape admits a longer string and only the size bound refuses it.
    const tag = String(s.tag);
    if (!/[a-z]+/.test(tag) || tag.length > 4) check("tag answers to its pattern and its length", false, `tag=${tag}`);
  }

  // Regression: two runs from one fast-check seed draw the same rows. A seeded
  // corpus is sampled and disturbed, and a disturbance drawn outside the
  // generator would make a reported counter-example unreplayable.
  const drawn = () => JSON.stringify(fc.sample(arbitraryRow(demo), { numRuns: 20, seed: 7 }));
  check("a run replays from its seed", drawn() === drawn(), "two runs at seed 7 differ");

  // Regression: a validation's edge rows are drawn correlated with the row
  // being judged, or the predicate never sees the case it exists to refuse.
  const edges = [{ table: "other", key: "demo_id", from: "id" }];
  const other: EntityDef = { table: "other", durability: "device", fields: [{ name: "demo_id", type: "text" }] };
  const inputs = fc.sample(arbitraryValidationInput(demo, edges, { demo, other }), { numRuns: 40, seed: 3 });
  const correlated = inputs.some((i) => (i.state.rows.other ?? []).some((r) => (r as { demo_id?: unknown }).demo_id === i.event.row.id));
  check("an edge row can carry the judged row's key", correlated, "no sample correlated the edge");

  return { failures };
}

if (import.meta.main) {
  const { failures } = selfTest();
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(failures.length === 0 ? "arbitrary self-test: passed" : `arbitrary self-test: ${failures.length} failed`);
  Deno.exit(failures.length === 0 ? 0 : 1);
}
