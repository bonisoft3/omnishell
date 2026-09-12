// A fold, authored as an ES module because the same file is inlined into the
// rpk stream at container tier. The role rewrites `export const` and hardens
// the four names, so this loads as a fold and as nothing else.

export const empty = (id) => harden({ id, total: 0 });

export const step = (acc, row) => harden({ ...acc, total: acc.total + (row.deleted_at == null ? 1 : 0) });

export const combine = (a, b) => harden({ ...a, total: a.total + b.total });

export const result = (acc) => acc;
