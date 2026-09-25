// The chart-derived path walker. Planning and the reference semantics come
// from xstate + @xstate/graph (the machine JSON is canonical XState via
// canonical.ts); the execution harness is this file's. Three phases:
//
// 1. PLAN — Chinese Postman (Eulerian multigraph tour) over the chart's arrows.
//    In-degree and out-degree imbalances are balanced via shortest paths, and
//    Hierholzer's algorithm extracts a continuous stimulus sequence.
// 2. DRIVE — the Eulerian tour (then arrow-seek / rotation fallback) fires the
//    machine's own event keys through the caller's harness against OUR
//    interpreter; coverage is read from the __prontoMachineTrace seam, and an
//    uncovered arrow is an error naming itself.
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
import { machineShape } from "../interpreter/fragment.js";
import { canonical, guardNames, type Machine, type StateNode } from "./canonical.ts";

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

function resolveStateNode(machine: Machine, path: string): StateNode | undefined {
  if (!path || path === "*") return undefined;
  if (machine.states[path]) return machine.states[path];
  const parts = path.split(".");
  let curr: StateNode | undefined = machine.states[parts[0]];
  for (let i = 1; i < parts.length && curr; i++) {
    curr = curr.states?.[parts[i]];
  }
  return curr;
}

function resolveTarget(machine: Machine, target: string | undefined, currentState?: string): string | undefined {
  if (target === undefined) return undefined;
  let resolved = target;
  if (target.startsWith(".")) {
    const sub = target.slice(1);
    if (currentState?.includes(".")) {
      const parent = currentState.slice(0, currentState.lastIndexOf("."));
      resolved = `${parent}.${sub}`;
    } else {
      resolved = sub;
    }
  } else if (!target.includes(".") && currentState?.includes(".")) {
    const parent = currentState.slice(0, currentState.lastIndexOf("."));
    const parentNode = resolveStateNode(machine, parent);
    if (parentNode?.states?.[target]) {
      resolved = `${parent}.${target}`;
    }
  }
  let node = resolveStateNode(machine, resolved);
  while (node?.initial && node?.states?.[node.initial]) {
    resolved = `${resolved}.${node.initial}`;
    node = node.states[node.initial];
  }
  return resolved;
}

function allStates(machine: Machine): string[] {
  const result: string[] = [];
  const walk = (prefix: string, states: Record<string, StateNode>) => {
    for (const [name, node] of Object.entries(states)) {
      const full = prefix ? `${prefix}.${name}` : name;
      result.push(full);
      if (node.states) walk(full, node.states);
    }
  };
  walk("", machine.states);
  return result;
}

/** The candidate one arrow names, so its guard's event is synthesized exactly
 * rather than guessed from the key it shares with its siblings. */
const candidateAt = (machine: Machine, state: string, key: string, index: number): unknown => {
  if (state === "*") {
    const val = machine.on?.[key];
    return val === undefined ? undefined : listOf(val)[index];
  }
  const node = resolveStateNode(machine, state);
  const value = key.startsWith("after:")
    ? node?.after?.[key.slice(6)]
    : node?.on?.[key] ?? machine.on?.[key];
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
  let value: unknown;
  if (a.state === "*") {
    value = machine.on?.[a.key];
  } else {
    const node = resolveStateNode(machine, a.state);
    value = a.key.startsWith("after:")
      ? node?.after?.[a.key.slice(6)]
      : node?.on?.[a.key] ?? machine.on?.[a.key];
  }
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
  for (const st of allStates(machine)) {
    const node = resolveStateNode(machine, st);
    if (node?.on?.[key] !== undefined) add(node.on[key]);
    if (key.startsWith("after:") && node?.after?.[key.slice(6)] !== undefined) {
      add(node.after[key.slice(6)]);
    }
  }
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

function resolveFinalTarget(machine: Machine, stateName: string): string | undefined {
  const node = resolveStateNode(machine, stateName);
  if (node?.type !== "final") return undefined;
  const hasParent = stateName.includes(".");
  const parent = hasParent ? resolveStateNode(machine, stateName.slice(0, stateName.lastIndexOf("."))) : machine;
  const onDone = (parent as { onDone?: unknown })?.onDone;
  if (onDone === undefined) return undefined;
  const rawTarget = typeof onDone === "string"
    ? onDone
    : (Array.isArray(onDone) ? onDone[0] : onDone as { target?: string })?.target;
  return resolveTarget(machine, rawTarget, stateName);
}

/** Guard-erased adjacency (state -> outgoing (key, to) edges, root on:
 * included), for point-to-point routing between plan phases. */
function edgesOf(machine: Machine): Map<string, Edge[]> {
  const edges = new Map<string, Edge[]>();
  const list = (value: unknown): { target?: string }[] =>
    typeof value === "string"
      ? [{ target: value }]
      : (Array.isArray(value) ? value : [value]) as { target?: string }[];
  const states = allStates(machine);
  for (const name of states) {
    const s = resolveStateNode(machine, name);
    if (!s) continue;
    const out: Edge[] = [];
    const add = (key: string, value: unknown) => {
      for (const c of list(value)) {
        let to = resolveTarget(machine, c.target, name) ?? name;
        const finalTarget = resolveFinalTarget(machine, to);
        if (finalTarget !== undefined) to = finalTarget;
        out.push({ key, to, init: eventInit(c) });
      }
    };
    for (const [key, value] of Object.entries(s.on ?? {})) add(key, value);
    for (const [delay, value] of Object.entries(s.after ?? {})) add(`after:${delay}`, value);
    if (s.type === "final") {
      const finalTarget = resolveFinalTarget(machine, name);
      if (finalTarget !== undefined) {
        out.push({ key: "onDone", to: finalTarget });
      }
    }
    for (const [key, value] of Object.entries(machine.on ?? {})) {
      let handled = s.on?.[key] !== undefined;
      let p = name;
      while (!handled && p.includes(".")) {
        p = p.slice(0, p.lastIndexOf("."));
        handled = resolveStateNode(machine, p)?.on?.[key] !== undefined;
      }
      if (!handled) add(key, value);
    }
    edges.set(name, out);
  }
  return edges;
}

/** Shortest key sequence from `from` to `to` over the guard-erased edges;
 * null when unreachable. */
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

type PostmanEdge = { from: string; to: string; stimuli: Stimulus[] };

/** A Chinese Postman tour (Eulerian multigraph circuit) covering every candidate
 * arrow. In-degree and out-degree imbalances are balanced via shortest paths,
 * and Hierholzer's algorithm extracts the continuous stimulus sequence. */
function planPostmanTour(machine: Machine): Stimulus[] {
  const shape = machineShape(machine);
  const arrows = shape.arrows as Arrow[];
  const edgesGraph = edgesOf(machine);
  const states = allStates(machine);
  const initialKey = machine.initial ?? Object.keys(machine.states)[0] ?? "";
  const startState = resolveTarget(machine, initialKey) ?? initialKey;

  const baseEdges: PostmanEdge[] = [];
  const adj = new Map<string, PostmanEdge[]>();
  for (const s of states) adj.set(s, []);
  if (!adj.has(startState)) adj.set(startState, []);

  for (const a of arrows) {
    if (a.key === "onDone") continue;
    const candidate = candidateAt(machine, a.state, a.key, a.index);
    const fromState = (a.state === "*" ? startState : a.state) ?? startState;
    const rawTarget = typeof candidate === "string"
      ? candidate
      : (candidate as { target?: string } | undefined)?.target ?? a.to;
    let target = resolveTarget(machine, rawTarget, fromState) ?? fromState;
    const finalTarget = resolveFinalTarget(machine, target);
    if (finalTarget !== undefined) target = finalTarget;
    const inits = eventInits(candidate);
    const stimuli = inits.map((init) => stimulusOf(a.key, init));
    const edge: PostmanEdge = { from: fromState, to: target, stimuli };
    baseEdges.push(edge);
    if (!adj.has(fromState)) adj.set(fromState, []);
    adj.get(fromState)!.push(edge);
  }

  // Eulerianization: balance in-degree and out-degree
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const s of adj.keys()) {
    inDegree.set(s, 0);
    outDegree.set(s, 0);
  }
  for (const e of baseEdges) {
    outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  // Connect deficit nodes (in > out) to surplus nodes (out > in) via shortest paths
  const deficits = [...inDegree.keys()].filter((s) => (inDegree.get(s) ?? 0) > (outDegree.get(s) ?? 0));
  for (const def of deficits) {
    while ((inDegree.get(def) ?? 0) > (outDegree.get(def) ?? 0)) {
      const surpluses = [...outDegree.keys()].filter(
        (s) => (outDegree.get(s) ?? 0) > (inDegree.get(s) ?? 0) && s !== def,
      );
      let bestTarget: string | null = null;
      let bestRoute: Stimulus[] | null = null;
      const targets = surpluses.length > 0 ? surpluses : [startState];
      for (const t of targets) {
        if (t === def) continue;
        const route = routeBetween(edgesGraph, def, t);
        if (route !== null && (bestRoute === null || route.length < bestRoute.length)) {
          bestTarget = t;
          bestRoute = route;
        }
      }
      if (bestTarget === null || bestRoute === null || bestRoute.length === 0) break;

      adj.get(def)!.push({ from: def, to: bestTarget, stimuli: bestRoute });
      outDegree.set(def, (outDegree.get(def) ?? 0) + 1);
      inDegree.set(bestTarget, (inDegree.get(bestTarget) ?? 0) + 1);
    }
  }

  // Hierholzer's Algorithm starting from startState
  const stack: string[] = [startState];
  const edgeStack: PostmanEdge[] = [];
  const tour: PostmanEdge[] = [];

  while (stack.length > 0) {
    const u = stack[stack.length - 1];
    const out = adj.get(u);
    if (out && out.length > 0) {
      const edge = out.pop()!;
      stack.push(edge.to);
      edgeStack.push(edge);
    } else {
      stack.pop();
      if (edgeStack.length > 0) {
        tour.unshift(edgeStack.pop()!);
      }
    }
  }

  const continuousStimuli: Stimulus[] = [];
  for (let i = 0; i < tour.length; i++) {
    if (i > 0 && tour[i - 1].to !== tour[i].from) {
      const bridge = routeBetween(edgesGraph, tour[i - 1].to, tour[i].from);
      if (bridge) continuousStimuli.push(...bridge);
    }
    continuousStimuli.push(...tour[i].stimuli);
  }

  return continuousStimuli;
}

function stateValueString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const [k, v] = Object.entries(value)[0] ?? [];
    if (k && v) return `${k}.${stateValueString(v)}`;
  }
  return String(value);
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
  const initialString = stateValueString(state.value);
  const expectedInitial = resolveTarget(machine, machine.initial) ?? machine.initial;
  if (initialString !== expectedInitial && initialString !== machine.initial) {
    throw new Error(`differ: XState initial ${JSON.stringify(state.value)} != ${machine.initial}`);
  }
  trace.forEach((a, i) => {
    if (a.key === "onDone") return;
    pending = a.index;
    [state] = transition(m, state, { type: a.key });
    const landed = stateValueString(state.value);
    if (a.to !== undefined && landed !== String(a.to) && String(state.value) !== String(a.to)) {
      throw new Error(
        `differ: step ${i} (${a.state} --${a.key}[${a.index}]-->): ` +
          `XState landed on ${JSON.stringify(state.value)}, the interpreter on ${JSON.stringify(a.to)}`,
      );
    }
    const finalTarget = resolveFinalTarget(machine, landed);
    if (finalTarget !== undefined) {
      state = m.resolveState({ value: finalTarget });
    }
  });
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
  const states = new Set(allStates(machine));

  const numericAfters = allStates(machine)
    .flatMap((s) => Object.keys(resolveStateNode(machine, s)?.after ?? {}))
    .filter((k) => /^\d+$/.test(k))
    .map(Number);
  const hasAfter = allStates(machine).some((s) => resolveStateNode(machine, s)?.after !== undefined);
  // A timer that names no target RESTORES something — a typeahead buffer is the
  // case — where one that names a target MOVES the row. Only the first can be
  // waited out mid-route without undoing the route, which is why the wait below
  // asks which kind this chart has rather than whether it has one.
  const restoringAfter = hasAfter &&
    allStates(machine).every((s) =>
      Object.values((resolveStateNode(machine, s) as { after?: Record<string, unknown> } | undefined)?.after ?? {}).every((t) =>
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
    ...allStates(machine).flatMap((s) => Object.keys(resolveStateNode(machine, s)?.on ?? {})),
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

    for (const s of planPostmanTour(machine)) {
      await deliver(s);
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
      if (a.key === "onDone") continue;
      // Let any armed timer expire first. A chart whose `after` resets a column
      // its own guards read — a typeahead buffer is the case — is reachable
      // only from the state that timer restores, and an arrow-seek that fired
      // straight away would carry the last attempt's leftovers into this one.
      if (restoringAfter) await harness.wait(afterMs + settleMs);
      const startState = resolveTarget(machine, machine.initial) ?? machine.initial;
      const targetState = a.state === "*" ? String(harness.field() ?? startState) : a.state;
      const route = routeBetween(edges, String(harness.field() ?? startState), targetState);
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
