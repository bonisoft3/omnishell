// A handler that writes to the state it was handed instead of returning an
// update. In the terminal the write would land on a row the store believes it
// owns, and the screen and the database would disagree from then on.
({ context }) => {
  context.rows.note = [];
  return { updates: [] };
};
