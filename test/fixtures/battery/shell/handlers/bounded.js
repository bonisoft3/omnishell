// The schema's own domains, restated as a refusal. Every row this handler is
// handed must obey what shell.yaml states about the column it sits in, so the
// handler reporting nothing is the assertion that the bounds crossed from the
// program and that the generators obeyed them.
(state, event) => {
  for (const note of state.rows.note ?? []) {
    if (typeof note.id !== "string" || note.id.length < 2 || note.id.length > 6) {
      throw new Error(`id outside sizeMin 2 sizeMax 6: ${JSON.stringify(note.id)}`);
    }
    if (note.kind !== "note" && note.kind !== "link") {
      throw new Error(`kind outside its closed set: ${JSON.stringify(note.kind)}`);
    }
    if (typeof note.rank !== "number" || note.rank < 1 || note.rank > 9) {
      throw new Error(`rank outside intMin 1 intMax 9: ${JSON.stringify(note.rank)}`);
    }
    if (!/^[a-f]{3}$/.test(note.code)) {
      throw new Error(`code outside its pattern: ${JSON.stringify(note.code)}`);
    }
  }
  return { updates: [] };
};
