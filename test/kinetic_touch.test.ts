// Touch as the kinetic input mapper's third source (kinetic.js attachTouch): the
// zones under each pointer are keys, so a touch makes the command bits a key
// does, through the same bindings, latching and clearing.
import { assertEquals } from "jsr:@std/assert@1";
import { attachTouch, createKineticInput } from "../interpreter/kinetic.js";
import { screen } from "./touch_screen.ts";
import { kineticChild } from "../interpreter/kinetic-mount.js";

// The car's bindings as an app lays its pad out: the left thumb's pad is
// throttle wherever it rests, and steers on its halves.
const bindings = {
  up: ["ArrowUp", "touch:drive"],
  left: ["ArrowLeft", "touch:left"],
  right: ["ArrowRight", "touch:right"],
  down: ["ArrowDown", "touch:brake"],
  nitro: ["Space", "touch:nitro"],
};

function car() {
  const s = screen();
  const input = createKineticInput({ bindings, gamepad: false, touch: s.track() });
  return { s, input };
}

Deno.test("touch: a zone is its bound action's key, and an element's zones are all pressed", () => {
  const { s, input } = car();
  const ev = s.down(1, ["drive", "left"]);
  assertEquals(ev.defaultPrevented, true, "a zone is a key, not a scroll or a click");
  const held = input.poll();
  assertEquals([held.up, held.left, held.right, held.down, held.nitro], [true, true, false, false, false]);
  s.up(1);
  const free = input.poll();
  assertEquals([free.up, free.left], [false, false]);
  input.destroy();
});

Deno.test("touch: two thumbs hold their zones at once, and each lets go of its own", () => {
  const { s, input } = car();
  s.down(1, ["drive", "right"]);
  s.down(2, ["nitro"]);
  let p = input.poll();
  assertEquals([p.up, p.right, p.nitro], [true, true, true]);
  assertEquals(s.attrs["data-touch-held"], "drive right nitro", "the screen wears what is held, for the controls to light");
  s.up(2);
  p = input.poll();
  assertEquals([p.up, p.right, p.nitro], [true, true, false], "lifting the right thumb keeps the left's");
  s.down(3, ["brake"]);
  p = input.poll();
  assertEquals([p.up, p.down], [true, true]);
  s.fire("pointercancel", 1);
  s.up(3);
  p = input.poll();
  assertEquals([p.up, p.right, p.down], [false, false, false], "a cancelled pointer lets go as a lifted one does");
  assertEquals(s.attrs["data-touch-held"], "");
  input.destroy();
});

Deno.test("touch: a thumb sliding across the pad steers the other way and never drops the zone both halves share", () => {
  const { s, input } = car();
  const released: string[] = [];
  input.inputs.up.on("up", () => released.push("up"));
  s.down(1, ["drive", "left"]);
  let p = input.poll();
  assertEquals([p.up, p.left, p.right], [true, true, false]);
  s.move(1, ["drive"]);
  s.move(1, ["drive", "right"]);
  input.poll();
  p = input.poll();
  assertEquals([p.up, p.left, p.right], [true, false, true]);
  assertEquals(released, [], "the throttle was never let go on the way across");
  s.move(1, []);
  assertEquals(input.poll().up, false, "sliding off the pad lets go");
  input.destroy();
});

// Regression: a thumb drifting past the pad's rounded end and back was
// forgotten once it left every zone, and lost steering and throttle until it
// was lifted and put down again.
Deno.test("touch: a thumb that slides off every zone and back holds again, until it lifts", () => {
  const { s, input } = car();
  s.down(1, ["drive", "left"]);
  s.move(1, []);
  input.poll();
  assertEquals(input.poll().up, false);
  s.move(1, ["drive", "left"]);
  let p = input.poll();
  assertEquals([p.up, p.left], [true, true], "back on the pad, it drives and steers again");
  s.up(1);
  input.poll();
  s.move(1, ["drive"]);
  p = input.poll();
  assertEquals(p.up, false, "a lifted pointer is no longer followed");
  input.destroy();
});

// Regression: a mouse or pen pressed on a zone and let go outside the screen
// stayed held; the pointer is captured to the screen, and a lost capture lets
// go as a lift does.
Deno.test("touch: a pointer down on a zone is captured to the screen, and losing the capture lets go", () => {
  const { s, input } = car();
  s.down(1, ["brake"]);
  assertEquals(s.captured, [1]);
  s.fire("lostpointercapture", 1);
  input.poll();
  assertEquals(input.poll().down, false);
  input.destroy();
});

// Regression: the tracker let go on the window's blur but not when the
// document went hidden, so a thumb held as the tab was switched stayed held
// where GameInputs had let go of every key.
Deno.test("touch: the window's blur and the document going hidden let go of every zone", () => {
  const { s, input } = car();
  s.down(1, ["drive", "left"]);
  s.win.dispatchEvent(new Event("blur"));
  input.poll();
  assertEquals(input.poll().up, false, "blur lets go");
  s.down(2, ["brake"]);
  s.doc.dispatchEvent(new Event("visibilitychange"));
  input.poll();
  assertEquals(input.poll().down, true, "a visible document keeps it");
  s.doc.hidden = true;
  s.doc.dispatchEvent(new Event("visibilitychange"));
  input.poll();
  assertEquals(input.poll().down, false, "a hidden one lets go");
  assertEquals(s.attrs["data-touch-held"], "");
  input.destroy();
});

// Regression: touch-action was each app's to remember, and only it stops a
// pan or a zoom; a pointerdown's preventDefault does not.
Deno.test("touch: the tracker gives every zone touch-action none, once a document", () => {
  const s = screen();
  const one = s.track();
  const two = s.track();
  assertEquals(s.doc.adoptedStyleSheets.length, 1);
  assertEquals(s.doc.adoptedStyleSheets[0].css.includes("[data-touch-zone] { touch-action: none;"), true);
  one.detach();
  two.detach();
});

// Regression: each mapper attached its own tracker to the screen, so every
// move hit-tested and rewrote data-touch-held once a mapper.
Deno.test("touch: one tracker serves every mapper, hit-tests a move once, and writes what is held only when it changes", () => {
  const s = screen();
  const tracker = s.track();
  const car = createKineticInput({ bindings, gamepad: false, touch: tracker });
  const menu = createKineticInput({ bindings: { confirm: ["touch:ok"] }, gamepad: false, touch: tracker });
  s.down(1, ["drive", "left"]);
  const before = s.hits;
  s.move(1, ["drive", "left"]);
  assertEquals(s.hits - before, 1, "one hit test a move");
  assertEquals(s.writes, ["drive left"], "the same list is not written again");
  s.down(2, ["ok"]);
  assertEquals([car.poll().up, menu.poll().confirm], [true, true]);
  car.destroy();
  menu.destroy();
  tracker.detach();
});

Deno.test("touch: one zone under two fingers is held until the last lets go", () => {
  const { s, input } = car();
  s.down(1, ["brake"]);
  s.down(2, ["brake"]);
  s.up(1);
  assertEquals(input.poll().down, true);
  s.up(2);
  assertEquals(input.poll().down, false);
  input.destroy();
});

Deno.test("touch: a finger down off every zone is nothing, even when it slides onto one", () => {
  const { s, input } = car();
  const ev = s.down(1, []);
  assertEquals(ev.defaultPrevented, false, "the road under it scrolls and clicks as the page says");
  s.move(1, ["nitro"]);
  assertEquals(input.poll().nitro, false);
  input.destroy();
});

Deno.test("touch: a tap between two polls still reaches the next frame, once", () => {
  const { s, input } = car();
  s.down(1, ["nitro"]);
  s.up(1);
  assertEquals(input.poll().nitro, true);
  assertEquals(input.poll().nitro, false);
  input.destroy();
});

Deno.test("touch: once destroyed, the screen's pointers reach nothing", () => {
  const { s, input } = car();
  input.destroy();
  s.down(1, ["drive"]);
  assertEquals(input.poll().up, false);
});

// Regression: the race's end hands the input to the menu; a thumb still on
// the pad, or one that taps it then, must reach neither the car's last frames
// nor the next race, as a held key and a gamepad's stick reach neither.
Deno.test("touch: once the row takes the input, nothing touched reaches the car, then or after", () => {
  const s = screen();
  const made: ReturnType<typeof createKineticInput>[] = [];
  const engine = {
    rateHz: 60,
    initState: () => ({ tick: 0, ups: 0 }),
    advanceFrame: (st: { tick: number; ups: number }, cmd: { up: boolean }) => ({ tick: st.tick + 1, ups: st.ups + (cmd.up ? 1 : 0) }),
    saveState: (st: unknown) => structuredClone(st),
    loadState: (st: unknown) => structuredClone(st),
    optionsOf: () => ({}),
    viewOf: (st: unknown) => st,
    commandOf: (poll: Record<string, boolean>) => ({ up: !!poll.up }),
    commandWidth: 1,
    encodeCommand: (cmd: { up: boolean }) => Uint8Array.of(cmd.up ? 1 : 0),
    decodeCommand: (b: Uint8Array) => ({ up: b[0] === 1 }),
    milestones: () => [],
    milestoneSnapshots: [],
  };
  const el = {
    dataset: { kinetic: "race" } as Record<string, string>,
    closest: () => s.root,
    ownerDocument: { defaultView: { CustomEvent, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } },
    dispatchEvent: () => true,
  };
  const child = kineticChild(el as unknown as HTMLElement, {
    decl: { bindings: { up: ["touch:drive"] }, menu: { confirm: ["touch:ok"] }, pause: ["touch:pause"] },
    engine,
    sound: null,
    presenter: { reading: 0, settled: () => Promise.resolve(), frame() {}, destroy() {} },
    makeInput: (opts: Parameters<typeof createKineticInput>[0]) => {
      const input = createKineticInput({ ...opts, gamepad: false });
      made.push(input);
      return input;
    },
    track: () => s.track(),
    schedule: () => 0,
    cancel: () => {},
  });
  child.update({ seed: "7", input: "car", clock: "hold" });
  s.down(1, ["drive"]);
  child.host.stepTick();
  assertEquals(child.host.getState().ups, 1);
  child.update({ seed: "7", input: "menu", clock: "hold" });
  for (let i = 0; i < 3; i++) child.host.stepTick();
  s.up(1);
  s.down(2, ["drive"]);
  s.up(2);
  child.host.stepTick();
  assertEquals(child.host.getState().ups, 1, "a held thumb and a tap under the menu are no throttle");
  child.update({ seed: "7", input: "car", clock: "hold" });
  child.host.stepTick();
  assertEquals(child.host.getState().ups, 1, "the tap under the menu does not latch into the next race");
  child.destroy();
});

// Regression: once a pointer was followed off every zone, a steering thumb
// drifting up from the pad onto the pause button paused the race; a tap zone
// is held only by a finger that goes down on it.
Deno.test("touch: the screen's own hit test reads an element's zones, and a sliding thumb enters no tap zone", () => {
  const s = screen();
  // Elements the document hit-tests at x: the pad's half at 10, pause at 20.
  const element = (zone: string, tap: boolean) => ({
    closest: function () {
      return this;
    },
    getAttribute: () => zone,
    hasAttribute: (name: string) => tap && name === "data-touch-tap",
  });
  const at: Record<number, unknown> = { 10: element("drive left", false), 20: element("pause", true) };
  Object.assign(s.doc, { elementFromPoint: (x: number) => at[x] ?? null });
  Object.assign(s.root, { contains: () => true });
  const tracker = attachTouch(s.root);
  const input = createKineticInput({ bindings: { ...bindings, pause: ["touch:pause"] }, gamepad: false, touch: tracker });
  const fire = (type: string, id: number, x: number) => {
    const ev = Object.assign(new Event(type, { cancelable: true }), { pointerId: id, clientX: x, clientY: 0 });
    s.root.dispatchEvent(ev);
  };
  fire("pointerdown", 1, 10);
  let p = input.poll();
  assertEquals([p.up, p.left], [true, true]);
  fire("pointermove", 1, 20);
  p = input.poll();
  assertEquals([p.up, p.pause], [false, false], "the thumb slid onto pause and paused nothing");
  fire("pointerup", 1, 20);
  fire("pointerdown", 2, 20);
  assertEquals(input.poll().pause, true, "a finger down on pause pauses");
  input.destroy();
  tracker.detach();
});
