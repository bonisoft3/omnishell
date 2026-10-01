// omnishell markup check: every screen says something this grammar admits,
// about entities the program declares.
//
//   omnishell check markup <appDir>
//   omnishell check markup --self-test
//
// The rules are interpreter/lint.ts's, stated beside the vocabulary they judge
// because the plugin publishing a grammar publishes what a well-formed
// sentence in it is. This is that ownership exercised over one app: the
// screens under shell/screens/ are read, every rule is applied to each, and
// the finding is the rule's own sentence.
//
// A rule needs more than the markup — which columns a table has, what
// witnesses a single row, which tier owns it, which values a column admits,
// which routes there are to link to — and the emitted shell.yaml carries all
// of it under `schema:` and `routes:`. Those keys are what make this rung
// standalone: the rules run here, against what the app emitted, so a terminal
// consumed on its own brings them along.
//
// The handler set is read from shell/handlers/ rather than from the routes,
// because a chart's reference is DERIVED into a route's file list: grading
// the references against that list would grade them against themselves. What
// the app ships is the answer, and a module declared and not shipped is
// check-handlers' finding.
//
// What this does NOT do is judge a VALUE. A rule here asks whether the markup
// could bind, write or admit something — never whether a row's contents
// satisfy the program's constraints, which is the store's rung.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding is reported.

import { load as parseYaml } from "./interpreter/vendor/js-yaml.js";
import {
  type Entity,
  formatBindings,
  formatLint,
  kindedRegions,
  kindLint,
  linkLint,
  type LinkRoute,
  machineLint,
  machineRegions,
  machineWrites,
  parallelLint,
  scanScreen,
  slotRegions,
  templateArity,
  undeclaredSlot,
  unknownColumns,
  unwitnessedControls,
  unwitnessedSlot,
  type Write,
  writeLint,
} from "./interpreter/lint.ts";
import { parseFilterSpec } from "./interpreter/fragment.js";

type Finding = { severity: string; path: string; message: string };

/** Whether a run's findings fail the verb. Nothing this check reports is a
 * fact about the checker — a screen either says something the grammar admits
 * or does not — so every finding here is an error. The band is stated anyway,
 * because the verb gate is the loop's vocabulary and not this file's to
 * redefine. check-handlers bands the same way. */
export const fails = (findings: Finding[]) => findings.some((f) => f.severity !== "advisory");

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/** shell.yaml's `schema:`: the entity projection these rules judge against.
 * `enum` is the closed value set a column's constraint states — the program's
 * constraint language is the only thing that knows it, so it arrives derived
 * rather than parsed here. */
type SchemaField = {
  name: string;
  type: string;
  pk?: boolean;
  unique?: boolean;
  default?: string;
  enum?: string[];
  money?: { currency: string; minorUnits: number };
};
type SchemaEntity = {
  durability: string;
  fields: SchemaField[];
  uniques?: { name: string; cols: string[]; where?: string }[];
};
type Shell = { schema?: Record<string, SchemaEntity>; routes?: LinkRoute[] };

/** The schema entry as the rules take it: they are written against a whole
 * entity, whose table is the key it is filed under. */
const entityOf = (table: string, e: SchemaEntity): Entity => ({
  table,
  durability: e.durability,
  fields: e.fields,
  uniques: e.uniques,
});

/** The values a column admits, or null where it admits an open set — read off
 * the emitted schema, which is where the program's constraint language put
 * them. */
const enumsOf = (e: SchemaEntity) => (col: string): string[] | null =>
  e.fields.find((f) => f.name === col)?.enum ?? null;

/**
 * One screen's findings, in the order the rules are stated: what a region
 * reads, what a slot binds, what a format resolves, what a template admits,
 * what a chart names and writes, where a caret may follow, and what a control
 * reaches.
 *
 * A reader that refuses the markup outright — a data-machine off a region, a
 * data-filter anchored to no table — is itself a finding: every rule after it
 * would be judging a screen nobody could read.
 */
export function screenFindings(
  path: string,
  html: string,
  schema: Record<string, SchemaEntity>,
  available: Set<string>,
  routes: LinkRoute[],
): Finding[] {
  const out: Finding[] = [];
  const report = (message: string) => out.push({ severity: "error", path, message });
  // A table the markup reads and the schema does not declare: the emitted
  // pair disagrees, and every rule about that region would be judging it
  // against nothing. Said once per table however many rules ask — the screen
  // names a table the app does not have, which is one defect and not one per
  // question asked about it.
  const missing = new Set<string>();
  const declared = (table: string): SchemaEntity | undefined => {
    const e = schema[table];
    if (e === undefined && !missing.has(table)) {
      missing.add(table);
      report(`reads "${table}", which the emitted schema does not declare`);
    }
    return e;
  };
  /** A reader's own refusal, reported rather than thrown. */
  const read = <T>(f: () => T): T | undefined => {
    try {
      return f();
    } catch (err) {
      report(said(err));
      return undefined;
    }
  };

  const scanned = read(() => scanScreen(html));
  for (const { table, filter } of scanned?.filters ?? []) {
    const e = declared(table);
    if (e === undefined) continue;
    const bad = unknownColumns(filter, e.fields.map((f) => f.name));
    if (bad.length > 0) report(`data-filter="${filter}" names ${bad.join(", ")} — not fields of "${table}"`);
  }

  for (const slot of read(() => slotRegions(html)) ?? []) {
    const e = declared(slot.table);
    if (e === undefined) continue;
    const why = unwitnessedSlot(slot.filter, entityOf(slot.table, e));
    if (why !== null) {
      report(
        `slot region "${slot.table}" (filter ${JSON.stringify(slot.filter ?? "")}) may bind more than one row: ${why}`,
      );
    }
    const unsaid = undeclaredSlot(slot);
    if (unsaid !== null) {
      report(`slot region "${slot.table}" (filter ${JSON.stringify(slot.filter ?? "")}) ${unsaid}`);
    }
  }

  for (const b of read(() => formatBindings(html)) ?? []) {
    // Read straight off the schema rather than through declared(): a region's
    // table is a table this screen reads, so an undeclared one is already the
    // rules above's to report, and asking here would only move the sentence.
    const e = b.table === undefined ? undefined : schema[b.table];
    const why = formatLint(b, e === undefined ? undefined : entityOf(b.table as string, e));
    if (why !== null) report(why);
  }

  for (const kinded of read(() => kindedRegions(html)) ?? []) {
    const e = declared(kinded.table);
    if (e === undefined) continue;
    const why = kindLint(kinded.whens, entityOf(kinded.table, e), enumsOf(e), kinded.projects);
    if (why !== null) report(`region "${kinded.table}": ${why}`);
  }

  // Every region on the screen that writes the same table is judged together:
  // one region's spelling is only inconsistent against another's.
  const writes = new Map<string, Write[]>();
  const grouped = new Set<string>();
  for (const region of read(() => machineRegions(html)) ?? []) {
    // machineRegions refuses what is not JSON, so a chart reaching here parses.
    const chart = JSON.parse(region.machine);
    const why = machineLint(chart, available);
    if (why !== null) report(`data-machine: ${why}`);
    writes.set(region.table, [...(writes.get(region.table) ?? []), ...machineWrites(chart, region.emptyRow)]);
    // The group's own rule, run once per group rather than once per chart.
    const group = region.parallel.join(" ");
    if (region.parallel.length > 1 && !grouped.has(group)) {
      grouped.add(group);
      const parallel = parallelLint(region.parallel.map((c) => JSON.parse(c)));
      if (parallel !== null) report(`region "${region.table}": ${parallel}`);
    }
  }
  for (const [table, cols] of writes) {
    const e = declared(table);
    if (e === undefined) continue;
    const why = writeLint(cols, entityOf(table, e));
    if (why !== null) report(`region "${table}": ${why}`);
  }

  // After the machine rules: a control's cover depends on what its region's
  // machine answers, and an unparseable machine is that pass's finding.
  for (const why of read(() => templateArity(html)) ?? []) report(why);
  for (const why of read(() => unwitnessedControls(html)) ?? []) report(why);
  for (const why of read(() => linkLint(html, routes)) ?? []) report(why);
  return out;
}

/** The rule the schema states about itself: a partial unique witnesses a
 * slot's cardinality through its predicate, so a predicate this grammar
 * cannot read witnesses nothing — and the slot rule above would report the
 * region instead of the declaration that disarmed it. */
export function schemaFindings(schema: Record<string, SchemaEntity>): Finding[] {
  const out: Finding[] = [];
  for (const [table, e] of Object.entries(schema)) {
    for (const u of e.uniques ?? []) {
      if (u.where !== undefined && parseFilterSpec(u.where) === null) {
        out.push({
          severity: "error",
          path: "shell/shell.yaml",
          message: `"${table}" uniques "${u.name}" where "${u.where}" is outside the translatable fragment subset`,
        });
      }
    }
  }
  return out;
}

/** The Jessie modules the app ships, by basename. An app shipping none is a
 * true answer: a screen whose regions are all bindings declares no module. */
async function shippedModules(appDir: URL): Promise<Set<string>> {
  const available = new Set<string>();
  try {
    for await (const f of Deno.readDir(new URL("shell/handlers/", appDir))) {
      if (f.isFile && f.name.endsWith(".js")) available.add(f.name.slice(0, -".js".length));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return available;
}

export type Checked = { findings: Finding[]; checked: number };

export async function checkApp(appDir: URL): Promise<Checked> {
  let shell: Shell;
  try {
    shell = parseYaml(await Deno.readTextFile(new URL("shell/shell.yaml", appDir))) as Shell;
  } catch (err) {
    // The one file this check cannot do without. Unreadable or malformed, it
    // is a finding in the format the verb reads rather than a stack trace: a
    // run that cannot read the schema has graded nothing.
    return { findings: [{ severity: "error", path: "shell/shell.yaml", message: said(err) }], checked: 0 };
  }
  const schema = shell.schema;
  const routes = shell.routes;
  if (schema === undefined || routes === undefined) {
    // Emitted keys, so an absence is a file that is not a shell.yaml rather
    // than an app that declares no entities or goes nowhere — and every rule
    // below would pass over a screen it cannot judge.
    return {
      findings: [{
        severity: "error",
        path: "shell/shell.yaml",
        message: `no ${schema === undefined ? "schema" : "routes"}: in shell.yaml; run plugins/pronto/write.ts`,
      }],
      checked: 0,
    };
  }

  const available = await shippedModules(appDir);
  const findings = schemaFindings(schema);
  const dir = new URL("shell/screens/", appDir);
  const names: string[] = [];
  try {
    for await (const f of Deno.readDir(dir)) if (f.isFile && f.name.endsWith(".html")) names.push(f.name);
  } catch (err) {
    return {
      findings: [...findings, { severity: "error", path: "shell/screens", message: said(err) }],
      checked: 0,
    };
  }
  for (const name of names.sort()) {
    findings.push(
      ...screenFindings(
        `shell/screens/${name}`,
        await Deno.readTextFile(new URL(name, dir)),
        schema,
        available,
        routes,
      ),
    );
  }
  return { findings, checked: names.length };
}

/**
 * The check's own claims, as sentences; empty is a pass. Returned rather than
 * printed so the caller owns the stream — check-machines' self-test says why.
 */
export async function selfTest(): Promise<{ failures: string[] }> {
  const failures: string[] = [];

  // The orchestration, against a fixture app carrying one screen per rule.
  // Every rule is a unit test of its own beside this file; what is proven here
  // is that each one is REACHED, with the entity the markup names and the
  // values the schema states.
  const fixture = new URL("./test/fixtures/markup/", import.meta.url);
  const run = await checkApp(fixture);
  const got = run.findings.map((f) => `${f.path.split("/").pop()}: ${f.message}`);
  const want = [
    // The schema's own, before any screen: the partial unique that witnesses
    // nothing because nothing can read its predicate.
    'shell.yaml: "note" uniques "one-pinned" where "title=fts.rain" is outside the translatable fragment subset',
    "arity.html: template[data-item] in [data-live=\"note\"] holds 2 elements",
    'columns.html: data-filter="colour=eq.blue" names colour — not fields of "note"',
    "control.html: <button class=\"act\"> is wired to nothing",
    'format.html: data-text-format="money" reads {msg.total} outside every data-live region',
    'format.html: data-text-format="number" reads {title}, which is text on "note"',
    'format.html: data-text-format="money" reads {step}, which declares no money: on "note"',
    'format.html: data-text-format="money" reads {category.budget}, which is not a column of "note"',
    'format.html: data-text-format="money" reads {amount}, which is not a column of "detail"',
    'kinds.html: region "note": data-when="kind=eq.quote": "quote" is not a declarable kind (note, link)',
    'link.html: <a href="/note/um"> writes an internal path by hand',
    'link.html: <a href="#/note/um"> writes an internal path by hand',
    'link.html: data-route="ghost" names no route in shell.yaml',
    'link.html: data-route="detail" fills no :id of "/note/:id"',
    'link.html: data-param-id on data-route="sound" names no :param of "/"',
    'machine.html: data-machine: "missing" name no module under shell/handlers/',
    'nested.html: slot region "detail" (filter "id=eq.{id}") is nested and declares no empty treatment',
    'parallel.html: region "note": the charts over "state" and "mark" both write "mark"',
    'refuses.html: data-machine on a tag with no data-live',
    'slot.html: slot region "note" (filter "kind=eq.note") may bind more than one row',
    'unknown.html: reads "ghost", which the emitted schema does not declare',
    'writes.html: region "note": "step" is written in 2 spellings',
  ];
  const orchestrated = got.length === want.length && want.every((w, i) => got[i].startsWith(w));
  if (!orchestrated) {
    failures.push(`the fixture app's findings: ${JSON.stringify(got, null, 2)}`);
  }
  // The sound screen is the half that would go dark if a reader's refusal
  // stopped the walk: a count, so a fixture that grows is not silently
  // half-read.
  if (run.checked !== 14) {
    failures.push(`the fixture app carries 14 screens, read ${run.checked}`);
  }

  // An app whose shell.yaml carries no schema is not an app with no rules to
  // apply: the run says so instead of grading every screen against nothing.
  const bare = await checkApp(new URL("./test/fixtures/handlers/", import.meta.url));
  if (bare.checked !== 0 || !bare.findings.some((f) => f.message.includes("no schema:"))) {
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

// What the `check markup` leaf of the command line is: runtime/cli.ts resolves
// the permissions this needs and hands over what followed the subcommand.
export async function run(args: string[]): Promise<void> {
  if (args[0] === "--self-test") {
    const { failures } = await selfTest();
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(failures.length === 0 ? "check-markup self-test: passed" : `check-markup self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = args[0];
  if (appDir === undefined) {
    console.error("usage: check-markup.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const { findings, checked } = await checkApp(new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`));
  console.log(JSON.stringify(findings, null, 2));
  // What was covered, not just what was wrong: an app whose screens are all
  // sound prints the same empty findings as one whose screens were never read.
  console.error(`check-markup: ${checked} screen(s) read; ${findings.length} finding(s).`);
  Deno.exit(fails(findings) ? 1 : 0);
}

if (import.meta.main) await run(Deno.args);
