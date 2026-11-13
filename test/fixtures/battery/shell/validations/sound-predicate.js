// A predicate with nothing wrong with it: it reads the rows its edge walks to,
// answers a boolean, and answers the same one twice.
({ context, event }) => (context.rows.note ?? []).every((note) => note.id !== event.row.id);
