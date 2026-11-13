// A chart leaf, which is handed the literals stated beside its reference. The
// column to read is one of them, so the module reporting nothing is the
// assertion that a reference's third argument reached it.
({ context }, params) => String(context.items[0][params.col] ?? "");
