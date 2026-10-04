// omnishell markup projection: what one app's screens SAY, as JSON.
//
//   omnishell read markup <appDir>
//   omnishell read markup --self-test
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
//     "handlers": [...],       // data-handler, data-on-* — sorted, deduped
//     "adapters": [...],       // data-value-adapter — sorted, deduped
//     "reads": [{              // every read, in document order (lint.ts ScreenRead, pronto's #Read)
//       "table":  "...",
//       "kind":   "live" | "reads" | "named",   // data-live, data-reads, data-read-<name>
//       "nested": true | false,                 // inside an enclosing data-live region
//       "lists":  [N, ...],                     // the reads of the lists stamping it, each once per row
//       "route":  "server" | "snapshot" | "whole" | "view",  // fragment.js routeOf
//       "clauses": [{"col": "...", "op": "..."}],  // absent where the server computes it
//       "embeds": ["<table>", ...],             // absent likewise
//       "limit":  N,                            // absent where the filter caps nothing
//       "orders": ["col", ...]                  // every column an order it can be in names
//     }],
//     "writes": [{"table": "...", "op": "...", "filter": "..."}],  // forms, chart effects, and each region's reduces as op "reduce"
//     "machines": [{           // one entry per CHART: a region listing two runs two
//       "table":    "...",     // the region's data-live
//       "machine":  "...",     // the chart as authored, the bytes #Machine is vetted on
//       "emptyRow": "...",     // data-empty-row, absent where the region states none
//       "filter":   "...",     // data-filter, absent where the region states none
//       "refs":          [...],   // positions that are always module references
//       "assignStrings": [...],   // dual positions: a module reference where the name is declared
//       "filterSpec": [{"col": "...", "op": "...", "value": "..."}] | null,
//       "writes":     [{"table": "...", "op": "...", "filter": "..."}]  // its effects, each among the screen's writes
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

import { machineRegions, scanScreen, screenAccess, type ScreenRead, type ScreenWrite } from "./interpreter/lint.ts";
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
  writes: ScreenWrite[];
};

export type ScreenProjection = {
  handlers: string[];
  adapters: string[];
  reads: ScreenRead[];
  writes: ScreenWrite[];
  machines: MachineProjection[];
};

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/** One screen's markup as the projection above. Optional keys are absent
 * rather than null where the markup states nothing, so a reader can tell "no
 * data-filter" from "a filter that parsed to nothing". */
export function projectScreen(html: string): ScreenProjection {
  const { handlers, adapters } = scanScreen(html);
  const { reads, writes } = screenAccess(html);
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
      writes: (shape.effects as { op: string; entity?: unknown; filter?: unknown }[]).map((e) => ({
        table: typeof e.entity === "string" ? e.entity : region.table,
        op: e.op,
        ...(typeof e.filter === "string" ? { filter: e.filter } : {}),
      })),
    };
    if (region.emptyRow !== undefined) projection.emptyRow = region.emptyRow;
    if (region.filter !== undefined) projection.filter = region.filter;
    return projection;
  });
  return { handlers, adapters, reads, writes: [...writes, ...machines.flatMap((m) => m.writes)], machines };
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
      on: { on: { click: { target: "off", effect: { op: "create", entity: "score", values: {} } } } },
    },
  };
  const html = `<main data-live="match" data-reads="round" data-on-mutation="table">` +
    `<div data-live="held" data-filter="id=eq.the" data-empty-row='{"id":"the","state":"off"}' ` +
    `data-machine='${JSON.stringify(chart)}'></div></main>`;
  check("the whole projection of one screen", projectScreen(html), {
    handlers: ["table"],
    adapters: [],
    reads: [
      { table: "match", kind: "live", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] },
      { table: "round", kind: "reads", nested: false, lists: [], route: "whole", clauses: [], embeds: [], orders: [] },
      { table: "held", kind: "live", nested: true, lists: [], route: "view", clauses: [{ col: "id", op: "eq" }], embeds: [], orders: [] },
    ],
    // A reduce's writes are its module's to say: recorded on its region's
    // table, as a reduce that may write any. A chart's effect names its own.
    writes: [{ table: "match", op: "reduce" }, { table: "score", op: "create" }],
    machines: [{
      table: "held",
      machine: JSON.stringify(chart),
      refs: ["allowed"],
      assignStrings: ["spun"],
      filterSpec: [{ col: "id", op: "eq", value: "the" }],
      // A chart's own writes, which pronto's facts count among the tables a
      // screen needs a collection for.
      writes: [{ table: "score", op: "create" }],
      emptyRow: '{"id":"the","state":"off"}',
      filter: "id=eq.the",
    }],
  });

  // Every route a read can take, each as the store would serve it: pronto's
  // derive decides which tables load on demand from exactly these.
  const routed = `<section data-live="game" data-filter="id=eq.{param.id}">` +
    `<ol data-live="goal" data-select="*,player(name)" data-filter="game_id=eq.{id}&limit=5" ` +
    `data-order='{"by":"{sort}","of":{"new":"minute.desc","old":"minute.asc"}}'></ol></section>` +
    `<ul data-live="card" data-filter="played=is.true"></ul>` +
    `<ul data-live="article" data-filter="title=fts.rain"></ul>` +
    `<div data-live="board" data-reads="team" data-read-mine="seat?player_id=eq.{me}&order=pos.asc"></div>` +
    `<form data-action="delete" data-entity="goal" data-filter="game_id=eq.{id}"></form>` +
    `<form data-action="update" data-entity="game"></form>`;
  const { reads, writes } = projectScreen(routed);
  check("each read's route, kind and nesting", reads.map((r) => [r.table, r.kind, r.route, r.nested]), [
    ["game", "live", "view", false],
    ["goal", "live", "view", true],
    ["card", "live", "snapshot", false],
    ["article", "live", "server", false],
    ["board", "live", "whole", false],
    ["team", "reads", "whole", false],
    ["seat", "named", "view", false],
  ]);
  check("a read's clauses, embeds, cap and the columns of every order it can be in", reads[1], {
    table: "goal", kind: "live", nested: true, lists: [], route: "view",
    clauses: [{ col: "game_id", op: "eq" }], embeds: ["player"], limit: 5, orders: ["minute"],
  });
  check("a filter the server computes states no clauses", reads[3], {
    table: "article", kind: "live", nested: false, lists: [], route: "server", embeds: [], orders: [],
  });
  // pronto's sync rule keeps a table eager when a view of it is read once per
  // row of a list, and lets one nested only in slots load on demand: a slot
  // binds one row, so its nested reads run once. A slot stamped by a list
  // runs once per row all the same, and a named template's read once per row
  // of each list naming it and of the one holding it.
  const stamped = `<ul data-live="championship"><template data-item>` +
    `<span data-live="category" data-filter="id=eq.{category_id}"></span>` +
    `<div data-live="phase" data-filter="id=eq.{phase_id}"><b data-live="zone" data-filter="phase_id=eq.{id}"></b></div>` +
    `</template></ul>` +
    `<section data-live="game" data-filter="id=eq.{param.id}">` +
    `<div data-live="team" data-filter="id=eq.{home_id}"><i data-live="crest" data-filter="team_id=eq.{id}"></i></div>` +
    `<ol data-live="goal" data-filter="game_id=eq.{id}" data-template="scorer"></ol></section>` +
    `<template data-item data-name="scorer"><li data-live="player" data-filter="id=eq.{player_id}"></li></template>` +
    `<ul data-live="assist" data-template="scorer"></ul>`;
  check("the lists stamping each read", projectScreen(stamped).reads.map((r) => [r.table, r.nested, r.lists]), [
    ["championship", false, []],
    ["category", true, [0]],
    ["phase", true, [0]],
    ["zone", true, [0]],
    ["game", false, []],
    ["team", true, []],
    ["crest", true, []],
    ["goal", true, []],
    ["player", true, [7, 9]],
    ["assist", false, []],
  ]);
  // Regression: a read in a top-level named template took only the regions
  // naming it, not the lists stamping those, so a player under a game that
  // pins one row stayed on demand while read once per championship row, where
  // the same markup written nested turned it eager.
  const outer = `<ul data-live="championship"><template data-item>`;
  const game = `<ol data-live="game" data-filter="id=eq.{game_id}"`;
  const player = `<li data-live="player" data-filter="id=eq.{player_id}"></li>`;
  const listsOf = (html: string) => projectScreen(html).reads.map((r) => [r.table, r.lists]);
  const want = [["championship", []], ["game", [0]], ["player", [0, 1]]];
  check("a read nested in a stamped list's template is stamped by both", listsOf(
    `${outer}${game}><template data-item>${player}</template></ol></template></ul>`,
  ), want);
  check("a read in a named template is stamped by the lists stamping its stamper", listsOf(
    `${outer}${game} data-template="scorer"></ol></template></ul>` +
      `<template data-item data-name="scorer">${player}</template>`,
  ), want);

  // pronto's sync rule reads a form's write from here alone.
  check("a form's writes", writes, [
    { table: "goal", op: "delete", filter: "game_id=eq.{id}" },
    { table: "game", op: "update" },
  ]);

  // Regression: only a data-on-mutation reduce was recorded, but a reduce
  // bound to any DOM event writes the same way (updates put, patch and
  // delete; effects upsert and delete by filter), and so does a drag's
  // data-handler, so pronto's sync rule left a table on demand that a click
  // could write by natural key. A reduce in a named template is wired in each
  // region that stamps the template: each naming it, and the one holding it.
  const reducing = `<template data-item data-name="cell"><li><button data-on-click="mark"></button></li></template>` +
    `<section data-live="board"><button data-on-click="move"></button>` +
    `<ol data-live="card" data-filter="board_id=eq.{id}"><template data-item><li data-on-answer="reply"></li></template></ol></section>` +
    `<ul data-live="lane" data-handler="drag"><template data-item><li></li></template></ul>` +
    `<ul data-live="cell" data-template="cell"></ul><ul data-live="slot" data-template="cell"></ul>` +
    `<ul data-live="deck"><template data-item data-name="face"><li data-on-click="flip"></li></template></ul>` +
    `<ul data-live="pile" data-template="face"></ul>`;
  check("every reduce's writes", projectScreen(reducing).writes, [
    { table: "board", op: "reduce" },
    { table: "card", op: "reduce" },
    { table: "lane", op: "reduce" },
    { table: "cell", op: "reduce" },
    { table: "slot", op: "reduce" },
    { table: "deck", op: "reduce" },
    { table: "pile", op: "reduce" },
  ]);

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

// What the `read markup` leaf of the command line is: runtime/cli.ts resolves
// the permissions this needs and hands over what followed the subcommand.
export async function run(args: string[]): Promise<void> {
  if (args[0] === "--self-test") {
    const { failures } = selfTest();
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(failures.length === 0 ? "read-markup self-test: passed" : `read-markup self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = args[0];
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

if (import.meta.main) await run(Deno.args);
