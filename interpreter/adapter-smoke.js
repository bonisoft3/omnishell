// Deno smoke: which module a control's value crosses, and where none does.
// `data-value-adapter` names a Jessie module with format and parse
// (REFERENCE.md#adapters); this covers the bind
// seat and what happens where no module is evaluated. The parse seat rides a
// form submit, whose validity and requestSubmit plumbing is the harness's:
// apps/thenote/tests/notes.test.ts drives the round trip through it.
//
// Three cases answer differently on purpose: a screen with its modules loaded
// converts, the fixture host adapter — which evaluates no module — binds the
// column's text, and a screen naming a module its route does not carry fails,
// because that is a broken declaration rather than a host that evaluates none.
import { parseHTML } from "npm:linkedom@0.18.4";
import { batched } from "./batched-store.js";

const SCREEN_HTML = `<section class="screen" data-screen="edit">
  <div data-live="note" data-filter="id=eq.n1">
    <form data-form="save" data-entity="note" data-action="update">
      <input type="hidden" name="id" data-value="{id}">
      <input type="datetime-local" step="1" name="at" data-value="{at}" data-value-adapter="shout">
      <button type="submit">Save</button>
    </form>
  </div>
</section>`;

// An adapter is a map of pure functions; this one only has to be visible in
// both directions, so it marks what it touched.
const SHOUT = `const format = (value, params) => value === "" ? "" : value + "!" + params.zone;
const parse = (text, params) => "parsed:" + text + ":" + params.zone;
({ format, parse });`;

const ROUTE = {
  screen: "edit",
  files: {
    html: "shell/screens/edit.html",
    css: "shell/screens/edit.css",
    handlers: [],
    adapters: ["shell/handlers/shout.js"],
  },
  states: ["loading", "populated"],
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

function boot(rows, { adapterOnDisk = true, html = SCREEN_HTML } = {}) {
  const { document } = parseHTML("<!doctype html><html><body><div id=shell></div></body></html>");
  globalThis.document = document;
  const store = batched({
    query: async () => rows,
    subscribe: () => () => {},
    create: async () => {},
    update: async () => {},
    put: async () => {},
    remove: async () => {},
  });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(html));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    if (u.endsWith("shout.js")) {
      return adapterOnDisk
        ? Promise.resolve(new Response(SHOUT))
        : Promise.resolve(new Response("not found", { status: 404 }));
    }
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };
  return { document, store };
}

async function render(rows, opts = {}, bootOpts = {}) {
  const { document, store } = boot(rows, bootOpts);
  const { interpretScreen } = await import("./screen.js");
  const mount = document.getElementById("shell");
  await interpretScreen(mount, "http://localhost:8090/shell/", ROUTE, store, {}, {
    timeZone: "Asia/Tokyo",
    ...opts,
  });
  return { mount };
}

const ROWS = [{ id: "n1", at: "2026-09-22T13:38:10.000000Z" }];

// The same control, per row, inside an item template — markup that is not in
// the screen's own tree.
const TEMPLATE_HTML = `<section class="screen" data-screen="edit">
  <ul data-live="note">
    <template data-item>
      <li><input type="datetime-local" step="1" name="at" data-value="{at}" data-value-adapter="shout"></li>
    </template>
  </ul>
</section>`;

Deno.test({
  name: "a control naming an adapter is filled through it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = await render(ROWS);
    const control = mount.querySelector("input[name=at]");
    assert(
      control.value === "2026-09-22T13:38:10.000000Z!Asia/Tokyo",
      `format fills the control with the screen's zone, got ${control.value}`,
    );

  },
});

Deno.test({
  name: "a control in an item template reaches the same adapter",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { mount } = await render(ROWS, {}, { html: TEMPLATE_HTML });
    const control = mount.querySelector("input[name=at]");
    assert(
      control.value === "2026-09-22T13:38:10.000000Z!Asia/Tokyo",
      `a per-row control is filled through the adapter, got ${control === null ? "no control" : control.value}`,
    );
  },
});

Deno.test({
  name: "the fixture tier evaluates no module, so the control binds the column's text",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // handlers: false is the storybook's host — no SES, no module, and every
    // frame still renders. A control that refused to bind here would take the
    // screen down with it.
    const { mount } = await render(ROWS, { handlers: false });
    const control = mount.querySelector("input[name=at]");
    // A real datetime-local rejects a value it cannot parse and renders empty,
    // so a storybook frame shows a blank control where the app shows a time.
    // The frame renders, which is what the storybook is for.
    assert(control.value === "2026-09-22T13:38:10.000000Z", `the column's text, got ${control.value}`);
  },
});

Deno.test({
  name: "a named adapter the route does not carry is a broken declaration",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let said = "";
    try {
      await render(ROWS, {}, { adapterOnDisk: false });
    } catch (err) {
      said = err.message;
    }
    assert(said.includes("shout.js"), `the screen says which module it could not load, got ${said}`);
  },
});
