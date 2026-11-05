import assert from "node:assert/strict";
import { parseHTML } from "npm:linkedom@0.18.4";

const transition = (name, persisted = false) => {
  const event = new Event(name);
  Object.defineProperty(event, "persisted", { value: persisted });
  globalThis.dispatchEvent(event);
};

async function fixture(run, nested = false, host = false) {
  await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
  const { interpretScreen } = await import("./screen.js");
  const { document } = parseHTML("<html><head></head><body><main id='mount'></main></body></html>");
  const previous = { document: globalThis.document, fetch: globalThis.fetch, error: console.error };
  globalThis.document = document;
  const subject = '<div id="subject" data-live="item" data-filter="id=eq.one" data-name="{name}"></div>';
  const content = nested ? `<div data-live="parent" data-filter="id=eq.one">${subject}</div>` : subject;
  globalThis.fetch = async (url) => new Response(String(url).endsWith(".css") ? "" : `<section data-screen="example">${content}</section>`);
  const errors = [];
  console.error = (...args) => errors.push(args);
  let subscriber, blocked, screen, nextError;
  const store = {
    query: async (table) => {
      if (table === "item" && blocked) return blocked();
      if (nextError) { const error = nextError; nextError = undefined; throw error; }
      return [{ id: "one", name: "ready" }];
    },
    subscribe: (_table, cb) => { subscriber = cb; return () => { subscriber = undefined; }; },
  };
  const server = host ? Deno.serve({ hostname: "localhost", port: 0, onListen() {} }, () => new Response('export default function mount(screen) { screen.setAttribute("data-host-mounted", "yes"); return () => screen.removeAttribute("data-host-mounted"); }', { headers: { "content-type": "application/javascript" } })) : undefined;
  const appBase = server ? `http://localhost:${server.addr.port}/` : "http://localhost/";
  const mount = () => interpretScreen(document.getElementById("mount"), appBase, { screen: "example", hatches: host ? ["lifecycle"] : [], files: { html: "example.html", css: "example.css", handlers: [] } }, store, {}, { hostDom: { lifecycle: { src: "shell/hatches/lifecycle.js", note: "Document lifecycle regression" } } });
  const defer = () => {
    let entered, reject, resolve;
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = new Promise((done, fail) => { resolve = done; reject = fail; });
    blocked = () => { entered(); return pending; };
    return { started, reject, resolve, release: () => { blocked = undefined; } };
  };
  try {
    await run({
      mount: async () => (screen = await mount()), defer, errors, failNext: (error) => { nextError = error; },
      wake: () => subscriber(), subscribed: () => Boolean(subscriber), document,
    });
  } finally {
    screen?.stop();
    await server?.shutdown();
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    console.error = previous.error;
  }
}

Deno.test("leaving the document owns an aborted read during initial screen hydration", () => fixture(async (f) => {
  const read = f.defer();
  const mounting = f.mount();
  await read.started;
  transition("pagehide");
  read.reject(new TypeError("Failed to fetch"));
  const screen = await mounting;
  await screen.settle();
  assert.equal(f.subscribed(), false);
  assert.deepEqual(f.errors, []);
}));

Deno.test("a history-restored document resumes reads without reporting its abandoned read", () => fixture(async (f) => {
  const screen = await f.mount();
  const read = f.defer();
  f.wake();
  await read.started;
  transition("pagehide", true);
  assert.equal(f.subscribed(), false);
  read.release();
  transition("pageshow", true);
  read.reject(new TypeError("Failed to fetch"));
  await screen.settle();
  assert.equal(f.subscribed(), true);
  assert.equal(f.document.getElementById("subject").getAttribute("data-name"), "ready");
  assert.deepEqual(f.errors, []);
}));

Deno.test("a failed read in the active document remains an observable error", () => fixture(async (f) => {
  const screen = await f.mount();
  const read = f.defer();
  f.wake();
  await read.started;
  const error = new TypeError("Failed to fetch");
  read.reject(error);
  await assert.rejects(screen.settle(), /Failed to fetch/);
  assert.equal(f.errors[0][0], error);
}));

Deno.test("a nested initial read succeeding across history restoration completes hydration", () => fixture(async (f) => {
  const read = f.defer();
  const mounting = f.mount();
  await read.started;
  transition("pagehide", true);
  read.release();
  transition("pageshow", true);
  read.resolve([{ id: "one", name: "ready" }]);
  const screen = await mounting;
  await screen.settle();
  assert.equal(f.document.getElementById("subject").getAttribute("data-name"), "ready");
  assert.deepEqual(f.errors, []);
}, true));

Deno.test("a screen first hydrated while suspended starts its host hatch on restoration", () => fixture(async (f) => {
  const read = f.defer();
  const mounting = f.mount();
  await read.started;
  transition("pagehide", true);
  read.release();
  read.resolve([{ id: "one", name: "ready" }]);
  const screen = await mounting;
  assert.equal(f.document.querySelector("[data-screen]").hasAttribute("data-host-mounted"), false);
  transition("pageshow", true);
  await screen.settle();
  assert.equal(f.document.querySelector("[data-screen]").getAttribute("data-host-mounted"), "yes");
  assert.deepEqual(f.errors, []);
}, false, true));

Deno.test("a fresh restored pass failure is not attributed to the successful departed pass", () => fixture(async (f) => {
  const read = f.defer();
  const mounting = f.mount();
  await read.started;
  transition("pagehide", true);
  read.release();
  const error = new TypeError("active restored read failed");
  f.failNext(error);
  transition("pageshow", true);
  read.resolve([{ id: "one", name: "ready" }]);
  const screen = await mounting;
  await assert.rejects(screen.settle(), /active restored read failed/);
  assert.equal(f.errors[0][0], error);
}));
