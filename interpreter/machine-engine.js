import { assign, createEmptyActor, createMachine } from "./vendor/xstate.js";

const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const candidates = (value) => list(value).map((c) => typeof c === "string" ? { target: c } : c);
const stateValue = (path) => {
  const parts = path.split(".");
  return parts.slice(0, -1).reduceRight((child, part) => ({ [part]: child }), parts.at(-1));
};
const statePath = (value) => typeof value === "string" ? value : Object.entries(value).map(([key, child]) => `${key}.${statePath(child)}`).join(".");

export function machineEngine(chart, hooks) {
  let run;
  const matched = Symbol("matched");
  const action = (act) => assign(({ context }) => {
    hooks.action(act, run, context);
    return context;
  });
  const actions = (value) => list(value).map(action);
  const marker = (origin, key, index, target) => assign(({ context }) => {
    run.taken = true;
    if (target !== undefined) run.targeted = true;
    if ((key === "always" || key === "onDone") && ++run.cascades > 10) throw new Error("machine eventless transitions did not settle in 10 steps");
    if (run.preview) throw matched;
    if (key === "always" && target === undefined) run.targetlessAlways.add(`${origin}:${index}`);
    hooks.trace?.(origin, key, index, target, run, context);
    return context;
  });
  const targetId = (target, origin, key, active) => {
    const name = target.replace(/^\./, "");
    const inherited = key !== "always" && key !== "onDone" &&
      (origin === "*" || active.startsWith(`${origin}.`));
    const parts = (inherited ? active : origin === "*" ? "" : origin).split(".").filter(Boolean);
    if (target.startsWith(".")) {
      const parent = key === "onDone" && origin !== "*" ? parts : parts.slice(0, -1);
      return `#pronto.${[...parent, name].join(".")}`;
    }
    if (name.includes(".")) return `#pronto.${name}`;
    const source = parts.reduce((node, part) => node?.states?.[part], chart);
    if (!inherited && !target.startsWith(".") && source?.states?.[name]) return `#pronto.${origin}.${name}`;
    const parent = parts.slice(0, -1);
    const parentNode = parent.reduce((node, part) => node?.states?.[part], chart);
    const path = parent.length && parentNode?.states?.[name] ? [...parent, name].join(".") : name;
    return `#pronto.${path}`;
  };
  const mapTransition = (value, origin, key, active) => candidates(value).map((c, index) => {
    const mapped = { actions: [marker(origin, key, index, c.target), ...actions(c.actions), action(c)] };
    mapped.guard = ({ context }) =>
      !(key === "always" && c.target === undefined && run.targetlessAlways.has(`${origin}:${index}`)) &&
      (c.guard === undefined || hooks.guard(c.guard, run, context));
    if (c.target !== undefined) {
      mapped.target = targetId(c.target, origin, key, active);
      mapped.reenter = c.reenter !== false;
    }
    return mapped;
  });
  const node = (source, path, active) => {
    const out = {};
    if (source.initial !== undefined) out.initial = source.initial;
    if (source.type !== undefined) out.type = source.type;
    const on = {};
    // A declared event shadows its ancestors even when all its guards decline.
    for (const [key, value] of Object.entries(source.on ?? {})) on[`pronto:${key}`] = [...mapTransition(value, path || "*", key, active), {}];
    for (const [key, value] of Object.entries(source.after ?? {})) on[`pronto:after:${key}`] = [...mapTransition(value, path || "*", `after:${key}`, active), {}];
    if (Object.keys(on).length) out.on = on;
    if (source.always !== undefined) out.always = mapTransition(source.always, path || "*", "always", active);
    if (source.onDone !== undefined) out.onDone = mapTransition(source.onDone, path || "*", "onDone", active);
    out.entry = [assign(({ context }) => { run.enter.push(path); if (path) run.guardState = path; return context; }), ...actions(source.entry)];
    out.exit = [assign(({ context }) => { run.exit.push(path); return context; }), ...actions(source.exit)];
    if (source.states) out.states = Object.fromEntries(Object.entries(source.states).map(([key, value]) => [key, node(value, path ? `${path}.${key}` : key, active)]));
    return out;
  };
  const machines = new Map();
  const machineAt = (active) => {
    if (!machines.has(active)) {
      const config = node(chart, "", active);
      config.id = "pronto";
      config.context = {};
      machines.set(active, createMachine(config));
    }
    return machines.get(active);
  };
  const self = createEmptyActor();
  const unsupported = () => { throw new Error("unsupported XState actor operation"); };
  const scope = { self, system: self.system, id: "", sessionId: "", defer: unsupported,
    logger: unsupported, stopChild: unsupported, emit: unsupported, actionExecutor: unsupported };

  return (row, event, keys, preview = false) => {
    const active = row[chart.field] || chart.initial;
    const logic = machineAt(active);
    let snapshot = logic.resolveState({ value: stateValue(active), context: {} });
    run = { row, event, preview, taken: false, targeted: false, cascades: 0, enter: [], exit: [], state: row[chart.field] || chart.initial, guardState: row[chart.field] || chart.initial, targetlessAlways: new Set() };
    for (const key of keys) {
      const input = { ...event, type: `pronto:${key}` };
      const selected = logic.getTransitionData(snapshot, input);
      if (key !== "always" && !selected.some((arrow) => arrow.actions.length > 0)) continue;
      try { snapshot = logic.transition(snapshot, input, scope); }
      catch (error) { if (error === matched) return run; throw error; }
      if (run.taken) break;
    }
    run.state = statePath(snapshot.value);
    return run;
  };
}
