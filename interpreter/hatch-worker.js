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
import { EVENT, parseDetail, PROPS, READY, SRC_SCHEMES } from "./hatch.js";

export function mountWorkerUnit(root, { src, onEvent } = {}) {
  const url = new URL(src);
  if (!SRC_SCHEMES.has(url.protocol)) throw new ProgramError(`hatch src scheme "${url.protocol}" is not allowed`);

  // Classic, never a module worker: importScripts is how a unit reaches the
  // code it wraps, and a module worker does not have it. Glue that derives its
  // .wasm URL from its own script URL then requires the unit's files to be
  // siblings in one served directory.
  const worker = new Worker(scriptURL(url.href));
  // A worker renders nothing. `root` carries data-hatch, data-prop-* and the
  // data-on-* that names the reduce; its children are the screen author's and
  // are left alone.

  let ready = false;
  let latest = {};

  const deliver = () => {
    if (ready) worker.postMessage({ type: PROPS, props: latest });
  };

  // There is no origin check and no source check here, and their absence is the
  // design rather than an omission: the frame seat needs both because every
  // sandboxed frame on the page reports origin "null" and posts to a listener
  // the whole page shares, so nothing in the message identifies its sender.
  // A port identifies one. This listener is on the worker and not on
  // globalThis, so no other sender can reach the bridge at all.
  //
  // A message the seat cannot rebuild is refused, where the frame seat drops
  // it: what posts there is a provider's page, and what posts here is the
  // app's own wrapper, so a shape outside the protocol is the app's bug and
  // a memo answer that failed in silence would stand as a question forever.
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
    const detail = parseDetail(message.detail);
    if (detail === undefined) refuse(`"${message.name}" with a detail outside the seat's grammar`);
    onEvent?.({ name: message.name, detail });
  };
  worker.addEventListener("message", onMessage);

  return {
    update(props) {
      latest = props;
      deliver();
    },
    destroy() {
      // The listener dies with the port, so terminate is the whole teardown.
      worker.terminate();
    },
  };
}
