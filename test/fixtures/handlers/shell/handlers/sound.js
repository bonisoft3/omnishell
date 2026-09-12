// A reduce, which is what the handler role asks a module to end in.
(state, event) => {
  const rows = state.rows?.thing ?? [];
  return { updates: rows.filter((r) => r.id === event.id).map((r) => ({ op: "patch", entity: "thing", id: r.id, row: { seen: "yes" } })) };
};
