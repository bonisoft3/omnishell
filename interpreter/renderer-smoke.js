import { batched } from "./batched-store.js";
// Deno smoke: the platform half of the renderer role — the node schema, the
// tag and attribute allowlist, the URL-scheme check, the builder, and the
// reconciliation that keeps the DOM
// untouched while the description is unchanged. A renderer is a pure
// (value) => nodes function, so everything a renderer could get wrong is
// decided here and asserted here.
import { parseHTML } from "npm:linkedom@0.18.4";

const assert = (cond, msg) => {
  if (!cond) throw new Error(`smoke failed: ${msg}`);
};

function dom() {
  const { document } = parseHTML("<!doctype html><html><body><div id=out></div></body></html>");
  globalThis.document = document;
  return { document, target: document.getElementById("out") };
}

const refuses = async (nodes, why) => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  try {
    buildNodes(nodes, target);
  } catch {
    return;
  }
  throw new Error(`smoke failed: built it anyway — ${why}\n${target.innerHTML}`);
};

Deno.test("a string is always a text node, and there is no node kind for markup", async () => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  const hostile = `<script>alert(1)</script> <img src=x onerror=alert(1)>`;
  buildNodes([{ tag: "p", children: [hostile] }], target);

  // The schema has no way to say "this string is markup", so a renderer
  // cannot ask for it and a value cannot smuggle it. This is the same
  // guarantee plain data-text has always had, now extended to rendered output.
  assert(target.querySelector("script") === null, "no <script> element");
  assert(target.querySelector("img") === null, "no <img> element");
  assert(target.querySelector("p").textContent === hostile, "the characters survive as text");
});

Deno.test("the tag allowlist is the platform's, and a renderer cannot widen it", async () => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  buildNodes([{ tag: "p" }, { tag: "h2" }, { tag: "ul", children: [{ tag: "li" }] }], target);
  const kinds = [...target.children].map((el) => el.localName);
  assert(JSON.stringify(kinds) === JSON.stringify(["p", "h2", "ul"]), `prose tags build, got ${kinds}`);

  // Each of these is absent from TAGS for its own stated reason; a renderer
  // reaching for one is a bug in the renderer, so it is loud rather than
  // quietly dropped.
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "input", "link", "meta", "svg"]) {
    await refuses([{ tag }], `<${tag}> is not a prose element`);
  }
});

Deno.test("attributes outside the allowlist are refused, data-* especially", async () => {
  // data-* is the terminal's own binding vocabulary. A renderer that could
  // emit one could forge a live region, a text binding or a hatch mount out
  // of a reader's prose — the sharpest reason the allowlist is not per-app.
  await refuses([{ tag: "p", attrs: { "data-live": "note" } }], "data-live forges a region");
  await refuses([{ tag: "p", attrs: { "data-text": "{secret}" } }], "data-text forges a binding");
  await refuses([{ tag: "div", attrs: { "data-hatch": "embed" } }], "data-hatch forges a mount");
  await refuses([{ tag: "p", attrs: { onclick: "alert(1)" } }], "onclick is script");
  await refuses([{ tag: "img", attrs: { onerror: "alert(1)", src: "https://e.example/x.png" } }], "onerror is script");
  await refuses([{ tag: "p", attrs: { style: "background:url(https://e.example)" } }], "style exfiltrates");
  await refuses([{ tag: "p", attrs: { href: "https://e.example" } }], "href is not a <p> attribute");
  await refuses([{ tag: "img", attrs: { srcset: "https://e.example/x 2x" } }], "srcset is not allowlisted");

  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  buildNodes([{ tag: "a", attrs: { href: "https://e.example", class: "ref", title: "t" } }], target);
  const a = target.querySelector("a");
  assert(a.getAttribute("href") === "https://e.example", "allowlisted url attribute kept");
  assert(a.getAttribute("class") === "ref" && a.getAttribute("title") === "t", "global attributes kept");
});

Deno.test("a malformed node description is refused", async () => {
  for (const node of [null, 42, true, {}, { tag: 7 }, { children: ["x"] }, [["p"]]]) {
    await refuses([node], `${JSON.stringify(node)} is not a string or {tag}`);
  }
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  let threw = null;
  try {
    buildNodes({ tag: "p" }, target);
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, "a renderer must return an array, not one node");
});

Deno.test("the scheme check is enforced by the builder, not trusted to the renderer", async () => {
  const { buildNodes, safeUrl } = await import("./render.js");
  // A renderer that never consulted safeUrl still cannot emit a javascript:
  // link: the value is user data flowing through a legitimate attribute, so
  // the attribute is dropped rather than throwing — a reader's own content
  // must not be able to take the screen down.
  for (const href of ["javascript:alert(1)", "JavaScript:alert(1)", "java\u0000script:alert(1)", "data:text/html,x", "vbscript:x"]) {
    const { target } = dom();
    buildNodes([{ tag: "a", attrs: { href }, children: ["click"] }], target);
    const a = target.querySelector("a");
    assert(a !== null, `the element still renders for ${href}`);
    assert(a.getAttribute("href") === null, `no href survives for ${href}`);
    assert(a.textContent === "click", "its text still reaches the reader");
  }
  for (const src of ["javascript:alert(1)", "data:text/html,x"]) {
    const { target } = dom();
    buildNodes([{ tag: "img", attrs: { src, alt: "a" } }], target);
    assert(target.querySelector("img").getAttribute("src") === null, `no src survives for ${src}`);
  }

  const { target } = dom();
  buildNodes([{ tag: "a", attrs: { href: "https://e.example/a?b=1#c" } }, { tag: "a", attrs: { href: "/local" } }], target);
  const hrefs = [...target.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  assert(JSON.stringify(hrefs) === JSON.stringify(["https://e.example/a?b=1#c", "/local"]), `allowed urls kept, got ${hrefs}`);
  assert(safeUrl("mailto:a@b.example") === "mailto:a@b.example", "mailto passes");
  assert(safeUrl("javascript:alert(1)") === null, "javascript: refused");
});

Deno.test("a link opening a new context cannot leak its opener", async () => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  buildNodes([{ tag: "a", attrs: { href: "https://e.example", target: "_blank" } }], target);
  // The renderer never has to remember this, because it cannot: the builder
  // stamps it whenever a target is set.
  assert(target.querySelector("a").getAttribute("rel") === "noopener noreferrer", "rel stamped");
});

Deno.test("the DOM is untouched while the description is unchanged", async () => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  const nodes = () => [{ tag: "p", children: ["body ", { tag: "strong", children: ["one"] }] }];

  buildNodes(nodes(), target);
  const first = target.firstElementChild;
  buildNodes(nodes(), target);
  buildNodes(nodes(), target);
  // A region re-binds on every refresh. Rebuilding an article each time would
  // drop the reader's text selection whenever any unrelated column moved, so
  // an equal description must not reach the DOM at all — which is also what
  // makes re-rendering idempotent structurally rather than by each renderer's
  // good behaviour.
  assert(target.firstElementChild === first, "the same node survived an equal re-render");
  assert(target.childNodes.length === 1, "no second copy appended");

  buildNodes([{ tag: "p", children: ["body ", { tag: "strong", children: ["two"] }] }], target);
  assert(target.firstElementChild !== first, "a changed description does rebuild");
  assert(target.querySelector("strong").textContent === "two", "and renders the new value");
});

Deno.test({
  name: "an app declares the renderer it wants, and a screen resolves it like a handler",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // The app's renderer: a pure (value) => nodes module, evaluated in a SES
    // compartment with nothing endowed, exactly as a handler is. This is what
    // an app writes to get a rendering the terminal does not ship.
    const SHOUT = `(value) => [{tag: "p", attrs: {class: "shout"}, children: [String(value).toUpperCase()]}];`;
    const SCREEN_HTML = `<section class="screen" data-screen="article">
      <article data-live="article" data-order="created_at.desc">
        <div class="body" data-text="{body}" data-text-format="shout"></div>
      </article>
    </section>`;
    const route = {
      screen: "article",
      files: {
        html: "shell/screens/article.html",
        css: "shell/screens/article.css",
        handlers: [],
        renderers: ["shell/renderers/shout.js"],
      },
      states: ["loading", "empty", "populated"],
    };

    const { document } = parseHTML("<!doctype html><html><head></head><body><div id=shell></div></body></html>");
    globalThis.document = document;
    const store = batched({
      query: async () => [{ id: "a1", body: "hello" }],
      subscribe: () => () => {},
      create: async () => {},
      update: async () => {},
      remove: async () => {},
    });
    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.endsWith("shout.js")) return Promise.resolve(new Response(SHOUT));
      if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML));
      if (u.endsWith(".css")) return Promise.resolve(new Response(""));
      return Promise.reject(new Error(`unexpected fetch ${u}`));
    };

    // The real ses pin, pre-imported so the Compartment a renderer is
    // evaluated in is the same one production uses.
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const mount = document.getElementById("shell");
    await interpretScreen(mount, "https://app.example/", route, store, {});
    const body = mount.querySelector(".body");
    assert(body.querySelector("p.shout") !== null, `app renderer built its node\n${body.innerHTML}`);
    assert(body.textContent === "HELLO", `and saw the bound value, got ${body.textContent}`);

    // A format naming no module is a wiring mistake, and it fails at
    // hydration rather than showing an empty box on the first row.
    const bare = parseHTML("<!doctype html><html><head></head><body><div id=shell></div></body></html>");
    globalThis.document = bare.document;
    let threw = null;
    await interpretScreen(bare.document.getElementById("shell"), "https://app.example/", {
      ...route,
      files: { ...route.files, renderers: [] },
    }, store, {}).catch((e) => (threw = e));
    assert(threw !== null, "an undeclared renderer is refused");
    assert(
      String(threw.message).includes('data-text-format="shout"'),
      `the error names the format, got ${threw?.message}`,
    );
  },
});

Deno.test({
  name: "a renderer may not shadow a built-in format",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const SCREEN_HTML = `<section class="screen" data-screen="a"><p data-text="{b}"></p></section>`;
    const { document } = parseHTML("<!doctype html><html><head></head><body><div id=shell></div></body></html>");
    globalThis.document = document;
    globalThis.fetch = (url) =>
      String(url).endsWith(".html")
        ? Promise.resolve(new Response(SCREEN_HTML))
        : Promise.resolve(new Response(""));
    await import("https://cdn.jsdelivr.net/npm/ses@1.15.0/dist/ses.umd.min.js");
    const { interpretScreen } = await import("./screen.js");
    const store = { query: async () => [], subscribe: () => () => {} };

    // Silently losing to a built-in is the failure worth refusing: the screen
    // would keep rendering, just never with the module the app shipped.
    for (const name of ["datetime", "plain"]) {
      let threw = null;
      await interpretScreen(document.getElementById("shell"), "https://app.example/", {
        screen: "a",
        files: { html: "a.html", css: "a.css", handlers: [], renderers: [`shell/renderers/${name}.js`] },
        states: [],
      }, store, {}).catch((e) => (threw = e));
      assert(threw !== null && String(threw.message).includes("collides"), `${name} is refused, got ${threw?.message}`);
    }
  },
});
