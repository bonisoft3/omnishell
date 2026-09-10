// omnishell machine walk: every arrow of every emitted chart fires, and the
// interpreter agrees with XState about where each one lands.
//
//   deno run --node-modules-dir=none --config ../../plugins/omnishell/test/deno.json \
//     --allow-read=.,../../plugins/omnishell/interpreter --allow-env \
//     ../../plugins/omnishell/check-machines.ts <appDir>
//   deno run check-machines.ts --self-test
//
// The app supplies nothing but its emitted tree: each route's markup is scanned
// for machine regions and every one is handed to the path walker (test/walker.ts
// owns what a walk is). An arrow that never fires, a field that leaves its
// states, or a step XState lands elsewhere on is the walker's error, and that
// sentence is the finding.
//
// One mount per REGION, because the held clock belongs to the whole mount and
// a sibling's timer would otherwise come due under a walk that is not its own.
// What this does NOT isolate is the store: siblings reading one row still see
// each other's writes, and a chart whose `after` moves a row a neighbour is
// reading is covered by none of it.
//
// A chart the markup states outright is walked, or reported when the mounted
// screen does not carry it. A chart whose filter interpolates is stamped per
// row: its instances are walked when the screen has rows for them, and nothing
// here notices when it has none. A route binding `:param` takes each value
// from a seeded row of the collection the markup filters by it, so the screen
// hydrates; a chart reading through a param no seed answers binds no row, and
// is reported rather than walked.
//
// Findings print as {severity, path, message} JSON (SPEC.md lint format);
// exit 1 when any finding is reported.

import { machineRegions, paramPlans } from "./interpreter/lint.ts";
import { parseFilter } from "./interpreter/fragment.js";
import { walkMachine, type WalkHarness } from "./test/walker.ts";
import type { Machine } from "./test/canonical.ts";
import {
  appCluster,
  appCollections,
  appFiles,
  appRoutes,
  appSeed,
  appUnits,
  boxOf,
  type Cluster,
  type El,
  type Mounted,
  mountScreen,
  type Route,
  type Row,
  type Unit,
} from "./test/screen-harness.ts";

type Finding = { severity: string; path: string; message: string };

/** Whether a run's findings fail the verb. A chart this rung cannot reach is a
 * fact about the checker, not about the app, and an app carrying one has no
 * way to make it walkable — so it is reported and costs nothing.
 * check-visual bands the same way. */
export const fails = (findings: Finding[]) => findings.some((f) => f.severity !== "advisory");

// Nothing in a chart is random and nothing renders a wall-clock instant, so
// the two knobs only have to be fixed. They are the file's, not a screen's:
// screen.js reads both once, at module evaluation.
const SEED = 20260901;
const EPOCH = "2026-09-01T00:00:00.000Z";

const said = (err: unknown) => err instanceof Error ? err.message : String(err);

/**
 * One region's walk, as findings. `where` names the region within its screen —
 * a screen carries several, and an arrow reported without it names a chart the
 * reader still has to find.
 */
export async function walkFindings(
  path: string,
  where: string,
  machine: Machine,
  harness: WalkHarness,
  opts: { owner?: unknown } = {},
): Promise<Finding[]> {
  try {
    const walk = await walkMachine(machine, harness, opts);
    if (walk.shadowed.length === 0) return [];
    // Advisory, not an error: the arrows are drawn and a reader reaches them by
    // typing further. What the walk reports is its own reach.
    return [{
      severity: "advisory",
      path,
      message: `${where}: ${walk.shadowed.length} arrow(s) an earlier sibling admits the event of, ` +
        `so nothing here selects them: ${
          walk.shadowed.map((a) => `${a.state} --${a.key}[${a.index}]-->`).join(", ")
        }`,
    }];
  } catch (err) {
    return [{ severity: "error", path, message: `${where}: ${said(err)}` }];
  }
}

/** The row the region reads, by the filter it pins itself with. */
function pinnedRow(rows: Row[], filter: string | undefined): Row | undefined {
  const preds = parseFilter(filter) as ((row: Row) => boolean)[] | null;
  if (preds === null) throw new Error(`filter outside the grammar: ${filter}`);
  return rows.find((r) => preds.every((p) => p(r)));
}

/** What a region reads and writes through, off the element the interpreter
 * mounted: the collection, and the filter that is the whole of an instance's
 * identity where a screen carries siblings on one collection. */
function readsOf(region: El) {
  const table = region.getAttribute("data-live");
  if (table === null) throw new Error("a machine region with no data-live");
  return { table, filter: region.getAttribute("data-filter") ?? undefined };
}

/** A `[data-machine]` match carrying no `data-machine` is the DOM disagreeing
 * with itself. */
function declaredOn(el: El): string {
  const declared = el.getAttribute("data-machine");
  if (declared === null) throw new Error("[data-machine] matched an element that carries none");
  return declared;
}

/** The charts one element runs: a list is several, and each is walked on its
 * own, because what a walk covers is a chart's arrows and not an element's. */
function chartsOn(el: El): string[] {
  const parsed: unknown = JSON.parse(declaredOn(el));
  return (Array.isArray(parsed) ? parsed : [parsed]).map((c) => JSON.stringify(c));
}

/** What pairs a mounted chart with the region the markup states: everything it
 * reads through, and the chart itself. */
const keyOf = (el: El, chart: string) => {
  const { table, filter } = readsOf(el);
  return `${table}\u0000${filter ?? ""}\u0000${chart}`;
};

/** The route params a filter names, substituted the way the interpreter
 * substitutes them (screen.js `interpolateFilter`). The attribute keeps its
 * placeholders — they are resolved per read — so anything pairing a filter
 * with a row resolves them too, and encodes as it does: `parseFilter` splits
 * on `&` and decodes, so a raw value carrying one leaves the grammar. */
const filled = (filter: string | undefined, params: Record<string, string>) =>
  filter?.replace(PARAM, (_whole, name: string) => {
    const v = params[name];
    // resolveParams answers every param the route binds, and screen.js refuses
    // a placeholder naming one it does not: no value here means the two
    // disagree about the route.
    if (v === undefined) throw new Error(`no value for {param.${name}}`);
    return encodeURIComponent(v);
  });
const PARAM = /\{param\.([\w-]+)\}/g;

/** The box every walked affordance is given. Square and even, so the midpoint
 * is exactly half of each side and a pointer-reading assign writes a value a
 * finding can quote. */
const WALK_BOX = { left: 0, top: 0, width: 100, height: 100 };

// The event leaves the terminal reads off the control rather than off the event
// (interpreter/screen.js): a walk that put these on the event would fire an
// arrow the guard then judged against an empty control.
const CONTROL_FIELDS = new Set(["value", "checked", "valueAsNumber"]);

/** The walker's harness over one mounted region. The field is read off the
 * store rather than the DOM: the row IS the state, and a binding that had not
 * landed yet would read as an arrow that never fired. */
function harnessFor(m: Mounted, region: El, machine: Machine, params: Record<string, string>): WalkHarness {
  const { table } = readsOf(region);
  const filter = filled(readsOf(region).filter, params);
  return {
    fire: async (type, from, init) => {
      const el = from === undefined ? region : m.one(`[id="${from}"]`);
      // The synthetic event carries every leaf a real one could. An assign
      // reading a field the event does not have declines the whole transition —
      // deliberately, so a select firing an arrow written for a checkbox writes
      // nothing — and a declined arrow is indistinguishable here from one that
      // cannot fire at all. A control's own leaves come off the element; the
      // pointer's need a box, which this tier has no layout to measure.
      boxOf(el, WALK_BOX);
      // Which is why the control's leaves are put on the CONTROL: the terminal
      // reads them off the element it fired from and never off the event, so an
      // arrow guarded on what has been typed is only drivable by typing it.
      const carried: Record<string, unknown> = {};
      for (const [field, leaf] of Object.entries(init ?? {})) {
        if (CONTROL_FIELDS.has(field)) m.set(el, field, leaf);
        else carried[field] = leaf;
      }
      m.fire(el, type, { clientX: WALK_BOX.width / 2, clientY: WALK_BOX.height / 2, ...carried });
    },
    wait: async (ms) => {
      m.advance(ms);
      await m.quiet();
    },
    field: () => pinnedRow(m.rows(table), filter)?.[machine.field],
  };
}

/** No row carries this, so a region filtered by it binds nothing while the
 * screen around it still hydrates. Filter-safe: the grammar takes it as an
 * ordinary value. */
const UNRESOLVED = "__unresolved__";

/** A value for every `:param` the route binds. A seeded row of the collection
 * the markup filters by it answers where there is one; every other param takes
 * UNRESOLVED, because `lookup` refuses a param it was not given anywhere on
 * the screen and one missing value would cost the whole screen its mount. */
function resolveParams(
  route: Route,
  html: string,
  tables: Record<string, Row[]>,
): Record<string, string> {
  const { path } = route;
  if (path === undefined) throw new Error(`shell.yaml route "${route.screen}" states no path`);
  const { plans, unplanned } = paramPlans([{ path }], { [path]: html });
  const params: Record<string, string> = {};
  for (const hole of unplanned) params[hole.param] = UNRESOLVED;
  for (const plan of plans) {
    // Only `eq` is answerable by echoing a row: `lt`, `gt` and `neq` against a
    // row's own value exclude that very row, so the chart would bind nothing
    // and read as one whose arrows never fired.
    const row = plan.op !== "eq"
      ? undefined
      : (tables[plan.table] ?? []).find((r) => r[plan.column] !== undefined && r[plan.column] !== "");
    params[plan.param] = row === undefined ? UNRESOLVED : String(row[plan.column]);
  }
  return params;
}

/** A filter stamped per row of an enclosing region: the row it reads is the
 * parent's, which nothing at this rung holds. A route param is not that — it
 * has a value here, even when that value is the one no row carries. */
const rowStamped = (filter: string | undefined) =>
  /\{[\w.]+\}/.test((filter ?? "").replace(PARAM, ""));

/** `walked` is the charts the walk actually DROVE — not the ones the markup
 * authors, and not the ones it reported as unreachable. An app floors on this:
 * a chart turned advisory is authored and undriven, and an authored-count floor
 * cannot tell those apart. */
type Walked = { findings: Finding[]; abandoned: boolean; walked: number; authored: number };

/** Every machine on one route, each walked against a mount of its own. */
async function walkScreen(
  appDir: URL,
  route: Route,
  tables: Record<string, Row[]>,
  cluster: Cluster,
  files: Record<string, string>,
  units: Record<string, Unit>,
): Promise<Walked> {
  const html = route.files.html;
  const markup = await Deno.readTextFile(new URL(html, appDir));
  const authored = machineRegions(markup);
  if (authored.length === 0) return { findings: [], abandoned: false, walked: 0, authored: 0 };

  const findings: Finding[] = [];
  const params = resolveParams(route, markup, tables);

  // A chart in an item template is authored once and mounts once per row, so
  // the mounted list is the authority for what runs, and the scan is paired to
  // it by what a region reads.
  const mounted: string[] = [];
  // Set once the first mount has enumerated: until then `mounted` is empty
  // because nothing looked, not because the screen carries nothing.
  let enumerated = false;
  let abandoned = false;
  // Walked, or reported as unwalkable: what the floor below counts is that no
  // chart the mount carried went by in silence.
  let accounted = 0;
  let walked = 0;
  let i = 0;
  do {
    let m: Mounted | undefined;
    try {
      m = await mountScreen({
        route,
        files,
        tables,
        params,
        seed: SEED,
        epoch: EPOCH,
        cluster,
        // The names a data-hatch may carry, so a declared unit resolves and an
        // undeclared one is still the wiring mistake it was — and no mount,
        // because a unit renders nothing and declares no machine, and linkedom
        // has neither of the boundaries one could be given.
        units,
        mountUnits: false,
      });
      // Quiet, not settled: the clock must not move before the walk arms its
      // trace, or a state whose way out is `after: 0` has already taken it and
      // the arrow is missing from a chart that works.
      await m.quiet();
      // One entry per (element, chart): an element running two charts is two
      // walks, and the floor below counts charts.
      const els = m.all("[data-machine]").flatMap((el) => chartsOn(el).map((chart) => ({ el, chart })));
      if (i === 0) {
        mounted.push(...els.map(({ el, chart }) => keyOf(el, chart)));
        enumerated = true;
      }
      if (i < els.length) {
        const { el, chart } = els[i];
        const machine = JSON.parse(chart) as Machine;
        const { table, filter } = readsOf(el);
        // A binding is interpolated at read time, so the attribute still holds
        // the placeholder: what this chart reads through is the param it names
        // and the value that param resolved to.
        const blind = [...(filter ?? "").matchAll(PARAM)].some((m) => params[m[1]] === UNRESOLVED);
        // A row-stamped chart reads the row its template was stamped under,
        // which is the enclosing region's and not anything this walk holds.
        const stamped = rowStamped(filter);
        if (blind || stamped) {
          findings.push({
            severity: "advisory",
            path: html,
            message: stamped
              ? `a chart on "${table}" is stamped per row of an enclosing region, whose row ` +
                `nothing here binds, so nothing here walks it`
              : `a chart on "${table}" reads through a route param no seeded row answers, ` +
                `so nothing here walks it`,
          });
          accounted++;
        } else {
          findings.push(
            ...await walkFindings(
              html,
              `${table}[${filter ?? "*"}].${machine.field}`,
              machine,
              harnessFor(m, el, machine, params),
              { owner: el },
            ),
          );
          accounted++;
          walked++;
        }
      }
    } catch (err) {
      findings.push({ severity: "error", path: html, message: `region ${i + 1}: ${said(err)}` });
      // interpretScreen hands back its handle only once every region is
      // hydrated, so a mount that threw leaves subscriptions and timers on the
      // process-wide clock with nothing able to stop them.
      if (m === undefined) abandoned = true;
    } finally {
      try {
        await m?.stop();
      } catch (err) {
        // screen.js holds one clock for the process, and `stop` drains it
        // before it detaches this mount's traps. A stop that threw leaves both
        // armed for every screen after this one.
        findings.push({ severity: "error", path: html, message: `region ${i + 1}: ${said(err)}` });
        abandoned = true;
      }
    }
    if (abandoned) return { findings, abandoned, walked, authored: authored.length };
    i++;
  } while (i < mounted.length);

  // Reached only when the mount stood up and reading it did not: a mount that
  // threw returned above, with the run.
  if (!enumerated) {
    findings.push({
      severity: "error",
      path: html,
      message: `the screen's charts could not be read off the mount, so none of its ` +
        `${authored.length} chart(s) is walked`,
    });
    return { findings, abandoned: false, walked, authored: authored.length };
  }

  // The floor within one screen. Nothing else notices a region the loop
  // enumerated and then skipped.
  if (accounted < mounted.length) {
    findings.push({
      severity: "error",
      path: html,
      message: `the mounted screen carries ${mounted.length} chart(s) and ${accounted} were ` +
        `walked or reported: the rest went by unmentioned`,
    });
  }
  // Every chart the markup states is one the screen mounted. A stamped region
  // pairs like any other: its placeholder survives into the mounted attribute,
  // so what it STATES is byte-identical on both sides even though what it
  // reads is not.
  const ran = new Set(mounted);
  for (const region of authored) {
    if (ran.has(`${region.table}\u0000${region.filter ?? ""}\u0000${region.machine}`)) continue;
    findings.push({
      severity: "error",
      path: html,
      message: `the markup states a chart on "${region.table}"` +
        `${region.filter === undefined ? "" : ` filtered ${region.filter}`} that the mounted screen ` +
        `does not carry, so nothing here walks it`,
    });
  }
  return { findings, abandoned, walked, authored: authored.length };
}

export async function checkApp(appDir: URL): Promise<Walked> {
  const seeded = await appSeed(appDir);
  // The seed states a later world than empty, so it wins over the placeholder.
  const tables: Record<string, Row[]> = Object.fromEntries(
    (await appCollections(appDir)).map((t) => [t, seeded[t] ?? []]),
  );
  // shell.yaml cannot change mid-run, and a mount per region would re-read and
  // re-parse it for every one.
  const cluster = await appCluster(appDir);
  const units = await appUnits(appDir);
  const findings: Finding[] = [];
  let walked = 0;
  let authored = 0;
  for (const route of await appRoutes(appDir)) {
    let one: Walked;
    try {
      one = await walkScreen(appDir, route, tables, cluster, await appFiles(appDir, route), units);
    } catch (err) {
      findings.push({ severity: "error", path: route.files.html, message: said(err) });
      continue;
    }
    findings.push(...one.findings);
    walked += one.walked;
    authored += one.authored;
    if (one.abandoned) {
      findings.push({
        severity: "error",
        path: route.files.html,
        message: "the waits this screen left armed are the run's, so no later screen is walked",
      });
      break;
    }
  }
  // An app that states charts and drives none is the check reporting nothing
  // while covering nothing: every chart turned advisory, or the enumeration
  // stopped. Silence there is indistinguishable from an app with no charts,
  // which is the one shape this check is silent about on purpose.
  if (authored > 0 && walked === 0) {
    findings.push({
      severity: "error",
      path: "shell/screens",
      message: `${authored} chart(s) are stated across this app's screens and none was walked`,
    });
  }
  return { findings, walked, abandoned: false, authored };
}

/**
 * The checker driven against charts whose behaviour is known, through a
 * reducer standing in for the interpreter: the walk plans and the differ
 * replays exactly as they do against a mount, so what is proven here is that a
 * chart the driver honours reports nothing and one it does not reports the
 * arrow by name.
 */
function reducerHarness(machine: Machine, opts: { refuse?: string; stray?: boolean } = {}): WalkHarness {
  let at = machine.initial;
  const candidates = (value: unknown) =>
    typeof value === "string" ? [{ target: value }] : (Array.isArray(value) ? value : [value]);
  const step = (key: string) => {
    const value = machine.states[at]?.on?.[key] ??
      machine.states[at]?.after?.[key.slice("after:".length)] ?? machine.on?.[key];
    if (value === undefined) return;
    if (key === opts.refuse) return;
    const [c] = candidates(value) as { target?: string }[];
    const to = opts.stray === true ? "nowhere" : c.target ?? at;
    (globalThis as Record<string, unknown> & { __prontoMachineTrace?: unknown[] })
      .__prontoMachineTrace?.push({ state: at, key, index: 0, to });
    at = to;
  };
  return {
    fire: async (type) => step(type),
    // The chart's own delays are the only ones a state can be waiting on, so
    // one wait is one due timer.
    wait: async () => {
      const due = Object.keys(machine.states[at]?.after ?? {})[0];
      if (due !== undefined) step(`after:${due}`);
    },
    field: () => at,
  };
}

/**
 * Two charts sharing one trace, the way two regions of a screen do. `mine`
 * drives its own machine and stamps its own region; `theirs` stamps a sibling's
 * and takes an arrow `mine` refuses — so a walk that counted the whole trace
 * would call `mine`'s chart covered on an arrow that never fired.
 */
function sharedTraceHarness(
  machine: Machine,
  mine: object,
  theirs: object,
  refused: string,
): WalkHarness {
  let at = machine.initial;
  const push = (region: object, state: string, key: string, to: string) =>
    (globalThis as Record<string, unknown> & { __prontoMachineTrace?: unknown[] })
      .__prontoMachineTrace?.push({ region, state, key, index: 0, to });
  return {
    fire: async (key: string) => {
      const value = machine.states[at]?.on?.[key];
      if (value === undefined) return;
      const to = typeof value === "string" ? value : (value as { target: string }).target;
      if (key === refused) {
        push(theirs, at, key, to);
        return;
      }
      push(mine, at, key, to);
      at = to;
    },
    wait: async () => {},
    field: () => at,
  };
}

/**
 * A driver that takes each arrow the chart draws but records it landing back
 * where it started. The field agrees with the machine at every step and every
 * arrow is covered, so nothing but the differential can notice.
 */
function misreportingHarness(machine: Machine): WalkHarness {
  let at = machine.initial;
  return {
    fire: async (key: string) => {
      const value = machine.states[at]?.on?.[key];
      if (value === undefined) return;
      const to = typeof value === "string" ? value : (value as { target: string }).target;
      (globalThis as Record<string, unknown> & { __prontoMachineTrace?: unknown[] })
        .__prontoMachineTrace?.push({ state: at, key, index: 0, to: at });
      at = to;
    },
    wait: async () => {},
    field: () => at,
  };
}

/**
 * The self-test's failures, as sentences; empty is a pass. Returned rather
 * than printed: a mount can leave `console` in a state a later write does not
 * survive, so what reports is the caller, on a stream it owns.
 */
export async function selfTest(): Promise<{ failures: string[] }> {
  const toggle: Machine = {
    field: "state",
    initial: "off",
    states: { off: { on: { click: "on" } }, on: { on: { click: "off" } } },
  };
  const beat: Machine = {
    field: "state",
    initial: "idle",
    states: { idle: { on: { start: "running" } }, running: { after: { "3000": "idle" } } },
  };
  const cases: { name: string; machine: Machine; opts?: { refuse?: string; stray?: boolean }; expect: string[] }[] = [
    { name: "a chart the driver honours is silent", machine: toggle, expect: [] },
    // The arrow is named, not merely counted: a walk that said only "1 arrow"
    // would leave the reader to guess which of a chart's dozens.
    {
      name: "an arrow the driver never takes is reported by name",
      machine: toggle,
      opts: { refuse: "click" },
      expect: ["off --click[0]-->"],
    },
    // An `after` is a wait the harness owns, so a chart whose only path out of
    // a state is a timer is walkable at all.
    { name: "a timer arrow walks", machine: beat, expect: [] },
    {
      name: "a field outside the chart's states is the walk's error, not a finding about arrows",
      machine: toggle,
      opts: { stray: true },
      expect: ["left its states"],
    },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const got = await walkFindings("t.html", "demo[id=eq.x].state", c.machine, reducerHarness(c.machine, c.opts));
    const ok = got.length === c.expect.length &&
      c.expect.every((want, i) => got[i].message.includes(want));
    if (!ok) {
      failures.push(`${c.name}: ${JSON.stringify(got.map((f) => f.message))}`);
    }
  }

  // The owner: what one mount per region cannot do on its own. Two charts share
  // a screen's one trace, so an arrow is the walk's only if the region that
  // wrote it is the region being walked.
  const mineRegion = { region: "mine" };
  const theirsRegion = { region: "theirs" };
  const owned: { name: string; owner?: unknown; expect: string[] }[] = [
    {
      name: "a sibling's arrow is not this walk's coverage",
      owner: mineRegion,
      expect: ["off --click[0]-->"],
    },
    // Without an owner every entry counts, which is the whole of the defect:
    // the sibling's `off --click-->` is taken for this chart's, so the arrow
    // that really never fired goes unnamed and a different one is reported.
    {
      name: "unowned, the sibling's arrow is miscounted as this chart's",
      owner: undefined,
      expect: ["on --click[0]-->"],
    },
  ];
  for (const c of owned) {
    const got = await walkFindings(
      "t.html",
      "demo[id=eq.x].state",
      toggle,
      sharedTraceHarness(toggle, mineRegion, theirsRegion, "click"),
      { owner: c.owner },
    );
    const ok = got.length === c.expect.length && c.expect.every((w, i) => got[i].message.includes(w));
    if (!ok) {
      failures.push(`${c.name}: ${JSON.stringify(got.map((f) => f.message))}`);
    }
  }

  // The differential, reached the way a walk reaches it. Every case above
  // drives an interpreter that agrees with XState, so none of them notices the
  // comparison being skipped or handed the wrong trace.
  const misreported = await walkFindings(
    "t.html",
    "demo[id=eq.x].state",
    toggle,
    misreportingHarness(toggle),
  );
  if (misreported.length !== 1 || !misreported[0].message.includes("differ")) {
    failures.push(`a step recorded landing elsewhere than XState puts it: ${JSON.stringify(misreported.map((f) => f.message))}`);
  }

  // An owner over a trace nobody stamped attributes nothing; the walk must say
  // so rather than report every arrow as one the chart never took.
  const unstamped = await walkFindings(
    "t.html",
    "demo[id=eq.x].state",
    toggle,
    reducerHarness(toggle),
    { owner: mineRegion },
  );
  if (unstamped.length !== 1 || !unstamped[0].message.includes("a trace entry carries no region")) {
    failures.push(`an owner over an unstamped trace: ${JSON.stringify(unstamped.map((f) => f.message))}`);
  }

  // A param two regions name: the `eq` is answerable by echoing a row and the
  // `lt` is not, so the plan must be the `eq` however the markup ordered them.
  const ordered = paramPlans([{ path: "/older/:when" }], {
    "/older/:when": `<div data-live="post" data-filter="rank=lt.{param.when}"></div>` +
      `<div data-live="post" data-filter="id=eq.{param.when}"></div>`,
  });
  if (ordered.plans[0]?.op !== "eq") {
    failures.push(`a param named by both a lt and an eq planned as ${JSON.stringify(ordered.plans)}`);
  }

  // The orchestration, against a fixture app carrying one screen per branch:
  // everything above this drives walkFindings alone, and every path that reads
  // a screen off disk, resolves a route param, pairs the scan to the mount or
  // decides a chart is uncoverable lives in walkScreen and checkApp.
  const fixture = new URL("./test/fixtures/machines/", import.meta.url);
  const run = await checkApp(fixture);
  const got = run.findings.map((f) => `${f.path.split("/").pop()}: ${f.message}`);
  const want = [
    // `plain`, `resolved` and `siblings` report nothing: a sound chart, a
    // param the seed answers, and two charts on one screen whose arrival
    // `after` lands in its own chart and not its neighbour's.
    'unresolved.html: a chart on "bare" reads through a route param no seeded row answers',
    'ghost.html: the markup states a chart on "toggle" filtered id=eq.parked that the mounted screen',
    'ranged.html: a chart on "item" reads through a route param no seeded row answers',
    'stray.html: oddity[id=eq.{param.slug}].state: walk: the machine\'s field left its states: "nowhere"',
    'stuck.html: toggle[id=eq.the].state: "[id="nobody"]" names 0 elements, not one',
    'stamped.html: a chart on "stamped" is stamped per row of an enclosing region',
    'stamped.html: a chart on "stamped" is stamped per row of an enclosing region',
    'refuses.html: region 1: machine region "toggle" has no data-empty-row',
    'refuses.html: the waits this screen left armed are the run\'s, so no later screen is walked',
  ];
  const orchestrated = got.length === want.length && want.every((w, i) => got[i].startsWith(w));
  if (!orchestrated) {
    failures.push(`the fixture app's findings: ${JSON.stringify(got, null, 2)}`);
  }

  // A chart this rung cannot reach is advisory and must not fail an app's test
  // verb; everything else is the app's own defect and must.
  const gate: [Finding[], boolean][] = [
    [[], false],
    [[{ severity: "advisory", path: "t", message: "m" }], false],
    [[{ severity: "error", path: "t", message: "m" }], true],
    [[{ severity: "advisory", path: "t", message: "m" }, { severity: "error", path: "t", message: "m" }], true],
  ];
  for (const [given, want] of gate) {
    if (fails(given) !== want) failures.push(`the verb gate on ${JSON.stringify(given.map((f) => f.severity))}`);
  }
  const banded = run.findings;
  // What the rung cannot reach, named by what it cannot bind — not by the tail
  // they share with "the mounted screen does not carry", which is the app's.
  const reach = banded.filter((f: Finding) =>
    f.message.includes("reads through a route param") || f.message.includes("is stamped per row")
  );
  const wrong = [
    ...reach.filter((f: Finding) => f.severity !== "advisory"),
    ...banded.filter((f: Finding) => !reach.includes(f) && f.severity !== "error"),
  ];
  if (reach.length === 0 || wrong.length > 0) {
    failures.push(`severity banding: ${JSON.stringify(banded.map((f: Finding) => [f.severity, f.message.slice(0, 48)]))}`);
  }

  return { failures };
}

if (import.meta.main) {
  // A mount that stalls — a rejection the DOM swallowed, a permission the
  // interpreter needed and did not have — drains the event loop with nothing
  // reported, and Deno exits 0 on an empty loop. So the run is failed until it
  // has said what it found.
  Deno.exitCode = 1;
  if (Deno.args[0] === "--self-test") {
    const { failures } = await selfTest();
    const say = (line: string) => Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
    for (const f of failures) say(`FAIL ${f}`);
    say(failures.length === 0 ? "check-machines self-test: passed" : `check-machines self-test: ${failures.length} failed`);
    Deno.exit(failures.length === 0 ? 0 : 1);
  }
  const appDir = Deno.args[0];
  if (appDir === undefined) {
    console.error("usage: check-machines.ts <appDir> | --self-test");
    Deno.exit(1);
  }
  const { findings } = await checkApp(new URL(`${appDir.replace(/\/*$/, "")}/`, `file://${Deno.cwd()}/`));
  console.log(JSON.stringify(findings, null, 2));
  if (!fails(findings)) Deno.exitCode = 0;
}
