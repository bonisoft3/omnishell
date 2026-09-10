import { batched } from "./batched-store.js";
// Deno smoke: the terminal-tier hatch — a vendored unit in a sandboxed
// iframe, props in and named events out. The frame is driven through a stub
// contentWindow: linkedom has no
// browsing context, and the bridge reads contentWindow per message precisely
// so a navigated (or stubbed) frame is the one that gets answered.
import { parseHTML } from "npm:linkedom@0.18.4";

const UNIT = { isolation: "iframe", capabilities: [], src: "shell/units/embed.html", note: "oEmbed host" };

const SCREEN_HTML = `<section class="screen" data-screen="article">
  <article data-live="article" data-order="created_at.desc" data-on-answer="shadow">
    <h1 data-text="{title}"></h1>
    <div class="embed" data-hatch="embed" data-on-answer="record"
         data-prop-url="{embed_url}" data-prop-theme="light"></div>
  </article>
</section>`;

// Jessie handlers, frozen mechanism: last expression is the reduce function.
// `record` is the one the mount names; `shadow` sits on the enclosing region
// and exists to be a witness that a unit's answer never reaches it.
const RECORD_SOURCE = `const reduce = (state, event) => ({
  updates: [{ op: "patch", id: "a1", row: { chose: event.detail.uci } }],
});
reduce;`;
const SHADOW_SOURCE = `const reduce = () => ({ updates: [{ op: "patch", id: "a1", row: { chose: "the ancestor" } }] });
reduce;`;

const ROUTE = {
  screen: "article",
  files: {
    html: "shell/screens/article.html",
    css: "shell/screens/article.css",
    handlers: ["shell/handlers/record.js", "shell/handlers/shadow.js"],
  },
  states: ["loading", "empty", "populated"],
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function dom() {
  const { document } = parseHTML("<!doctype html><html><body><div id=out></div></body></html>");
  globalThis.document = document;
  return { document, target: document.getElementById("out") };
}

// A stand-in for the frame's window: records what the terminal posts into it.
function stubWindow(frame) {
  const posts = [];
  frame.contentWindow = { postMessage: (data, targetOrigin) => posts.push({ data, targetOrigin }) };
  return { posts, source: frame.contentWindow };
}

// Deno's MessageEvent constructor drops a source that is not a real Window, so
// the identity the bridge checks would always be null. A plain Event carrying
// the same fields is the only vehicle that preserves it.
function post(source, data, origin = "null") {
  const e = new Event("message");
  Object.assign(e, { data, origin, source });
  globalThis.dispatchEvent(e);
}

Deno.test("the frame is sandboxed, and never with allow-same-origin", async () => {
  const { mountHatch } = await import("./hatch.js");
  const { target } = dom();
  const hatch = mountHatch(target, { unit: UNIT, src: "https://app.example/shell/units/embed.html" });

  const frame = target.querySelector("iframe");
  assert(frame !== null, "an iframe was mounted");
  const tokens = frame.getAttribute("sandbox").split(" ");
  // Each token costs something and is justified where SANDBOX is declared;
  // this is the assertion that a future edit has to argue with.
  assert(
    JSON.stringify(tokens) ===
      JSON.stringify(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"]),
    `exact sandbox token set, got ${tokens}`,
  );
  // The one that would make the whole boundary theatre: with it the frame
  // shares this origin and can read our storage and reach through parent.
  assert(!tokens.includes("allow-same-origin"), "allow-same-origin is never granted");
  assert(!tokens.some((t) => t.startsWith("allow-top-navigation")), "the embed cannot take the page");
  assert(frame.getAttribute("referrerpolicy") === "no-referrer", "the article URL does not leak");
  assert(frame.getAttribute("loading") === "lazy", "embeds do not load before they are reached");
  hatch.destroy();
});

Deno.test("a height event from the frame resizes it", async () => {
  const { mountHatch } = await import("./hatch.js");
  const { target } = dom();
  const hatch = mountHatch(target, { unit: UNIT, src: "https://app.example/u.html" });
  const frame = target.querySelector("iframe");
  const { source } = stubWindow(frame);

  post(source, { type: "pronto:event", name: "height", height: 420 });
  assert(frame.style.height === "420px", `height performed by the shell, got ${frame.style.height}`);

  // A unit that lies must not be able to blow out the document.
  post(source, { type: "pronto:event", name: "height", height: 9e9 });
  assert(frame.style.height === "10000px", `height clamped, got ${frame.style.height}`);
  hatch.destroy();
});

Deno.test("messages from anywhere else, or of any other shape, are ignored", async () => {
  const { mountHatch } = await import("./hatch.js");
  const { target } = dom();
  const events = [];
  const hatch = mountHatch(target, {
    unit: UNIT,
    src: "https://app.example/u.html",
    onEvent: (e) => events.push(e),
  });
  const frame = target.querySelector("iframe");
  const { source } = stubWindow(frame);
  // linkedom reports an unset inline style as undefined, a browser as "".
  const height = () => frame.style.height ?? "";

  // Another sandboxed frame on the same page also posts with origin "null",
  // so origin can never identify a sender on its own — source identity is
  // what makes this frame the only one that can drive this bridge.
  const impostor = { postMessage: () => {} };
  post(impostor, { type: "pronto:event", name: "height", height: 800 });
  assert(height() === "", `a different window is ignored, got ${height()}`);

  // A same-origin script can post to the page freely; a message claiming a
  // real origin did not come from an opaque-origin frame.
  post(source, { type: "pronto:event", name: "height", height: 800 }, "https://evil.example");
  assert(height() === "", `an unexpected origin is ignored, got ${height()}`);
  post(source, { type: "pronto:event", name: "height", height: 800 }, "https://app.example");
  assert(height() === "", "even our own origin is not the frame's origin");

  for (const shape of [
    null,
    "height:800",
    42,
    { type: "pronto:event" },
    { type: "pronto:event", name: "" },
    { type: "pronto:event", name: 7 },
    { type: "other", name: "height", height: 800 },
    { type: "pronto:event", name: "height", height: "800" },
    { type: "pronto:event", name: "height", height: NaN },
    { type: "pronto:event", name: "height", height: -5 },
  ]) {
    post(source, shape);
    assert(height() === "", `unexpected shape ignored: ${JSON.stringify(shape)}`);
  }
  assert(events.length === 0, `nothing reached onEvent, got ${JSON.stringify(events)}`);

  // The channel is real: a named event the terminal cannot perform is handed
  // on rather than dropped — carrying the detail the boundary rebuilt, since
  // an event with nothing sayable in it is one of the shapes above.
  post(source, { type: "pronto:event", name: "select", detail: { id: "a1" } });
  assert(events.length === 1 && events[0].name === "select", `named event forwarded, got ${events.length}`);
  assert(events[0].detail.id === "a1", `the parsed detail travels, got ${JSON.stringify(events[0].detail)}`);
  hatch.destroy();
});

Deno.test("props wait for ready, coalesce, and re-deliver idempotently", async () => {
  const { mountHatch } = await import("./hatch.js");
  const { target } = dom();
  const hatch = mountHatch(target, { unit: UNIT, src: "https://app.example/u.html" });
  const frame = target.querySelector("iframe");
  const { posts, source } = stubWindow(frame);

  // Props are a current-value feed, not a log: everything sent before the unit
  // is listening collapses to the value it would have read anyway.
  hatch.update({ url: "https://x.example/1" });
  hatch.update({ url: "https://x.example/2" });
  hatch.update({ url: "https://x.example/3" });
  assert(posts.length === 0, `nothing posted before ready, got ${posts.length}`);

  post(source, { type: "pronto:ready" });
  assert(posts.length === 1, `one delivery on ready, got ${posts.length}`);
  assert(posts[0].data.type === "pronto:props", "delivery is a props message");
  assert(posts[0].data.props.url === "https://x.example/3", "the latest value, not the first");
  // An opaque origin cannot be named, so "*" is the only reachable target —
  // which is exactly why a hatch is never fed anything secret.
  assert(posts[0].targetOrigin === "*", `opaque origin can only be targeted with *`);

  hatch.update({ url: "https://x.example/3" });
  hatch.update({ url: "https://x.example/3" });
  const seen = posts.map((p) => JSON.stringify(p.data.props));
  assert(new Set(seen).size === 1, `re-delivery changes nothing the unit sees, got ${seen}`);
  hatch.destroy();
});

Deno.test("a unit the terminal cannot honour fails loudly", async () => {
  const { mountHatch } = await import("./hatch.js");
  const refuses = (unit, src, why) => {
    const { target } = dom();
    try {
      mountHatch(target, { unit, src });
    } catch {
      return;
    }
    throw new Error(`smoke failed: mounted anyway — ${why}`);
  };
  // The schema offers three isolation boundaries; the terminal implements two.
  // Quietly substituting a different boundary is the failure worth refusing.
  refuses({ ...UNIT, isolation: "compartment" }, "https://a.example/u.html", "compartment isolation");
  // An opaque-origin frame is granted nothing, so answering a capability
  // request with silence would hand the app a unit that cannot do its job.
  refuses({ ...UNIT, capabilities: ["sensors.camera"] }, "https://a.example/u.html", "camera capability");
  refuses(UNIT, "javascript:alert(1)", "javascript: src");
});

Deno.test({
  name: "a screen mounts its hatch once, feeds it the row, and refuses an unknown unit",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { document } = parseHTML("<!doctype html><html><body><div id=shell></div></body></html>");
    globalThis.document = document;
    const state = { rows: [{ id: "a1", title: "Post", embed_url: "https://x.example/1" }], notify: null };
    const updates = [];
    const store = batched({
      query: async () => state.rows,
      subscribe: (_t, fn) => {
        state.notify = fn;
        return () => {};
      },
      create: async () => {},
      update: async (table, id, patch) => updates.push({ table, id, patch }),
      remove: async () => {},
    });
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
      if (u.endsWith(".css")) return Promise.resolve(new Response(""));
      if (u.endsWith("record.js")) return Promise.resolve(new Response(RECORD_SOURCE));
      if (u.endsWith("shadow.js")) return Promise.resolve(new Response(SHADOW_SOURCE));
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    };

    // The real ses pin, pre-imported so ensureSes finds Compartment already
    // installed: linkedom does not execute the <script> the browser path adds.
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    const base = "https://app.example/";
    await interpretScreen(mount, base, ROUTE, store, {}, { units: { embed: UNIT } });

    const host = mount.querySelector(".embed");
    assert(host.querySelectorAll("iframe").length === 1, "one frame mounted");
    const frame = host.querySelector("iframe");
    assert(
      frame.getAttribute("src") === "https://app.example/shell/units/embed.html",
      `unit src resolved against appBase, got ${frame.getAttribute("src")}`,
    );
    const { posts, source } = stubWindow(frame);
    post(source, { type: "pronto:ready" });
    // data-prop-* rides the attribute binder, so the row reaches the unit
    // without the dispatcher knowing what an embed is.
    assert(posts[0].data.props.url === "https://x.example/1", `row-bound prop, got ${posts[0].data.props.url}`);
    assert(posts[0].data.props.theme === "light", "literal prop delivered too");

    // Re-binding is the normal case, not the exception: a region re-binds on
    // every refresh, and a second frame each time would stack embeds forever.
    state.rows = [{ id: "a1", title: "Post", embed_url: "https://x.example/2" }];
    await state.notify();
    assert(host.querySelectorAll("iframe").length === 1, "still one frame after a refresh");
    assert(host.querySelector("iframe") === frame, "the frame itself survived, so the embed did not reload");
    assert(posts.at(-1).data.props.url === "https://x.example/2", "the new row reached the unit");

    // The return path: a named event becomes a DOM event on the mount, and the
    // ordinary data-on-* wiring carries it into the reduce with the region's
    // world — the terminal never looks a handler up itself.
    post(source, { type: "pronto:event", name: "answer", detail: { uci: "e2e4" } });
    await tick();
    assert(
      JSON.stringify(updates) === JSON.stringify([{ table: "article", id: "a1", patch: { chose: "e2e4" } }]),
      `the answer reached data-on-answer and nothing else, got ${JSON.stringify(updates)}`,
    );

    // A screen naming a unit no app declared is a wiring mistake, and one that
    // would otherwise show as an empty box nobody notices.
    const bare = parseHTML("<!doctype html><html><body><div id=shell></div></body></html>");
    globalThis.document = bare.document;
    let threw = null;
    await interpretScreen(bare.document.getElementById("shell"), base, ROUTE, store, {}, { units: {} })
      .catch((e) => (threw = e));
    assert(threw !== null, "an undeclared unit is refused");
    assert(String(threw.message).includes('data-hatch="embed"'), `the error names the unit, got ${threw?.message}`);
  },
});
