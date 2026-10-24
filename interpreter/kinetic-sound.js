// The kinetic plane's sound seat: a Jessie sound role (pronto's
// `surface.engines.<name>.role: "sound"`) plays the race on one AudioContext
// this seat hands it, and the context reaches nothing but the speakers.
//
// Sound is a view of the race, like pixels, so the role is level 0 output.
// What an AudioContext could reach past the speakers is taken from the realm
// before the first one exists: a worklet's module (code fetched and run) and
// another output device. The rest of its graph — nodes, params, buffers, the
// analyser — reaches no document, network or storage (test/sound.pw.ts walks
// it), so the role holds the context as an argument and no global at all.

/** What `tameAudio` removes, by owner and property, each for its reason. */
export const TAMED = [
  // A worklet's module is fetched and evaluated: code and network.
  ["Worklet", "addModule"],
  ["BaseAudioContext", "audioWorklet"],
  // Routing the mix to another device is an effect outside the page.
  ["AudioContext", "setSinkId"],
];

const tamed = new WeakSet();

/** Removes TAMED from `realm`'s prototypes, once a realm. A property the
 * platform does not have is nothing to remove; one that will not delete
 * throws (a module is strict), and one a parent prototype still has fails.
 * @param {Record<string, any>} [realm] */
export function tameAudio(realm = globalThis) {
  if (tamed.has(realm)) return;
  for (const [owner, name] of TAMED) {
    const proto = realm[owner]?.prototype;
    if (proto === undefined || !(name in proto)) continue;
    delete proto[name];
    if (name in proto) throw new Error(`kinetic-sound: ${owner}.prototype.${name} survives on a parent prototype`);
  }
  tamed.add(realm);
}

/** The sound role `namespace` (evaluateEngine(graph, "sound")) on a tamed
 * context, built at the first gesture the role's `resume` answers. `close`
 * closes every context the role made, so its voices end with the mount.
 * @param {{createSound: (make: () => AudioContext) => any}} namespace
 * @param {Record<string, any>} [realm] */
export function createSoundSeat(namespace, realm = globalThis) {
  tameAudio(realm);
  const made = [];
  const role = namespace.createSound(() => {
    const ctx = new realm.AudioContext();
    made.push(ctx);
    return ctx;
  });
  return { role, close: () => Promise.all(made.map((ctx) => ctx.close())) };
}
