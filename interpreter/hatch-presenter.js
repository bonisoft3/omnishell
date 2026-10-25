// The agent seat's presenter: a vendored unit on its own thread that paints on
// a canvas this seat transfers to it, and does nothing else.
//
// What contains it is the worker's realm (presenter.js, presenter-realm.js and
// the policy its script is sent with), not this seat. The seat's part is the
// port: it hands in the pinned scripts it fetched against their integrity,
// the canvas, the frames and the bytes the unit is declared to read, and it
// refuses every message but the protocol's. A presenter raises nothing (the
// schema refuses one that declares a raise), so anything else the worker
// posts is the app's bug, thrown where the shell banners it.
import { ProgramError } from "./fragment.js";
import { FRAME, INIT, PROPS, READ, READY, RESIZE } from "./presenter-realm.js";
import { scriptURL } from "./script-url.js";

// The objects a blob seed ships are named by their content.
const SEEDED = /^blobs\/mecha-objects\/[0-9a-f]{64}\.[a-z0-9]+$/;

/** Mounts `unit` into `root` behind a presenter's worker. `frame(value)` hands
 * it the next frame, structured-cloned; `ready` settles once its unit is up,
 * and rejects with the worker's own failure. */
export function mountPresenterUnit(root, { unit, src }) {
  if (unit.ports.raises.length) throw new ProgramError(`presenter "${src}" declares raises (${unit.ports.raises.join(", ")}): a presenter paints and raises nothing`);
  const canvas = document.createElement("canvas");
  canvas.className = "presenter-canvas";
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  root.prepend(canvas);
  const size = () => {
    const box = canvas.getBoundingClientRect();
    const dpr = globalThis.devicePixelRatio || 1;
    return { width: Math.max(1, Math.round(box.width * dpr)), height: Math.max(1, Math.round(box.height * dpr)), dpr };
  };
  const offscreen = canvas.transferControlToOffscreen();
  // The screen's layers: a `<canvas data-layer>` marks where something the
  // presenter draws sits in the screen's own markup — a gauge's digits inside
  // its panel — so the DOM keeps the panel and the worker paints what moves.
  // Each goes with its box and the text style CSS gave it.
  const scope = root.closest("[data-screen]") ?? root.ownerDocument;
  const layered = [...scope.querySelectorAll("canvas[data-layer]")];
  // `dpr` is device pixels per CSS pixel of the layer's own styles: a CSS
  // `zoom` above it shrinks its box but not the font its style reports.
  const measure = (el) => {
    const box = el.getBoundingClientRect();
    const device = globalThis.devicePixelRatio || 1;
    const css = getComputedStyle(el);
    return {
      width: Math.max(1, Math.round(box.width * device)),
      height: Math.max(1, Math.round(box.height * device)),
      dpr: device * (el.currentCSSZoom ?? 1),
      style: { font: css.font, color: css.color, textShadow: css.textShadow, letterSpacing: css.letterSpacing, textAlign: css.textAlign },
    };
  };
  const offscreens = layered.map((el) => {
    const name = el.dataset.layer;
    if (!name) throw new ProgramError(`presenter "${src}": a canvas[data-layer] names no layer`);
    return [name, el, el.transferControlToOffscreen()];
  });
  if (new Set(offscreens.map(([name]) => name)).size !== layered.length) {
    throw new ProgramError(`presenter "${src}": two canvases name one layer`);
  }
  const worker = new Worker(scriptURL(new URL("./presenter.js", import.meta.url).href), { type: "module" });

  const refuse = (what) => {
    throw new ProgramError(`presenter "${src}" ${what}`);
  };
  // The worker takes nothing before its unit is up: props and resizes wait for
  // it, as at the other seats, and a frame before it is superseded by the next.
  let ready = false;
  let latest = {};
  const resized = new Set();
  const sendResize = (target) => {
    if (target === canvas) worker.postMessage({ type: RESIZE, ...size() });
    else worker.postMessage({ type: RESIZE, layer: target.dataset.layer, ...measure(target) });
  };
  let settle;
  const drawn = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // The worker's own throw: its init failed, or its unit did. Either way the
  // canvas will never paint, so the mount fails loudly where the shell sees.
  worker.addEventListener("error", (e) => {
    e.preventDefault();
    const err = new ProgramError(`presenter "${src}" failed: ${e.message}`);
    settle.reject(err);
    throw err;
  });

  const files = new Set(unit.files);
  const readable = (path) => files.has(path) || (unit.seed && SEEDED.test(path));
  // The reads this seat is performing, which a host may hold its clock for:
  // a presenter's art arriving is the seat's own knowledge, not the worker's.
  let reading = 0;
  let waiters = [];
  const done = () => {
    if (--reading > 0) return;
    for (const resolve of waiters) resolve();
    waiters = [];
  };
  worker.addEventListener("message", ({ data: message }) => {
    if (message === null || typeof message !== "object") refuse("posted a message that is not an object");
    if (message.type === READY) {
      ready = true;
      for (const target of resized) sendResize(target);
      resized.clear();
      worker.postMessage({ type: PROPS, props: latest });
      settle.resolve();
      return;
    }
    if (message.type !== READ) refuse(`posted ${JSON.stringify(message.type)}, which a presenter's port does not carry`);
    if (typeof message.path !== "string" || !readable(message.path)) refuse(`read ${JSON.stringify(message.path)}, which it does not declare`);
    reading++;
    fetch(new URL(`/${message.path}`, location.href), { credentials: "omit" }).then(async (res) => {
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const bytes = await res.arrayBuffer();
      worker.postMessage({ type: READ, id: message.id, bytes }, [bytes]);
    }).catch((err) => worker.postMessage({ type: READ, id: message.id, error: `${message.path}: ${err.message}` })).finally(done);
  });

  // The pinned scripts, each held to its integrity by the fetch that reads it.
  Promise.all(unit.scripts.map(async ({ url, integrity }) => {
    const res = await fetch(url, { integrity, credentials: "omit" });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return { url, bytes: await res.arrayBuffer() };
  })).then((scripts) => {
    const at = size();
    const layers = Object.fromEntries(offscreens.map(([name, el, l]) => [name, { ...measure(el), canvas: l }]));
    worker.postMessage(
      { type: INIT, src: new URL(src, location.href).href, scripts, canvas: offscreen, layers, ...at },
      [offscreen, ...offscreens.map(([, , l]) => l), ...scripts.map((s) => s.bytes)],
    );
  }, (err) => {
    const failed = new ProgramError(`presenter "${src}" could not load a pinned script: ${err.message}`);
    settle.reject(failed);
    throw failed;
  });

  const observer = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      if (ready) sendResize(target);
      else resized.add(target);
    }
  });
  observer.observe(canvas);
  for (const el of layered) observer.observe(el);

  return {
    ready: drawn,
    get reading() {
      return reading;
    },
    /** Resolves once no read is in flight. */
    settled() {
      return reading === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
    },
    frame(value) {
      if (ready) worker.postMessage({ type: FRAME, frame: value });
    },
    update(props) {
      latest = props;
      if (ready) worker.postMessage({ type: PROPS, props });
    },
    destroy() {
      observer.disconnect();
      worker.terminate();
      canvas.remove();
    },
  };
}
