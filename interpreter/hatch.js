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

// The permissions a frame may be delegated, each only to a unit that declares
// it (shell.yaml `units.<name>.grants`), as the frame's `allow`. A grant is the
// reader's to answer: the browser prompts in this app's name, and the unit sees
// a denial as the API's own error. terminal.cue publishes the same list.
export const REALM_GRANTS = Object.freeze(["geolocation"]);

// A sandboxed frame without allow-same-origin has an opaque origin, and an
// opaque origin serialises as the string "null" — so this, not the src's
// origin, is what its messages carry. Reading the src's host here instead
// would reject every message the unit ever sends.
const OPAQUE_ORIGIN = "null";

// A unit that lies about its height must not be able to blow out the document.
const MAX_HEIGHT = 10000;

// What a unit's event may carry. The browser's structured clone already
// guarantees data alone crosses — no getter, function or prototype — so the
// seat's own floor is size: at most DETAIL_BYTES, strings counted as UTF-16
// bytes. Everything else is the event's payload
// shape, which the program declares beside the name (pronto's `ports.raises`,
// mecha's #Shape) because only the program knows what the event means.
export const DETAIL_BYTES = 10 * 1024 * 1024;

class Unfit extends Error {}

/** The value `shape` rebuilds out of `value`, deep-frozen: the unit's own
 * object never crosses. Throws Unfit naming the first path that does not fit,
 * which the realm seat drops with the event and the agent seat refuses. Object
 * fields are exactly the declared ones, as mecha's check reads them. */
export function rebuildDetail(shape, value) {
  let left = DETAIL_BYTES;
  const spend = (bytes, path) => {
    left -= bytes;
    if (left < 0) throw new Unfit(`${path}: over ${DETAIL_BYTES} bytes`);
  };
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o, key);
  const rebuild = (shape, value, path) => {
    switch (shape.type) {
      case "string":
        if (typeof value !== "string" || value.length > shape.maxLength || (shape.values && !shape.values.includes(value))) {
          throw new Unfit(`${path}: invalid string`);
        }
        spend(value.length * 2, path);
        return value;
      case "integer":
        if (!Number.isSafeInteger(value) || value < shape.min || value > shape.max) throw new Unfit(`${path}: invalid integer`);
        spend(8, path);
        return value;
      case "boolean":
        if (typeof value !== "boolean") throw new Unfit(`${path}: invalid boolean`);
        spend(1, path);
        return value;
      case "array":
        if (!Array.isArray(value) || value.length > shape.maxItems) throw new Unfit(`${path}: invalid array`);
        // Indexed, not mapped: map skips a hole, which structured clone keeps,
        // and the reduce would be handed an item no shape admitted.
        return Object.freeze(Array.from({ length: value.length }, (_, i) => rebuild(shape.items, value[i], `${path}[${i}]`)));
      case "object": {
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Unfit(`${path}: invalid object`);
        for (const key of Object.keys(value)) if (!own(shape.fields, key)) throw new Unfit(`${path}.${key}: undeclared field`);
        const out = {};
        for (const [key, field] of Object.entries(shape.fields)) {
          if (!own(value, key)) throw new Unfit(`${path}.${key}: missing field`);
          spend(key.length * 2, path);
          out[key] = rebuild(field, value[key], `${path}.${key}`);
        }
        return Object.freeze(out);
      }
      default:
        throw new Unfit(`${path}: unknown shape`);
    }
  };
  return rebuild(shape, value, "detail");
}

// A single-file page has no file to serve a frame from, so it serves itself:
// a unit the bundle marks `self` is this document's own URL with the unit
// named in the fragment, which keeps one cache entry for both loads. The
// document's boot, finding the name in a sandboxed (opaque-origin) frame,
// writes the unit inlined beside it instead of the app.
export const SELF_UNIT = "pronto-unit";
export function selfSrc(name, href = globalThis.location.href) {
  return `${href.split("#")[0]}#${SELF_UNIT}=${encodeURIComponent(name)}`;
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
  // memo reads one as an answer, and before a DOM event is dispatched. A name
  // outside it is the wiring's bug at either seat; a detail its shape does not
  // rebuild is dropped from a frame, whose sender is a provider's page, and
  // refused from a worker, whose sender is the app's own wrapper and whose
  // answer lost in silence would leave a question standing.
  const { raises } = unit.ports;
  const declared = (event) => {
    if (!Object.hasOwn(raises, event.name)) {
      throw new ProgramError(
        `hatch "${unit.src}" raised "${event.name}", which its ports do not declare (raises: ${Object.keys(raises).join(", ") || "nothing"})`,
      );
    }
    try {
      return { name: event.name, detail: rebuildDetail(raises[event.name], event.detail) };
    } catch (err) {
      if (!(err instanceof Unfit)) throw err;
      if (unit.isolation === "agent") throw new ProgramError(`hatch "${src}" posted "${event.name}" with ${err.message}`);
      return undefined;
    }
  };
  const admitted = (event) => {
    const held = declared(event);
    if (held !== undefined) onEvent?.(held);
  };
  if (unit.memo === undefined) return seat(root, { unit, src, onEvent: admitted });
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
  const [answer] = Object.keys(unit.ports.raises);
  const at = (row, k) => String(row[k]);
  const detailOf = (row) => Object.freeze(Object.fromEntries(key.map((k) => [k, at(row, k)])));
  const attributed = (what) => (err) => {
    throw new ProgramError(`hatch "${src}" memo on "${table}": ${what} — ${err.message}`);
  };
  let alive = true;
  const inner = seat(root, {
    unit,
    src,
    onEvent: (raw) => {
      // The answer's shape is the memo's key and columns (pronto derives it),
      // so a missing one is refused by the rebuild before it reaches here.
      const event = declared(raw);
      const row = Object.fromEntries(columns.map((c) => [c, event.detail[c]]));
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

  const grants = unit.grants ?? [];
  for (const g of grants) {
    if (!REALM_GRANTS.includes(g)) throw new ProgramError(`hatch "${src}" asks for "${g}", which the realm seat does not grant`);
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", SANDBOX);
  if (grants.length) frame.setAttribute("allow", grants.join("; "));
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
    onEvent?.({ name: message.name, detail: message.detail });
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
