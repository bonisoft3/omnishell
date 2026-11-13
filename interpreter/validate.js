// The judge of a write: every validation of an entity, asked in declared
// order about the row the write would produce. Store-agnostic — the caller
// loads the predicates, finds the standing row, and answers each edge's rows
// out of whatever it holds — so any store that wants the terminal's refusals
// asks the same loop.

/**
 * Throws a NonRetriableError, carrying the refusing validation's name as
 * `.validation`, at the first predicate that answers false; resolves when
 * every predicate answers true.
 *
 * `list` is the table's loaded predicates, `[{name, edges, test}]`, where
 * `test` is the evaluated validation module. `row` is what the write states:
 * a whole row for an insert, the changed fields for an update, which `held`
 * — the standing row, required for an update — completes. The owner column
 * is filled with `me()` when the produced row omits it: the server defaults
 * it, and a predicate over an absent owner judges nothing. Filled after the
 * merge, so an update never restates the owner of a row this reader does not
 * own. `me` also names the write's origin, `event._origin`, as `user:<id>`.
 *
 * `rowsFor(edge, row, name)` answers the rows of `edge.table` the produced
 * row walks to, for the validation named `name`; they reach the predicate as
 * `context.rows[edge.table]`.
 *
 * A predicate answering anything but a boolean is a program error, not a
 * refusal: there is no reading of a rule that did not answer.
 */
export async function judge(list, { table, type, row, held, rowsFor, owner, me }) {
  const items = held === undefined ? [] : [held];
  // Who sent the write: the origin, as the trigger states it, which a guest
  // has none of, and the owner of a row that names none.
  const sender = me();
  let produced = held === undefined ? row : { ...held, ...row };
  if (owner !== undefined && produced[owner] === undefined) {
    produced = { ...produced, [owner]: sender };
  }
  const event = sender == null ? { type, row: produced } : { type, row: produced, _origin: `user:${sender}` };
  for (const v of list) {
    const rows = {};
    for (const edge of v.edges) rows[edge.table] = await rowsFor(edge, event.row, v.name);
    const verdict = v.test({ context: { items, rows }, event });
    if (verdict === true) continue;
    if (verdict !== false) {
      throw new Error(`validation ${table}.${v.name}: the predicate answered ${typeof verdict}`);
    }
    const err = new Error(`validation ${table}.${v.name}`);
    err.name = "NonRetriableError";
    err.validation = v.name;
    throw err;
  }
}
