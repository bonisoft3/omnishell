// The kinetic child's wiring (kinetic-mount.js) over a counting engine, a
// presenter that draws nothing and the terminal's own input mappers: what the
// row hands in (seed, input, clock) and what the race hands out (milestones,
// menu presses) as events on the mount.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { kineticChild } from "../interpreter/kinetic-mount.js";
import { ProgramError } from "../interpreter/fragment.js";
import { createKineticInput } from "../interpreter/kinetic.js";
import { packInputs } from "../interpreter/kinetic-milestones.js";
import { screen } from "./touch_screen.ts";

type Cmd = { up: boolean };
type State = { tick: number; seed: number; ups: number; laps: number; events: { type: string }[] };

const engine = {
  rateHz: 60,
  initState: (seed: number, options: { laps: number }): State => ({ tick: 0, seed, ups: 0, laps: options.laps, events: [] }),
  advanceFrame: (s: State, cmd: Cmd): State => ({ ...s, tick: s.tick + 1, ups: s.ups + (cmd.up ? 1 : 0), events: s.tick + 1 === 3 ? [{ type: "go" }] : [] }),
  saveState: (s: State) => structuredClone(s),
  loadState: (s: State) => structuredClone(s),
  optionsOf: (props: Record<string, string>) => ({ laps: Number(props.laps) }),
  viewOf: (s: State) => s,
  commandOf: (poll: Record<string, boolean>): Cmd => ({ up: !!poll.up }),
  commandWidth: 1,
  encodeCommand: (cmd: Cmd) => Uint8Array.of(cmd.up ? 1 : 0),
  decodeCommand: (bytes: Uint8Array): Cmd => ({ up: bytes[0] === 1 }),
  milestones: (s: State) => s.events.map(() => ({ kind: "start" })),
  milestoneSnapshots: ["start"],
};

const decl = {
  bindings: { up: ["ArrowUp", "gamepad:axis:1:-"] },
  menu: { up: ["ArrowUp", "gamepad:axis:1:-"], confirm: ["Enter"] },
  pause: ["Escape"],
};

/** A mount: an element whose events are recorded, and a frame clock the test
 * turns by hand, in `win` and on the screen `within` (none: no screen). */
const quietWindow = { CustomEvent, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} };
function mount(overrides: Record<string, unknown> = {}, { win = quietWindow as object, within = screen().root as Element | null } = {}) {
  const raised: { type: string; detail: Record<string, unknown> }[] = [];
  const target = new EventTarget();
  target.addEventListener("milestone", (e) => raised.push({ type: "milestone", detail: (e as CustomEvent).detail }));
  target.addEventListener("menu", (e) => raised.push({ type: "menu", detail: (e as CustomEvent).detail }));
  target.addEventListener("replayed", (e) => raised.push({ type: "replayed", detail: (e as CustomEvent).detail }));
  const frames: FrameRequestCallback[] = [];
  const el = {
    dataset: { kinetic: "race" } as Record<string, string>,
    closest: () => within,
    ownerDocument: { defaultView: win },
    dispatchEvent: (e: Event) => target.dispatchEvent(e),
  };
  const presenter = { reading: 0, settled: () => Promise.resolve(), frame() {}, destroy() {} };
  const child = kineticChild(el as unknown as HTMLElement, {
    decl,
    engine,
    sound: null,
    presenter,
    schedule: (fn: FrameRequestCallback) => frames.push(fn),
    cancel: () => {},
    ...overrides,
  });
  // deno-lint-ignore no-explicit-any
  const key = (input: any, code: string, down: boolean) => input.inputs._handleKeyEvent(code, down, { code });
  /** Runs the menu's frame poll once. */
  const pollMenu = () => frames.shift()!(0);
  return { child, raised, key, pollMenu };
}

/** The terminal's own mappers, each kept as it is made: the car's first, the
 * menu's last. */
const recording = (made: ReturnType<typeof createKineticInput>[]) => (opts: Parameters<typeof createKineticInput>[0]) => {
  const input = createKineticInput(opts);
  made.push(input);
  return input;
};

Deno.test("a new seed on the row is a new race, from the row's options", () => {
  const { child } = mount();
  child.update({ seed: "7", laps: "3", input: "car", clock: "hold" });
  for (let i = 0; i < 5; i++) child.host.stepTick();
  assertEquals(child.host.getState().tick, 5);
  child.update({ seed: "7", laps: "3", input: "car", clock: "hold" });
  assertEquals(child.host.getState().tick, 5, "the same seed keeps the race");
  child.update({ seed: "8", laps: "2", input: "car", clock: "hold" });
  assertEquals(child.host.getState(), { tick: 0, seed: 8, ups: 0, laps: 2, events: [] });
});

Deno.test("a lifted milestone is a milestone event on the mount, naming its race", () => {
  const { child, raised } = mount();
  child.update({ seed: "7", laps: "1", input: "car", clock: "hold" });
  for (let i = 0; i < 4; i++) child.host.stepTick();
  const lifted = raised.filter((r) => r.type === "milestone");
  assertEquals(lifted.length, 1);
  assertEquals(lifted[0].detail.race, "7");
  assertEquals(lifted[0].detail.kind, "start");
  assertEquals(lifted[0].detail.frame, 3);
  assert(Object.isFrozen(lifted[0].detail), "a reduce reads the terminal's record, frozen");
});

// Regression: the car and the initials read one keyboard; a press after the
// race reached the car's ring as well as the letters.
Deno.test("once the row takes the input, nothing pressed reaches the car, then or after", () => {
  const inputs: ReturnType<typeof createKineticInput>[] = [];
  const { child, key } = mount({ makeInput: recording(inputs) });
  const [car] = inputs;
  child.update({ seed: "7", laps: "1", input: "car", clock: "hold" });
  key(car, "ArrowUp", true);
  child.host.stepTick();
  assertEquals(child.host.getState().ups, 1);
  child.update({ seed: "7", laps: "1", input: "menu", clock: "hold" });
  for (let i = 0; i < 3; i++) child.host.stepTick();
  key(car, "ArrowUp", false);
  key(car, "ArrowUp", true);
  key(car, "ArrowUp", false);
  child.host.stepTick();
  assertEquals(child.host.getState().ups, 1, "a held key and a tap under the menu are no throttle");
  child.update({ seed: "7", laps: "1", input: "car", clock: "hold" });
  child.host.stepTick();
  assertEquals(child.host.getState().ups, 1, "the tap under the menu does not latch into the next race");
});

Deno.test("between races a key and a gamepad axis are both menu presses; during one only pause is", () => {
  const inputs: ReturnType<typeof createKineticInput>[] = [];
  const { child, raised, key, pollMenu } = mount({ makeInput: recording(inputs) });
  const menu = inputs.at(-1);
  child.update({ seed: "7", laps: "1", input: "car", clock: "hold" });
  key(menu, "ArrowUp", true);
  key(menu, "ArrowUp", false);
  key(menu, "Escape", true);
  key(menu, "Escape", false);
  assertEquals(raised.map((r) => r.detail.action), ["pause"]);
  child.update({ seed: "7", laps: "1", input: "menu", clock: "hold" });
  key(menu, "ArrowUp", true);
  key(menu, "ArrowUp", false);
  const pads = [{ connected: true, buttons: [], axes: [0, -1] }];
  Object.defineProperty(navigator, "getGamepads", { value: () => pads, configurable: true });
  try {
    pollMenu();
  } finally {
    Object.defineProperty(navigator, "getGamepads", { value: () => [], configurable: true });
  }
  assertEquals(raised.map((r) => [r.detail.action, r.detail.n]), [["pause", "1"], ["up", "2"], ["up", "3"]]);
});

Deno.test("the row's clock holds the race and plays it", () => {
  const scheduled: FrameRequestCallback[] = [];
  const { child } = mount({ schedule: (fn: FrameRequestCallback) => scheduled.push(fn) });
  child.update({ seed: "7", laps: "1", input: "car", clock: "play" });
  assert(child.host.isPlaying());
  child.update({ seed: "7", laps: "1", input: "menu", clock: "hold" });
  assert(!child.host.isPlaying());
});

// Time travel across the planes: the row hands the race windows of itself,
// each a lifted milestone that carries its frame's state and the commands
// lifted after it, and the child plays them back to the presenter on a host
// of its own, so the race's head stands and is drawn again after.
Deno.test("a replay plays windows of the race from their rows, each frame with its cut, and the race's head stands", () => {
  const queued: FrameRequestCallback[] = [];
  const drawn: { frame: number; state: State; cut: unknown }[] = [];
  const presenter = { reading: 0, settled: () => Promise.resolve(), destroy() {}, frame: (f: { frame: number; state: State; cut?: unknown }) => drawn.push({ frame: f.frame, state: f.state, cut: f.cut ?? null }) };
  const { child, raised } = mount({ presenter, schedule: (fn: FrameRequestCallback) => queued.push(fn) });
  const turn = (now: number) => queued.splice(0).forEach((fn) => fn(now));
  child.update({ seed: "7", laps: "1", input: "car", clock: "hold" });
  const ups = [false, true, true, false, true, true, true, false, true, false];
  const forward: State[] = ups.map((up) => child.host.stepTick({ up }));
  const [start] = raised.filter((r) => r.type === "milestone").map((r) => r.detail);
  assertEquals([start.kind, start.frame, (start.snapshot as State).ups], ["start", 3, 2], "the start's row carries its frame's state");
  const commands = packInputs(ups.slice(3, 8).map((up) => engine.encodeCommand({ up })), 1);
  const replay = JSON.stringify({ windows: [{ at: { ...start, inputs: "" }, commands, frames: 5 }] });
  child.update({ seed: "7", laps: "1", input: "menu", clock: "hold", replay });
  for (let t = 1; t < 40 && !raised.some((r) => r.type === "replayed"); t++) turn(t * 1000 / 60);
  const cut = drawn.filter((d) => d.cut !== null);
  assertEquals(cut.at(-1)!.frame, 8, "the window plays to its end");
  for (const d of cut) assertEquals(d.state, forward[d.frame - 1], `frame ${d.frame} is the race's own`);
  assertEquals(cut[0].cut, { index: 0, count: 1, from: 3, frames: 5 });
  assertEquals(raised.at(-1), { type: "replayed", detail: { race: "7" } });
  assertEquals(child.host.getCurrentTick(), 10, "the race's head stands");
  assertEquals([drawn.at(-1)!.frame, drawn.at(-1)!.cut], [10, null], "and is drawn again");
});

// Regression: sound resumed only on a key or a pointer's down, and WebKit
// grants a gesture at a touch's end, so a player on touch alone heard nothing.
Deno.test("the sound resumes on a key, a pointer's down and up, and a click", () => {
  const win = Object.assign(new EventTarget(), { CustomEvent, matchMedia: () => ({ matches: false }) });
  let resumed = 0;
  const sound = { frame() {}, props() {}, levels: () => [], resume: () => resumed++ };
  const { child } = mount({ sound }, { win });
  for (const type of ["keydown", "pointerdown", "pointerup", "click"]) win.dispatchEvent(new Event(type));
  assertEquals(resumed, 4);
  child.destroy();
  win.dispatchEvent(new Event("pointerup"));
  assertEquals(resumed, 4, "a destroyed child resumes nothing");
});

Deno.test("a mount outside every [data-screen] is refused: its touch zones are a screen's", () => {
  assertThrows(() => mount({}, { within: null }), ProgramError, "sits in no [data-screen]");
});

Deno.test("an engine without the child's exports is refused, naming them", () => {
  const { optionsOf: _o, viewOf: _v, ...bare } = engine;
  assertThrows(() => mount({ engine: bare }), ProgramError, "its engine exports no optionsOf, viewOf");
});

// Two seats of one duel, each counting its own throttle; a frame's command is
// both seats' inputs as decodeInputs makes them.
type Duel = { tick: number; seed: number; ups: number[]; events: { type: string }[] };
const duelEngine = {
  ...engine,
  initState: (seed: number): Duel => ({ tick: 0, seed, ups: [0, 0], events: [] }),
  advanceFrame: (s: Duel, cmd: Cmd | Cmd[]): Duel => {
    const both = Array.isArray(cmd) ? cmd : [cmd, { up: false }];
    return { ...s, tick: s.tick + 1, ups: s.ups.map((n, seat) => n + (both[seat].up ? 1 : 0)), events: s.tick + 1 === 30 ? [{ type: "go" }] : [] };
  },
  encodeInput: (input: Cmd) => (input.up ? 1 : 0),
  decodeInputs: (bytes: Uint8Array, gone: boolean[]) => [...bytes].map((byte, seat) => ({ up: !gone[seat] && byte === 1 })),
};
const ggrs = await Deno.readFile(new URL("../interpreter/vendor/ggrs/ggrs_wasm_bg.wasm", import.meta.url));
const { createRollbackHost } = await import("../interpreter/kinetic-session.js");

/** Two ends of a data channel that opens once each side has heard the other's
 * description, every message delivered as it is sent. */
function wire(asked: unknown[] = []) {
  const ends: { handlers: ((bytes: Uint8Array) => void)[]; opened: () => void }[] = [];
  return ({ initiator, signal, iceServers }: { initiator: boolean; iceServers: unknown; signal: { send: (d: unknown) => void; onDescription: (h: (d: { type: string }) => void) => void } }) => {
    asked.push(iceServers);
    const me = initiator ? 0 : 1;
    let opened = () => {};
    const open = new Promise<void>((resolve) => (opened = resolve));
    ends[me] = { handlers: [], opened };
    signal.onDescription((d) => {
      if (!initiator) return signal.send({ type: "answer" });
      if (d.type === "answer") for (const end of ends) end.opened();
    });
    if (initiator) signal.send({ type: "offer" });
    return {
      open,
      send: (bytes: Uint8Array) => ends[1 - me].handlers.forEach((h) => h(bytes.slice())),
      onMessage: (h: (bytes: Uint8Array) => void) => ends[me].handlers.push(h),
      close() {},
    };
  };
}

Deno.test("an online race signals through the row, races GGRS over the channel, and both seats lift the same milestones", async () => {
  const asked: unknown[] = [];
  const connect = wire(asked);
  const iceServers = [{ urls: "stun:stun.example:3478" }];
  const frames: FrameRequestCallback[][] = [[], []];
  const raised: { type: string; detail: Record<string, unknown> }[][] = [[], []];
  const props = [0, 1].map((seat) => ({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: String(seat), peer: "" }));
  const children = [0, 1].map((seat) => {
    const target = new EventTarget();
    for (const type of ["milestone", "describe"]) target.addEventListener(type, (e) => raised[seat].push({ type, detail: (e as CustomEvent).detail }));
    const el = {
      dataset: { kinetic: "race" } as Record<string, string>,
      closest: () => screen().root,
      ownerDocument: { defaultView: { CustomEvent, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {} } },
      dispatchEvent: (e: Event) => target.dispatchEvent(e),
    };
    return kineticChild(el as unknown as HTMLElement, {
      decl,
      engine: duelEngine,
      sound: null,
      presenter: { reading: 0, settled: () => Promise.resolve(), frame() {}, destroy() {} },
      schedule: (fn: FrameRequestCallback) => frames[seat].push(fn),
      cancel: () => {},
      iceServers,
      connect,
      rollback: (options: Record<string, unknown>) => createRollbackHost({ ...options, module: ggrs }),
    });
  });
  // What one side describes reaches the other as the row's `peer`, as the
  // duel machine's rows carry it.
  const relay = (from: number) => {
    const said = raised[from].filter((r) => r.type === "describe").at(-1);
    if (said === undefined) return;
    assertEquals(said.detail.race, "41");
    props[1 - from] = { ...props[1 - from], peer: said.detail.description as string };
    children[1 - from].update(props[1 - from]);
  };
  children[0].update(props[0]);
  children[1].update(props[1]);
  relay(0);
  relay(1);
  for (let t = 1; t <= 240; t++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const seat of [0, 1]) for (const fn of frames[seat].splice(0)) fn(t * 1000 / 60);
  }
  const lifted = raised.map((r) => r.filter((e) => e.type === "milestone").map((e) => [e.detail.race, e.detail.frame, e.detail.kind, e.detail.checksum, e.detail.width]));
  assertEquals(lifted[0].length, 1, "the start, lifted once its frame was confirmed");
  assertEquals(lifted[0], lifted[1], "both seats lift one row");
  assertEquals(lifted[0][0].slice(0, 3), ["41", 30, "start"]);
  assertEquals(lifted[0][0][4], 2, "a frame's two seats' bytes");
  assertEquals(asked, [iceServers, iceServers], "each seat's channel gathers over the terminal config's ICE servers");
  for (const child of children) child.destroy();
});

// The resume once a held race's art arrives used to belong to the race that
// held: a duel replaced by an offline race while it held left the new race
// frozen, since the duel's resume plays only its own session.
Deno.test("a race that replaced a held duel plays once the art arrives", async () => {
  let settle = () => {};
  const presenter = { reading: 1, settled: () => new Promise<void>((resolve) => (settle = resolve)), frame() {}, destroy() {} };
  let duel: { onCommit: (state: unknown) => void } | null = null;
  const stopped: string[] = [];
  const { child } = mount({
    engine: duelEngine,
    presenter,
    iceServers: [],
    connect: () => ({ open: Promise.resolve(), send() {}, onMessage() {}, close() {} }),
    rollback: (options: { onCommit: (state: unknown) => void }) => {
      duel = options;
      return Promise.resolve({ start() {}, stop: () => stopped.push("duel"), dispose() {} });
    },
  });
  child.update({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: "0", peer: "" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  duel!.onCommit(duelEngine.initState(41));
  assertEquals(stopped, ["duel"], "the duel holds while the art loads");
  child.update({ seed: "42", laps: "1", input: "car", clock: "play" });
  assert(!child.host.isPlaying(), "the new race waits for the art too");
  presenter.reading = 0;
  settle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(child.host.isPlaying());
});

Deno.test("a failed connection raises one numbered abort and closes the channel", async () => {
  let closed = 0;
  const { child, raised } = mount({
    engine: duelEngine,
    iceServers: [],
    connect: () => ({ open: Promise.reject(new Error("connection failed")), close: () => closed++, send() {}, onMessage() {} }),
  });
  try {
    child.update({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: "0", peer: "" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(raised.filter((e) => e.type === "menu").map((e) => e.detail), [{ action: "duel-abort", n: "1" }]);
    assertEquals(closed, 1);
  } finally {
    child.destroy();
  }
});

Deno.test("a timed out connection raises a numbered abort only once", async () => {
  const realTimeout = globalThis.setTimeout;
  let timeout!: () => void;
  let reject!: (error: Error) => void;
  const open = new Promise<void>((_, fail) => { reject = fail; });
  const { child, raised } = mount({
    engine: duelEngine,
    iceServers: [],
    connect: () => ({ open, close: () => reject(new Error("closed")), send() {}, onMessage() {} }),
  });
  try {
    globalThis.setTimeout = ((callback: () => void, delay: number) => {
      if (delay === 15000) timeout = callback;
      return realTimeout(callback, delay);
    }) as typeof setTimeout;
    child.update({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: "0", peer: "" });
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  try {
    timeout();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(raised.filter((e) => e.type === "menu").map((e) => e.detail), [{ action: "duel-abort", n: "1" }]);
  } finally {
    child.destroy();
  }
});

Deno.test("a replaced connection cannot abort the current race", async () => {
  let reject!: (error: Error) => void;
  const open = new Promise<void>((_, fail) => { reject = fail; });
  const { child, raised } = mount({
    engine: duelEngine,
    iceServers: [],
    connect: () => ({ open, close() {}, send() {}, onMessage() {} }),
  });
  try {
    child.update({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: "0", peer: "" });
    child.update({ seed: "42", laps: "1", input: "car", clock: "hold" });
    reject(new Error("old connection failed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(raised.filter((e) => e.type === "menu"), []);
  } finally {
    child.destroy();
  }
});

// A terminal config without the list would race over host candidates alone,
// which connects in every dev and CI stack and fails only past a NAT.
Deno.test("an online race refuses a terminal config that carries no ICE servers", () => {
  const { child } = mount({ engine: duelEngine, connect: wire() });
  assertThrows(
    () => child.update({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: "0", peer: "" }),
    ProgramError,
    "an online race needs the terminal config's iceServers",
  );
  child.destroy();
});

Deno.test("an online race uses dynamic ICE servers from /rtc-ice when available", async () => {
  const dynamic = [{ urls: "turn:turn.example:3478", username: "u", credential: "c" }];
  const originalFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = (url: string) => {
    if (url === "/rtc-ice") return Promise.resolve(new Response(JSON.stringify(dynamic), { status: 200 }));
    return Promise.reject(new Error("not found"));
  };
  try {
    const asked: unknown[] = [];
    const connect = ({ iceServers }: { iceServers: unknown }) => {
      asked.push(iceServers);
      return { open: Promise.resolve(), send() {}, onMessage() {}, close() {} };
    };
    const { child } = mount({
      engine: duelEngine,
      iceServers: [{ urls: "stun:stun.example:3478" }],
      // deno-lint-ignore no-explicit-any
      connect: connect as any,
      rollback: () => Promise.resolve({ start() {}, stop() {}, dispose() {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    child.update({ seed: "41", laps: "1", input: "car", clock: "play", mode: "online", seat: "0", peer: "" });
    assertEquals(asked, [dynamic], "channel used dynamic ICE servers fetched from /rtc-ice");
    child.destroy();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
