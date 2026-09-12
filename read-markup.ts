// omnishell markup projection: what one app's screens SAY, as JSON.
//
//   deno run --no-lock --no-check --node-modules-dir=none --allow-read=. \
//     ../../plugins/omnishell/read-markup.ts <appDir>
//   deno run read-markup.ts --self-test
//
// The terminal publishes the markup's grammar, so it publishes the readings of
// it too (interpreter/lint.ts, interpreter/fragment.js). A compiler needs the
// same answers this plugin's own checkers do — which collections a screen
// reads, which Jessie modules it binds, which charts it runs — and asks for
// them through this command rather than importing the readers: an import is a
// path into this plugin's tree, and a compiler published on its own carries no
// such path. A subprocess is the form that survives being consumed.
//
// The contract, one JSON object on stdout, compact because its reader is a
// parser:
//
//   {"screens": {"<name>": {
//     "tables":   [...],       // data-live, data-reads, data-read-* — sorted, deduped
//     "handlers": [...],       // data-handler, data-on-* — sorted, deduped
//     "machines": [{           // one entry per CHART: a region listing two runs two
//       "table":    "...",     // the region's data-live
//       "machine":  "...",     // the chart as authored, the bytes #Machine is vetted on
//       "emptyRow": "...",     // data-empty-row, absent where the region states none
//       "filter":   "...",     // data-filter, absent where the region states none
//       "refs":          [...],   // positions that are always module references
//       "assignStrings": [...],   // dual positions: a module reference where the name is declared
//       "filterSpec": [{"col": "...", "op": "...", "value": "..."}] | null
//     }]
//   }}}
//
// `filterSpec` is the region's own filter parsed by the one filter grammar;
// null is that grammar's answer for a fragment the server computes, and a
// caller asking whether a region pins a row has to tell that apart from a
// filter pinning nothing.
//
// Screens are read from shell/screens/, the directory an app keeps them in,
// and not from shell.yaml's routes: a compiler runs this to DERIVE what the
// routes are declared from, so the declaration does not exist yet.
//
// A screen whose markup the readers refuse — a data-machine off a region, a
// data-filter anchored to no table — is named on stderr with the reason, and
// the run exits 1 having printed nothing: a partial projection would be read
// as an app whose screens say less than they do.

import { machineRegions, scanScreen } from "./interpreter/lint.ts";
import { machineShape, parseFilterSpec } from "./interpreter/fragment.js";

/** A filter as descriptors, or null where the fragment is server-computed. */
export type Spec = { col: string; op: string; value?: string }[] | null;

export type MachineProjection = {
  table: string;
  machine: string;
  emptyRow?: string;
  filter?: string;
  refs: string[];
  assignStrings: string[];
  filterSpec: Spec;
};

export type ScreenProjection = { tables: string[]; handlers: string[]; machines: MachineProjection[] };

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/** One screen's markup as the projection above. Optional keys are absent
 * rather than null where the markup states nothing, so a reader can tell "no
 * data-filter" from "a filter that parsed to nothing". */
export function projectScreen(html: string): ScreenProjection {
  const { tables, handlers } = scanScreen(html);
  const machines = machineRegions(html).map((region) => {
    // machineRegions has already parsed this and refused what is not JSON, so
    // the shape walk reads a value rather than a string.
    const shape = machineShape(JSON.parse(region.machine));
    const projection: MachineProjection = {
      table: region.table,
      machine: region.machine,
      refs: shape.refs,
      assignStrings: shape.assignStrings,
      filterSpec: parseFilterSpec(region.filter ?? "") as Spec,
    };
    if (region.emptyRow !== undefined) projection.emptyRow = region.emptyRow;
    if (region.filter !== undefined) projection.filter = region.filter;
    return projection;
  });
  return { tables, handlers, machines };
}

/** Every screen of one app, keyed by the name its file carries. */
export async function projectApp(
  appDir: URL,
): Promise<{ screens: Record<string, ScreenProjection>; errors: string[] }> {
  const screens: Record<string, ScreenProjection> = {};
  const errors: string[] = [];
  const dir = new URL("shell/screens/", appDir);
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch (err) {
    // The directory an app's screens live in. Unreadable, there is nothing to
    // project and no answer to give — the caller derives from this.
    return { screens, errors: [`shell/screens: ${said(err)}`] };
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile || !entry.name.endsWith(".html")) continue;
    const name = entry.name.slice(0, -".html".length);
    try {
      screens[name] = projectScreen(await Deno.readTextFile(new URL(entry.name, dir)));
    } catch (err) {
      errors.push(`${entry.name}: ${said(err)}`);
    }
  }
  return { screens, errors };
}

/**
 * The command's own claims, as sentences; empty is a pass. Returned rather
 * than printed so the caller owns the stream, as the checkers' are.
 */
export function selfTest(): { failures: string[] } {
  const failures: string[] = [];
  const check = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push(`${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };

  // One screen carrying every position of the contract: a plain read, a named
  // read, a bound handler, and a chart whose guard is a reference and whose
  // assign is the dual position.
  const chart = {
    field: "state",
    initial: "off",
    states: {
      off: { on: { click: { target: "on", guard: "allowed", assign: { note: "spun" } } } },
      on: { on: { click: "off" } },
    },
  };
  const html = `<main data-live="match" data-reads="round" data-on-mutation="table">` +
    `<div data-live="held" data-filter="id=eq.the" data-empty-row='{"id":"the","state":"off"}' ` +
    `data-machine='${JSON.stringify(chart)}'></div></main>`;
  check("the whole projection of one screen", projectScreen(html), {
    tables: ["held", "match", "round"],
    handlers: ["table"],
    machines: [{
      table: "held",
      machine: JSON.stringify(chart),
      refs: ["allowed"],
      assignStrings: ["spun"],
      filterSpec: [{ col: "id", op: "eq", value: "the" }],
      emptyRow: '{"id":"the","state":"off"}',
      filter: "id=eq.the",
    }],
  });

  // A server-computed fragment is null and not an empty list: a caller asking
  // whether a region pins its id must tell "the grammar does not answer this"
  // from "it answers, and nothing is pinned".
  const searched = `<ul data-live="article" data-filter="title=fts.rain" ` +
    `data-machine='{"field":"state","initial":"a","states":{"a":{}}}'></ul>`;
  check("a filter outside the translatable subset", projectScreen(searched).machines[0].filterSpec, null);
  const bare = `<ul data-live="article" data-machine='{"field":"state","initial":"a","states":{"a":{}}}'></ul>`;
  check("a region stating no filter", projectScreen(bare).machines[0].filterSpec, []);

  // A region listing two charts runs two, and each is projected on its own —
  // the bytes of each are what a schema is vetted against.
  const listed = `<ul data-live="pair" data-machine='[{"field":"a","initial":"x","states":{"x":{}}},` +
    `{"field":"b","initial":"y","states":{"y":{}}}]'></ul>`;
  check(
    "a region listing two charts projects two entries",
    projectScreen(listed).machines.map((m) => m.machine),
    ['{"field":"a","initial":"x","states":{"x":{}}}', '{"field":"b","initial":"y","states":{"y":{}}}'],
  );

  // Markup the readers refuse is the reason a screen has no projection, and
  // the sentence is the grammar's own.
  try {
    projectScreen(`<div data-machine='{"field":"f","initial":"a","states":{"a":{}}}'></div>`);
    failures.push("a data-machine off a region projected instead of refusing");
  } catch (err) {
    check("a data-machine off a region", said(err), "data-machine on a tag with no data-live");
  }

  return { failures };
}

if (import.meta.main) {
  if (Deno.args[0] === "--self-test") {
    const { failures } = selfTest();
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(failures.length === 0 ? "read-markup self-test: passed" : `read-markup self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = Deno.args[0];
  if (appDir === undefined) {
    console.error("usage: read-markup.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const { screens, errors } = await projectApp(
    new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`),
  );
  for (const e of errors) console.error(`read-markup: ${e}`);
  if (errors.length > 0) Deno.exit(1);
  console.log(JSON.stringify({ screens }));
}
