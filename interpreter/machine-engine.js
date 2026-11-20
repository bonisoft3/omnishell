import { assign, createMachine, fromCallback, raise, transition } from "./vendor/xstate.js";

const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const candidates = (value) => list(value).map((c) => typeof c === "string" ? { target: c } : c);
const stateValue = (path) => {
  const parts = path.split(".");
  return parts.slice(0, -1).reduceRight((child, part) => ({ [part]: child }), parts.at(-1));
};
const statePath = (value) => typeof value === "string" ? value : Object.entries(value).map(([key, child]) => `${key}.${statePath(child)}`).join(".");
const eventless = (key) => key === "always" || key === "onDone";
// Every state of a chart, the root first.
const nodes = (node) => [node, ...Object.values(node.states ?? {}).flatMap(nodes)];

// Five rules a chart may read differently from XState, one switch each, on
// in KEPT: a target re-enters unless it says `reenter: false`; a state that
// declares an event hides its ancestors' arrows for it even when every guard
// declines; a target is read against the active state (`.name` a sibling, a
// bare name from the root a top-level state); a raised event is a step of
// its own; a timer is the host's, which arms it and sends `after:<delay>`
// as an event. Off is XState's rule: its own `after`, whose events the host
// takes from the actions a step returns and sends back as they are.
export const KEPT = Object.freeze({ reenter: true, shadow: true, targets: true, raise: true, timers: true });

// XState reads these as wildcards, as no event, or claims them for itself.
const reserved = (key) => key === "" || key === "*" || key.endsWith(".*") || key.startsWith("xstate.");

const matched = Symbol("matched");

/** The chart as an XState config. Guards and actions report to `run()`, the
 * call in progress. `active` is the state targets are read against when
 * `rules.targets` is on. */
export function machineConfig(chart, run, hooks, rules = KEPT, active = chart.initial) {
  const action = (act) => assign(({ context }) => {
    if (!context.stepping) return context;
    hooks.action(act, run(), context);
    return context;
  });
  const actions = (act) => rules.raise || act.raise === undefined
    ? [action(act)]
    : [action({ ...act, raise: undefined }), raise({ type: act.raise })];
  const marker = (origin, key, index, target) => assign(({ context }) => {
    if (!context.stepping) return context;
    const r = run();
    r.taken = true;
    if (target !== undefined) r.targeted = true;
    if (eventless(key) && ++r.cascades > 10) throw new Error("machine eventless transitions did not settle in 10 steps");
    if (r.preview) throw matched;
    if (key === "always" && target === undefined) r.targetlessAlways.add(`${origin}:${index}`);
    hooks.trace?.(origin, key, index, target, r, context);
    return context;
  });
  const targetId = (target, origin, key) => {
    if (!rules.targets) return target;
    const name = target.replace(/^\./, "");
    const inherited = !eventless(key) && (origin === "*" || active.startsWith(`${origin}.`));
    const parts = (inherited ? active : origin === "*" ? "" : origin).split(".").filter(Boolean);
    if (target.startsWith(".")) {
      const parent = key === "onDone" && origin !== "*" ? parts : parts.slice(0, -1);
      return `#pronto.${[...parent, name].join(".")}`;
    }
    if (name.includes(".")) return `#pronto.${name}`;
    const source = parts.reduce((node, part) => node?.states?.[part], chart);
    if (!inherited && source?.states?.[name]) return `#pronto.${origin}.${name}`;
    const parent = parts.slice(0, -1);
    const parentNode = parent.reduce((node, part) => node?.states?.[part], chart);
    const path = parent.length && parentNode?.states?.[name] ? [...parent, name].join(".") : name;
    return `#pronto.${path}`;
  };
  // `kind` is the construct the arrows hang from; `key` names them, and an
  // event may be called `always`.
  const arrows = (value, origin, key, kind) => {
    const mapped = candidates(value).map((c, index) => {
      const out = { actions: [marker(origin, key, index, c.target), ...list(c.actions).flatMap(actions), ...actions(c)] };
      // XState runs eventless arrows after any event, answered or not; here
      // they follow only an arrow the key took, or the key `always`, and the
      // caller otherwise tries the next key.
      out.guard = ({ context }) => context.stepping === true &&
        !(eventless(kind) && run().key !== "always" && !run().taken) &&
        !(key === "always" && c.target === undefined && run().targetlessAlways.has(`${origin}:${index}`)) &&
        (c.guard === undefined || hooks.guard(c.guard, run(), context));
      if (c.target !== undefined) {
        out.target = targetId(c.target, origin, key);
        if (rules.reenter ? c.reenter !== false : c.reenter === true) out.reenter = true;
      }
      return out;
    });
    return rules.shadow && !eventless(kind) ? [...mapped, {}] : mapped;
  };
  const node = (source, path) => {
    const origin = path || "*";
    const out = {};
    if (source.initial !== undefined) out.initial = source.initial;
    if (source.type !== undefined) out.type = source.type;
    const on = {};
    for (const [key, value] of Object.entries(source.on ?? {})) {
      if (reserved(key)) throw new Error(`machine event "${key}" is a name XState reserves`);
      on[key] = arrows(value, origin, key, "on");
    }
    if (rules.timers) for (const [key, value] of Object.entries(source.after ?? {})) on[`after:${key}`] = arrows(value, origin, `after:${key}`, "after");
    else if (source.after !== undefined) out.after = Object.fromEntries(Object.entries(source.after).map(([key, value]) => [key, arrows(value, origin, `after:${key}`, "after")]));
    if (Object.keys(on).length) out.on = on;
    if (source.always !== undefined) out.always = arrows(source.always, origin, "always", "always");
    if (source.onDone !== undefined) out.onDone = arrows(source.onDone, origin, "onDone", "onDone");
    if (source.invoke !== undefined) out.invoke = list(source.invoke).map((spec, index) => ({ src: spec.src, id: spec.id ?? `${path || "root"}:${index}` }));
    out.entry = [assign(({ context }) => { if (context.stepping) { run().enter.push(path); if (path) run().guardState = path; } return context; }), ...list(source.entry).flatMap(actions)];
    out.exit = [assign(({ context }) => { if (context.stepping) run().exit.push(path); return context; }), ...list(source.exit).flatMap(actions)];
    if (source.states) out.states = Object.fromEntries(Object.entries(source.states).map(([key, value]) => [key, node(value, path ? `${path}.${key}` : key)]));
    return out;
  };
  // `transition()` builds a throwaway actor whose construction computes the
  // chart's initial snapshot from this context, entering the initial states
  // and completing any that are final; a step starts from a snapshot whose
  // context says `stepping`, and nothing else is the step's.
  return { ...node(chart, ""), id: "pronto", context: {} };
}

/** Steps a chart with XState's `transition()` from the state a row holds,
 * trying each key in order until one is taken. The run says what was taken,
 * the state landed in, what was entered and exited, and the actions XState
 * leaves to its host: delays to arm and cancel, observers to spawn and stop. */
export function machineEngine(chart, hooks, rules = KEPT) {
  let run;
  const sources = new Set(nodes(chart).flatMap((node) => list(node.invoke).map((spec) => spec.src)));
  // XState reads a delay that is a number as milliseconds, and any other as a name.
  const delays = new Set(nodes(chart).flatMap((node) => Object.keys(node.after ?? {})).filter((delay) => Number.isNaN(+delay)));
  const implementations = {
    actors: Object.fromEntries([...sources].map((src) => [src, fromCallback(() => () => {})])),
    delays: Object.fromEntries([...delays].map((delay) => [delay, ({ context }) => context.stepping ? hooks.delay?.(delay, run, context) ?? 0 : 0])),
  };
  const machines = new Map();
  const machineAt = (active) => {
    const at = rules.targets ? active : "";
    if (!machines.has(at)) machines.set(at, createMachine(machineConfig(chart, () => run, hooks, rules, active)).provide(implementations));
    return machines.get(at);
  };

  return (row, event, keys, preview = false) => {
    const active = row[chart.field] || chart.initial;
    const logic = machineAt(active);
    const from = logic.resolveState({ value: stateValue(active), context: { stepping: true } });
    const fresh = (key) => ({ row, event, key, preview, taken: false, targeted: false, cascades: 0, enter: [], exit: [], state: active, guardState: active, targetlessAlways: new Set() });
    let snapshot = from, actions = [];
    run = fresh(undefined);
    for (const key of keys) {
      run = fresh(key);
      try { [snapshot, actions] = transition(logic, from, { ...event, type: key }); }
      catch (error) {
        if (error === matched) return run;
        throw error;
      }
      if (run.taken) break;
    }
    if (!run.taken) snapshot = from;
    run.state = statePath(snapshot.value);
    run.actions = run.taken ? actions : [];
    return run;
  };
}
