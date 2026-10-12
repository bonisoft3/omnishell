// The memo around an agent's seat (hatch.js memoSeat): a question whose answer
// the memo table holds is answered from the row and never posted, an answer
// the unit posts is upserted on the key before the chart hears it, and the
// same question asked twice runs the unit once. The seat is driven through a
// stand-in Worker and a two-method store, since what is under test is the
// terminal's own performance of the memo and nothing a unit or a store does.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { mountHatch } from "../interpreter/hatch.js";
import { parseFilterSpec, ProgramError } from "../interpreter/fragment.js";

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
  /** What the unit says, delivered as the port does: a task of its own, so a
   * listener's throw is the window's `error` event and never the caller's. */
  says(data: unknown) {
    setTimeout(() => {
      for (const fn of this.listeners) fn({ data });
    }, 0);
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
    query: (table: string, _order: unknown, opts: {filter: string}) => {
      calls.push(`query ${table}`);
      const clauses = parseFilterSpec(opts.filter);
      assert(clauses?.length === UNIT.memo.key.length, "a memo lookup bounds every key field");
      return Promise.resolve(rows.filter(row => clauses.every(c => String(row[c.col]) === c.value)));
    },
    upsertBy: (table: string, values: Row, _onRefused?: (err: Error) => void) => {
      calls.push(`upsert ${table} ${values.fen}`);
      const at = rows.findIndex((r) => r.fen === values.fen && r.nodes === values.nodes);
      if (at < 0) rows.push({ id: String(rows.length + 1), ...values });
      else rows[at] = { ...rows[at], ...values };
      return Promise.resolve();
    },
  };
}

const settled = () => new Promise((r) => setTimeout(r, 1));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => resolve = accept);
  return { promise, resolve };
}

/** What `act` let escape to where the shell listens: uncaught throws (the
 * `error` event) and rejections nobody awaited, in order. */
async function escaped(act: () => void): Promise<unknown[]> {
  const out: unknown[] = [];
  const onError = (e: ErrorEvent) => {
    e.preventDefault();
    out.push(e.error);
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    e.preventDefault();
    out.push(e.reason);
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onRejection);
  try {
    act();
    await settled();
  } finally {
    globalThis.removeEventListener("error", onError);
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
  return out;
}

const mount = async (store: ReturnType<typeof memoStore>) => {
  FakeWorker.made.length = 0;
  const events: { name: string; detail: Row }[] = [];
  const hatch = mountHatch(null, { unit: UNIT, src: SRC, onEvent: (e: { name: string; detail: Row }) => events.push(e), store });
  const worker = FakeWorker.made[0];
  worker.says({ type: "pronto:ready" });
  await settled();
  // The seat delivers its current-value feed the moment the unit is ready,
  // empty here; the questions are what follows it.
  const asked = () => worker.posted.slice(1).map((p) => p.props);
  return { hatch, worker, events, asked };
};

Deno.test("asked twice with the same key, the agent runs once: the second ask is answered from the row", async () => {
  const store = memoStore();
  const { hatch, worker, events, asked } = await mount(store);

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
  const { hatch, events, asked } = await mount(store);
  hatch.update({ fen: "d4", nodes: "100" });
  hatch.update({ fen: "d4", nodes: "100" });
  await settled();
  assertEquals(asked(), [], "the unit was never asked");
  assertEquals(events, [{ name: "answer", detail: { fen: "d4", nodes: "100" } }], "one answer for one question, however often the props are re-delivered");
  assertEquals(store.calls, ["query answer"]);
  hatch.destroy();
});

Deno.test("a memo lookup settling after destroy neither answers a hit nor posts a miss", async () => {
  for (const rows of [[{ id: "1", fen: "d4", nodes: "100", uci: "d7d5" }], []]) {
    const lookup = deferred<Row[]>();
    const store = memoStore();
    store.query = () => lookup.promise;
    const { hatch, events, asked } = await mount(store);

    hatch.update({ fen: "d4", nodes: "100" });
    hatch.destroy();
    lookup.resolve(rows);
    await settled();

    assertEquals(events, [], "a destroyed memo cannot answer a held row");
    assertEquals(asked(), [], "or turn a late miss into work for its dead unit");
  }
});

Deno.test("a memo upsert settling after destroy does not dispatch its answer", async () => {
  const write = deferred<void>();
  const store = memoStore();
  let writing = false;
  store.upsertBy = () => {
    writing = true;
    return write.promise;
  };
  const { hatch, worker, events } = await mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();

  worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", nodes: "100", uci: "e7e5" } });
  await settled();
  assert(writing, "the answer is waiting for the memo row to be held");
  hatch.destroy();
  write.resolve();
  await settled();

  assertEquals(events, [], "a write cannot complete into a chart whose hatch is gone");
});

Deno.test("an event outside the unit's raises is refused before the memo reads it as an answer", async () => {
  const store = memoStore();
  const { hatch, worker, events } = await mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  const [threw] = await escaped(() => worker.says({ type: "pronto:event", name: "verdict", detail: { fen: "e4", nodes: "100", uci: "e7e5" } }));
  assert(threw instanceof ProgramError, `the undeclared name is the app's bug, got ${threw}`);
  assert(String(threw).includes('raised "verdict"'), `refused by the raises port, got ${threw}`);
  assertEquals(store.calls, ["query answer"], "and the memo wrote nothing");
  assertEquals(events, [], "and the chart heard nothing");
  hatch.destroy();
});

Deno.test("an answer the store refuses is a ProgramError naming the unit and its memo, never a dropped connection", async () => {
  const store = memoStore();
  store.upsertBy = () => Promise.reject(new Error("uci: this.matches('^[a-h]...') is false"));
  const { hatch, worker, events } = await mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  // The seat's chain has nobody to await it, so the refusal lands where the
  // shell listens; the shell banners a ProgramError wherever it lands.
  const out = await escaped(() => worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", nodes: "100", uci: "z9" } }));
  assertEquals(out.length, 1);
  assert(out[0] instanceof ProgramError, `a program error, got ${out[0]}`);
  const said = String((out[0] as Error).message);
  for (const word of [SRC, '"answer"', "refused", "this.matches"]) assert(said.includes(word), `${word} in ${said}`);
  assertEquals(events, [], "and the chart heard nothing");
  hatch.destroy();
});

Deno.test("a refusal landing after the store's acceptance window is the same ProgramError, not settle's console line", async () => {
  const store = memoStore();
  // data-sync's settle resolves a slow write as accepted and hands a refusal
  // that lands afterwards to onRefused alone; a memo has no form to carry the
  // words to, so onRefused must throw where the shell listens.
  store.upsertBy = (_table: string, _values: Row, onRefused?: (err: Error) => void) => {
    Promise.resolve().then(() => onRefused?.(new Error("uci: this.matches('^[a-h]...') is false")));
    return Promise.resolve();
  };
  const { hatch, worker } = await mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  const out = await escaped(() => worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", nodes: "100", uci: "z9" } }));
  const late = out.find((e) => e instanceof ProgramError && String((e as Error).message).includes("refused"));
  assert(late !== undefined, `the late refusal escapes as a program error, got ${out}`);
  assert(String((late as Error).message).includes(SRC), "naming the unit");
  hatch.destroy();
});

Deno.test("an answer missing a key field or a column of the memo is refused, and a question missing a key field too", async () => {
  const store = memoStore();
  const { hatch, worker } = await mount(store);
  hatch.update({ fen: "e4", nodes: "100" });
  await settled();
  // Thrown from the port's listener, each is the window's `error` event — a
  // ProgramError, so the shell banners it rather than leaving a console line
  // and a question that stands forever.
  let [threw] = await escaped(() => worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", uci: "e7e5" } }));
  assert(threw instanceof ProgramError && String(threw).includes('"nodes"'), `a key field the answer lacks is named, got ${threw}`);
  [threw] = await escaped(() => worker.says({ type: "pronto:event", name: "answer", detail: { fen: "e4", nodes: "100" } }));
  assert(threw instanceof ProgramError && String(threw).includes('"uci"'), `a column the answer lacks is named, got ${threw}`);
  assertEquals(store.rows, [], "and nothing was written");
  // A question is put inside the region's refresh, whose outage guard retries
  // anything but a ProgramError as a dead gateway; worker-smoke.js drives this
  // one through interpretScreen.
  await assertRejects(() => Promise.resolve().then(() => hatch.update({ nodes: "100" })), ProgramError, '"fen"');
  hatch.destroy();
});

Deno.test("memo lookup addresses the complete key and escapes filter delimiters", async () => {
  const fen = "a&nodes=eq.200 /?%";
  const store = memoStore([{ id: "1", fen, nodes: "100", uci: "e2e4" }, { id: "2", fen, nodes: "200", uci: "d2d4" }]);
  const { hatch, events, asked } = await mount(store);
  hatch.update({ fen, nodes: "100" });
  await settled();
  assertEquals(asked(), []);
  assertEquals(events, [{ name: "answer", detail: { fen, nodes: "100" } }]);
  hatch.destroy();
});
