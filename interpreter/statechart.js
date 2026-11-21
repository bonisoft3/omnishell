import { assign, createMachine, transition } from "./vendor/xstate.js";

// A timer's event, as XState names it: `xstate.after.<delay>.<state>`.
const AFTER = /^xstate\.after\.([^.]+)\.(.+)$/;

export function Statechart(chart, implementations) {
  const fail = message => { throw new Error(`statechart: ${message}`); };
  const only = (value, keys) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`unsupported ${key}`);
  };
  only(chart, ["initial", "states"]);
  if (!chart.states || typeof chart.states !== "object" || Array.isArray(chart.states)) fail("expected states");
  const names = Object.keys(chart.states);
  const own = key => Object.prototype.hasOwnProperty.call(chart.states, key);
  if (!names.length || names.length > 1000 || !own(chart.initial)) fail("invalid state count or initial state");
  // A state named `a.b` is the child `b` of the compound state `a`, whose
  // `initial` names the child it enters, as XState's nested states are.
  const parentOf = name => name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined;
  for (const name of names) {
    const parent = parentOf(name);
    if (parent !== undefined && !own(parent)) fail(`state ${name} has no parent ${parent}`);
    const initial = chart.states[name]?.initial;
    if (initial !== undefined && (typeof initial !== "string" || parentOf(initial) !== name || !own(initial))) fail(`state ${name} enters no child ${initial}`);
  }
  // A state, then its ancestors.
  const chain = name => name === undefined ? [] : [name, ...chain(parentOf(name))];
  // The atomic state a state's entry lands in.
  const leaf = name => chart.states[name].initial === undefined ? name : leaf(chart.states[name].initial);
  if (typeof implementations?.guard !== "function" || typeof implementations?.reduce !== "function") fail("guard and reduce callbacks are required");
  const keys = new Map(names.map((name, index) => [name, `phase_${index}`]));
  const named = new Map(names.map((name, index) => [`phase_${index}`, name]));
  const events = new Map();
  // Each state's delays, and the named ones its host resolves.
  const timers = new Map();
  const delays = new Set();
  let arrows = 0;
  // The automatic transitions the step in progress has taken.
  let settling = 0;
  const transition_ = (source, automatic) => {
    if (++arrows > 10000) fail("transition count exceeds 10000");
    only(source, ["target", "guard", "reduce", "reenter"]);
    if (source.target !== undefined && !keys.has(source.target)) fail("unknown target");
    for (const key of ["guard", "reduce"]) if (source[key] !== undefined && typeof source[key] !== "string") fail(`invalid ${key}`);
    if (source.reenter !== undefined && typeof source.reenter !== "boolean") fail("invalid reenter");
    const arrow = Object.freeze({target: source.target, guard: source.guard, reduce: source.reduce});
    return {
      ...(arrow.target === undefined ? {} : {target: `#${keys.get(arrow.target)}`}),
      ...(source.reenter ? {reenter: true} : {}),
      ...(arrow.guard ? {guard: ({context, event}) => {
        const answer = implementations.guard(context.row, arrow.guard, event.input, automatic);
        if (typeof answer !== "boolean") fail("guard must return a boolean");
        return answer;
      }} : {}),
      actions: assign({row: ({context, event}) => {
        if (automatic && settling++ >= 100) fail("automatic transitions did not settle");
        return implementations.reduce(context.row, arrow, event.input, automatic);
      }}),
    };
  };
  const nodes = new Map(names.map(name => {
    const state = chart.states[name];
    only(state, ["final", "on", "always", "after", "initial"]);
    if (typeof state.final !== "boolean" || !state.on || typeof state.on !== "object" || Array.isArray(state.on)) fail("invalid state declaration");
    if (state.always !== undefined && !Array.isArray(state.always)) fail("invalid automatic transitions");
    if (state.after !== undefined && (!state.after || typeof state.after !== "object" || Array.isArray(state.after))) fail("invalid delayed transitions");
    if (state.final && (Object.keys(state.on).length || state.always?.length || Object.keys(state.after ?? {}).length)) fail("final state has transitions");
    // XState reads a delay that is a number as milliseconds and any other as
    // a name its host resolves. A name here is a word, so a timer's event
    // tells its delay and its state apart.
    const after = Object.entries(state.after ?? {}).map(([delay, value]) => {
      if (!/^(0|[1-9][0-9]{0,11})$/.test(delay) && !/^[A-Za-z_$][\w$]*$/.test(delay)) fail(`invalid delay ${delay}`);
      if (!Array.isArray(value) || !value.length) fail("invalid delayed transitions");
      if (Number.isNaN(+delay)) delays.add(delay);
      // A timer is no reader's event: its guards fall through, as `always`'s do.
      return [delay, value.map(arrow => transition_(arrow, true))];
    });
    timers.set(name, new Set(after.map(([delay]) => delay)));
    return [name, {
      id: keys.get(name), ...(state.final ? {type: "final"} : {}),
      ...(state.initial === undefined ? {} : {initial: keys.get(state.initial)}),
      on: Object.fromEntries(Object.entries(state.on).map(([event, arrow]) => {
        if (!events.has(event)) events.set(event, `event_${events.size}`);
        return [events.get(event), transition_(arrow, false)];
      })),
      ...(state.always?.length ? {always: state.always.map(arrow => transition_(arrow, true))} : {}),
      ...(after.length ? {after: Object.fromEntries(after)} : {}),
    }];
  }));
  const nest = parent => Object.fromEntries(names.filter(name => parentOf(name) === parent).map(name => {
    const children = nest(name);
    return [keys.get(name), {...nodes.get(name), ...(Object.keys(children).length ? {states: children} : {})}];
  }));
  const states = nest(undefined);
  // XState's state value for an atomic state: `{a: "b"}` for `a.b`.
  const valueOf = name => chain(name).reduce((value, at) => value === undefined ? keys.get(at) : {[keys.get(at)]: value}, undefined);
  if ([...timers.values()].some(set => set.size) && typeof implementations.schedule !== "function") fail("a chart with delayed transitions requires a schedule callback");
  if (delays.size && typeof implementations.delay !== "function") fail("a named delay requires a delay callback");
  const duration = (row, delay) => {
    const ms = Number.isNaN(+delay) ? implementations.delay(row, delay) : +delay;
    if (!Number.isSafeInteger(ms) || ms < 0) fail(`delay ${delay} is not a duration in milliseconds`);
    return ms;
  };
  const top = chain(chart.initial).pop();
  const machine = createMachine({id: "statechart", initial: keys.get(top), states}).provide({
    delays: Object.fromEntries([...delays].map(delay => [delay, ({context}) => duration(context.row, delay)])),
  });
  // The timers XState leaves to its host, in the order it leaves them: a
  // state's entry raises its delayed events and its exit cancels them, each
  // naming its state as the chart does.
  const host = actions => {
    for (const action of actions) {
      const id = action.type === "xstate.raise" ? action.params.id : action.type === "xstate.cancel" ? action.params.sendId : undefined;
      const timer = typeof id === "string" ? AFTER.exec(id) : null;
      if (!timer || !named.has(timer[2]) || (action.type === "xstate.raise" && !Number.isSafeInteger(action.params.delay))) fail(`unexpected action ${action.type}`);
      const event = `xstate.after.${timer[1]}.${named.get(timer[2])}`;
      implementations.schedule(action.type === "xstate.raise"
        ? {type: "xstate.raise", params: {event: {type: event}, id: event, delay: action.params.delay}}
        : {type: "xstate.cancel", params: {sendId: event}});
    }
  };
  const step = (row, event) => {
    const timer = !events.has(event.kind) && AFTER.exec(event.kind);
    if (!keys.has(row.phase) || chart.states[row.phase].initial !== undefined || !(events.has(event.kind) || (timer && timers.get(timer[2])?.has(timer[1])))) fail("invalid state or event");
    const type = timer ? `xstate.after.${timer[1]}.${keys.get(timer[2])}` : events.get(event.kind);
    settling = 0;
    const [next, actions] = transition(machine, machine.resolveState({value: valueOf(row.phase), context: {row}}), {type, input: event});
    host(actions);
    return next.context.row;
  };
  // An instance's creation enters the initial state and its ancestors, each
  // entry raising its timers as XState's does, outermost first and in the
  // order its `after` lists them; its eventless transitions wait for the
  // first event, as a created row's do.
  step.start = row => {
    if (row.phase !== leaf(chart.initial)) fail("a new instance starts in the initial state");
    host(chain(row.phase).reverse().flatMap(name => Object.keys(nodes.get(name).after ?? {}).map(delay => {
      const id = `xstate.after.${delay}.${keys.get(name)}`;
      return {type: "xstate.raise", params: {event: {type: id}, id, delay: duration(row, delay)}};
    })));
  };
  return step;
}
