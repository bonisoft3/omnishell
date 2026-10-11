// The memo around an agent's seat (hatch.js memoSeat): a question whose answer
// the memo table holds is answered from the row and never posted, an answer
// the unit posts is upserted on the key before the chart hears it, and the
// same question asked twice runs the unit once. The seat is driven through a
// stand-in Worker and a two-method store, since what is under test is the
// terminal's own performance of the memo and nothing a unit or a store does.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { mountHatch } from "../interpreter/hatch.js";

type Row = Record<string, string>;
type Posted = { type: string; props?: Row; detail?: Row };

const UNIT = {
  isolation: "agent",
  ports: { reads: ["game"], raises: ["answer"] },
  memo: { table: "answer", key: ["fen", "nodes"], columns: ["fen", "nodes", "uci"] },
  src: "shell/units/engine/unit.js",
};
const SRC = "https://app.example/shell/units/engine/unit.js";

class FakeWorker {
  static made: FakeWorker[] = [];
  posted: Posted[] = [];
  listeners: ((e: { data: unknown }) => void)[] = [];
  constructor(readonly url: string) {
    FakeWorker.made.push(this);
  }
  postMessage(data: Posted) {
    this.posted.push(data);
  }
  addEventListener(_type: string, fn: (e: { data: unknown }) => void) {
    this.listeners.push(fn);
  }
  terminate() {}
  says(data: unknown) {
    for (const fn of this.listeners) fn({ data });
  }
}
// deno-lint-ignore no-explicit-any
(globalThis as any).Worker = FakeWorker;

/** A store of one table: rows by the memo's natural key, as upsertBy resolves. */
function memoStore(rows: Row[] = []) {
  const calls: string[] = [];
  return {
    rows,
    calls,
    query: (table: string) => {
      calls.push(`query ${table}`);
      return Promise.resolve(rows);
    },
    upsertBy: (table: string, values: Row) => {
      calls.push(`upsert ${table} ${values.fen}`);
      const at = rows.findIndex((r) => r.fen === values.fen && r.nodes === values.nodes);
      if (at < 0) rows.push({ id: String(rows.length + 1), ...values });
      else rows[at] = { ...rows[at], ...values };
      return Promise.resolve();
    },
  };
}

const settled = () => new Promise((r) => setTimeout(r, 0));

const mount = (store: ReturnType<typeof memoStore>) => {
  FakeWorker.made.length = 0;
  const events: { name: string; detail: Row }[] = [];
  const hatch = mountHatch(null, { unit: UNIT, src: SRC, onEvent: (e: { name: string; detail: Row }) => events.push(e), store });
  const worker = FakeWorker.made[0];
  worker.says({ type: "pronto:ready" });
  // The seat delivers its current-value feed the moment the unit is ready,
  // empty here; the questions are what follows it.
  const asked = () => worker.posted.slice(1).map((p) => p.props);
  return { hatch, worker, events, asked };
};

Deno.test("asked twice with the same key, the agent runs once: the second ask is answered from the row", async () => {
  const store = memoStore();
  const { hatch, worker, events, asked } = mount(store);

  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  assertEquals(asked(), [{ fen: "e4", nodes: "100" }], "a question the memo does not hold reaches the unit");
  assertEquals(events, [], "and nothing is heard before the unit answers");

  worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", nodes: "100", uci: "e7e5" } });
  await settled();
  assertEquals(store.rows.map((r) => [r.fen, r.nodes, r.uci]), [["e4", "100", "e7e5"]], "the answer is a row on the key");
  assertEquals(events, [{ name: "answer", detail: { fen: "e4", nodes: "100" } }], "the chart hears the key, and reads the row");
  assert(Object.isFrozen(events[0].detail));

  // The question withdrawn, then put again: the row answers it, the unit is
  // never posted, and the chart hears the same event.
  hatch.update({ fen: "", nodes: "" });
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  assertEquals(asked(), [{ fen: "e4", nodes: "100" }, { fen: "", nodes: "" }], "the withdrawal reached the unit, the repeat did not");
  assertEquals(events.length, 2);
  assertEquals(events[1].detail, { fen: "e4", nodes: "100" });

  // A different budget is a different question.
  hatch.update({ fen: "e4", nodes: "200" });
  await settled();
  assertEquals(asked().at(-1), { fen: "e4", nodes: "200" });
  hatch.destroy();
});

Deno.test("a row held before the mount answers without the unit, and a re-delivery of the same props is silence", async () => {
  const store = memoStore([{ id: "1", fen: "d4", nodes: "100", uci: "d7d5" }]);
  const { hatch, events, asked } = mount(store);
  hatch.update({ fen: "d4", nodes: "100" });
  hatch.update({ fen: "d4", nodes: "100" });
  await settled();
  assertEquals(asked(), [], "the unit was never asked");
  assertEquals(events, [{ name: "answer", detail: { fen: "d4", nodes: "100" } }], "one answer for one question, however often the props are re-delivered");
  assertEquals(store.calls, ["query answer"]);
  hatch.destroy();
});

Deno.test("an event outside the unit's raises is refused before the memo reads it as an answer", async () => {
  const store = memoStore();
  const { hatch, worker, events } = mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  let threw: unknown = null;
  try {
    worker.says({ type: "pronto:event", name: "verdict", detail: { fen: "e4", nodes: "100", uci: "e7e5" } });
  } catch (e) {
    threw = e;
  }
  assert(String(threw).includes('raised "verdict"'), `the undeclared name is refused by the raises port, got ${threw}`);
  await settled();
  assertEquals(store.calls, ["query answer"], "and the memo wrote nothing");
  assertEquals(events, [], "and the chart heard nothing");
  hatch.destroy();
});

Deno.test("an answer missing a key field or a column of the memo is refused, and a question missing a key field too", async () => {
  const store = memoStore();
  const { hatch, worker } = mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  let threw: unknown = null;
  try {
    worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", uci: "e7e5" } });
  } catch (e) {
    threw = e;
  }
  assert(String(threw).includes('"nodes"'), `a key field the answer lacks is named, got ${threw}`);
  threw = null;
  try {
    worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", nodes: "100" } });
  } catch (e) {
    threw = e;
  }
  assert(String(threw).includes('"uci"'), `a column the answer lacks is named, got ${threw}`);
  assertEquals(store.rows, [], "and nothing was written");
  await assertRejects(() => Promise.resolve().then(() => hatch.update({ nodes: "100" })), Error, '"fen"');
  hatch.destroy();
});
