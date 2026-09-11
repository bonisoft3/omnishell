// Deno smoke: the judge alone, with plain functions for predicates and an
// in-memory rowsFor — no store, no client, no compartment. What reaches a
// predicate is `({items, rows}, {type, row})`; a false stops the loop with a
// NonRetriableError naming the validation; a non-boolean is a program error.

import { judge } from "./validate.js";

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

const refusal = async (p) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("smoke failed: the judge accepted");
};

const noRows = () => {
  throw new Error("smoke failed: rowsFor asked with no edges declared");
};
const noMe = () => {
  throw new Error("smoke failed: me asked with the owner present");
};

Deno.test("an insert is judged as stated, with no standing row", async () => {
  const seen = [];
  const list = [{ name: "any", edges: [], test: (state, event) => (seen.push({ state, event }), true) }];
  await judge(list, { table: "note", type: "insert", row: { id: "n1", title: "a" }, rowsFor: noRows, me: noMe });
  assert(seen.length === 1, "the predicate ran once");
  assert(JSON.stringify(seen[0].state) === JSON.stringify({ items: [], rows: {} }), "no items, no rows");
  assert(
    JSON.stringify(seen[0].event) === JSON.stringify({ type: "insert", row: { id: "n1", title: "a" } }),
    "the event is the row as stated",
  );
});

Deno.test("an update is judged as the merged row, the standing row its one item", async () => {
  const held = { id: "n1", title: "a", body: "b" };
  let got;
  const list = [{ name: "any", edges: [], test: (state, event) => ((got = { state, event }), true) }];
  await judge(list, { table: "note", type: "update", row: { id: "n1", title: "c" }, held, rowsFor: noRows, me: noMe });
  assert(got.state.items.length === 1 && got.state.items[0] === held, "the standing row is the item");
  assert(got.event.type === "update", "the type rides along");
  assert(
    JSON.stringify(got.event.row) === JSON.stringify({ id: "n1", title: "c", body: "b" }),
    "the changed fields over the standing row",
  );
});

Deno.test("the owner is filled from me only when the produced row omits it", async () => {
  const rows = [];
  const list = [{ name: "any", edges: [], test: (_s, event) => (rows.push(event.row), true) }];
  let asked = 0;
  const me = () => (asked++, "u1");
  await judge(list, { table: "note", type: "insert", row: { id: "n1" }, rowsFor: noRows, owner: "user_id", me });
  assert(rows[0].user_id === "u1" && asked === 1, "an absent owner is the session's");
  await judge(list, {
    table: "note",
    type: "update",
    row: { id: "n2", title: "t" },
    held: { id: "n2", user_id: "u2" },
    rowsFor: noRows,
    owner: "user_id",
    me: noMe,
  });
  assert(rows[1].user_id === "u2", "an update keeps the standing row's owner");
  await judge(list, { table: "note", type: "insert", row: { id: "n3" }, rowsFor: noRows, me: noMe });
  assert(!("user_id" in rows[2]), "a table with no owner column gets none");
});

Deno.test("each edge's rows come from rowsFor, asked with the produced row", async () => {
  const asks = [];
  const rowsFor = async (edge, row, name) => {
    asks.push({ table: edge.table, from: row[edge.from], name });
    return edge.table === "article" ? [{ id: "a1", author_id: "u2" }] : [];
  };
  let state;
  const list = [{
    name: "own-article",
    edges: [{ table: "article", key: "id", from: "article_id" }, { table: "tag", key: "id", from: "tag_id" }],
    test: (s) => ((state = s), true),
  }];
  await judge(list, {
    table: "favorite",
    type: "update",
    row: { id: "f1", article_id: "a1" },
    held: { id: "f1", article_id: "a0", tag_id: "t1" },
    rowsFor,
    me: noMe,
  });
  assert(
    JSON.stringify(asks) ===
      JSON.stringify([{ table: "article", from: "a1", name: "own-article" }, { table: "tag", from: "t1", name: "own-article" }]),
    "one ask per edge, in order, over the merged row",
  );
  assert(state.rows.article.length === 1 && state.rows.tag.length === 0, "rows keyed by the edge's table");
});

Deno.test("the first refusal stops the loop and names its validation", async () => {
  const ran = [];
  const list = ["a", "b", "c"].map((name) => ({
    name,
    edges: [],
    test: () => (ran.push(name), name !== "b"),
  }));
  const err = await refusal(judge(list, { table: "note", type: "insert", row: { id: "n1" }, rowsFor: noRows, me: noMe }));
  assert(err.name === "NonRetriableError", `a refusal is non-retriable: ${err.name}`);
  assert(err.message === "validation note.b", `the message names table and validation: ${err.message}`);
  assert(err.validation === "b", "the validation rides on the error");
  assert(ran.join() === "a,b", "no predicate after the refusing one runs");
});

Deno.test("a predicate answering a non-boolean is a program error, not a refusal", async () => {
  const list = [{ name: "maybe", edges: [], test: () => "maybe" }];
  const err = await refusal(judge(list, { table: "note", type: "insert", row: { id: "n1" }, rowsFor: noRows, me: noMe }));
  assert(err.name === "Error", `not a refusal: ${err.name}`);
  assert(err.validation === undefined, "no validation named");
  assert(err.message === "validation note.maybe: the predicate answered string", err.message);
});

Deno.test("no predicates judges nothing", async () => {
  await judge([], { table: "note", type: "insert", row: { id: "n1" }, rowsFor: noRows, owner: "user_id", me: () => "u1" });
});
