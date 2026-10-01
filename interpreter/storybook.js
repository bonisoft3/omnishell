// Storybook: renders a route's screen once per storyboard state, against a
// deterministic fixture store — no cluster, no PGlite. The frames are the
// review surface the ir.html storyboard sketches promise, and the future
// hook for pixel-level verify.
//
// Fixture synthesis is heuristic v0 (documented interim until fixtures are
// derived from the program's test pairs): Proxy rows answer any field —
// including dotted paths, which the interpreter's lookup probes as whole
// keys against the total `has` — synthesizing from the leaf segment.

import { screenEnv } from "./fragment.js";
import { interpretScreen } from "./screen.js";

function fixture(field, i, state, counted) {
  const leaf = field.split(".").pop();
  // A field named like the frame's state answers true, so state frames whose
  // standout treatment rides attribute reflection (data-due="{due}" under the
  // "due" frame) render it instead of a pixel-copy of populated. -dark twins
  // are the same frame under dark tokens, so they match on the base name.
  if (leaf === state.replace(/-dark$/, "")) return true;
  if (leaf === "id") return `fixture-${i}`;
  if (/count/.test(leaf)) return (leaf.length % 5) + 1;
  // A column a plural selector reads must answer a number; the synthesized
  // sentence below is what the interpreter refuses.
  if (counted.has(leaf)) return (leaf.length % 5) + 1;
  if (/^(done|is_|has_)/.test(leaf)) return i % 2 === 1;
  return `Sample ${leaf} ${i + 1}`;
}

const row = (i, state, counted) =>
  new Proxy({}, {
    get: (_, f) => (typeof f === "string" ? fixture(f, i, state, counted) : undefined),
    has: () => true,
  });

export function fixtureStore(state, counted = new Set()) {
  const empty = state === "empty" || state === "loading";
  const reject = () => {
    throw new Error("storybook is read-only");
  };
  return {
    // Same signature as the cluster store; filter/select opts are ignored —
    // fixtures answer any shape.
    //
    // The empty state is asked first, singleton or not: a region reading one
    // row is still reading none when there is none. What stands in its place
    // is the app's own data-empty-row — which is what a reader with no rows
    // sees, and the whole of what a prerendered document offers a crawler.
    query: async (_table, _order, opts) =>
      empty ? [] : opts?.singleton ? [row(0, state, counted)] : [0, 1, 2].map((i) => row(i, state, counted)),
    subscribe: () => () => {},
    create: reject,
    update: reject,
    remove: reject,
    removeWhere: reject,
  };
}

export async function renderStorybook(mount, appBase, route, params = {}, units = {}, opts = {}) {
  // Which columns a plural reads, so the fixture row answers them with
  // a count rather than the sentence it answers every other column with.
  const counted = new Set();
  const addCountedFromAst = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node.type === 6) counted.add(node.value.split(".").pop());
      if (node.options) {
        for (const opt of Object.values(node.options)) {
          if (opt?.value) addCountedFromAst(opt.value);
        }
      }
    }
  };
  if (opts.messages) {
    for (const cat of Object.values(opts.messages)) {
      if (!cat || typeof cat !== "object") continue;
      for (const val of Object.values(cat)) {
        if (Array.isArray(val)) addCountedFromAst(val);
        else if (typeof val === "string") {
          for (const m of val.matchAll(/\{([a-zA-Z0-9_]+),\s*plural,/g)) {
            counted.add(m[1].split(".").pop());
          }
        }
      }
    }
  }

  // A route's :params, answered the way its rows are. The frames render off a
  // fixture store precisely because the real ones do not exist here, and a
  // {param.x} binding is no more available than a column is — so a caller that
  // knows a value passes one, and every other param gets a fixture rather than
  // taking the screen down. Every locale's spelling is read, not just the
  // default's: nothing makes a translated pattern carry the same holes.
  const declared = new Set(
    [route.path, ...Object.values(route.paths ?? {})]
      .filter((p) => typeof p === "string")
      .flatMap((p) => [...p.matchAll(/:(\w+)/g)].map((m) => m[1])),
  );
  const addressed = { ...Object.fromEntries([...declared].map((n) => [n, `fixture-${n}`])), ...params };

  const style = document.createElement("style");
  style.textContent = `
    .storybook { display: flex; flex-wrap: wrap; gap: 24px; padding: 24px;
      font: 0.8125rem system-ui, sans-serif; }
    .storybook figure { margin: 0; scroll-margin: 24px; }
    .storybook figcaption { margin-bottom: 8px; color: #6C7278; }
    .storybook figcaption a { color: inherit; }
    .storybook .frame { width: 360px; border: 1px solid #d8d5cf; border-radius: 8px;
      overflow: hidden; }
    .storybook figure[data-targeted] figcaption { color: #0B7A5A; font-weight: 600; }
    .storybook figure[data-targeted] .frame { border-color: #0B7A5A;
      box-shadow: 0 0 0 3px rgba(11, 122, 90, 0.25); }
  `;
  document.head.append(style);

  const book = document.createElement("div");
  book.className = "storybook";
  document.title = `${route.screen} — storybook`;
  mount.replaceChildren(book);

  for (const state of route.states ?? ["populated"]) {
    const figure = document.createElement("figure");
    // Same identifier the ir gives its storyboard frame and the bijection
    // checker builds — the two surfaces address each other by it.
    figure.id = `${route.screen}-${state}`;
    const caption = document.createElement("figcaption");
    caption.textContent = `${state} `;
    // The shell is fetch-driven and never loads from file://, so unlike the
    // ir's return links this one has no degraded form to fall back to.
    const sketch = document.createElement("a");
    sketch.href = `../docs/ir.html#${figure.id}`;
    sketch.textContent = "sketch ↗";
    caption.append(sketch);
    const frame = document.createElement("div");
    frame.className = "frame";
    figure.append(caption, frame);
    book.append(figure);

    // handlers: false — the fixture adapter loads no ses and evaluates no handlers;
    // drag is inert in the frames. fixtures: true keeps media inert too:
    // fixture rows interpolated into img src would otherwise fire real
    // requests ("Sample object_key 1" against imgproxy, each a 404).
    // Every data-hatch resolves before a region hydrates, ahead of the inert
    // check, so a screen declaring a unit needs the table even though
    // `fixtures: true` means none is mounted.
    await interpretScreen(frame, appBase, route, fixtureStore(state, counted), addressed, screenEnv(opts, {
      handlers: false,
      fixtures: true,
      units,
      messages: opts.messages,
      locale: opts.locale,
      // A storybook frame is compared — by eye, by the visual gate, by a golden
      // — and it is rendered off a reader's machine. Left to the host, every
      // date-bearing frame would differ between a laptop and CI.
      timeZone: "UTC",
    }));
    // data-state alone cannot say "posed": the live states (loading, empty,
    // populated, …) are drawn here under the same names the interpreter sets on
    // a running screen. A frame-only rule — one that poses an arm the probes
    // would otherwise decide — has to carry this too, or it reaches the app.
    if (frame.firstElementChild) {
      frame.firstElementChild.dataset.storybook = "";
      frame.firstElementChild.dataset.state = state;
    }
  }

  // `?frame=` addresses one frame. The hash is spoken for by the route, so the
  // browser will not anchor-scroll and neither :target nor a fragment jump is
  // available — both have to be done by hand.
  const wanted = new URLSearchParams(location.search).get("frame");
  if (wanted) {
    const target = book.querySelector(`#${CSS.escape(wanted)}`);
    if (target) {
      target.dataset.targeted = "";
      target.scrollIntoView({ block: "center" });
    }
  }
}
