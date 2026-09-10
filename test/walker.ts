// The chart-derived path walker. Planning and the reference semantics come
// from xstate + @xstate/graph (the machine JSON is canonical XState via
// canonical.ts); the execution harness is this file's. Three phases:
//
// 1. PLAN — @xstate/graph shortest paths over a guard-erased variant where
//    every (state, key, candidate) arrow is its own synthetic event, so the
//    plan names a stimulus sequence toward every arrow.
// 2. DRIVE — the plans (then rotation rounds) fire the machine's own event
//    keys through the caller's harness against OUR interpreter; coverage is
//    read from the __prontoMachineTrace seam, and an uncovered arrow is an
//    error naming itself. Rotation stays because planning treats guards as
//    free: a guard-gated arrow (fib's pastLimit) is reached by driving the
//    real sequence to the branch point, not by solving arithmetic.
// 3. DIFFER — the observed trace replays through XState's own pure
//    transition() over the drive-form canonical config: for every arrow our
//    interpreter fired, XState must land on the same field value. Guard
//    outcomes replay from the trace (candidate index i means the first i
//    guard calls answered false), so the differential compares transition
//    SELECTION and TARGET APPLICATION; the two deliberate deviations (after
//    timing, bounded raise) are excluded structurally in canonical.ts.
//
// Static imports on purpose: a dynamic import() issued after the smokes'
// lockdown() never settles; module load happens before any test body runs.

import { createMachine, initialTransition, transition } from "npm:xstate@5.32.6";
import { getShortestPaths } from "npm:@xstate/graph@3.0.4";
import { machineShape } from "../interpreter/fragment.js";
import { canonical, guardNames, type Machine } from "./canonical.ts";

export type Arrow = { state: string; key: string; index: number; to?: string };

type TraceEntry = Arrow & { region?: unknown; field?: string };

export type WalkHarness = {
  /** Deliver one event: dispatch `type` (bubbling) on the element `from`
   * names, on the machine's region when `from` is absent — or synthesize,
   * for keys the DOM never dispatches (`refused`). `init` carries the leaves
   * an arrow's guard reads off the event; see `eventInit`. */
  fire(type: string, from?: string, init?: Record<string, unknown>): Promise<void>;
  wait(ms: number): Promise<void>;
  /** The machine field's current value, for the state invariant. */
  field(): unknown;
};

const arrowId = (a: Arrow) => `${a.state}|${a.key}|${a.index}`;

type Stimulus = { type: string; from?: string; init?: Record<string, unknown> } | { waitFor: string };

/** The event leaves a guard's params name (machine.cue #EventRef). Params are
 * literals by construction — a threshold is data in the chart — so a param
 * named after an event field IS the chart saying which event satisfies the
 * arrow, and the walk can synthesize it instead of driving a key it cannot
 * guess. A param named anything else is the guard's own data and says nothing
 * about the event. */
const EVENT_FIELDS = new Set(["value", "checked", "valueAsNumber", "key", "pointerX", "pointerY"]);

/** The plural of the event field `key`: a SEQUENCE of keystrokes, one per
 * character, delivered in order.
 *
 * One event cannot always select an arrow. A typeahead's letters accumulate in
 * a column, so the keystrokes that disambiguate an item pass THROUGH the arrows
 * of the items they rule out — type "t" and the first item whose label starts
 * with it answers; type "o" after it and the one spelled "to" does. No single
 * event reaches the second, and no search over the keys the chart declares
 * finds "o" either, because no arrow declares it. What can state it is the
 * component: it holds every label and the order they are asked in, so it knows
 * the shortest prefix that reaches each one. */
const SEQUENCE_FIELD = "keys";

const listOf = (value: unknown): unknown[] =>
  typeof value === "string" ? [{ target: value }] : Array.isArray(value) ? value : [value];

/** The candidate one arrow names, so its guard's event is synthesized exactly
 * rather than guessed from the key it shares with its siblings. */
const candidateAt = (machine: Machine, state: string, key: string, index: number): unknown => {
  const value = machine.states[state]?.on?.[key] ?? machine.on?.[key];
  return value === undefined ? undefined : listOf(value)[index];
};

/**
 * Whether an earlier candidate under the same key admits the very event this one
 * declares. First guard to pass wins, so it does — and no event this walk can
 * synthesize will ever select this arrow.
 *
 * It is not a broken chart. A typeahead draws an arrow per destination and each
 * admits the letters that spell its own label, so two labels sharing a first
 * letter put two arrows on one keystroke and the earlier answers it; a reader
 * reaches the later by typing further, over a buffer this walk holds still. What
 * the walk can say is that it cannot drive this one, which is a truer report
 * than calling the arrow dead.
 */
const shadowed = (machine: Machine, a: Arrow): boolean => {
  const value = machine.states[a.state]?.on?.[a.key] ?? machine.on?.[a.key];
  if (value === undefined) return false;
  const list = listOf(value);
  // An arrow declaring a SEQUENCE has said how it is reached, so whether it
  // fires is a fact the walk goes and gets rather than one it infers here.
  if (eventInits(list[a.index]).length > 1) return false;
  const mine = JSON.stringify(eventInit(list[a.index]) ?? null);
  return list.slice(0, a.index).some((c) => JSON.stringify(eventInit(c) ?? null) === mine);
};

/** Every distinct event the candidates under `key` ask for. An arrow guarded on
 * an event field needs its own event, so a key whose candidates name different
 * ones is as many stimuli as they name — one fire per key would drive the first
 * branch forever and report the rest as arrows that never fired. */
const initsUnder = (machine: Machine, key: string): (Record<string, unknown> | undefined)[] => {
  const seen = new Set<string>();
  const out: (Record<string, unknown> | undefined)[] = [];
  const add = (value: unknown) => {
    for (const c of listOf(value)) {
      const init = eventInit(c);
      const id = JSON.stringify(init ?? null);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(init);
    }
  };
  if (machine.on?.[key] !== undefined) add(machine.on[key]);
  for (const st of Object.values(machine.states)) if (st.on?.[key] !== undefined) add(st.on[key]);
  return out.length === 0 ? [undefined] : out;
};

const paramsOf = (candidate: unknown): Record<string, unknown> | undefined => {
  const guard = (candidate as { guard?: unknown } | undefined)?.guard;
  return (guard as { params?: Record<string, unknown> } | undefined)?.params;
};

/** Every event an arrow asks for, in order — one for most arrows, several where
 * the chart declares a sequence. */
const eventInits = (candidate: unknown): (Record<string, unknown> | undefined)[] => {
  const seq = paramsOf(candidate)?.[SEQUENCE_FIELD];
  if (typeof seq === "string" && seq.length > 0) return [...seq].map((key) => ({ key }));
  return [eventInit(candidate)];
};

/** The event an arrow asks for, or the FIRST of the sequence it asks for: what
 * a plan or a rotation can fire in one step. An arrow reached by one keystroke
 * is the same under both spellings, which is why a set can declare sequences
 * throughout rather than only where one is needed. */
const eventInit = (candidate: unknown): Record<string, unknown> | undefined => {
  const params = paramsOf(candidate);
  if (params === undefined) return undefined;
  const seq = params[SEQUENCE_FIELD];
  if (typeof seq === "string" && seq.length > 0) return { key: seq[0] };
  const init = Object.fromEntries(Object.entries(params).filter(([k]) => EVENT_FIELDS.has(k)));
  return Object.keys(init).length === 0 ? undefined : init;
};

/** A stimulus per plan step: `after:` keys are waits (the harness owns the
 * clock's real milliseconds), everything else a fire, `@` split back into
 * (type, from). */
const stimulusOf = (key: string, init?: Record<string, unknown>): Stimulus => {
  if (key.startsWith("after:")) return { waitFor: key };
  const at = key.indexOf("@");
  const where = at < 0 ? { type: key } : { type: key.slice(0, at), from: key.slice(at + 1) };
  return init === undefined ? where : { ...where, init };
};

/** Shortest stimulus sequences toward every arrow, from a guard-erased plan
 * machine where each candidate is its own synthetic event — reachability and
 * ordering are XState's answer; whether a guard admits the arrow is reality's. */
function planPaths(machine: Machine): Stimulus[][] {
  const mark = "\u0000"; // separator no authored key can carry
  const states: Record<string, unknown> = {};
  const events = new Set<string>();
  // The event a guard names, per synthetic arrow. Two states spelling one key
  // and index with DIFFERENT guards cannot both be satisfied by one synthesized
  // event, and guessing between them would drive an arrow the chart did not
  // mean — so the pair answers nothing and reports as uncovered instead.
  const inits = new Map<string, Record<string, unknown> | undefined>();
  const noteInit = (ev: string, candidate: unknown) => {
    const init = eventInit(candidate);
    if (!inits.has(ev)) return void inits.set(ev, init);
    if (JSON.stringify(inits.get(ev)) !== JSON.stringify(init)) inits.set(ev, undefined);
  };
  const list = (value: unknown): { target?: string }[] =>
    typeof value === "string"
      ? [{ target: value }]
      : (Array.isArray(value) ? value : [value]) as { target?: string }[];
  for (const [name, s] of Object.entries(machine.states)) {
    const on: Record<string, unknown> = {};
    const add = (key: string, value: unknown) => {
      list(value).forEach((c, index) => {
        const ev = `${key}${mark}${index}`;
        events.add(ev);
        noteInit(ev, c);
        on[ev] = c.target !== undefined ? { target: c.target } : {};
      });
    };
    for (const [key, value] of Object.entries(s.on ?? {})) add(key, value);
    for (const [delay, value] of Object.entries(s.after ?? {})) add(`after:${delay}`, value);
    states[name] = { on };
  }
  const rootOn: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(machine.on ?? {})) {
    list(value).forEach((c, index) => {
      const ev = `${key}${mark}${index}`;
      events.add(ev);
      noteInit(ev, c);
      rootOn[ev] = c.target !== undefined ? { target: `.${c.target}` } : {};
    });
  }
  const planM = createMachine({
    id: "plan",
    initial: machine.initial,
    states,
    ...(Object.keys(rootOn).length > 0 ? { on: rootOn } : {}),
  } as never);
  const paths = getShortestPaths(planM, { events: [...events].map((type) => ({ type })) });
  return paths.map((p) =>
    p.steps
      .filter((s) => s.event.type !== "xstate.init")
      .map((s) => stimulusOf(s.event.type.split(mark)[0], inits.get(s.event.type)))
  ).filter((p) => p.length > 0);
}

/** Replay the observed trace through XState's own pure transition() over the
 * drive-form canonical config. Guard outcomes come from the trace itself: a
 * fired candidate at index i means the first i guard calls answered false —
 * so a divergence in selection or target lands as a field mismatch here. */
export function differ(machine: Machine, trace: Arrow[]): void {
  let pending = 0;
  const guards: Record<string, () => boolean> = {};
  for (const name of guardNames(machine)) {
    guards[name] = () => (pending-- > 0 ? false : true);
  }
  const m = createMachine(canonical(machine, { drive: true }) as never).provide({
    guards,
    actions: { assign: () => {} },
  });
  let [state] = initialTransition(m);
  if (String(state.value) !== machine.initial) {
    throw new Error(`differ: XState initial ${JSON.stringify(state.value)} != ${machine.initial}`);
  }
  trace.forEach((a, i) => {
    pending = a.index;
    [state] = transition(m, state, { type: a.key });
    if (a.to !== undefined && String(state.value) !== String(a.to)) {
      throw new Error(
        `differ: step ${i} (${a.state} --${a.key}[${a.index}]-->): ` +
          `XState landed on ${JSON.stringify(state.value)}, the interpreter on ${JSON.stringify(a.to)}`,
      );
    }
  });
}

/** Guard-erased adjacency (state -> outgoing (key, to) edges, root on:
 * included), for point-to-point routing between plan phases: a plan's steps
 * assume the initial state, but the row keeps whatever the last plan left. */
function edgesOf(machine: Machine): Map<string, Edge[]> {
  const edges = new Map<string, Edge[]>();
  const list = (value: unknown): { target?: string }[] =>
    typeof value === "string"
      ? [{ target: value }]
      : (Array.isArray(value) ? value : [value]) as { target?: string }[];
  for (const [name, s] of Object.entries(machine.states)) {
    const out: Edge[] = [];
    // An edge carries the event its own candidate needs. Firing a key's FIRST
    // candidate's event and hoping the guard falls the routed way is how a
    // route through guarded arrows arrives somewhere else and every arrow
    // beyond it reports as never fired.
    const add = (key: string, value: unknown) => {
      for (const c of list(value)) out.push({ key, to: c.target ?? name, init: eventInit(c) });
    };
    for (const [key, value] of Object.entries(s.on ?? {})) add(key, value);
    for (const [delay, value] of Object.entries(s.after ?? {})) add(`after:${delay}`, value);
    for (const [key, value] of Object.entries(machine.on ?? {})) {
      if (s.on?.[key] === undefined) add(key, value);
    }
    edges.set(name, out);
  }
  return edges;
}

/** Shortest key sequence from `from` to `to` over the guard-erased edges;
 * null when unreachable (rotation's problem, not routing's). */
type Edge = { key: string; to: string; init?: Record<string, unknown> };

function routeBetween(
  edges: Map<string, Edge[]>,
  from: string,
  to: string,
): Stimulus[] | null {
  if (from === to) return [];
  const prev = new Map<string, { at: string; key: string; init?: Record<string, unknown> }>();
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of edges.get(at) ?? []) {
      if (e.to === from || prev.has(e.to)) continue;
      prev.set(e.to, { at, key: e.key, init: e.init });
      if (e.to === to) {
        const steps: Stimulus[] = [];
        for (let n = to; n !== from;) {
          const p = prev.get(n)!;
          steps.unshift(stimulusOf(p.key, p.init));
          n = p.at;
        }
        return steps;
      }
      queue.push(e.to);
    }
  }
  return null;
}

/** Arrows a walk could not select because an earlier sibling admits their own
 * declared event. Reported, never thrown: the chart is sound and the walk is
 * what cannot reach them. */
export type Walk = { arrows: Arrow[]; shadowed: Arrow[] };

export async function walkMachine(
  machine: Machine,
  harness: WalkHarness,
  opts: { rounds?: number; settleMs?: number; afterMs?: number; patience?: number; owner?: unknown } = {},
): Promise<Walk> {
  const { rounds = 64, settleMs = 30, patience = 6 } = opts;
  const shape = machineShape(machine);
  const wanted = new Map(shape.arrows.map((a: Arrow) => [arrowId(a), a]));
  const shadows: Arrow[] = [];
  const states = new Set(Object.keys(machine.states));

  const numericAfters = Object.values(machine.states)
    .flatMap((s) => Object.keys(s.after ?? {}))
    .filter((k) => /^\d+$/.test(k))
    .map(Number);
  const hasAfter = Object.values(machine.states).some((s) => s.after !== undefined);
  // A timer that names no target RESTORES something — a typeahead buffer is the
  // case — where one that names a target MOVES the row. Only the first can be
  // waited out mid-route without undoing the route, which is why the wait below
  // asks which kind this chart has rather than whether it has one.
  const restoringAfter = hasAfter &&
    Object.values(machine.states).every((s) =>
      Object.values((s as { after?: Record<string, unknown> }).after ?? {}).every((t) =>
        // A bare state name is the shorthand for {target}, so a string IS a
        // target and the shape has to be read before the field.
        (Array.isArray(t) ? t : [t]).every((c) =>
          typeof c !== "string" && (c as { target?: string })?.target === undefined
        )
      )
    );
  const afterMs = opts.afterMs ?? (numericAfters.length > 0 ? Math.max(...numericAfters) : 60);

  const fires: { type: string; from?: string; init?: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  const keys = [
    ...Object.keys(machine.on ?? {}),
    ...Object.values(machine.states).flatMap((s) => Object.keys(s.on ?? {})),
  ];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const init of initsUnder(machine, key)) {
      const s = stimulusOf(key, init);
      if ("type" in s) fires.push(s);
    }
  }

  // One array per screen, not per chart: every region on the mount pushes into
  // whatever is armed here. `owner` is this walk's region; mine() is its slice.
  const trace: TraceEntry[] = [];
  const mine = (): Arrow[] => {
    if (opts.owner === undefined) return trace;
    // An unstamped entry belongs to no region, so there is no slice to put it
    // in: the caller is driving something that is not the interpreter.
    if (trace.some((t) => t.region === undefined)) {
      throw new Error("walk: owner was given, but a trace entry carries no region");
    }
    // Region AND field: a region may run several charts, and they share the
    // element the owner names.
    return trace.filter((t) => t.region === opts.owner && t.field === machine.field);
  };
  (globalThis as Record<string, unknown>).__prontoMachineTrace = trace;
  try {
    const deliver = async (s: Stimulus) => {
      if ("waitFor" in s) {
        await harness.wait(afterMs + settleMs);
        return;
      }
      await harness.fire(s.type, s.from, s.init);
      await harness.wait(settleMs);
      const v = harness.field();
      if (v !== undefined && !states.has(String(v))) {
        throw new Error(`walk: the machine's field left its states: ${JSON.stringify(v)}`);
      }
    };
    const covered = () => new Set(mine().map(arrowId));
    const done = () => {
      const got = covered();
      return [...wanted.keys()].every((id) => got.has(id));
    };

    for (const path of planPaths(machine)) {
      for (const s of path) await deliver(s);
      if (done()) break;
    }

    // Arrow-seek: plans are shortest paths from the initial state, so arrows
    // off those paths starve once the row has moved on. Route from the state
    // the row is actually in to each uncovered arrow's state and fire it;
    // guard-gated arrows that refuse the route stay the rotation's.
    const edges = edgesOf(machine);
    for (const a of wanted.values()) {
      if (done()) break;
      if (covered().has(arrowId(a))) continue;
      // Let any armed timer expire first. A chart whose `after` resets a column
      // its own guards read — a typeahead buffer is the case — is reachable
      // only from the state that timer restores, and an arrow-seek that fired
      // straight away would carry the last attempt's leftovers into this one.
      if (restoringAfter) await harness.wait(afterMs + settleMs);
      const route = routeBetween(edges, String(harness.field() ?? machine.initial), a.state);
      if (route === null) continue;
      for (const step of route) await deliver(step);
      // And again after the route, for the same reason: the steps that carried
      // the row here were themselves events, and one may have left the column a
      // guard reads holding their leftovers. Only a RESTORING timer may be
      // waited out here — one that moves the row would undo the route.
      if (restoringAfter) await harness.wait(afterMs + settleMs);
      // Every event this arrow asks for, in order: one keystroke for most, and
      // the sequence that walks past its shadowing siblings for a typeahead's.
      for (const init of eventInits(candidateAt(machine, a.state, a.key, a.index))) {
        await deliver(stimulusOf(a.key, init));
      }
    }

    // Rotation rounds pick up what plans cannot promise: an arrow behind a
    // real guard needs the real sequence driven until the branch opens.
    let last = covered().size;
    let stale = 0;
    for (let round = 0; round < rounds && !done(); round++) {
      const order = fires.map((_, i) => fires[(i + round) % fires.length]);
      for (const f of order) await deliver(f);
      if (hasAfter) await harness.wait(afterMs + settleMs);
      const got = covered();
      stale = got.size === last ? stale + 1 : 0;
      last = got.size;
      if (stale >= patience) break;
    }

    if (!done()) {
      const got = covered();
      const missing = [...wanted.values()].filter((a) => !got.has(arrowId(a)));
      // An arrow an earlier sibling shadows is not one the chart failed to
      // reach; it is one this walk cannot select, and saying so is the whole
      // report. Everything else uncovered is the finding it always was.
      const dead = missing.filter((a) => !shadowed(machine, a));
      if (dead.length > 0) {
        throw new Error(
          `walk: ${dead.length} arrow(s) never fired: ${
            dead.map((a) => `${a.state} --${a.key}[${a.index}]-->`).join(", ")
          }`,
        );
      }
      shadows.push(...missing);
    }
    differ(machine, mine());
    return { arrows: [...wanted.values()], shadowed: shadows };
  } finally {
    delete (globalThis as Record<string, unknown>).__prontoMachineTrace;
  }
}
