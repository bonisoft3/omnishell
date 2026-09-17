// A handler with nothing wrong with it: bounded, pure, and answering in the
// shape the role states. Its silence is what tells a run that ran from a run
// that never drew an input.
(state, event) => {
  const rows = state.rows.note ?? [];
  const want = String(event.id ?? "");
  if (want === "") return { updates: [] };
  const updates = [];
  for (const note of rows) {
    const kind = note.id === want ? "note" : "link";
    if (note.kind !== kind) {
      updates.push({ op: "patch", entity: "note", id: note.id, row: { kind } });
    }
  }
  return { updates };
};
