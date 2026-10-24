import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createSoundSeat, tameAudio, TAMED } from "../interpreter/kinetic-sound.js";

// A realm with the three ways out of an AudioContext, as the platform has them.
function realm() {
  class Worklet { addModule() {} }
  class BaseAudioContext { get audioWorklet() { return new Worklet(); } }
  class AudioContext extends BaseAudioContext { setSinkId() {} }
  return { Worklet, BaseAudioContext, AudioContext } as Record<string, any>;
}

Deno.test("kinetic-sound: the seat hands the role a context with no worklet and no other device", () => {
  const r = realm();
  let made: any = null;
  createSoundSeat({ createSound: (make: () => unknown) => { made = make(); return {}; } }, r);
  assertEquals(made instanceof r.AudioContext, true);
  assertEquals(TAMED.filter(([owner, name]) => name in r[owner].prototype), []);
  assertEquals(made.audioWorklet, undefined);
  assertEquals(made.setSinkId, undefined);
});

// A property a browser does not have is nothing to remove; one that will not
// go is a role holding more than the seat says, so the seat fails.
Deno.test("kinetic-sound: a property that will not delete fails the seat", () => {
  const r = realm();
  Object.defineProperty(r.Worklet.prototype, "addModule", { value() {}, configurable: false });
  delete r.AudioContext.prototype.setSinkId;
  assertThrows(() => tameAudio(r), TypeError);
});

// The role's voices — an engine's oscillators, its noise beds — run until
// their context closes, so a mount that left without closing it kept sounding.
Deno.test("kinetic-sound: closing the seat closes every context the role made", async () => {
  const r = realm();
  let closed = 0;
  r.AudioContext.prototype.close = () => {
    closed++;
    return Promise.resolve();
  };
  const seat = createSoundSeat({ createSound: (make: () => unknown) => ({ a: make(), b: make() }) }, r);
  await seat.close();
  assertEquals(closed, 2);
});
