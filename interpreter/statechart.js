import { assign, createEmptyActor, createMachine } from "./vendor/xstate.js";

export function Statechart(chart, implementations) {
  const fail = message => { throw new Error(`statechart: ${message}`); };
  const only = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`unsupported ${key}`);
  };
  only(chart, ["initial", "states"]);
  if (!chart.states || typeof chart.states !== "object" || Array.isArray(chart.states)) fail("expected states");
  const names = Object.keys(chart.states);
  if (!names.length || names.length > 1000 || !Object.prototype.hasOwnProperty.call(chart.states, chart.initial)) fail("invalid state count or initial state");
  if (typeof implementations?.guard !== "function" || typeof implementations?.reduce !== "function") fail("guard and reduce callbacks are required");
  const keys = new Map(names.map((name, index) => [name, `phase_${index}`]));
  const events = new Map();
  let arrows = 0;
  const transition = (source, automatic) => {
    if (++arrows > 10000) fail("transition count exceeds 10000");
    only(source, ["target", "guard", "reduce"]);
    if (source.target !== undefined && !keys.has(source.target)) fail("unknown target");
    for (const key of ["guard", "reduce"]) if (source[key] !== undefined && typeof source[key] !== "string") fail(`invalid ${key}`);
    const arrow = Object.freeze({target: source.target, guard: source.guard, reduce: source.reduce});
    return {
      ...(arrow.target === undefined ? {} : {target: `#${keys.get(arrow.target)}`}),
      ...(arrow.guard ? {guard: ({context, event}) => {
        const answer = implementations.guard(context.row, arrow.guard, event.input, automatic);
        if (typeof answer !== "boolean") fail("guard must return a boolean");
        return answer;
      }} : {}),
      actions: assign({row: ({context, event}) => {
        if (automatic && event.automatic++ >= 100) fail("automatic transitions did not settle");
        return implementations.reduce(context.row, arrow, event.input, automatic);
      }}),
    };
  };
  const states = Object.fromEntries(names.map(name => {
    const state = chart.states[name];
    only(state, ["final", "on", "always"]);
    if (typeof state.final !== "boolean" || !state.on || typeof state.on !== "object" || Array.isArray(state.on)) fail("invalid state declaration");
    if (state.always !== undefined && !Array.isArray(state.always)) fail("invalid automatic transitions");
    if (state.final && (Object.keys(state.on).length || state.always?.length)) fail("final state has transitions");
    return [keys.get(name), {
      id: keys.get(name), ...(state.final ? {type: "final"} : {}),
      on: Object.fromEntries(Object.entries(state.on).map(([event, arrow]) => {
        if (!events.has(event)) events.set(event, `event_${events.size}`);
        return [events.get(event), transition(arrow, false)];
      })),
      ...(state.always?.length ? {always: state.always.map(arrow => transition(arrow, true))} : {}),
    }];
  }));
  const machine = createMachine({id: "statechart", initial: keys.get(chart.initial), states});
  const self = createEmptyActor();
  const unsupported = () => fail("cannot schedule or invoke actors");
  const scope = {self, system: self.system, id: "statechart", sessionId: "statechart", logger: unsupported,
    defer: unsupported, stopChild: unsupported, emit: unsupported, actionExecutor: unsupported};
  return (row, event) => {
    if (!keys.has(row.phase) || !events.has(event.kind)) fail("invalid state or event");
    return machine.transition(machine.resolveState({value: keys.get(row.phase), context: {row}}),
      {type: events.get(event.kind), input: event, automatic: 0}, scope).context.row;
  };
}
