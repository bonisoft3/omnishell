// The same four functions, declared the other way the contract allows:
// schema.cue names empty, step, combine and result and says nothing about how
// they are spelled, so `export function` is as good as `export const`. The
// role strips the export keyword whichever follows it.

export function empty(id) {
  return harden({ id, total: 0 });
}

export function step(acc, row) {
  return harden({ ...acc, total: acc.total + (row.deleted_at == null ? 1 : 0) });
}

export function combine(a, b) {
  return harden({ ...a, total: a.total + b.total });
}

export function result(acc) {
  return acc;
}
