// The batch surface, in terms of a double's one-row-at-a-time methods.
//
// The interpreter's store writes in batches — a fold states its rows as one
// array and they reach the collection as one call, which is what keeps building
// a table from costing the table. A test double has no collection and nothing
// to hoist, so what it needs is not batching of its own but a faithful
// decomposition of the batch into the singular writes it already records.
//
// It covers the four writes that take a batch and nothing else: upsertBy and
// dropWhere are singular in the real store too, so a double that needs one
// states it itself rather than being handed a guess.
//
// It lives here, and not copied into a dozen smokes, so the next change to the
// store's shape is one edit rather than a dozen.
export function batched(singular) {
  // Dispatched through `store`, never through the object passed in: a smoke
  // swaps a method after construction to watch one write, and the batch above
  // it has to reach the swapped one.
  const store = {
    ...singular,
    // `add` and `write` are not the same intent, and the doubles record them
    // apart: a form's create asserts the row is new, and a refusal on that is
    // meaningful; a fold's write states a row whether or not it is there.
    add: async (table, rows, onRefused) => {
      for (const row of rows) await store.create(table, row, onRefused);
    },
    // The key travels beside the row, so the decomposition puts it back under
    // the column the double keys on. Every double here keys on `id`; one that
    // did not would state its own `write` rather than be guessed at.
    write: async (table, edits, onRefused) => {
      for (const e of edits) await store.put(table, { ...e.row, id: e.key }, onRefused);
    },
    patch: async (table, edits, onRefused) => {
      for (const edit of edits) await store.update(table, edit.key, edit.changes, onRefused);
    },
    drop: async (table, keys, onRefused) => {
      for (const key of keys) await store.remove(table, key, onRefused);
    },
  };
  return store;
}
