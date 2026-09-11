// Deno smoke: the held clock as a replay seam. A reset puts table time and the
// seed's draw sequence back at their start, so two mounts in one process that
// take the same path write byte-identical rows — the key a form's create mints
// included. due() names what is queued, a metronome reading as periodic and an
// arrow that raises its way out reading as not; and a reset over a queue some
// screen still owns is refused.
import { batched } from "./batched-store.js";
import { parseHTML } from "npm:linkedom@0.18.4";

// The knobs screen.js reads once, at evaluation.
globalThis.location = new URL("http://screen.test/?clock=manual&seed=7");

const METRONOME = {
  field: "phase",
  initial: "on",
  states: { on: { after: { "50": { target: "on" } } } },
};

// Targets its own state, but the raise it carries moves the machine on.
const RELAY = {
  field: "phase",
  initial: "on",
  on: { finish: { target: "over" } },
  states: { on: { after: { "50": { target: "on", raise: "finish" } } }, over: {} },
};

const beatHtml = (machine, rest = "") =>
  `<section class="screen" data-screen="clock">
  <div id="beat" data-live="beat" data-filter="id=eq.the" data-text="{phase}"
       data-machine='${JSON.stringify(machine)}'></div>${rest}
</section>`;

const CAPTURE_HTML = beatHtml(
  METRONOME,
  `
  <ul class="notes" data-live="note">
    <template data-item><li data-text="{title}"></li></template>
  </ul>
  <form data-form="capture" data-entity="note" data-action="create">
    <input name="title" required />
    <button type="submit">Add</button>
  </form>`,
);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

const clock = () => globalThis.__prontoClock;

const macrotask = () => new Promise((r) => setTimeout(r, 0));

// Three calm turns with no region inside a pass, as the harness's quiet() asks.
async function quiet() {
  for (let turns = 0, calm = 0; calm < 3; turns++) {
    if (turns > 200) throw new Error("smoke failed: the screen never went quiet");
    await macrotask();
    calm = globalThis.__prontoBusy().regions === 0 ? calm + 1 : 0;
  }
}

// One mount of `html`, served as route `screen`, over fresh copies of `rows`.
async function mountScreen(screen, html, rows) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  );
  globalThis.document = document;
  const tables = structuredClone(rows);
  const subs = new Map();
  const wake = (table) => {
    for (const cb of subs.get(table) ?? []) setTimeout(cb, 0);
  };
  const store = batched({
    query: (table) => Promise.resolve(tables[table].map((r) => ({ ...r }))),
    subscribe: (table, cb) => {
      if (!subs.has(table)) subs.set(table, new Set());
      subs.get(table).add(cb);
      return () => subs.get(table).delete(cb);
    },
    create: (table, row) => {
      tables[table].push({ ...row });
      wake(table);
      return Promise.resolve();
    },
    put: (table, row) => {
      const i = tables[table].findIndex((r) => r.id === row.id);
      if (i < 0) tables[table].push({ ...row });
      else tables[table][i] = { ...tables[table][i], ...row };
      wake(table);
      return Promise.resolve();
    },
    update: (table, id, changes) => {
      const i = tables[table].findIndex((r) => r.id === id);
      tables[table][i] = { ...tables[table][i], ...changes };
      wake(table);
      return Promise.resolve();
    },
    remove: async () => {},
  });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.endsWith(".html")) return Promise.resolve(new Response(html));
    if (u.endsWith(".css")) return Promise.resolve(new Response(""));
    return Promise.reject(new Error(`unexpected fetch ${u}`));
  };

  const { interpretScreen } = await import("./screen.js");
  const mount = document.getElementById("shell");
  const route = {
    screen,
    files: { html: `shell/screens/${screen}.html`, css: `shell/screens/${screen}.css`, handlers: [] },
    states: ["loading", "empty", "populated"],
  };
  const handle = await interpretScreen(mount, `http://localhost:8080/${screen}/`, route, store, {});
  await quiet();
  return { handle, tables, mount, Event };
}

// The capture screen over fresh tables, then one path: submit the form.
async function mountAndCapture() {
  const { handle, tables, mount, Event } = await mountScreen("clock", CAPTURE_HTML, {
    beat: [{ id: "the", phase: "on" }],
    note: [],
  });
  const armed = clock().due();

  const form = mount.querySelector("form[data-form=capture]");
  form.querySelector("input[name=title]").value = "a";
  // linkedom implements neither constraint validation nor reset.
  form.checkValidity ??= () => true;
  form.reset ??= () => {};
  form.dispatchEvent(new Event("submit"));
  await quiet();
  return { handle, tables, armed, after: clock().due() };
}

// A stopped screen's waits stay queued until their time comes, and die on a
// stale mark when it does; advancing past the last is what empties the queue.
function drain(run) {
  run.handle.stop();
  const last = Math.max(...run.after.map((d) => d.in));
  const left = clock().advance(last);
  assert(left === 0, `a stopped screen left ${left} waits after ${last}ms`);
}

Deno.test({
  name: "a reset clock replays a path byte for byte and names what it holds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const first = await mountAndCapture();
    assert(
      JSON.stringify(first.armed) ===
        JSON.stringify([{
          in: 50,
          label: { kind: "after", key: "50", table: "beat", field: "phase", state: "on", periodic: true },
        }]),
      `a self-targeting after reads as periodic, got ${JSON.stringify(first.armed)}`,
    );
    assert(
      JSON.stringify(first.after.map((d) => [d.in, d.label.kind])) === JSON.stringify([[50, "after"], [600, "flash"]]),
      `due() lists the beat before the success flash, got ${JSON.stringify(first.after)}`,
    );
    assert(first.tables.note.length === 1, `one note captured, got ${first.tables.note.length}`);
    const minted = first.tables.note[0].id;
    assert(UUID_V4.test(minted), `a seeded create mints a v4 uuid, got ${minted}`);
    assert(clock().draws() === 4, `a minted key is four draws, counted ${clock().draws()}`);

    let refused;
    try {
      clock().reset();
    } catch (err) {
      refused = err.message;
    }
    assert(refused === "reset over 2 waits, 0 regions", `reset refuses a dirty queue, got ${refused}`);

    drain(first);
    clock().reset();
    assert(clock().draws() === 0, `reset zeroes the draw count, got ${clock().draws()}`);

    const second = await mountAndCapture();
    assert(
      JSON.stringify(second.tables) === JSON.stringify(first.tables),
      `the same seed and path replay the same rows: ${JSON.stringify(first.tables)} then ${
        JSON.stringify(second.tables)
      }`,
    );
    assert(clock().draws() === 4, `the replay drew as often, counted ${clock().draws()}`);
    drain(second);

    // The reset is what makes it a replay: without one the draw sequence
    // carries on from where the last mount left it.
    const third = await mountAndCapture();
    assert(third.tables.note[0].id !== minted, `an unreset mount minted the same key ${minted}`);
    drain(third);
    clock().reset();
  },
});

Deno.test({
  name: "an after arrow that raises is not periodic, and its tick ends the phase",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { handle, tables } = await mountScreen("relay", beatHtml(RELAY), {
      beat: [{ id: "the", phase: "on" }],
    });
    const armed = clock().due();
    assert(
      JSON.stringify(armed) ===
        JSON.stringify([{
          in: 50,
          label: { kind: "after", key: "50", table: "beat", field: "phase", state: "on", periodic: false },
        }]),
      `a self-targeting after that raises reads as not periodic, got ${JSON.stringify(armed)}`,
    );

    const left = clock().advance(50);
    await quiet();
    assert(left === 0, `the tick left ${left} waits`);
    assert(tables.beat[0].phase === "over", `the raise carried the machine out, got ${tables.beat[0].phase}`);
    assert(
      clock().due().length === 0,
      `nothing re-armed once the phase ended, got ${JSON.stringify(clock().due())}`,
    );
    handle.stop();
    clock().reset();
  },
});
