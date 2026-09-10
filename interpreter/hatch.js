// The terminal-tier hatch: a vendored unit mounted into a screen behind one of
// two boundaries, fed props and answering with named events.
//
// The unit itself is the app's own, declared in CUE and audited — that is where
// its trust comes from. What sits behind it usually is not: an article embed is
// a provider's page arriving over the network at read time, unreviewable by
// anyone; an engine is megabytes of machine code nobody reads. Which of the two
// a unit is decides its boundary, and the boundaries are not ordered — a frame
// is contained and shares this thread, a worker owns a thread and shares this
// origin.
//
// Props in are a current-value feed, resynchronised on every bind pass, the
// same shape hydrateWidget's update(rows) has. Events out are named and
// request-shaped: the unit describes, the terminal performs. `height` is the
// one name the terminal performs itself; everything else is handed to onEvent,
// its detail parsed here first.
import { mountWorkerUnit } from "./hatch-worker.js";

export const PROPS = "pronto:props";
export const READY = "pronto:ready";
export const EVENT = "pronto:event";

export const SRC_SCHEMES = new Set(["http:", "https:"]);

// Fixed, and the terminal's to choose — a unit cannot widen it. Each token
// costs something, so each is here for a stated reason:
//   allow-scripts   the unit is script-driven; without it nothing runs, it
//                   cannot measure itself, and there is no bridge at all.
//   allow-popups    an embed's whole affordance is clicking through to the
//                   source; without it a target=_blank link is swallowed
//                   silently, which reads to the user as a broken embed.
//   allow-popups-to-escape-sandbox
//                   a popup inherits the opener's sandbox unless this is set,
//                   so the provider's own page would open scriptless and
//                   opaque. What it opens is a separate top-level document at
//                   the provider's origin — no more authority than a link in
//                   the article already has.
//
// allow-same-origin is refused, permanently and without a widening path. With
// it the frame shares this origin: it reads our storage and our cookies, and
// for a same-origin src it reaches through window.parent into the screen's own
// DOM. A sandbox carrying it is theatre. The top-navigation tokens are refused
// on the same footing — an embed that can replace the page the reader is on
// has taken the app away from them.
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

// A sandboxed frame without allow-same-origin has an opaque origin, and an
// opaque origin serialises as the string "null" — so this, not the src's
// origin, is what its messages carry. Reading the src's host here instead
// would reject every message the unit ever sends.
const OPAQUE_ORIGIN = "null";

// A unit that lies about its height must not be able to blow out the document.
const MAX_HEIGHT = 10000;

// The shape a unit's event detail may take. The reduce that receives it is a
// compartment with nothing endowed and cannot defend itself, so the parse sits
// here, on the trusted side, exactly as `height`'s number check does. What the
// grammar means is the app's: the terminal cannot know what a move looks like,
// only that a megabyte, a control character, a getter or a nested object must
// not reach a screen.
const DETAIL_KEYS = 8;
const DETAIL_KEY = /^[a-z][a-z0-9_]{0,23}$/;
const DETAIL_VALUE_LENGTH = 128;
const DETAIL_VALUE = /^[\x20-\x7e]*$/;

/** A frozen string→string record built key by key from `value`, or undefined
 * when `value` is not one — and undefined drops the event that carried it.
 * Nothing is passed through: the unit's own object never crosses. */
export function parseDetail(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > DETAIL_KEYS) return undefined;
  const detail = {};
  for (const key of keys) {
    if (!DETAIL_KEY.test(key)) return undefined;
    const held = value[key];
    if (typeof held !== "string") return undefined;
    if (held.length > DETAIL_VALUE_LENGTH || !DETAIL_VALUE.test(held)) return undefined;
    detail[key] = held;
  }
  return Object.freeze(detail);
}

export function mountHatch(root, { unit, src, onEvent } = {}) {
  if (unit.isolation === "iframe") return mountFrameUnit(root, { unit, src, onEvent });
  if (unit.isolation === "worker") return mountWorkerUnit(root, { unit, src, onEvent });
  // The schema offers three isolation boundaries and the terminal implements
  // two. A unit asking for a boundary that does not exist must not quietly get
  // a different one.
  throw new Error(`hatch isolation "${unit.isolation}" is not implemented`);
}

function mountFrameUnit(root, { unit, src, onEvent }) {
  // An opaque-origin frame is granted no terminal capabilities at all.
  // Answering a request for one with silence would hand the app a unit that
  // cannot do what it declared.
  if (unit.capabilities?.length) {
    throw new Error(`hatch capabilities ${unit.capabilities} are not grantable to an iframe unit`);
  }
  const url = new URL(src);
  if (!SRC_SCHEMES.has(url.protocol)) throw new Error(`hatch src scheme "${url.protocol}" is not allowed`);

  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", SANDBOX);
  frame.setAttribute("src", url.href);
  // An article carries several of these and none of them is what the reader
  // came for.
  frame.setAttribute("loading", "lazy");
  // The provider learns that it was embedded, never which article was read.
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", root.getAttribute("aria-label") ?? root.dataset.hatch);
  frame.style.border = "0";
  frame.style.width = "100%";
  root.replaceChildren(frame);

  let ready = false;
  let latest = {};

  // targetOrigin cannot name an opaque origin, so "*" is the only reachable
  // value — meaning whatever document is in the frame receives these props. A
  // unit that navigated itself elsewhere would receive them too, which is why
  // a hatch is never fed anything secret.
  const deliver = () => {
    if (ready) frame.contentWindow?.postMessage({ type: PROPS, props: latest }, "*");
  };

  const onMessage = (e) => {
    // contentWindow is read per message, not captured: it is replaced when the
    // frame navigates, and a stale handle would accept nothing.
    // Every sandboxed frame on the page shares the origin "null", so origin
    // alone identifies nobody — this identity check is what makes the frame
    // the only sender that can reach this bridge.
    if (e.source !== frame.contentWindow || e.source == null) return;
    if (e.origin !== OPAQUE_ORIGIN) return;
    const message = e.data;
    if (message === null || typeof message !== "object") return;
    if (message.type === READY) {
      ready = true;
      deliver();
      return;
    }
    if (message.type !== EVENT) return;
    if (typeof message.name !== "string" || message.name === "") return;
    if (message.name === "height") {
      const height = message.height;
      if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return;
      frame.style.height = `${Math.min(Math.round(height), MAX_HEIGHT)}px`;
      return;
    }
    const detail = parseDetail(message.detail);
    if (detail === undefined) return;
    onEvent?.({ name: message.name, detail });
  };
  globalThis.addEventListener("message", onMessage);

  return {
    frame,
    update(props) {
      latest = props;
      deliver();
    },
    destroy() {
      globalThis.removeEventListener("message", onMessage);
      frame.remove();
    },
  };
}
