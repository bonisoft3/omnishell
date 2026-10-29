import { FIXTURE_CARRIERS } from "./fixture-types.js";
import { assert, withBrowser } from "./smoke-browser.js";

let worlds = 0;
function server() {
  const base = `http://server-mutation${++worlds}`;
  const rows = [{ id: "n1", slug: "existing", title: "before", owner_id: "reader", txid: "1" }];
  const requests = [];
  let txid = 1;
  let writes = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.pathname === "/crud/note") {
      requests.push({ url, ...init });
      const matched = rows.filter(row => [...url.searchParams].every(([col, condition]) =>
        col === "select" || (condition === "is.null" ? row[col] == null : String(row[col]) === condition.slice(3))));
      if (!init.method || init.method === "GET") return Response.json(matched);
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (init.method === "POST") {
        const added = (Array.isArray(body) ? body : [body]).map(row => ({ id: `n${rows.length + 1}`, owner_id: "reader", ...row, txid: String(++txid) }));
        rows.push(...added);
        writes++;
        return Response.json(added);
      }
      if (matched.length === 0) return Response.json([]);
      assert(init.method !== "PATCH" || !Object.hasOwn(body, "id"), "a field update does not require an UPDATE grant on the key");
      writes++;
      for (const row of matched) {
        if (init.method === "DELETE") rows.splice(rows.indexOf(row), 1);
        else Object.assign(row, body, { txid: String(++txid) });
      }
      return Response.json(matched);
    }
    throw new Error(`a server command opened a replicated shape: ${url}`);
  };
  return { base, fetch, rows, requests, get writes() { return writes; } };
}

for (const operation of ["patch", "drop"]) {
  for (const exists of [true, false]) {
    Deno.test({
      name: `a cold private server read can ${operation} a record without Electric${exists ? "" : " and refuses an absent key"}`,
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
              assert(collection.size === 0, "reading and subscribing do not load a local snapshot");
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
                assert(/changed no rows/.test(result?.message), `an absent key is refused: ${result}`);
                assert(fake.writes === 0, "an absent key never reaches CRUD");
              }
              assert(collection.subscriberCount === subscribers, "the command creates no collection listeners");
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

Deno.test({
  name: "server creates keep database defaults and natural-key upserts and writes resolve through CRUD without Electric",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = server();
    const session = sessionStorage.getItem("pronto-token");
    sessionStorage.setItem("pronto-token", JSON.stringify({ token: "reader-token", user: { id: "reader", guest: false } }));
    try {
      await withBrowser({ fetch: fake.fetch }, async createStore => {
        const store = createStore(fake.base, {
          tables: ["note"], carriers: FIXTURE_CARRIERS,
          read: { note: "lazy" },
          access: { note: { scope: "private", owner: "owner_id" } },
          uniques: { note: [["owner_id", "slug"]] },
          schema: { note: { durability: "server", fields: [
            { name: "id", type: "string" }, { name: "slug", type: "string" }, { name: "title", type: "string" }, { name: "owner_id", type: "string" },
          ] } },
        });
        await store.add("note", [{ slug: "new", title: "created", txid: "99", scope_id: "forged", $synced: false }]);
        const created = fake.rows.find(row => row.slug === "new");
        assert(created.id === "n2" && created.owner_id === "reader", "the server owns absent primary-key and owner defaults");
        const sent = JSON.parse(fake.requests[0].body)[0];
        assert(!Object.hasOwn(sent, "id") && !Object.hasOwn(sent, "owner_id") && !Object.hasOwn(sent, "txid") && !Object.hasOwn(sent, "scope_id") && !Object.hasOwn(sent, "$synced"), "the command carries only submitted domain values");
        await store.upsertBy("note", { slug: "new", title: "upserted" });
        assert(fake.rows.filter(row => row.slug === "new").length === 1 && created.title === "upserted", "an existing natural key is updated");
        assert(fake.requests.some(request => request.url.searchParams.get("owner_id") === "eq.reader"), "the session's owner completes the natural key lookup");
        await store.upsertBy("note", { slug: "fresh", title: "inserted" });
        assert(fake.rows.filter(row => row.slug === "fresh").length === 1, "an absent natural key creates one row");
        await store.write("note", [{ key: "n2", row: { title: "written" } }, { key: "n4", row: { slug: "written", title: "new write" } }]);
        assert(created.title === "written" && fake.rows.some(row => row.id === "n4"), "write by key updates or inserts the stated row");
        await store.dropWhere("note", "slug=eq.new");
        assert(!fake.rows.some(row => row.slug === "new") && fake.rows.some(row => row.slug === "fresh"), "a filtered delete remains scoped");
        assert(fake.requests.every(request => request.headers.Authorization === "Bearer reader-token"), "each read and command carries authentication");
        assert(globalThis.__mechaClient.collections.note.size === 0 && globalThis.__prontoViews.size === 0, "server commands retain no replicated state");
        await globalThis.__mechaClient.collections.note.cleanup();
      });
    } finally {
      if (session === null) sessionStorage.removeItem("pronto-token");
      else sessionStorage.setItem("pronto-token", session);
    }
  },
});

Deno.test({
  name: "a server command waits for acceptance beyond the queue window and forwards its eventual refusal without waking readers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let refuse;
    let wakes = 0;
    let done = false;
    await withBrowser({ fetch: async (input, init) => {
      assert(String(input) === "http://refused-command/crud/note" && init.method === "POST", "a command neither reads nor opens Electric");
      await new Promise(resolve => { refuse = resolve; });
      return Response.json({ message: "validation note.own-record" }, { status: 403 });
    } }, async createStore => {
      const store = createStore("http://refused-command", {
        tables: ["note"], carriers: FIXTURE_CARRIERS,
        schema: { note: { durability: "server", fields: [{ name: "id", type: "string" }] } },
      });
      const stop = store.subscribe("note", () => wakes++);
      try {
        const write = store.add("note", [{ id: "n1" }]).then(() => { done = true; return null; }, error => { done = true; return error; });
        await new Promise(resolve => setTimeout(resolve, 2600));
        assert(refuse !== undefined && !done, "a server command cannot report durable queueing before CRUD accepts it");
        refuse();
        const error = await write;
        assert(error?.name === "NonRetriableError" && error.message.includes("validation note.own-record"), "the caller receives the database refusal");
        store.flushNotifications();
        assert(wakes === 0, "a refused command does not publish completion");
      } finally { refuse?.(); stop(); await globalThis.__mechaClient.collections.note.cleanup(); }
    });
  },
});

Deno.test({
  name: "server validation judges the standing row and bounded edge through CRUD before any batch update",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = server();
    const edges = [];
    const source = `const f = (state, event) => event.row.owner_id === "reader" && event.row.title !== "refused" && state.rows.owner[0].id === event.row.owner_id; f;`;
    await withBrowser({ fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/validation.js") return new Response(source);
      if (url.pathname === "/crud/owner") {
        assert(url.searchParams.get("id") === "eq.reader", "a validation reads only the edge rows it names");
        edges.push(url);
        return Response.json([{ id: "reader" }]);
      }
      return fake.fetch(input, init);
    } }, async createStore => {
      const store = createStore(fake.base, {
        appBase: `${fake.base}/`, tables: ["note", "owner"], carriers: FIXTURE_CARRIERS,
        read: { note: "lazy", owner: "lazy" },
        validations: { note: { editable: { src: "validation.js", on: ["insert", "update"], order: {insert: [0, 0], update: [0, 0]}, edges: [{ table: "owner", key: "id", from: "owner_id" }] } } },
        schema: {
          note: { durability: "server", fields: [{ name: "id", type: "string" }, { name: "owner_id", type: "string" }, { name: "title", type: "string" }] },
          owner: { durability: "server", fields: [{ name: "id", type: "string" }] },
        },
      });
      await store.patch("note", [{ key: "n1", changes: { title: "accepted" } }]);
      assert(fake.rows[0].title === "accepted" && edges.length === 1, "the judge receives a complete standing row and its edge");
      const refused = await store.patch("note", [
        { key: "n1", changes: { title: "would change" } },
        { key: "n1", changes: { title: "refused" } },
      ]).then(() => null, error => error);
      assert(refused?.name === "NonRetriableError" && refused.validation === "editable", "a local validation refusal retains its identity");
      assert(fake.rows[0].title === "accepted" && fake.writes === 1, "every row is judged before the batch performs any update");
      await Promise.all(Object.values(globalThis.__mechaClient.collections).map(collection => collection.cleanup()));
    });
  },
});

Deno.test({
  name: "a partially accepted server create wakes readers for committed rows and refuses the incomplete batch",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const rows = [{ id: "existing", title: "before" }];
    const methods = [];
    await withBrowser({ fetch: async (input, init) => {
      assert(String(input).startsWith("http://partial-command/crud/note"), "partial creates open no Electric demand");
      methods.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        const created = JSON.parse(init.body).filter(row => !rows.some(existing => existing.id === row.id));
        rows.push(...created);
        return Response.json(created);
      }
      return Response.json(rows);
    } }, async createStore => {
      const store = createStore("http://partial-command", {
        tables: ["note"], carriers: FIXTURE_CARRIERS,
        schema: { note: { durability: "server", fields: [{ name: "id", type: "string" }, { name: "title", type: "string" }] } },
      });
      let refreshed;
      const stop = store.subscribe("note", () => { refreshed = store.query("note"); });
      try {
        const error = await store.add("note", [{ id: "existing", title: "duplicate" }, { id: "fresh", title: "created" }])
          .then(() => null, error => error);
        assert(error?.name === "NonRetriableError" && error.message.includes("1 of 2 rows"), "partial acceptance cannot report batch success");
        store.flushNotifications();
        assert(refreshed !== undefined && (await refreshed).some(row => row.id === "fresh"), "the accepted side effect refreshes readers despite the batch refusal");
        assert(rows.find(row => row.id === "existing").title === "before", "a duplicate create does not update the standing row");
        assert(methods.join(",") === "POST,GET", "the batch is sent once and its committed rows reread once");
      } finally { stop(); await globalThis.__mechaClient.collections.note.cleanup(); }
    });
  },
});

for (const operation of ["patch", "drop"]) {
  for (const status of [403, 503]) {
    Deno.test({
      name: `a server ${operation} forwards HTTP ${status} without publishing completion`,
      sanitizeOps: false,
      sanitizeResources: false,
      async fn() {
        await withBrowser({ fetch: async (input, init) => {
          assert(String(input) === "http://failed-command/crud/note?id=eq.n1", "the command retains its scoped key");
          assert(init.method === (operation === "patch" ? "PATCH" : "DELETE"), "the requested command reaches CRUD");
          return new Response("command refused", { status });
        } }, async createStore => {
          const store = createStore("http://failed-command", {
            tables: ["note"], carriers: FIXTURE_CARRIERS,
            schema: { note: { durability: "server", fields: [{ name: "id", type: "string" }, { name: "title", type: "string" }] } },
          });
          let wakes = 0;
          const stop = store.subscribe("note", () => wakes++);
          try {
            const error = await (operation === "patch" ? store.patch("note", [{ key: "n1", changes: { title: "after" } }]) : store.drop("note", ["n1"]))
              .then(() => null, error => error);
            assert(error?.name === (status === 403 ? "NonRetriableError" : "Error") && error.message === `${status} ${operation === "patch" ? "PATCH" : "DELETE"} http://failed-command/crud/note?id=eq.n1: command refused`, "HTTP refusal and transport failure retain the status, method, address and response detail");
            store.flushNotifications();
            assert(wakes === 0, "a failed update or delete does not wake a successful refresh");
          } finally { stop(); await globalThis.__mechaClient.collections.note.cleanup(); }
        });
      },
    });
  }
}

Deno.test({
  name: "server command coverage compares keys in the declared carrier's canonical spelling",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const id = "0C000000-0000-4000-8000-0000000000AA";
    await withBrowser({ fetch: async (input, init) => {
      assert(String(input) === "http://canonical-command/crud/note" && init.method === "POST", "a create is one server command");
      return Response.json([{ id: id.toLowerCase() }]);
    } }, async createStore => {
      const store = createStore("http://canonical-command", {
        tables: ["note"], carriers: FIXTURE_CARRIERS,
        schema: { note: { durability: "server", fields: [{ name: "id", type: "uuid" }] } },
      });
      await store.add("note", [{ id }]);
      await globalThis.__mechaClient.collections.note.cleanup();
    });
  },
});

Deno.test({
  name: "request-only creates and patches canonicalize typed fields while preserving nulls and database defaults",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = server();
    await withBrowser({ fetch: fake.fetch }, async createStore => {
      const store = createStore(fake.base, {
        tables: ["note"], carriers: FIXTURE_CARRIERS,
        schema: { note: { durability: "server", fields: [
          { name: "id", type: "string" },
          { name: "kickoff", type: "timestamp" },
          { name: "optional_kickoff", type: "timestamp", required: false },
          { name: "created_at", type: "timestamp", defaulted: true },
          { name: "actor_id", type: "uuid" },
          { name: "amount", type: "decimal", precision: 4, scale: 2 },
        ] } },
      });
      try {
        await store.add("note", [{ id: "fresh", kickoff: "2026-02-04T20:30:00Z", optional_kickoff: null,
          actor_id: "0C000000-0000-4000-8000-0000000000AA", amount: "1.2300" }]);
        const created = JSON.parse(fake.requests[0].body)[0];
        assert(created.kickoff === "2026-02-04T20:30:00.000000Z", "a timestamp adapter's seconds reach SQL as canonical microseconds");
        assert(created.actor_id === "0c000000-0000-4000-8000-0000000000aa" && created.amount === "1.23", "every typed field crosses the shared carrier boundary");
        assert(created.optional_kickoff === null && !Object.hasOwn(created, "created_at"), "null stays null and an omitted default belongs to the database");
        await store.patch("note", [{ key: "fresh", changes: { kickoff: "2026-02-04T17:30:00.123456-03:00", optional_kickoff: null } }]);
        const patched = JSON.parse(fake.requests[1].body);
        assert(patched.kickoff === "2026-02-04T20:30:00.123456Z", "patches convert offsets without losing microseconds");
        assert(patched.optional_kickoff === null && !Object.hasOwn(patched, "created_at") && !Object.hasOwn(patched, "id"), "patch normalization adds no absent or immutable fields");
        assert(fake.requests.length === 2 && globalThis.__mechaClient.collections.note.size === 0 && globalThis.__prontoViews.size === 0,
          "canonical writes use CRUD without acquiring an Electric snapshot");
      } finally { await globalThis.__mechaClient.collections.note.cleanup(); }
    });
  },
});

Deno.test({
  name: "conditional server patches preserve int64 revisions, refresh stale intent and still reject policy failures",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const fake = server();
    fake.rows[0].txid = "9007199254740993";
    let deny = false;
    let fail = false;
    await withBrowser({ fetch: (url, init = {}) => {
      if (init.method === "PATCH" && fail) return Response.json({ message: "forbidden" }, { status: 403 });
      if (init.method === "PATCH" && deny) return Response.json([]);
      return fake.fetch(url, init);
    } }, async createStore => {
      const store = createStore(fake.base, {
        tables: ["note"], carriers: FIXTURE_CARRIERS,
        schema: { note: { durability: "server", fields: [{ name: "id", type: "string" }, { name: "title", type: "string" }] } },
      });
      const stop = store.subscribe("note", () => {}, { filter: "id=eq.n1" });
      try {
        await store.query("note", null, { filter: "id=eq.n1" });
        await store.patch("note", [{ key: "n1", ifTxid: "9007199254740993", changes: { title: "won" } }]);
        const first = fake.requests.find(r => r.method === "PATCH");
        assert(first.url.searchParams.get("txid") === "eq.9007199254740993", "the condition keeps all int64 digits");
        await store.patch("note", [{ key: "n1", ifTxid: "9007199254740993", changes: { title: "stale" } }]);
        assert(fake.writes === 1 && fake.rows[0].title === "won", "stale intent makes no write");
        assert((await store.query("note", null, { filter: "id=eq.n1" }))[0].title === "won", "stale settlement invalidates the cached read");
        deny = true;
        fake.rows[0].txid = 2;
        let error = await store.patch("note", [{ key: "n1", ifTxid: "2", changes: { title: "denied" } }]).then(() => null, e => e);
        assert(error?.name === "NonRetriableError", "a matching revision denied by policy remains a refusal");
        fail = true;
        error = await store.patch("note", [{ key: "n1", ifTxid: "1", changes: { title: "denied" } }]).then(() => null, e => e);
        assert(error !== null, "HTTP errors remain errors even for stale intent");
        for (const ifTxid of [42, "0", "1&status=eq.idle", "9223372036854775808"]) {
          error = await store.patch("note", [{ key: "n1", ifTxid, changes: { title: "invalid" } }]).then(() => null, e => e);
          assert(/ifTxid must be a positive int64/.test(error?.message), "invalid preconditions fail before HTTP");
        }
      } finally {
        stop();
        await globalThis.__mechaClient.collections.note.cleanup();
      }
    });
  },
});
