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
  for (const tag of ["script", "style", "iframe", "object", "embed", "form", "input", "link", "meta"]) {
    await refuses([{ tag }], `<${tag}> is not a prose element`);
  }
});

Deno.test("chart SVG builds in its namespace while the SVG surface stays narrow", async () => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  buildNodes([{
    tag: "svg", attrs: { viewBox: "0 0 100 60", role: "group", "aria-label": "Ratings" },
    children: [
      { tag: "title", children: ["Ratings"] },
      { tag: "line", attrs: { x1: 0, y1: 50, x2: 100, y2: 50, class: "team-chart__axis" } },
      { tag: "a", attrs: { href: "/jogo/123", tabindex: 0, "aria-label": "Match 1, rating 7" },
        children: [{ tag: "circle", attrs: { cx: 40, cy: 20, r: 4, title: "7" } }] },
      { tag: "text", attrs: { x: 2, y: 58, "text-anchor": "start" }, children: ["2026"] },
    ],
  }], target);
  const svg = target.querySelector("svg");
  assert(svg.namespaceURI === "http://www.w3.org/2000/svg", "svg root uses the SVG namespace");
  assert(svg.querySelector("line").namespaceURI === svg.namespaceURI, "SVG children use the SVG namespace recursively");
  assert(svg.querySelector("a").getAttribute("href") === "/jogo/123", "a local SVG point link survives");
  assert(svg.querySelector("a").getAttribute("tabindex") === "0", "SVG point link is keyboardable");

  for (const tag of ["script", "foreignObject", "image", "use", "animate"]) {
    await refuses([{ tag: "svg", children: [{ tag }] }], `<${tag}> is outside the chart SVG vocabulary`);
  }
  await refuses([{ tag: "svg", attrs: { onclick: "alert(1)" } }], "SVG event attributes are script");
  await refuses([{ tag: "svg", attrs: { style: "background:url(https://e.example)" } }], "SVG inline styles are refused");
  await refuses([{ tag: "svg", attrs: { fill: "url(https://e.example/p.svg#paint)" } }], "SVG paint references are not a fetch surface");
  await refuses([{ tag: "svg", attrs: { "data-live": "forged" } }], "SVG cannot forge terminal bindings");

  const { target: hostileTarget } = dom();
  buildNodes([{ tag: "svg", children: [{ tag: "a", attrs: { href: "javascript:alert(1)" }, children: ["match"] }] }], hostileTarget);
  assert(hostileTarget.querySelector("svg a").getAttribute("href") === null, "SVG links use the URL-scheme check");
  assert(hostileTarget.querySelector("svg a").textContent === "match", "unsafe SVG URLs do not erase point labels");
});

Deno.test("chart fill is literal six-digit hex paint on paths and rects only", async () => {
  const { buildNodes } = await import("./render.js");
  const { target } = dom();
  buildNodes([{ tag: "svg", children: [
    { tag: "rect", attrs: { x: 0, y: 0, width: 4, height: 4, fill: "#8a2be2" } },
    { tag: "path", attrs: { d: "M0,0 L4,4", fill: "#8A2BE2" } },
  ] }], target);
  assert(target.querySelector("rect").getAttribute("fill") === "#8a2be2", "a lowercase hex fill is kept");
  assert(target.querySelector("path").getAttribute("fill") === "#8A2BE2", "an uppercase hex fill is kept");
  for (const fill of ["url(#x)", "url(https://e.example/p.svg#paint)", "red", "#abc", "", "#8a2be2 ", "currentColor"]) {
    await refuses([{ tag: "svg", children: [{ tag: "rect", attrs: { fill } }] }], `fill ${JSON.stringify(fill)} is not hex paint`);
    await refuses([{ tag: "svg", children: [{ tag: "path", attrs: { fill } }] }], `fill ${JSON.stringify(fill)} is not hex paint`);
  }
  await refuses([{ tag: "svg", children: [{ tag: "circle", attrs: { fill: "#8a2be2" } }] }], "fill is a path and rect attribute");
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

Deno.test("CSV data URLs require an HTML download anchor and never widen navigable schemes", async () => {
  const { buildNodes, safeUrl } = await import("./render.js");
  const href = "data:text/csv;charset=utf-8,%EF%BB%BFName%2CGoals%0D%0APlayer%2C2%0D%0A";
  const { target } = dom();
  buildNodes([{ tag: "a", attrs: { href, download: "players.csv" }, children: ["Export"] }], target);
  assert(target.querySelector("a").getAttribute("href") === href, "a typed CSV download retains its data URL");
  assert(target.querySelector("a").getAttribute("download") === "players.csv", "the filename remains attached");
  assert(safeUrl(href) === null, "CSV is still refused by the general navigation policy");
  for (const attrs of [{ href }, { href, download: undefined }, { href, download: null },
    { href: "data:text/html;charset=utf-8,%3Cscript%3Ealert(1)%3C%2Fscript%3E", download: "players.csv" },
    { href: "data:text/csv;charset=utf-8;base64,YQ==", download: "players.csv" },
    { href: "data:text/csv;charset=utf-8,%ZZ", download: "players.csv" },
    { href: "data:text/csv;charset=utf-8,raw\ncontrol", download: "players.csv" },
    { href: "java\nscript:alert(1)", download: "players.csv" }]) {
    const { target } = dom();
    buildNodes([{ tag: "a", attrs }], target);
    assert(target.querySelector("a").getAttribute("href") === null, `download does not admit ${JSON.stringify(attrs)}`);
  }
  const image = dom().target;
  buildNodes([{ tag: "img", attrs: { src: href, alt: "csv" } }], image);
  assert(image.querySelector("img").getAttribute("src") === null, "CSV data cannot reach image URLs");
  await refuses([{ tag: "svg", children: [{ tag: "a", attrs: { href, download: "players.csv" } }] }], "SVG download attributes");
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
