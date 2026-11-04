import { scriptURL } from "./script-url.js";
// The hatch's second boundary: a vendored unit on its own thread.
//
// A thread is what this buys and it is all it buys. The worker is same-origin,
// so it keeps fetch, IndexedDB and the cache API — MORE ambient authority than
// the frame seat, not less. Nothing here contains the unit; the app's audit and
// the pinned hash of what it loads are what stand behind it, and the terminal
// grants it nothing on top. A unit whose untrusted half arrives over the
// network at read time belongs in the frame seat instead.
//
// The seat speaks pronto:props / pronto:ready / pronto:event and nothing else.
// A unit driving some other protocol — UCI, an RPC, a codec — is the app's
// wrapper script, which is also the half an engineer can read: this dispatcher
// never learns what a unit is.
import { ProgramError } from "./fragment.js";
import { EVENT, PROPS, READY, SRC_SCHEMES } from "./hatch.js";

export function mountWorkerUnit(root, { src, onEvent } = {}) {
  const url = new URL(src);
  if (!SRC_SCHEMES.has(url.protocol)) throw new ProgramError(`hatch src scheme "${url.protocol}" is not allowed`);
  // The blob: below is this origin's whatever bytes it holds, so the unit's
  // own address is what must be this origin's.
  if (globalThis.location && url.origin !== globalThis.location.origin) {
    throw new ProgramError(`hatch src ${url.href} crosses origins`);
  }

  // The worker shares this origin and its authority, so it runs under this
  // document's policy too: started from a blob: of its fetched bytes, it
  // inherits the page's Content-Security-Policy, and what it may connect to is
  // what the app declares (capabilities.resources). Fetched through the
  // terminal's own fetch, so a single-file page's shim answers it. Classic,
  // never a module worker: a unit is one script, and importScripts reaches
  // only absolute URLs from a blob:.
  let worker = null;
  let blob = null;
  let alive = true;
  const queued = [];
  const started = fetch(url.href).then(async (res) => {
    if (!res.ok) throw new ProgramError(`hatch "${src}" could not be fetched: ${res.status}`);
    const text = await res.text();
    if (!alive) return;
    blob = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
    worker = new Worker(scriptURL(blob));
    worker.addEventListener("message", onMessage);
    // A unit that throws has failed the app, and a question it was asked would
    // otherwise stand forever: its error is the app's bug, not a console line.
    worker.addEventListener("error", (e) => {
      e.preventDefault();
      refuse(`an error: ${e.message}`);
    });
    for (const message of queued.splice(0)) worker.postMessage(message);
  });
  started.catch((err) => {
    throw err instanceof ProgramError ? err : new ProgramError(`hatch "${src}" could not start: ${err.message}`);
  });
  const post = (message) => (worker ? worker.postMessage(message) : queued.push(message));
  // A worker renders nothing. `root` carries data-hatch, data-prop-* and the
  // data-on-* that names the reduce; its children are the screen author's and
  // are left alone.

  let ready = false;
  let latest = {};

  const deliver = () => {
    if (ready) post({ type: PROPS, props: latest });
  };

  // There is no origin check and no source check here, and their absence is the
  // design rather than an omission: the frame seat needs both because every
  // sandboxed frame on the page reports origin "null" and posts to a listener
  // the whole page shares, so nothing in the message identifies its sender.
  // A port identifies one. This listener is on the worker and not on
  // globalThis, so no other sender can reach the bridge at all.
  //
  // A message outside the protocol is refused, where the frame seat drops
  // it: what posts there is a provider's page, and what posts here is the
  // app's own wrapper, so a shape outside the protocol is the app's bug and
  // a memo answer that failed in silence would stand as a question forever.
  // The detail is mountHatch's to rebuild against the event's shape.
  // Thrown from the port's listener, it is the window's `error` event, which
  // the shell banners for a ProgramError.
  const refuse = (what) => {
    throw new ProgramError(`hatch "${src}" posted ${what}`);
  };
  const onMessage = (e) => {
    const message = e.data;
    if (message === null || typeof message !== "object") refuse("a message that is not an object");
    if (message.type === READY) {
      ready = true;
      deliver();
      return;
    }
    if (message.type !== EVENT) refuse(`a message of type ${JSON.stringify(message.type)}, which the seat does not speak`);
    if (typeof message.name !== "string" || message.name === "") refuse("an event with no name");
    onEvent?.({ name: message.name, detail: message.detail });
  };

  return {
    update(props) {
      latest = props;
      deliver();
    },
    destroy() {
      // The listener dies with the port, so terminate is the whole teardown.
      alive = false;
      worker?.terminate();
      if (blob) URL.revokeObjectURL(blob);
    },
  };
}
