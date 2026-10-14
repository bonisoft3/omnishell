import {hybridInteraction} from "./hybrid-client.js";

export function commandInitial(chart) {
  return {phase: chart.initial, pending: null, outcome: null, view: null, error: null, instance: null, admission: null, inFlight: false};
}

export function commandTransition(chart, state, event) {
  if (chart.states[state.phase]?.final) return state;
  const declared = chart.states[state.phase]?.on[event.type];
  if (!declared) throw new Error(`illegal Cortex command event ${state.phase}/${event.type}`);
  const candidates = Array.isArray(declared) ? declared : [declared];
  let next = {...state};
  for (const action of candidates[0].actions ?? []) {
    if (action === "open") next = {...event.held, error: null, instance: event.instance, admission: event.admission, inFlight: false};
    else if (action === "capture") {
      if (state.inFlight) throw new Error("Cortex command already has an in-flight request");
      next.inFlight = true;
    } else if (action === "release") next.inFlight = false;
    else if (action === "admitted") next.admission = null;
    else if (action === "refuse_admission") {next.admission = null; next.inFlight = false; next.error = event.message;}
    else if (["submit", "outcome", "view", "unknown", "retry"].includes(action)) {
      if (event.type === "submit" && !chart.mecha.events.includes(event.command.request.event.kind)) throw new Error("undeclared Cortex client event");
      next = hybridInteraction(state, event);
      if (event.type === "view" && !next.pending) next = {...next, phase: "ready"};
    } else throw new Error(`unknown Cortex command action ${action}`);
  }
  const transition = candidates.find(candidate => !candidate.guard || candidate.guard === next.phase);
  if (!transition) throw new Error("unhandled Cortex reconciliation result");
  if (transition.target) next = {...next, phase: transition.target};
  if (event.type === "failure") {next.error = event.message; next.inFlight = false;}
  return next;
}

export function mountCommand(chart, {signal, rpc, storage, prefix, changed, opened, id = () => crypto.randomUUID()}) {
  const openingKey = `${prefix}:opening`;
  let state = commandInitial(chart);
  let timer;
  const transition = event => {
    const next = commandTransition(chart, state, event);
    if (next.instance) storage.setItem(`${prefix}:${next.instance}`, JSON.stringify(next));
    state = next;
    if (!signal.aborted) changed(state, state.instance);
  };
  const unavailable = error => ["TransportUnavailable", "UnknownOutcome"].includes(error.name);
  const poll = async () => {
    if (state.inFlight || !state.instance || signal.aborted || ["closed", "failed"].includes(state.phase)) return;
    transition({type: "begin"});
    const instance = state.instance;
    try {
      if (state.admission) {
        const opening = state.admission;
        const value = await rpc(chart.mecha[opening.kind], {...opening.input, instance_id: instance});
        if (signal.aborted) return;
        if (!value) throw new Error("instance has no authorized view");
        transition({type: "view", value});
        storage.removeItem(openingKey);
        transition({type: "admitted"});
        opened(instance);
      }
      if (state.pending && !state.outcome) {
        transition({type: "retry"});
        const command = state.pending;
        let value;
        try { value = await rpc(chart.mecha.command, {instance_id: instance, ...command}); }
        catch (error) {
          if (signal.aborted) return;
          if (!unavailable(error)) throw error;
          transition({type: "unknown", command_id: command.command_id});
          return;
        }
        if (signal.aborted) return;
        if (value?.command_id !== command.command_id) throw new Error("uncorrelated Cortex command receipt");
        transition({type: "outcome", value});
      }
      const value = await rpc(chart.mecha.sync, {instance_id: instance});
      if (signal.aborted) return;
      if (!value) throw new Error("instance has no authorized view");
      transition({type: "view", value});
    } catch (error) {
      if (!signal.aborted) {
        if (state.admission && error.name === "ProtocolError") {
          storage.removeItem(openingKey);
          transition({type: "admission_refused", message: error.message});
        } else transition(unavailable(error) ? {type: "unavailable"} : {type: "failure", message: error.message});
      }
    } finally {
      if (!signal.aborted && state.phase !== "failed") transition({type: "completed"});
      if (!signal.aborted && state.phase !== "failed") timer = setTimeout(poll, state.pending && !state.outcome && state.phase === "submitting" ? 0 : chart.omnishell.pollMs);
    }
  };
  const open = (instanceId, kind = "join", input = {}) => {
    if (signal.aborted) return;
    if (state.inFlight) throw new Error("Cortex admission is already in progress");
    const opening = JSON.parse(storage.getItem(openingKey) ?? "null");
    if (opening && opening.instance !== instanceId) throw new Error("Cortex admission has an unresolved outcome");
    if (!["create", "join"].includes(kind)) throw new Error("invalid Cortex admission kind");
    clearTimeout(timer);
    // A lost creation response must reuse its original initializer arguments.
    const admission = opening ?? {instance: instanceId, kind, input: structuredClone(input)};
    const fields = admission.kind === "create" ? chart.mecha.inputs : chart.mecha.joinInputs;
    if (Object.keys(admission.input).some(key => !fields.includes(key)) || (admission.kind === "create" && fields.some(key => !Object.hasOwn(admission.input, key)))) throw new Error("invalid Cortex admission input");
    storage.setItem(openingKey, JSON.stringify(admission));
    const held = JSON.parse(storage.getItem(`${prefix}:${instanceId}`) ?? "null") ?? commandInitial(chart);
    transition({type: "open", held, instance: instanceId, admission});
    return poll();
  };
  signal.addEventListener("abort", () => {clearTimeout(timer); transition({type: "close"});}, {once: true});
  changed(state, state.instance);
  return {
    resume() {
      const opening = JSON.parse(storage.getItem(openingKey) ?? "null");
      return opening ? open(opening.instance, opening.kind, opening.input) : undefined;
    },
    open,
    submit(kind, payload = {}) {
      if (signal.aborted || !state.view || state.pending || state.admission || ["failed", "closed"].includes(state.phase)) return;
      transition({type: "submit", command: {command_id: id(), request: {version: chart.mecha.version, expected_revision: state.view.revision, event: {kind, payload}}}});
      clearTimeout(timer);
      return poll();
    },
    retry() {clearTimeout(timer); return poll();},
  };
}
