// A predicate with nothing wrong with it: it reads the rows its edge walks to,
// answers a boolean, and answers the same one twice.
(state, event) => (state.rows.note ?? []).every((note) => note.id !== event.row.id);
