// Storybook: renders a route's screen once per storyboard state, against a
// deterministic fixture store — no cluster, no PGlite. The frames are the
// review surface the ir.html storyboard sketches promise, and the future
// hook for pixel-level verify.
//
// Fixture synthesis is heuristic v0 (documented interim until fixtures are
// derived from the program's test pairs): Proxy rows answer any field —
// including dotted paths, which the interpreter's lookup probes as whole
// keys against the total `has` — synthesizing from the leaf segment.

import { interpretScreen } from "./screen.js";

function fixture(field, i, state) {
  const leaf = field.split(".").pop();
  // A field named like the frame's state answers true, so state frames whose
  // standout treatment rides attribute reflection (data-due="{due}" under the
  // "due" frame) render it instead of a pixel-copy of populated. -dark twins
  // are the same frame under dark tokens, so they match on the base name.
  if (leaf === state.replace(/-dark$/, "")) return true;
  if (leaf === "id") return `fixture-${i}`;
  if (/count/.test(leaf)) return (leaf.length % 5) + 1;
  if (/^(done|is_|has_)/.test(leaf)) return i % 2 === 1;
  return `Sample ${leaf} ${i + 1}`;
}

const row = (i, state) =>
  new Proxy({}, {
    get: (_, f) => (typeof f === "string" ? fixture(f, i, state) : undefined),
    has: () => true,
  });

function fixtureStore(state) {
  const empty = state === "empty" || state === "loading";
  const reject = () => {
    throw new Error("storybook is read-only");
  };
  return {
    // Same signature as the cluster store; filter/select opts are ignored —
    // fixtures answer any shape.
    query: async (_table, _order, opts) =>
      opts?.singleton ? [row(0, state)] : empty ? [] : [0, 1, 2].map((i) => row(i, state)),
    subscribe: () => () => {},
    create: reject,
    update: reject,
    remove: reject,
    removeWhere: reject,
  };
}

export async function renderStorybook(mount, appBase, route, params = {}, units = {}) {
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

  for (const state of route.states) {
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

    // handlers: false — fixture tier loads no ses and evaluates no handlers;
    // drag is inert in the frames. fixtures: true keeps media inert too:
    // fixture rows interpolated into img src would otherwise fire real
    // requests ("Sample object_key 1" against imgproxy, each a 404).
    await interpretScreen(frame, appBase, route, fixtureStore(state), params, {
      handlers: false,
      fixtures: true,
      // Every data-hatch resolves before a region hydrates, ahead of the inert
      // check, so a screen declaring a unit needs the table here even though
      // `fixtures: true` means none is mounted.
      units,
    });
    // data-state alone cannot say "posed": the live states (loading, empty,
    // populated, …) are drawn here under the same names the interpreter sets on
    // a running screen. A frame-only rule — one that poses an arm the probes
    // would otherwise decide — has to carry this too, or it reaches the app.
    frame.firstElementChild.dataset.storybook = "";
    frame.firstElementChild.dataset.state = state;
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
