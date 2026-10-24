// The presenter's worker: a vendored unit that paints on a canvas the terminal
// transferred, and can do nothing else.
//
// Two things stand behind that, and neither is this file's code being careful.
// The script's own Content-Security-Policy (terminal.cue `presenter.policy`,
// sent by both doors) governs the worker: it connects to blob: only and runs
// no script from another origin, so the network and stray code are the
// browser's to refuse. What a policy cannot reach — storage, locks, the
// channels between contexts, a nested worker (its worker-src is 'self', which
// Firefox and WebKit hold this worker's own imports to) — is deleted here,
// before the unit's first line runs, by an allow-list: a global this worker
// was born with stays only if it is an ECMAScript intrinsic or named below
// with why.
//
// Nothing is sealed. The pinned scripts a presenter names (Babylon writes onto
// Array.prototype.push, which a frozen intrinsic refuses) run before the
// prune, and the unit's code computes whatever it likes; there is nowhere for
// it to go but the canvas. A message out is the protocol below, and the seat
// refuses anything else.
import { FRAME, INIT, PROPS, prune, READ, READY, RESIZE } from "./presenter-realm.js";

// A rejection in a worker reaches nobody but its console; thrown from a task
// of its own it is the worker's `error` event, which the seat makes the app's.
const fail = (err) => setTimeout(() => {
  throw err;
});

addEventListener("message", ({ data }) => start(data).catch(fail), { once: true });

async function start(data) {
  if (data?.type !== INIT) throw new Error(`presenter: the first message is ${INIT}, not ${JSON.stringify(data?.type)}`);
  // Indirect eval runs a pinned script as a classic script at global scope,
  // where a UMD wrapper puts its namespace. The seat checked its integrity.
  const decoder = new TextDecoder();
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  for (const script of data.scripts) (0, eval)(decoder.decode(script.bytes));
  prune(globalThis, new Set(Object.getOwnPropertyNames(globalThis).filter((key) => !before.has(key))));
  const pending = new Map();
  let next = 0;
  // A frame or props before the unit is up are superseded by the next. A
  // frame is drawn as it arrives, the newest of any that queued behind a
  // slow one: waiting for the worker's own animation frame instead costs a
  // frame of latency, and a render near a frame's length then misses every
  // other one (pronto's endowed-Babylon record, "Frame cost").
  let unit = null;
  let latest = null;
  const draw = () => {
    const frame = latest;
    latest = null;
    unit.frame(frame);
  };
  addEventListener("message", ({ data: message }) => {
    if (message.type === READ) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.bytes);
    } else if (message.type === FRAME) {
      if (unit === null) return;
      if (latest === null) setTimeout(draw);
      latest = message.frame;
    }
    else if (message.type === PROPS) unit?.props?.(message.props);
    else if (message.type === RESIZE && message.layer !== undefined) unit?.resizeLayer?.(message.layer, message);
    else if (message.type === RESIZE) unit?.resize?.(message.width, message.height, message.dpr);
    else throw new Error(`presenter: the seat sent ${JSON.stringify(message.type)}`);
  });
  const env = Object.freeze({
    width: data.width,
    height: data.height,
    dpr: data.dpr,
    /** The screen's `<canvas data-layer>`s, by name: each its canvas, box
     * and the text style CSS gave it (hatch-presenter.js). */
    layers: Object.freeze({ ...data.layers }),
    /** The bytes of a declared file or a seeded blob, by its app path. */
    read: (path) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      postMessage({ type: READ, id, path });
    }),
  });
  const { default: present } = await import(data.src);
  if (typeof present !== "function") throw new Error(`presenter: ${data.src} default-exports no function`);
  const made = await present(data.canvas, env);
  if (typeof made?.frame !== "function") throw new Error(`presenter: ${data.src} returned no frame(frame)`);
  unit = made;
  postMessage({ type: READY });
}
