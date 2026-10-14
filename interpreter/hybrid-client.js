// A transport timeout cannot undo a committed move. Keep the original intent
// until its correlated receipt and a sufficiently new view have both arrived.
export function hybridInteraction(state, event) {
  const revision = value => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid hybrid revision");
    return BigInt(value);
  };
  const next = { ...state };
  if (event.type === "submit") {
    if (state.pending) throw new Error("a hybrid command is unresolved");
    if (!state.view) throw new Error("a hybrid command requires a confirmed view");
    if (event.command.request.expected_revision !== state.view.revision) throw new Error("command does not name the confirmed revision");
    next.pending = event.command;
    next.outcome = null;
    next.phase = "submitting";
  } else if (event.type === "unknown") {
    if (state.pending?.command_id !== event.command_id || state.outcome) return state;
    next.phase = "unknown";
  } else if (event.type === "retry") {
    if (!state.pending || state.outcome) throw new Error("no unknown command to resolve");
    next.phase = "submitting";
  } else if (event.type === "outcome") {
    if (state.pending?.command_id !== event.value.command_id) return state;
    if (!["accepted", "rejected"].includes(event.value.kind)) throw new Error("invalid hybrid outcome");
    revision(event.value.revision);
    if (state.outcome && ["command_id", "kind", "revision", "reason"].some(key => state.outcome[key] !== event.value[key])) throw new Error("conflicting hybrid outcomes");
    next.outcome = event.value;
    next.phase = event.value.kind === "rejected" ? "rejected" : "awaiting_view";
    if (event.value.kind === "rejected") next.pending = null;
  } else if (event.type === "view") {
    if (state.view && revision(event.value.revision) <= revision(state.view.revision)) return state;
    revision(event.value.revision);
    next.view = event.value;
  } else throw new Error(`unknown hybrid interaction event ${event.type}`);
  if (next.pending && next.outcome?.kind === "accepted" && next.view && revision(next.view.revision) >= revision(next.outcome.revision)) {
    next.pending = null;
    next.phase = "ready";
  }
  return next;
}
