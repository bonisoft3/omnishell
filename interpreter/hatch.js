// The terminal's hatch: a vendored unit mounted into a screen behind one of
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
import { ProgramError } from "./fragment.js";
import { mountPresenterUnit } from "./hatch-presenter.js";
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

// The shape a unit's event detail may take, the offer terminal.cue publishes
// as `hatch.<seat>.detail` (pronto's vendored-unit test holds the two equal).
// The reduce that receives it is a compartment with nothing endowed and
// cannot defend itself, so the parse sits here, on the trusted side, exactly
// as `height`'s number check does. What the grammar means is the app's: the
// terminal cannot know what a move looks like, only that a megabyte, a
// control character, a getter or a nested object must not reach a screen.
export const DETAIL = Object.freeze({ keys: 8, key: /^[a-z][a-z0-9_]{0,23}$/, value: 128 });
const DETAIL_VALUE = /^[^\x00-\x1f\x7f-\x9f]*$/;

/** A frozen string→string record built key by key from `value`, or undefined
 * when `value` is not one — which the realm seat drops with the event and the
 * agent seat refuses. Nothing is passed through: the unit's own object never
 * crosses. */
export function parseDetail(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > DETAIL.keys) return undefined;
  const detail = {};
  for (const key of keys) {
    if (!DETAIL.key.test(key)) return undefined;
    const held = value[key];
    if (typeof held !== "string") return undefined;
    if (held.length > DETAIL.value || !DETAIL_VALUE.test(held)) return undefined;
    detail[key] = held;
  }
  return Object.freeze(detail);
}

// The seats, by the ECMA-262 name of what each gives the unit: a realm is an
// iframe (its own globals and DOM), an agent a worker (its own thread).
const SEATS = { realm: mountFrameUnit, agent: mountWorkerUnit };

// A unit touches the app through its ports alone (shell.yaml `units`):
// `reads`, the tables whose row the mount feeds it, which the screen holds the
// mount to, and `raises`, the events it may post, held here at the seat so an
// undeclared name never becomes a DOM event. The terminal grants nothing
// else at either boundary. `store` is the terminal's, for a unit with a memo.
//
// Every refusal here and in the seats is a ProgramError: the app's own bug,
// which the shell banners wherever it lands. The mount and a question run
// inside the region's refresh, whose outage guard retries anything else as a
// dead gateway; an answer runs inside the port's message listener, where
// anything else is a console line and the question stands forever.
export function mountHatch(root, { unit, src, onEvent, store } = {}) {
  // An agent without a memo is a presenter (pronto's `role`): its worker only
  // paints, and its seat is the presenter's.
  if (unit.role === "presenter") return mountPresenterUnit(root, { unit, src });
  const seat = SEATS[unit.isolation];
  // The schema offers three isolation boundaries and the terminal implements
  // two. A unit asking for a boundary that does not exist must not quietly get
  // a different one.
  if (seat === undefined) throw new ProgramError(`hatch isolation "${unit.isolation}" is not implemented`);
  if (unit.ports === undefined) throw new ProgramError(`hatch "${unit.src}" declares no ports`);
  // The raises port, applied to every event the seat delivers — before the
  // memo reads one as an answer, and before a DOM event is dispatched.
  const declared = (event) => {
    if (!unit.ports.raises.includes(event.name)) {
      throw new ProgramError(
        `hatch "${unit.src}" raised "${event.name}", which its ports do not declare (raises: ${unit.ports.raises.join(", ") || "nothing"})`,
      );
    }
    return event;
  };
  if (unit.memo === undefined) return seat(root, { unit, src, onEvent: (event) => onEvent?.(declared(event)) });
  return memoSeat(seat, root, { unit, src, onEvent, store, declared });
}

// The memo (Michie 1968), performed by the terminal around an agent's seat.
// A question is a props object carrying every key field non-empty; one with a
// key field empty is the mount withdrawing its question and passes through.
// Before a question is posted, the memo table is looked up by the key: a row
// found answers the question — the one event the unit raises is dispatched
// with the key as its detail, and the unit is never asked. An answer the unit
// posts carries the key fields of the question it answered and every memo
// column; it is upserted on the key, then dispatched the same way. The chart
// hearing the event reads the answer off the row, so a hit and a fresh answer
// are one path, and the same question asked twice runs the unit once.
//
// The store refusing the answer — a column outside the entity's cel — or the
// lookup failing is the unit disagreeing with the entity it was declared to
// land in: a ProgramError naming both, which the shell banners. No reduce
// authored the write, so there is no `refused` event to hand one.
function memoSeat(seat, root, { unit, src, onEvent, store, declared }) {
  const { table, key, columns } = unit.memo;
  const [answer] = unit.ports.raises;
  const at = (row, k) => String(row[k]);
  const detailOf = (row) => Object.freeze(Object.fromEntries(key.map((k) => [k, at(row, k)])));
  const attributed = (what) => (err) => {
    throw new ProgramError(`hatch "${src}" memo on "${table}": ${what} — ${err.message}`);
  };
  let alive = true;
  const inner = seat(root, {
    unit,
    src,
    onEvent: (event) => {
      declared(event);
      for (const k of key) {
        if (event.detail[k] === undefined) throw new ProgramError(`hatch "${src}" answered without "${k}", a key of its memo`);
      }
      const row = {};
      for (const c of columns) {
        if (event.detail[c] === undefined) throw new ProgramError(`hatch "${src}" answered without "${c}", a column of its memo`);
        row[c] = event.detail[c];
      }
      // Dispatched once the row is held, so the chart hearing it reads the
      // answer off the row and never off the detail. The refusal is handed in
      // as onRefused too: one landing after the store's acceptance window can
      // no longer reject the upsert, and a memo has no form to carry the words
      // back to, so it is the same ProgramError either way.
      const refused = attributed("the answer was refused");
      store.upsertBy(table, row, refused).then(() => {
        if (alive) onEvent({ name: answer, detail: detailOf(row) });
      }, refused);
    },
  });
  // The question the memo last answered or posted, so a re-delivery of the
  // same props is silence here as it is in a unit.
  let asked = "";
  return {
    ...inner,
    update(props) {
      for (const k of key) {
        if (props[k] === undefined) throw new ProgramError(`hatch "${src}" is asked without "${k}", a key of its memo`);
      }
      if (key.some((k) => props[k] === "")) {
        asked = "";
        inner.update(props);
        return;
      }
      const stamp = JSON.stringify(key.map((k) => props[k]));
      if (stamp === asked) return;
      asked = stamp;
      const filter = key.map((k) => `${k}=eq.${encodeURIComponent(props[k])}`).join("&");
      // A lookup acts once on its answer, so the answer is current.
      store.query(table, null, { filter, current: true }).then((rows) => {
        // A newer question or a dead seat makes this lookup moot.
        if (!alive || asked !== stamp) return;
        const [held] = rows;
        if (held !== undefined) onEvent({ name: answer, detail: detailOf(held) });
        else inner.update(props);
      }, attributed("the question could not be looked up"));
    },
    destroy() {
      alive = false;
      inner.destroy();
    },
  };
}

function mountFrameUnit(root, { unit, src, onEvent }) {
  const url = new URL(src);
  if (!SRC_SCHEMES.has(url.protocol)) throw new ProgramError(`hatch src scheme "${url.protocol}" is not allowed`);

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
