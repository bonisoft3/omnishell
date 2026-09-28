// omnishell jessie battery: every handler and validation module an app declares
// survives the inputs its own schema admits.
//
//   omnishell check battery <appDir>
//   omnishell check battery --self-test
//
// The rung above check-handlers: that one asks whether a module LOADS in the
// cage its role runs in, and stops there because nothing supplies it a state
// or an event. This one supplies both, hundreds of times over, drawn from the
// value domains the emitted shell.yaml states per column — so a handler that
// loads and then throws on the second row is a finding here and nowhere else.
//
// Three properties, held over every input:
//
//   confinement   the module runs in the compartment production runs it in
//                 (interpreter/jessie.js), endowed with nothing but its meter
//   termination   every loop head and function entry spends a step of a fixed
//                 budget, so a module that does not finish is stopped by a
//                 counter rather than by CI's wall clock. The steps are spent
//                 where the rewrite put them: the meter reaches the module as
//                 an endowment it cannot write, and a module that binds the
//                 meter's name is refused and reported here. What the budget
//                 counts is the module's OWN steps — one call into a frozen
//                 intrinsic is a single step whatever it costs, so a module
//                 can still buy wall-clock time it never spends fuel for
//   purity        the state and the event are deep-frozen before the call and
//                 the call is made twice, so a module that mutates what it was
//                 handed, or answers differently to the same input, says so
//
// Termination covers a module's top level as well as its completion value,
// which is the reach check-handlers' accepted hazard names as beyond loading
// alone. That check evaluates unbounded; the rewrite is here for it to borrow.
//
// The inputs are drawn, never accepted-and-discarded. shell.yaml's `schema:`
// carries each column's type, the closed set its constraint admits (`enum`)
// and what an open one still admits (`bounds`) — a range, a length, a pattern
// — and arbitrary.ts builds a generator per column out of that. A domain named
// in those terms is one the terminal can obey without parsing the program's
// constraint language, which it does not speak.
//
// The run is seeded, so two runs over one tree draw the same inputs: a gate
// that answered differently on the same source would grade nothing, and a
// counter-example nobody can replay is not a defect report.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding above the advisory band is reported.

import fc from "npm:fast-check@3.23.2";
import { load as parseYaml } from "./interpreter/vendor/js-yaml.js";
import { evaluateCaged } from "./interpreter/jessie.js";
import { machineRegions, scanScreen } from "./interpreter/lint.ts";
import { machineCandidates, RESERVED_LEAVES } from "./interpreter/fragment.js";
import {
  arbitraryHandlerInput,
  arbitraryValidationInput,
  type EntityDef,
  type FieldDef,
  selfTest as arbitrarySelfTest,
} from "./arbitrary.ts";
import { fuelMeter, instrument, METER, selfTest as instrumentSelfTest } from "./instrument.ts";

type Finding = { severity: string; path: string; message: string };

/** Whether a run's findings fail the verb. Nothing this check reports is a
 * fact about the checker — a module either survives the inputs its own schema
 * admits or does not — so every finding here is an error. The band is stated
 * anyway, because the verb gate is the loop's vocabulary and not this file's
 * to redefine. check-handlers and check-markup band the same way. */
export const fails = (findings: Finding[]) => findings.some((f) => f.severity !== "advisory");

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

export type BatteryOptions = {
  numRuns?: number;
  fuelLimit?: number;
  seed?: number;
};

const RUNS = 100;
// The budget answers "did this finish", not "was it quick": it has to clear the
// costliest wake a module in this corpus legitimately makes, or the check calls
// a correct module non-terminating. The dearest measured is a chess referee
// naming every legal move of the position it stands on and asking mate of each
// that gives check — a hundred and sixty thousand steps in a position with nine
// queens on the board, and half a million again over the boards its column's
// type admits. What the budget exists to catch spends it in milliseconds either
// way, so the headroom costs the gate nothing it was ever holding.
//
// That dearest figure is the worst of four hundred draws and not a bound: what
// keeps a correct module's verdict repeatable is the seed below, not the
// margin above it, so widening the draw is a measurement before it is a config.
const FUEL = 1_000_000;
const SEED = 0;

/** One module's run: what was exercised and how far it got. `maxFuel` is the
 * costliest single call, which is the number a budget is judged against. */
export type Exercised = {
  path: string;
  role: "handler" | "validation";
  table?: string;
  params?: Record<string, unknown>;
  runs: number;
  maxFuel: number;
  error?: string;
};

/** Where a screen calls a module from: the region whose rows it is handed, and
 * the literals stated beside the reference. A chart states its own region and
 * its own literals; a reduce bound to a gesture (data-handler, data-on-*)
 * states neither, because which region encloses the element is a fact about
 * the tree and not about the attribute. */
export type CallSite = { table?: string; params?: Record<string, unknown> };

const sameSite = (a: CallSite, b: CallSite) =>
  a.table === b.table && JSON.stringify(a.params ?? null) === JSON.stringify(b.params ?? null);

/**
 * The call sites one screen's markup states, by the basename it names each
 * module with — which is how every reference in the markup resolves. One
 * module is called from as many places as the screen names it, and a leaf's
 * third argument comes from the reference and not from the module, so each
 * distinct set of literals is its own run.
 *
 * An assign's string value is the dual position: a module reference where the
 * name is one the app declares, a literal otherwise. It is taken as a
 * reference here and resolved by the caller, which is the only place that
 * knows which names are declared.
 */
export function callSites(html: string): Map<string, CallSite[]> {
  const sites = new Map<string, CallSite[]>();
  const take = (name: string, site: CallSite) => {
    const held = sites.get(name) ?? [];
    if (!held.some((s) => sameSite(s, site))) held.push(site);
    sites.set(name, held);
  };
  for (const name of scanScreen(html).handlers) take(name, {});
  for (const region of machineRegions(html)) {
    // machineRegions refuses what is not JSON, so a chart reaching here parses.
    const chart = JSON.parse(region.machine);
    const table = region.table;
    const walk = (value: unknown) => {
      // deno-lint-ignore no-explicit-any
      for (const candidate of machineCandidates(value) as any[]) {
        const guard = candidate.guard;
        if (typeof guard === "string") take(guard, { table });
        else if (guard !== null && typeof guard === "object") take(guard.type, { table, params: guard.params });
        for (const v of Object.values(candidate.assign ?? {})) {
          if (typeof v === "string") take(v, { table });
          // deno-lint-ignore no-explicit-any
          else if (v !== null && typeof v === "object" && !RESERVED_LEAVES.has((v as any).type)) {
            // deno-lint-ignore no-explicit-any
            take((v as any).type, { table, params: (v as any).params });
          }
        }
      }
    };
    for (const value of Object.values(chart.on ?? {})) walk(value);
    // deno-lint-ignore no-explicit-any
    for (const state of Object.values(chart.states ?? {}) as any[]) {
      for (const value of Object.values(state.on ?? {})) walk(value);
      for (const [delay, value] of Object.entries(state.after ?? {})) {
        // A non-numeric delay is a module answering the milliseconds.
        if (!/^\d+$/.test(delay)) take(delay, { table });
        walk(value);
      }
    }
  }
  return sites;
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj as Record<string, unknown>)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

/** The shape a module of this role must answer in, or the sentence saying it
 * did not. Asked of a value the module returned, so `null` is a pass. */
type Shape = (value: unknown) => string | null;

const handlerShape: Shape = (value) => {
  if (typeof value !== "object" || value === null || !("updates" in value)) return null;
  const updates = (value as { updates?: unknown }).updates;
  if (!Array.isArray(updates)) return "updates is not a list";
  for (const u of updates) {
    if (typeof u !== "object" || u === null) return `an update is ${JSON.stringify(u)}, not an object`;
    const op = (u as { op?: unknown }).op;
    if (typeof op !== "string" || !["put", "patch", "delete", "insert"].includes(op)) {
      return `an update's op is ${JSON.stringify(op)}, not put, patch, delete or insert`;
    }
  }
  return null;
};

const validationShape: Shape = (value) => typeof value === "boolean" ? null : `returned ${typeof value}, not a boolean`;

/**
 * One module, exercised. The rewrite is about THIS module — source the
 * instrumenter cannot read is that module's defect — so it is reported as a
 * result and the run goes on to the next one. Building the compartment is
 * not: a cage that cannot be built is a fact about the environment, true of
 * every module, and it propagates.
 */
export async function exercise(
  path: string,
  role: "handler" | "validation",
  source: string,
  inputs: fc.Arbitrary<{ state: unknown; event: unknown }>,
  site: CallSite = {},
  options: BatteryOptions = {},
): Promise<Exercised> {
  const runs = options.numRuns ?? RUNS;
  const meter = fuelMeter(options.fuelLimit ?? FUEL);
  const shape = role === "handler" ? handlerShape : validationShape;
  const result = (maxFuel: number, error?: string): Exercised => ({
    path,
    role,
    table: site.table,
    params: site.params,
    runs,
    maxFuel,
    error,
  });
  // Frozen like the state and the event, and for the same reason: the
  // literals belong to the screen that stated them, and a module that writes
  // one has written into the next reader's chart.
  const params = site.params === undefined ? undefined : deepFreeze(structuredClone(site.params));

  let target: (...args: unknown[]) => unknown;
  try {
    target = await evaluateCaged(instrument(source), meter.endowments) as (...args: unknown[]) => unknown;
  } catch (err) {
    return result(meter.consumed(), said(err));
  }
  if (typeof target !== "function") {
    // check-handlers states this in the role's own words; reaching here means
    // the two disagree, and there is nothing to call.
    return result(0, `${role} source does not end in a function`);
  }

  let maxFuel = 0;
  const details = fc.check(
    fc.property(inputs, ({ state, event }) => {
      const frozenState = deepFreeze(structuredClone(state));
      const frozenEvent = deepFreeze(structuredClone(event));

      meter.reset();
      const first = target(frozenState, frozenEvent, params);
      const firstFuel = meter.consumed();
      if (firstFuel > maxFuel) maxFuel = firstFuel;

      const wrong = shape(first);
      if (wrong !== null) throw new Error(wrong);

      meter.reset();
      const second = target(frozenState, frozenEvent, params);
      if (meter.consumed() !== firstFuel) {
        throw new Error(`the same input cost ${firstFuel} steps and then ${meter.consumed()}`);
      }
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        throw new Error("the same input answered twice, differently");
      }
      return true;
    }),
    { numRuns: runs, seed: options.seed ?? SEED },
  );
  if (!details.failed) return result(maxFuel);
  // The module's own words first, and the input it said them on after: a
  // finding a reader has to unwrap a property runner's framing from is a
  // finding they will read as the runner's problem. The counterexample is the
  // shrunk one, which is the smallest state and event that still provoke it.
  return result(maxFuel, [said(details.errorInstance), `  on ${JSON.stringify(details.counterexample?.[0])}`].join("\n"));
}

/** shell.yaml, as this check reads it: the entity projection the generators
 * are built from, and the two places a module is declared with a state and an
 * event to be run on. A renderer and an adapter take a value and a fold takes
 * rows, so none is drawn here — check-handlers loads all five roles. */
type SchemaEntity = { durability: string; fields: FieldDef[] };
type Edge = { table: string; key: string; from: string };
type Shell = {
  schema?: Record<string, SchemaEntity>;
  routes?: { files?: { handlers?: string[] } }[];
  validations?: Record<string, Record<string, { src?: string; edges?: Edge[] }>>;
};

/** The entities as the generators take them, keyed by the table they are
 * filed under — which is the name a validation and a handler's `state.rows`
 * both reach them by. */
export function entitiesOf(schema: Record<string, SchemaEntity>): Record<string, EntityDef> {
  const entities: Record<string, EntityDef> = {};
  for (const [table, e] of Object.entries(schema)) {
    entities[table] = { table, durability: e.durability, fields: e.fields };
  }
  return entities;
}

/** The name a screen's markup reaches a module by: its file's basename. */
export const basenameOf = (path: string) => path.replace(/^.*\//, "").replace(/\.js$/, "");

/** Every call site the app's screens state, merged. A screen the readers
 * refuse is a finding rather than a throw: the modules the other screens name
 * are still worth running, and check-markup reports the refusal in the
 * grammar's own words. */
async function screenCallSites(appDir: URL, findings: Finding[]): Promise<Map<string, CallSite[]>> {
  const merged = new Map<string, CallSite[]>();
  const dir = new URL("shell/screens/", appDir);
  const names: string[] = [];
  try {
    for await (const f of Deno.readDir(dir)) if (f.isFile && f.name.endsWith(".html")) names.push(f.name);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  for (const name of names.sort()) {
    let sites: Map<string, CallSite[]>;
    try {
      sites = callSites(await Deno.readTextFile(new URL(name, dir)));
    } catch (err) {
      findings.push({ severity: "error", path: `shell/screens/${name}`, message: said(err) });
      continue;
    }
    for (const [module, found] of sites) {
      const held = merged.get(module) ?? [];
      for (const site of found) if (!held.some((s) => sameSite(s, site))) held.push(site);
      merged.set(module, held);
    }
  }
  return merged;
}

export type Checked = { findings: Finding[]; exercised: Exercised[] };

export async function checkApp(appDir: URL, options: BatteryOptions = {}): Promise<Checked> {
  let shell: Shell;
  try {
    shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as Shell;
  } catch (err) {
    // The one file this check cannot do without. Unreadable or malformed, it
    // is a finding in the format the verb reads rather than a stack trace: a
    // run that cannot enumerate has exercised nothing.
    return { findings: [{ severity: "error", path: "shell/shell.yaml", message: said(err) }], exercised: [] };
  }
  const schema = shell.schema;
  if (schema === undefined) {
    // An emitted key, so its absence is a file that is not a shell.yaml rather
    // than an app that declares no entities — and every generator below would
    // be drawing from nothing.
    return {
      findings: [{
        severity: "error",
        path: "shell/shell.yaml",
        message: "no schema: in shell.yaml; run plugins/pronto/write.ts",
      }],
      exercised: [],
    };
  }

  const entities = entitiesOf(schema);
  const findings: Finding[] = [];
  const exercised: Exercised[] = [];

  /** One declaration, read and run. A module the app names and does not ship
   * is check-handlers' finding, said in the role's words; this one says it in
   * its own rather than falling over. */
  const take = async (
    path: string,
    role: "handler" | "validation",
    inputsFor: (site: CallSite) => fc.Arbitrary<{ state: unknown; event: unknown }>,
    sites: CallSite[],
  ) => {
    let source: string;
    try {
      source = await Deno.readTextFile(new URL(path, appDir));
    } catch (err) {
      exercised.push({ path, role, runs: 0, maxFuel: 0, error: said(err) });
      return;
    }
    for (const site of sites) {
      let inputs: fc.Arbitrary<{ state: unknown; event: unknown }>;
      try {
        inputs = inputsFor(site);
      } catch (err) {
        // A call site naming a region the schema does not declare: the world
        // it asks for does not exist, so there is nothing to draw and the
        // disagreement is the finding.
        exercised.push({ path, role, table: site.table, params: site.params, runs: 0, maxFuel: 0, error: said(err) });
        continue;
      }
      exercised.push(await exercise(path, role, source, inputs, site, options));
    }
  };

  // One module named by two routes is one run per call site: the world is the
  // app's whole schema either way, so what separates two runs is the literals
  // the reference hands it.
  const handlers = new Set<string>();
  for (const route of shell.routes ?? []) for (const path of route.files?.handlers ?? []) handlers.add(path);
  const sites = await screenCallSites(appDir, findings);
  if (handlers.size > 0 && Object.keys(entities).length === 0) {
    // A module reads a world and the world is the app's collections. An app
    // that ships modules and registers no table has nothing to draw one from,
    // and a run that drew an empty world would report every module sound.
    findings.push({
      severity: "error",
      path: "shell/shell.yaml",
      message: `${handlers.size} module(s) declared and no table in schema: to draw a world from`,
    });
  } else {
    for (const path of [...handlers].sort()) {
      const named = sites.get(basenameOf(path));
      if (named === undefined) {
        // Two emitted keys disagreeing: a route lists a module its own screen
        // names nowhere. Called with no literals it might pass, and the
        // reference that would have said which literals does not exist.
        findings.push({
          severity: "error",
          path: "shell/shell.yaml",
          message: `a route lists ${path}, which no screen names`,
        });
        continue;
      }
      await take(path, "handler", (site) => arbitraryHandlerInput(entities, site.table), named);
    }
  }

  for (const [table, declared] of Object.entries(shell.validations ?? {})) {
    for (const [name, v] of Object.entries(declared)) {
      if (v.src === undefined) continue;
      const entity = entities[table];
      if (entity === undefined) {
        findings.push({
          severity: "error",
          path: "shell/shell.yaml",
          message: `validations "${name}" is filed under "${table}", which the emitted schema does not declare`,
        });
        continue;
      }
      // A validation is handed the row being written and the rows its edges
      // walk to — the same world the store and plv8 hand it — so the inputs
      // are drawn against those edges and not against the whole schema.
      await take(v.src, "validation", () => arbitraryValidationInput(entity, v.edges ?? [], entities), [{}]);
    }
  }

  for (const run of exercised) {
    if (run.error !== undefined) findings.push({ severity: "error", path: run.path, message: `${run.role}: ${run.error}` });
  }
  return { findings, exercised };
}

/**
 * The check's own claims, as sentences; empty is a pass. Returned rather than
 * printed so the caller owns the stream — check-markup's self-test says why.
 */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];
  // The two halves this check is assembled from answer for themselves.
  failures.push(...(await instrumentSelfTest()).failures);
  failures.push(...arbitrarySelfTest().failures);

  // The orchestration, against a fixture app carrying one module per property.
  // Each property is exercised on its own below; what is proven here is that
  // every declaration shell.yaml makes is REACHED, with the inputs the
  // schema's own domains admit.
  const fixture = new URL("./test/fixtures/battery/", import.meta.url);
  const run = await checkApp(fixture, { numRuns: 20, fuelLimit: 2000 });
  const got = run.findings.map((f) => `${f.path.split("/").pop()}: ${f.message.split("\n")[0]}`);
  const want = [
    "mutating.js: handler: ",
    "shapeless.js: handler: an update's op is \"nudge\", not put, patch, delete or insert",
    "spinning.js: handler: Jessie fuel limit exceeded (2000 steps)",
    "unshipped.js: handler: ",
    "not-a-predicate.js: validation: returned object, not a boolean",
  ];
  const orchestrated = got.length === want.length && want.every((w, i) => got[i].startsWith(w));
  if (!orchestrated) failures.push(`the fixture app's findings: ${JSON.stringify(got, null, 2)}`);
  // The sound modules are the half that would go dark if the first defect
  // stopped the walk: a count, so a fixture that grows is not silently
  // half-run.
  if (run.exercised.length !== 9) {
    failures.push(`the fixture app declares 9 runnable modules, exercised ${run.exercised.length}`);
  }
  // A module that answers is a module that was RUN: a battery whose generator
  // produced nothing would report the same empty findings as one that ran.
  const sound = run.exercised.find((e) => e.path.endsWith("sound.js"));
  if (sound === undefined || sound.error !== undefined || sound.maxFuel <= 0) {
    failures.push(`the fixture's sound handler: ${JSON.stringify(sound)}`);
  }

  // The generated rows obey the fixture's own schema. The handler under
  // `bounded.js` refuses any row outside the domains shell.yaml states, so its
  // silence is the assertion: the bounds crossed, and the generator obeyed
  // them. Weaken either end and this is the entry that appears above.
  const bounded = run.exercised.find((e) => e.path.endsWith("bounded.js"));
  if (bounded === undefined || bounded.error !== undefined) {
    failures.push(`generated rows left the schema's bounds: ${JSON.stringify(bounded?.error)}`);
  }

  // A chart's reference is a third argument, and the fixture's screen states
  // one. `params-read.js` reads the column it names, so its silence — and the
  // literals carried on its own result row — is the assertion that the call
  // site reached the module.
  const named = run.exercised.find((e) => e.path.endsWith("params-read.js"));
  if (named?.error !== undefined || JSON.stringify(named?.params) !== '{"col":"code"}') {
    failures.push(`a chart's literals did not reach the leaf: ${JSON.stringify(named)}`);
  }

  // A module runs CONFINED, not merely metered. Every property above passes
  // just as well when the source runs with this process's own globals in
  // scope, so the authority it can SEE is the thing to assert on: `fetch` and
  // `Deno` are both real here and neither may reach a module.
  const confined = await exercise(
    "confinement",
    "handler",
    `(state, event) => {
  if (typeof fetch !== "undefined") throw new Error("fetch reached a handler");
  if (typeof Deno !== "undefined") throw new Error("Deno reached a handler");
  return { updates: [] };
};`,
    fc.record({ state: fc.constant({}), event: fc.constant({}) }),
    {},
    { numRuns: 5 },
  );
  if (confined.error !== undefined) failures.push(`a module ran outside the compartment: ${confined.error}`);

  // And the realm around it was sealed: a compartment on an unlocked realm
  // still shares mutable intrinsics with everything else in the process.
  if ((globalThis as { __prontoLockdown?: boolean }).__prontoLockdown !== true) {
    failures.push("the realm was never locked down, so the compartment shares mutable intrinsics");
  }

  // A module is metered, which means it may spend the meter and may not be
  // the meter. The rewrite refuses one that binds the name, and the refusal
  // is a finding about THAT module — named, with the line it did it on —
  // rather than a throw that would take the whole run down with it.
  const captured = await exercise(
    "capture",
    "handler",
    `const ${METER} = Function.prototype;\n(state, event) => ({ updates: [] });\n`,
    fc.record({ state: fc.constant({}), event: fc.constant({}) }),
    {},
    { numRuns: 5 },
  );
  if (captured.error === undefined || !captured.error.includes(METER)) {
    failures.push(`a module that binds the meter's name: ${JSON.stringify(captured.error)}`);
  }

  // An app whose shell.yaml carries no schema is not an app with no modules to
  // run: the run says so instead of drawing every input from nothing.
  const bare = await checkApp(new URL("./test/fixtures/handlers/", import.meta.url));
  if (bare.exercised.length !== 0 || !bare.findings.some((f) => f.message.includes("no schema:"))) {
    failures.push(`a shell.yaml with no schema: ${JSON.stringify(bare.findings.map((f) => f.message))}`);
  }

  // The verb gate.
  const gate: [Finding[], boolean][] = [
    [[], false],
    [[{ severity: "advisory", path: "t", message: "m" }], false],
    [[{ severity: "error", path: "t", message: "m" }], true],
  ];
  for (const [given, want] of gate) {
    if (fails(given) !== want) failures.push(`the verb gate on ${JSON.stringify(given.map((f) => f.severity))}`);
  }

  return { failures };
}

// What the `check battery` leaf of the command line is: runtime/cli.ts
// resolves the permissions this needs and hands over what followed the
// subcommand.
export async function run(args: string[]): Promise<void> {
  // A module that stalls without spending a step — one awaiting something that
  // never comes — drains the event loop with nothing reported, and Deno exits
  // 0 on an empty loop. So the run is failed until it has said what it found.
  Deno.exitCode = 1;
  if (args[0] === "--self-test") {
    const { failures } = await selfTest();
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(failures.length === 0 ? "check-battery self-test: passed" : `check-battery self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = args[0];
  if (appDir === undefined) {
    console.error("usage: check-battery.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const { findings, exercised } = await checkApp(new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`));
  console.log(JSON.stringify(findings, null, 2));
  // What was covered, module by module, not just what was wrong: an app whose
  // handlers all survive prints the same empty findings as one whose modules
  // were never run, and only the steps each one spent separates them.
  for (const e of exercised) {
    const where = [e.table === undefined ? "" : `@${e.table}`, e.params === undefined ? "" : ` ${JSON.stringify(e.params)}`].join("");
    console.error(
      `check-battery: ${e.path} (${e.role}${where}) ${e.runs} run(s), ${e.maxFuel} step(s)${e.error === undefined ? "" : " FAILED"}`,
    );
  }
  console.error(`check-battery: ${exercised.length} module(s) exercised; ${findings.length} finding(s).`);
  if (!fails(findings)) Deno.exitCode = 0;
}

if (import.meta.main) await run(Deno.args);
