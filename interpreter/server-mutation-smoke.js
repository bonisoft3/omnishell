import { FIXTURE_CARRIERS } from "./fixture-types.js";
import { assert, withBrowser } from "./smoke-browser.js";

let worlds = 0;
function server() {
  const base = `http://server-mutation${++worlds}`;
  const rows = [{ id: "n1", title: "before", owner_id: "reader", txid: "1" }];
  const changes = [];
  let wake;
  let txid = 1;
  let snapshots = 0;
  let writes = 0;
  const message = (operation, value) => ({
    key: `"public"."note"/"${value.id}"`, value,
    headers: { operation, relation: ["public", "note"], txids: [Number(value.txid)] },
  });
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/crud/note") {
      const id = url.searchParams.get("id")?.slice(3);
      const row = rows.find(row => row.id === id);
      if (!init.method || init.method === "GET") return Response.json(row ? [row] : []);
      assert(row !== undefined, "mutations reach an existing server record");
      writes++;
      const operation = init.method === "DELETE" ? "delete" : "update";
      const value = { ...row, ...(init.body ? JSON.parse(init.body) : {}), txid: String(++txid) };
      if (operation === "delete") rows.splice(rows.indexOf(row), 1);
      else Object.assign(row, value);
      changes.push(message(operation, value));
      wake?.();
      return Response.json([value]);
    }
    if (url.pathname === "/auth/shape") {
      return Response.json({ token: "shape-token", where: "owner_id = 'reader'", expires_in: 900 });
    }
    assert(url.pathname === "/electric/v1/shape", `expected an Electric request: ${url}`);
    let batch;
    if (url.searchParams.get("live") === "true") {
      if (!changes.length) await new Promise((resolve, reject) => {
        wake = resolve;
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      wake = undefined;
      batch = changes.splice(0);
    } else if (url.searchParams.get("offset") === "-1") {
      snapshots++;
      batch = rows.map(row => message("insert", row));
    } else {
      batch = changes.splice(0);
    }
    return Response.json([...batch, { headers: { control: "up-to-date", global_last_seen_lsn: String(txid) } }], {
      headers: {
        "electric-handle": "note-shape",
        "electric-offset": `0_${txid}`,
        "electric-cursor": String(txid),
        "electric-schema": JSON.stringify({
          id: { type: "text" }, title: { type: "text" }, owner_id: { type: "text" }, txid: { type: "int8" },
        }),
      },
    });
  };
  return { base, fetch, rows, get snapshots() { return snapshots; }, get writes() { return writes; } };
}

for (const operation of ["patch", "drop"]) {
  for (const exists of [true, false]) {
    Deno.test({
      name: `a cold private server read can ${operation} an eager record${exists ? "" : " and refuses an absent key without leaking its lease"}`,
      sanitizeOps: false,
      sanitizeResources: false,
      async fn() {
        const fake = server();
        const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
        Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
        try {
          await withBrowser({ fetch: fake.fetch }, async createStore => {
            const store = createStore(fake.base, {
              tables: ["note"], carriers: FIXTURE_CARRIERS,
              access: { note: { scope: "private", owner: "owner_id" } },
              schema: { note: { durability: "server", fields: [
                { name: "id", type: "string" }, { name: "title", type: "string" }, { name: "owner_id", type: "string" },
              ] } },
            });
            const client = globalThis.__mechaClient;
            await client.ready;
            const collection = client.collections.note;
            const stop = store.subscribe("note", () => {}, { filter: "id=eq.n1" });
            try {
              const read = await store.query("note", null, { filter: "id=eq.n1" });
              assert(read[0]?.title === "before", "the server read returns the record");
              assert(collection.size === 0 && fake.snapshots === 0, "reading and subscribing do not load a local snapshot");
              const subscribers = collection.subscriberCount;
              const key = exists ? "n1" : "missing";
              const result = await (operation === "patch"
                ? store.patch("note", [{ key, changes: { title: "after" } }])
                : store.drop("note", [key])).then(() => null, error => error);
              if (exists) {
                assert(result === null, `the cold mutation succeeds: ${result}`);
                assert(fake.writes === 1, "the real mutation reaches CRUD once");
                assert(operation === "patch" ? fake.rows[0]?.title === "after" : fake.rows.length === 0, "the server accepts the mutation");
              } else {
                assert(/not found|no item/.test(result?.message), `an absent key is refused: ${result}`);
                assert(fake.writes === 0, "an absent key never reaches CRUD");
              }
              assert(fake.snapshots === 1, `the mutation loads the eager snapshot itself: ${fake.snapshots}`);
              assert(collection.subscriberCount === subscribers, "the mutation releases its listener after success or refusal");
            } finally {
              stop();
              await collection.cleanup();
            }
          });
        } finally {
          if (online) Object.defineProperty(navigator, "onLine", online);
          else delete navigator.onLine;
        }
      },
    });
  }
}
