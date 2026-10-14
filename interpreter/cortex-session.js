const read = (value, path) => path.split(".").reduce((node, key) => node?.[key], value);

export function sessionInitial(chart, pending = null) {
  return {phase: chart.initial, pending, snapshot: null, inFlight: null, transmitted: Boolean(pending), draft: "", edited: false, error: null, receipt: null};
}

export function sessionTransition(chart, state, event) {
  const phase = chart.states[state.phase];
  if (!phase) throw new Error(`unknown Cortex session state ${state.phase}`);
  if (phase.final) return state;
  const candidates = phase.on[event.type];
  if (!candidates) throw new Error(`illegal Cortex session event ${state.phase}/${event.type}`);
  const queued = state.inFlight?.operation === null && Boolean(state.pending);
  const transition = (Array.isArray(candidates) ? candidates : [candidates]).find(t => !t.guard || (t.guard === "queued" && queued));
  if (!transition) return state;
  const next = {...state, phase: transition.target ?? state.phase};
  for (const action of transition.actions) {
    if (action === "capture") {
      if (state.inFlight) throw new Error("Cortex session already has an in-flight request");
      next.inFlight = {operation: state.pending};
      if (state.pending) next.transmitted = true;
    } else if (action === "enqueue") {
      if (state.pending || !state.snapshot) throw new Error("Cortex session is not ready for a command");
      if (!chart.mecha.routes[event.operation.type] || typeof event.operation.command_id !== "string") throw new Error("undeclared Cortex session operation");
      next.pending = structuredClone(event.operation);
      next.transmitted = false;
      next.error = null;
      next.receipt = null;
    } else if (action === "snapshot" || action === "receipt") {
      if (!state.inFlight) throw new Error("unsolicited Cortex session response");
      const sent = state.inFlight.operation;
      if (sent) {
        const receipt = event.snapshot.receipt;
        if (receipt?.command_id !== sent.command_id || !["accepted", "rejected"].includes(receipt.kind)) throw new Error("uncorrelated Cortex session receipt");
        next.receipt = receipt;
        next.pending = null;
        next.transmitted = false;
      }
      const rebase = chart.omnishell.rebaseUnsent;
      if (queued && !state.transmitted && rebase && state.pending.type === rebase.route && rebase.unchanged.every(path => JSON.stringify(read(state.snapshot, path)) === JSON.stringify(read(event.snapshot, path)))) {
        next.pending = {...state.pending, request: {...state.pending.request, expected_revision: event.snapshot.self.revision}};
      }
      next.snapshot = event.snapshot;
      next.inFlight = null;
      const draft = chart.omnishell.draft;
      if ((!state.snapshot && !state.edited) || (!next.pending && read(event.snapshot, draft.locked.path) === draft.locked.equals)) next.draft = read(event.snapshot, draft.path);
    } else if (action === "draft") {
      next.draft = event.value;
      next.edited = true;
      next.error = null;
    } else if (action === "release") {
      next.inFlight = null;
    } else if (action === "fail") {
      next.inFlight = null;
      next.error = event.message;
    } else throw new Error(`unknown Cortex session action ${action}`);
  }
  return next;
}

export function mountSession(chart, {signal, rpc, storage, key, changed, id = () => crypto.randomUUID()}) {
  const saved = JSON.parse(storage.getItem(key) ?? "null");
  let state = sessionInitial(chart, saved?.pending ?? null);
  const lease = id();
  let timer;
  const transition = event => {
    const next = sessionTransition(chart, state, event);
    // Persist before publishing or performing an effect. A storage failure sends nothing.
    storage.setItem(key, JSON.stringify({pending: next.pending}));
    state = next;
    if (!signal.aborted) changed(state);
  };
  const unavailable = error => ["TransportUnavailable", "UnknownOutcome"].includes(error.name);
  const poll = async () => {
    if (signal.aborted || state.inFlight || ["failed", "closed"].includes(state.phase)) return;
    transition({type: "begin"});
    const operation = state.inFlight.operation;
    let snapshot;
    try {
      snapshot = await rpc(chart.mecha.sync, {session_id: lease, operation});
    } catch (error) {
      if (signal.aborted) return;
      transition(unavailable(error) ? {type: "unavailable"} : {type: "failure", message: error.message});
      if (state.phase !== "failed") timer = setTimeout(poll, chart.omnishell.pollMs);
      return;
    }
    if (signal.aborted) return;
    try {
      transition({type: "completed", snapshot});
    } catch (error) {
      transition({type: "failure", message: error.message});
      return;
    }
    timer = setTimeout(poll, state.pending && operation === null ? 0 : chart.omnishell.pollMs);
  };
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    transition({type: "close"});
    // Cleanup is best-effort only for transport loss; Mecha owns lease expiry.
    rpc(chart.mecha.leave, {session_id: lease}, {signal: AbortSignal.timeout(3000), keepalive: true}).catch(error => {
      if (!unavailable(error)) throw error;
    });
  }, {once: true});
  changed(state);
  if (!signal.aborted) void poll();
  return {
    edit(value) { if (!signal.aborted) transition({type: "edit", value}); },
    submit(operation) {
      if (signal.aborted || state.phase !== "ready") return;
      transition({type: "submit", operation: {command_id: id(), ...operation}});
      clearTimeout(timer);
      if (!state.inFlight) void poll();
    },
  };
}
