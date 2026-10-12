// Our machine JSON → canonical XState v5 config. Pure, data → data: what the
// subset renames or relocates comes back to XState's own spelling so xstate
// and @xstate/graph can consume the chart directly — `field` is the one key
// carried beside the config, never inside it (it names the row column, a
// ladder concept XState does not have).
//
// Two modes. The faithful form keeps `after` as XState delayed transitions
// and renders `raise`/`assign` as named action descriptors ({type, params})
// for a consumer to provide. The drive form (`{drive: true}`) exists for the
// walker's differential and encodes the two DELIBERATE deviations from SCXML
// semantics structurally, so they cannot register as divergence:
// - `after` timing is the terminal's (tempo, manual clock), so each after
//   transition is lifted to an ordinary event under its trace key
//   (`after:<delay>`) and the differential sends it instead of waiting;
// - raise cascades are depth-bounded and each link is its own traced arrow,
//   where XState raises run to quiescence inside one macrostep — so `raise`
//   is stripped and the differential asserts every link separately.

type Candidate = {
  guard?: string | { type: string; params?: Record<string, unknown> };
  target?: string;
  assign?: Record<string, unknown>;
  raise?: string;
  actions?: unknown;
};
export type StateNode = {
  field?: string;
  type?: string;
  initial?: string;
  on?: Record<string, unknown>;
  onDone?: unknown;
  always?: unknown;
  after?: Record<string, unknown>;
  entry?: unknown;
  exit?: unknown;
  states?: Record<string, StateNode>;
};

export type Machine = {
  field?: string;
  type?: string;
  initial?: string;
  context?: Record<string, unknown>;
  on?: Record<string, unknown>;
  onDone?: unknown;
  always?: unknown;
  after?: Record<string, unknown>;
  entry?: unknown;
  exit?: unknown;
  states: Record<string, StateNode>;
};

const candidates = (value: unknown): Candidate[] => {
  if (typeof value === "string") return [{ target: value }];
  return (Array.isArray(value) ? value : [value]) as Candidate[];
};

function mapAction(act: unknown, opts: { drive: boolean }): Record<string, unknown>[] {
  if (typeof act !== "object" || act === null) return [];
  const a = act as { assign?: Record<string, unknown>; effect?: unknown; raise?: string };
  const out: Record<string, unknown>[] = [];
  if (a.assign !== undefined) out.push({ type: "assign", params: a.assign });
  if (a.raise !== undefined && !opts.drive) out.push({ type: "raise", params: { event: a.raise } });
  if (a.effect !== undefined) out.push({ type: "effect", params: a.effect });
  return out;
}

function mapActions(actions: unknown, opts: { drive: boolean }): Record<string, unknown>[] {
  if (actions === undefined) return [];
  const list = Array.isArray(actions) ? actions : [actions];
  return list.flatMap((a) => mapAction(a, opts));
}

function transition(c: Candidate, opts: { drive: boolean; atRoot: boolean }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.guard !== undefined) {
    out.guard = typeof c.guard === "string" ? { type: c.guard } : c.guard;
  }
  if (c.target !== undefined) {
    // A root-level transition's string target resolves among the root's
    // siblings, of which it has none; the leading dot addresses its children.
    out.target = opts.atRoot ? `.${c.target}` : c.target;
  }
  const actions: Record<string, unknown>[] = [];
  if (c.assign !== undefined) actions.push({ type: "assign", params: c.assign });
  if (c.raise !== undefined && !opts.drive) actions.push({ type: "raise", params: { event: c.raise } });
  if (c.actions !== undefined) actions.push(...mapActions(c.actions, opts));
  if (actions.length > 0) out.actions = actions;
  return out;
}

const mapValue = (value: unknown, opts: { drive: boolean; atRoot: boolean }) =>
  candidates(value).map((c) => transition(c, opts));

function mapStateNode(s: StateNode, opts: { drive: boolean }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  if (s.type !== undefined) node.type = s.type;
  if (s.initial !== undefined) node.initial = s.initial;
  const on: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s.on ?? {})) {
    on[key] = mapValue(value, { drive: opts.drive, atRoot: false });
  }
  const after: Record<string, unknown> = {};
  for (const [delay, value] of Object.entries(s.after ?? {})) {
    if (opts.drive) on[`after:${delay}`] = mapValue(value, { drive: opts.drive, atRoot: false });
    else after[delay] = mapValue(value, { drive: opts.drive, atRoot: false });
  }
  if (Object.keys(on).length > 0) node.on = on;
  if (Object.keys(after).length > 0) node.after = after;
  if (s.always !== undefined) {
    node.always = mapValue(s.always, { drive: opts.drive, atRoot: false });
  }
  if (s.onDone !== undefined) {
    node.onDone = mapValue(s.onDone, { drive: opts.drive, atRoot: false });
  }
  if (s.entry !== undefined) {
    node.entry = mapActions(s.entry, opts);
  }
  if (s.exit !== undefined) {
    node.exit = mapActions(s.exit, opts);
  }
  if (s.states !== undefined) {
    const subStates: Record<string, unknown> = {};
    for (const [subName, subNode] of Object.entries(s.states)) {
      subStates[subName] = mapStateNode(subNode, opts);
    }
    node.states = subStates;
  }
  return node;
}

export function canonical(machine: Machine, opts: { drive?: boolean } = {}): Record<string, unknown> {
  const drive = opts.drive === true;
  const states: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(machine.states ?? {})) {
    states[name] = mapStateNode(s, { drive });
  }
  const out: Record<string, unknown> = { id: "machine", states };
  if (machine.type !== undefined) out.type = machine.type;
  if (machine.initial !== undefined) out.initial = machine.initial;
  if (machine.context !== undefined) out.context = machine.context;
  const rootOn: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(machine.on ?? {})) {
    rootOn[key] = mapValue(value, { drive, atRoot: true });
  }
  if (Object.keys(rootOn).length > 0) out.on = rootOn;
  if (machine.onDone !== undefined) {
    out.onDone = mapValue(machine.onDone, { drive, atRoot: false });
  }
  return out;
}

/** The guard names a machine references, for a consumer's provide map. */
export function guardNames(machine: Machine): string[] {
  const names = new Set<string>();
  const collect = (s: StateNode) => {
    const vals: unknown[] = [
      ...Object.values(s.on ?? {}),
      ...Object.values(s.after ?? {}),
    ];
    if (s.always !== undefined) vals.push(s.always);
    if (s.onDone !== undefined) vals.push(s.onDone);
    for (const v of vals) {
      for (const c of candidates(v)) {
        if (c.guard !== undefined) names.add(typeof c.guard === "string" ? c.guard : c.guard.type);
      }
    }
    for (const sub of Object.values(s.states ?? {})) collect(sub);
  };
  for (const v of Object.values(machine.on ?? {})) {
    for (const c of candidates(v)) {
      if (c.guard !== undefined) names.add(typeof c.guard === "string" ? c.guard : c.guard.type);
    }
  }
  for (const s of Object.values(machine.states ?? {})) collect(s);
  return [...names];
}
