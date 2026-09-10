import { batched } from "./batched-store.js";
// Deno smoke: data-machine end to end — the XState-JSON data subset executed
// by the terminal through the same step() path as a Jessie reduce, against a
// linkedom screen and a fake store. The colour-cycling button is the whole
// idiom: markup alone, no handler module, no data-empty-row.
import { parseHTML } from "npm:linkedom@0.18.4";

const MACHINE =
  '{"field":"hue","initial":"warm","states":{"warm":{"on":{"click":"cool"}},"cool":{"on":{"click":"sun"}},"sun":{"on":{"click":"warm"}}}}';

const screenHtml = (machine, extra = "") => `<section class="screen" data-screen="demo">
  <button id="tint" data-live="tint" data-filter="id=eq.the" data-hue="{hue}"
          data-machine='${machine}'${extra}>Change colour</button>
</section>`;

const ROUTE = {
  screen: "demo",
  files: { html: "shell/screens/demo.html", css: "shell/screens/demo.css", handlers: [] },
  states: ["populated"],
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function boot(html, handlerSource) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;

  const rows = [];
  const calls = { puts: [], updates: [] };
  const subs = new Set();
  const store = batched({
    query: async () => rows,
    subscribe: (_table, cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    create: async () => {},
    update: async (table, id, patch) => calls.updates.push({ table, id, patch }),
    put: async (table, row) => {
      calls.puts.push({ table, row });
      const i = rows.findIndex((r) => r.id === row.id);
      if (i < 0) rows.push({ ...row });
      else rows[i] = { ...rows[i], ...row };
      for (const cb of subs) setTimeout(cb, 0);
    },
    remove: async () => {},
  });

  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(html));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    if (handlerSource !== undefined && u.endsWith("log.js")) {
      return Promise.resolve(new Response(handlerSource));
    }
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  return { document, Event, store, calls };
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

Deno.test({
  name: "the colour-cycling button runs from markup alone",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot(screenHtml(MACHINE));
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});

    const region = mount.querySelector("[data-live]");
    for (let i = 0; i < 3; i++) {
      region.dispatchEvent(new Event("click"));
      await tick(30);
    }
    assert(
      JSON.stringify(calls.puts) ===
        JSON.stringify([
          { table: "tint", row: { id: "the", hue: "cool" } },
          { table: "tint", row: { id: "the", hue: "sun" } },
          { table: "tint", row: { id: "the", hue: "warm" } },
        ]),
      `three clicks cycle the machine, got ${JSON.stringify(calls.puts)}`,
    );
    assert(region.getAttribute("data-hue") === "warm", "the binding tracked the row back to warm");
  },
});

Deno.test({
  name: "an event with no transition for the current state is a no-op",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const stuck =
      '{"field":"hue","initial":"warm","states":{"warm":{"on":{"click":"cool"}},"cool":{"on":{}},"sun":{"on":{}}}}';
    const { document, Event, store, calls } = boot(screenHtml(stuck));
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector("[data-live]");
    region.dispatchEvent(new Event("click"));
    await tick(30);
    region.dispatchEvent(new Event("click"));
    await tick(30);

    assert(calls.puts.length === 1, `cool has no click transition, got ${calls.puts.length} puts`);
    assert(mount.firstElementChild.dataset.state === "populated", "a no-op is not an error");
  },
});

Deno.test({
  name: "the fallback row is synthesized from the filter and the machine's initial",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot(screenHtml(MACHINE));
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector("[data-live]");
    assert(region.getAttribute("data-hue") === "warm", "initial state bound before any row exists");

    region.dispatchEvent(new Event("click"));
    await tick(30);
    assert(
      calls.puts[0]?.row.id === "the",
      `the first write's key comes from the filter's id=eq., got ${JSON.stringify(calls.puts)}`,
    );
  },
});

// The fallback row exists nowhere yet, so the first write must state every
// fact of it: a multi-eq slot's created row would otherwise fall outside its
// own filter, and the next refresh would re-bind the fallback at initial
// while writes land on an invisible row.
Deno.test({
  name: "the first write on a fallback row states every filter-pinned fact",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const html = screenHtml(MACHINE).replace(
      'data-filter="id=eq.the"',
      'data-filter="id=eq.m1&amp;game_id=eq.g1"',
    );
    const { document, Event, store, calls } = boot(html);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector("[data-live]");
    region.dispatchEvent(new Event("click"));
    await tick(30);
    region.dispatchEvent(new Event("click"));
    await tick(30);

    assert(
      JSON.stringify(calls.puts[0]) ===
        JSON.stringify({ table: "tint", row: { id: "m1", game_id: "g1", hue: "cool" } }),
      `the fallback's write carries the pinned equalities, got ${JSON.stringify(calls.puts[0])}`,
    );
    assert(
      JSON.stringify(calls.puts[1]) === JSON.stringify({ table: "tint", row: { id: "m1", hue: "sun" } }),
      `a stored row's write names only the key and the moved field, got ${JSON.stringify(calls.puts[1])}`,
    );
  },
});

Deno.test({
  name: "a rich empty row's first write states its whole row",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const html = screenHtml(MACHINE, ' data-empty-row=\'{"id":"the","hue":"warm","label":"lamp"}\'');
    const { document, Event, store, calls } = boot(html);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const region = mount.querySelector("[data-live]");
    region.dispatchEvent(new Event("click"));
    await tick(30);

    assert(
      JSON.stringify(calls.puts[0]) ===
        JSON.stringify({ table: "tint", row: { id: "the", hue: "cool", label: "lamp" } }),
      `the empty row's fields ride the first write, got ${JSON.stringify(calls.puts[0])}`,
    );
  },
});

Deno.test({
  name: "a machine region with no empty row and no pinned id refuses to hydrate",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const html = screenHtml(MACHINE).replace('data-filter="id=eq.the"', 'data-filter="status=eq.on"');
    const { document, store } = boot(html);
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    let refused = false;
    try {
      await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    } catch (err) {
      refused = String(err).includes("pins no id=eq.");
    }
    assert(refused, "hydration threw the precondition, not a quieter path that works until it doesn't");
  },
});

Deno.test({
  name: "a refused machine write reaches the region's mutation reduce as an event",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const html = screenHtml(MACHINE, ' data-on-mutation="log"').replace(
      "</section>",
      "</section>",
    );
    const { document, Event, store, calls } = boot(
      html,
      `const reduce = (state, event) => event.type === "refused"
  ? { updates: [{ op: "patch", id: "notice", row: { entity: event.entity, id: event.id, kind: event.kind, validation: event.validation } }] }
  : { updates: [] };
reduce;`,
    );
    store.put = async () => {
      const err = new Error("409 refused");
      err.name = "NonRetriableError";
      err.validation = "own-article";
      throw err;
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: ["shell/handlers/log.js"] } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    const region = mount.querySelector("[data-live]");
    region.dispatchEvent(new Event("click"));
    await tick(40);

    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{
          table: "tint",
          id: "notice",
          patch: { entity: "tint", id: "the", kind: "refused", validation: "own-article" },
        }]),
      `the refusal became the reduce's event, got ${JSON.stringify(calls.updates)}`,
    );
    assert(mount.firstElementChild.dataset.state === "populated", "the reduce owns the words; no state flip");
  },
});

Deno.test({
  name: "the server's refusal names its validation out of the client's own message",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot(
      screenHtml(MACHINE, ' data-on-mutation="log"'),
      `const reduce = (state, event) => event.type === "refused"
  ? { updates: [{ op: "patch", id: "notice", row: { kind: event.kind, validation: event.validation } }] }
  : { updates: [] };
reduce;`,
    );
    // A refusal raised by the trigger reaches the terminal as the mecha
    // client's own wording, with no `validation` property to read: the name
    // comes out of the message or nowhere.
    store.put = async () => {
      const err = new Error(
        'insert favorite failed: 400 {"code":"23514","details":null,"hint":null,"message":"validation favorite.own-article"}',
      );
      err.name = "NonRetriableError";
      throw err;
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: ["shell/handlers/log.js"] } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    mount.querySelector("[data-live]").dispatchEvent(new Event("click"));
    await tick(40);

    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{ table: "tint", id: "notice", patch: { kind: "refused", validation: "own-article" } }]),
      `the message named the validation, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

Deno.test({
  name: "a program error naming a validation is not a validation that said no",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { document, Event, store, calls } = boot(
      screenHtml(MACHINE, ' data-on-mutation="log"'),
      `const reduce = (state, event) => event.type === "refused"
  ? { updates: [{ op: "patch", id: "notice", row: { kind: event.kind, validation: event.validation } }] }
  : { updates: [] };
reduce;`,
    );
    // The seat's own program errors carry a validation's name in the same
    // words a server refusal does — a module that 404s, a predicate that
    // answers no boolean. Neither is a rule saying no. Delivered late, past
    // the acceptance window, because a fast failure never reaches the event at
    // all: applyUpdates rethrows anything that is not NonRetriableError.
    store.put = async (_table, _row, onRefused) => {
      setTimeout(
        () => onRefused(new Error("validation favorite.own-article: the predicate answered string")),
        0,
      );
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    const route = { ...ROUTE, files: { ...ROUTE.files, handlers: ["shell/handlers/log.js"] } };
    await interpretScreen(mount, "http://localhost:8080/keep/", route, store, {});
    mount.querySelector("[data-live]").dispatchEvent(new Event("click"));
    await tick(40);

    assert(
      JSON.stringify(calls.updates) ===
        JSON.stringify([{ table: "tint", id: "notice", patch: { kind: "failed" } }]),
      `a failure names no validation, got ${JSON.stringify(calls.updates)}`,
    );
  },
});

// A machine that draws the refused arrow is a mounted consumer of the event
// even when no mutation reduce shares the region — a form's refusal must
// transition it, not fall through to the .store-error default.
Deno.test({
  name: "a form's refused create transitions the region's machine without a mutation reduce",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const machine =
      '{"field":"hue","initial":"warm","states":{"warm":{"on":{"refused":"sun"}},"sun":{"on":{}}}}';
    const html = `<section class="screen" data-screen="demo">
  <div data-live="tint" data-filter="id=eq.the" data-hue="{hue}" data-machine='${machine}'>
    <form data-form="add" data-entity="tint" data-action="create">
      <input name="label" />
      <p class="store-error" hidden>refused</p>
      <button type="submit">Add</button>
    </form>
  </div>
</section>`;
    const { document, Event, store, calls } = boot(html);
    store.create = async () => {
      const err = new Error("409 refused");
      err.name = "NonRetriableError";
      throw err;
    };
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    const form = mount.querySelector("form");
    form.checkValidity ??= () => true;
    form.reset ??= () => {};
    form.dispatchEvent(new Event("submit"));
    await tick(40);

    assert(
      JSON.stringify(calls.puts) === JSON.stringify([{ table: "tint", row: { id: "the", hue: "sun" } }]),
      `the refusal drove warm→sun, got ${JSON.stringify(calls.puts)}`,
    );
    assert(
      form.querySelector(".store-error").hasAttribute("hidden"),
      "the machine owns the refusal; the default side channel stays untouched",
    );
    assert(
      mount.firstElementChild.dataset.state !== "validation-error",
      "the machine owns the refusal; no default state flip",
    );
  },
});

// The generation mark armed with a state dies with the region's
// subscriptions — a wait expiring on a torn-down region must not write into
// the live store.
Deno.test({
  name: "stop() before an after delay fires means no write lands",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const timed = '{"field":"hue","initial":"warm","states":{"warm":{"after":{"60":"cool"}},"cool":{"on":{}}}}';
    const { document, store, calls } = boot(screenHtml(timed));
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    const handle = await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    handle.stop();
    await tick(150);
    assert(calls.puts.length === 0, `no write after teardown, got ${JSON.stringify(calls.puts)}`);
  },
});

// The positive control for the teardown test above: the same delay on a
// screen left standing does fire, so the empty puts list there measures the
// teardown and not a timer that never armed.
Deno.test({
  name: "an after delay fires on a standing screen",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const timed = '{"field":"hue","initial":"warm","states":{"warm":{"after":{"60":"cool"}},"cool":{"on":{}}}}';
    const { document, store, calls } = boot(screenHtml(timed));
    const { interpretScreen } = await import("./screen.js");

    const mount = document.getElementById("shell");
    await interpretScreen(mount, "http://localhost:8080/keep/", ROUTE, store, {});
    await tick(150);
    assert(
      calls.puts.length === 1 && calls.puts[0].row.hue === "cool",
      `the armed wait moved warm→cool, got ${JSON.stringify(calls.puts)}`,
    );
  },
});
