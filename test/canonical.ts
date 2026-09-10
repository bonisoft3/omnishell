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
};
export type Machine = {
  field: string;
  initial: string;
  context?: Record<string, unknown>;
  on?: Record<string, unknown>;
  states: Record<string, { on?: Record<string, unknown>; after?: Record<string, unknown> }>;
};

const candidates = (value: unknown): Candidate[] => {
  if (typeof value === "string") return [{ target: value }];
  return (Array.isArray(value) ? value : [value]) as Candidate[];
};

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
  if (actions.length > 0) out.actions = actions;
  return out;
}

const mapValue = (value: unknown, opts: { drive: boolean; atRoot: boolean }) =>
  candidates(value).map((c) => transition(c, opts));

export function canonical(machine: Machine, opts: { drive?: boolean } = {}): Record<string, unknown> {
  const drive = opts.drive === true;
  const states: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(machine.states)) {
    const node: Record<string, unknown> = {};
    const on: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s.on ?? {})) {
      on[key] = mapValue(value, { drive, atRoot: false });
    }
    const after: Record<string, unknown> = {};
    for (const [delay, value] of Object.entries(s.after ?? {})) {
      if (drive) on[`after:${delay}`] = mapValue(value, { drive, atRoot: false });
      else after[delay] = mapValue(value, { drive, atRoot: false });
    }
    if (Object.keys(on).length > 0) node.on = on;
    if (Object.keys(after).length > 0) node.after = after;
    states[name] = node;
  }
  const out: Record<string, unknown> = { id: "machine", initial: machine.initial, states };
  if (machine.context !== undefined) out.context = machine.context;
  const rootOn: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(machine.on ?? {})) {
    rootOn[key] = mapValue(value, { drive, atRoot: true });
  }
  if (Object.keys(rootOn).length > 0) out.on = rootOn;
  return out;
}

/** The guard names a machine references, for a consumer's provide map. */
export function guardNames(machine: Machine): string[] {
  const names = new Set<string>();
  const all = [
    ...Object.values(machine.on ?? {}),
    ...Object.values(machine.states).flatMap((s) => [
      ...Object.values(s.on ?? {}),
      ...Object.values(s.after ?? {}),
    ]),
  ];
  for (const v of all) {
    for (const c of candidates(v)) {
      if (c.guard !== undefined) names.add(typeof c.guard === "string" ? c.guard : c.guard.type);
    }
  }
  return [...names];
}
