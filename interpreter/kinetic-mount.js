// The kinetic child (pronto's kinetic-machine record): a screen's
// `data-kinetic="<actor>"` mount, where the terminal hosts the race a Cortex
// `via: "kinetic"` actor declares — its engine and sound graphs in the cage,
// its presenter in its worker, its input mappers on the window.
//
// The race reaches the DOM plane only as events on the mount the region's
// `data-on-*` hands its reduce: each milestone the host lifts at a confirmed
// frame (`milestone`), each menu press between races (`menu`), for a duel
// raced over a channel this side's session description (`describe`), and the
// end of a replay (`replayed`). The row reaches the race only as the mount's
// props: a new `seed` is a new race, `input` says whether the car or the menu
// reads the keys, and `clock` holds the race or plays it; `mode: online`
// races the row's `seat` against the peer whose description `peer` carries;
// `replay` plays windows of the race back from its lifted rows (pronto's
// kinetic-machine record, time travel across the planes).
import { ProgramError } from "./fragment.js";
import { evaluateEngine } from "./jessie.js";
import { attachTouch, createKineticHost, createKineticInput } from "./kinetic.js";
import { unpackInputs } from "./kinetic-milestones.js";
import { createSoundSeat } from "./kinetic-sound.js";
import { createRtcChannel } from "./rtc-channel.js";

/** What a kinetic child's engine exports past the host's four: the row's
 * props as its options and its view, a mapper's poll as its command, the
 * command's bytes and milestones a lift carries, and the milestone kinds
 * whose rows carry their frame's state. */
export const CHILD_EXPORTS = ["optionsOf", "viewOf", "commandOf", "commandWidth", "encodeCommand", "decodeCommand", "milestones", "milestoneSnapshots"];
/** What a kinetic child's sound role returns from `createSound`. */
export const SOUND_EXPORTS = ["frame", "props", "levels", "resume"];
/** What a duel raced over a channel asks of the engine: a seat's input as the
 * byte that crosses, and both seats' bytes as a frame's command. */
export const DUEL_EXPORTS = ["encodeInput", "decodeInputs"];
const loadSession = (options) => import("./kinetic-session.js").then(({ createRollbackHost }) => createRollbackHost(options));

/**
 * Wires a loaded engine, sound and presenter to `el`. `decl` is the actor as
 * shell.json carries it: `bindings` the car's, `seats` each hot-seat car's,
 * `menu` the presses the row reads between races and `pause` the one it reads
 * during them. An online race's channel is `connect`'s (rtc-channel.js), over
 * the terminal config's `iceServers`, and its GGRS session `rollback`'s
 * (kinetic-session.js). The screen's touch zones are `track`'s, one tracker
 * every mapper listens to (docs/kinetic.md "Touch").
 * @param {HTMLElement} el
 * @param {{decl: any, engine: any, sound: any, closeSound?: (() => Promise<unknown>) | null, presenter: any, makeInput?: typeof createKineticInput,
 *   schedule?: (fn: FrameRequestCallback) => number, cancel?: (id: number) => void, syncTest?: number,
 *   iceServers?: RTCIceServer[], connect?: typeof createRtcChannel, rollback?: (options: any) => Promise<any>, track?: typeof attachTouch}} opts
 */
export function kineticChild(el, { decl, engine, sound, closeSound = null, presenter, makeInput = createKineticInput, schedule, cancel, syncTest = 0, iceServers, connect = createRtcChannel, rollback = loadSession, track = attachTouch }) {
  const missing = CHILD_EXPORTS.filter((name) => engine[name] === undefined);
  if (missing.length > 0) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: its engine exports no ${missing.join(", ")}`);
  const unsounded = sound === null ? [] : SOUND_EXPORTS.filter((name) => typeof sound[name] !== "function");
  if (unsounded.length > 0) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: its sound role answers no ${unsounded.join(", ")}`);
  const tick = schedule ?? requestAnimationFrame;
  const untick = cancel ?? cancelAnimationFrame;
  let effectiveIce = iceServers;
  if (Array.isArray(iceServers) && typeof fetch === "function") {
    fetch("/rtc-ice")
      .then((r) => r.ok ? r.json() : null)
      .then((dynamic) => {
        if (Array.isArray(dynamic) && dynamic.length > 0) effectiveIce = dynamic;
      })
      .catch(() => {});
  }
  /** @type {Record<string, string>} */
  let props = {};
  let race = null;
  let frames = 0;
  let holding = false;
  let disposed = false;
  // The duel raced over a channel, while the row races one.
  let duel = null;

  const raise = (type, detail) => el.dispatchEvent(new el.ownerDocument.defaultView.CustomEvent(type, { bubbles: false, detail: Object.freeze(detail) }));
  const hotseat = () => props.mode === "hotseat";
  const view = (state) => engine.viewOf(state, props);

  const screen = el.closest("[data-screen]");
  if (screen === null) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: its mount sits in no [data-screen], whose touch zones it reads`);
  const touch = track(screen);
  const car = makeInput({ element: el, bindings: decl.bindings, touch });
  const seats = (decl.seats ?? []).map((bindings) => makeInput({ element: el, bindings, touch }));
  const menu = makeInput({ element: el, bindings: { ...decl.menu, pause: decl.pause }, touch });
  let pressed = 0;
  for (const action of [...Object.keys(decl.menu), "pause"]) {
    menu.inputs.down.on(action, () => {
      if (action !== "pause" && props.input !== "menu") return;
      raise("menu", { action, n: String(++pressed) });
    });
  }
  // A gamepad is read by polling: the menu's is polled every animation frame,
  // held race or none. A held race's last frame keeps its sound role
  // hearing it, so what plays on, plays on.
  let polling = 0;
  let seen = null;
  const playing = () => (duel === null ? host.isPlaying() : duel.host !== null && !holding);
  const poll = () => {
    menu.poll();
    if (seen !== null && !playing()) sound?.frame(seen);
    polling = tick(poll);
  };

  const clear = () => {
    car.clear();
    for (const seat of seats) seat.clear();
  };
  // A committed frame is heard, unless the presenter is reading a stage's
  // art: then the race holds until it has, and whichever race the row runs
  // by then plays again — a new seed may have replaced the one that held.
  // Art that cannot load is the presenter's failure, which its seat throws.
  const resume = () => {
    if (duel !== null) duel.host?.start();
    else if (props.clock !== "hold") host.play();
  };
  const committed = (state, hold) => {
    if (holding) return;
    if (presenter.reading > 0) {
      holding = true;
      hold();
      el.dataset.kineticLoading = "";
      presenter.settled().then(() => {
        holding = false;
        delete el.dataset.kineticLoading;
        if (!disposed) resume();
      });
      return;
    }
    seen = view(state);
    sound?.frame(seen);
  };
  const render = (prev, curr, alpha, frame, historical) => {
    presenter.frame({ frame, state: view(curr ?? prev), prev: view(prev), alpha, historical, levels: sound ? sound.levels() : [] });
    frames++;
    if (frames > 1 && presenter.reading === 0) el.dataset.kineticReady = "";
  };
  const host = createKineticHost({
    engine,
    rateHz: engine.rateHz ?? 60,
    historyLimit: 1200,
    syncTest,
    schedule: tick,
    cancel: untick,
    milestones: {
      width: engine.commandWidth,
      encode: engine.encodeCommand,
      decode: engine.decodeCommand,
      snapshots: engine.milestoneSnapshots,
      onLift: (row) => raise("milestone", { race: String(race), ...row }),
    },
    // Only the car the row hands the input to is driven; between races it
    // gets a released stick, and what was pressed meanwhile is dropped.
    getInput: () => {
      if (props.input !== "car") {
        clear();
        return hotseat() ? seats.map(() => engine.commandOf({})) : engine.commandOf({});
      }
      return hotseat() ? seats.map((seat) => engine.commandOf(seat.poll())) : engine.commandOf(car.poll());
    },
    onCommit: (state) => committed(state, () => host.pause()),
    onRender: render,
  });

  // A duel raced over a channel (pronto's kinetic-machine record): GGRS's
  // session on this side's `seat`, the peer's input arriving over a data
  // channel whose two descriptions the row's machine carries. This side's
  // goes out as a `describe` event once its ICE gathering completes; the
  // peer's comes in as the `peer` prop. Its milestones lift at GGRS's
  // confirmed frame, both seats' bytes a frame.
  const goOnline = (seed) => {
    const missing = DUEL_EXPORTS.filter((name) => typeof engine[name] !== "function");
    if (missing.length > 0) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: an online race needs its engine to export ${missing.join(", ")}`);
    const seat = Number(props.seat);
    if (seat !== 0 && seat !== 1) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: seat ${JSON.stringify(props.seat)} is no duel seat`);
    if (!Array.isArray(iceServers)) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: an online race needs the terminal config's iceServers, which it does not carry`);
    let answer = null;
    let heard = "";
    const session = {
      seed,
      host: null,
      closed: false,
      channel: connect({
        initiator: seat === 0,
        iceServers: effectiveIce,
        signal: {
          send: (description) => raise("describe", { race: String(seed), description: JSON.stringify(description) }),
          onDescription: (handler) => {
            answer = handler;
          },
        },
      }),
      /** The peer's description, once the row carries it. */
      peer(text) {
        if (!text || text === heard) return;
        heard = text;
        answer(JSON.parse(text));
      },
    };
    session.peer(props.peer);
    el.dataset.kineticConnecting = "";
    session.connectTimer = setTimeout(() => {
      if (!session.closed && session.host === null) {
        delete el.dataset.kineticConnecting;
        session.closed = true;
        session.channel.close();
        raise("menu", { action: "duel-abort", n: String(++pressed) });
      }
    }, 15000);
    if (typeof session.connectTimer?.unref === "function") session.connectTimer.unref();
    else if (typeof globalThis.Deno?.unrefTimer === "function") globalThis.Deno.unrefTimer(session.connectTimer);
    session.channel.open
      .then(() => {
        clearTimeout(session.connectTimer);
        delete el.dataset.kineticConnecting;
        return rollback({
          engine,
          seed,
          initOptions: engine.optionsOf(props),
          seat,
          channel: session.channel,
          encode: engine.encodeInput,
          decode: engine.decodeInputs,
          schedule: tick,
          cancel: untick,
          milestones: { onLift: (row) => raise("milestone", { race: String(seed), ...row }) },
          getInput: () => {
            if (props.input === "car") return engine.commandOf(car.poll());
            car.clear();
            return engine.commandOf({});
          },
          onCommit: (state) => committed(state, () => session.host.stop()),
          onRender: render,
        });
      })
      .then((started) => {
        if (session.closed) return started.dispose();
        session.host = started;
        started.start();
      })
      .catch(() => {
        if (session.closed) return;
        clearTimeout(session.connectTimer);
        delete el.dataset.kineticConnecting;
        session.closed = true;
        session.channel.close();
        raise("menu", { action: "duel-abort", n: String(++pressed) });
      });
    return session;
  };
  // A replay (the row's `replay`): windows of this race, each loaded at a
  // lifted milestone that carries its frame's state, held to its checksum,
  // then played at the race's rate on the commands its next milestone lifted.
  // It plays on a host of its own, so the race's head stands; the presenter
  // is handed each frame with its `cut`, `{index, count, from, frames}`.
  let playback = null;
  const replay = (plan) => {
    const { windows } = plan;
    let cut = null;
    let commands = [];
    const player = createKineticHost({
      engine,
      seed: race,
      initOptions: engine.optionsOf(props),
      rateHz: engine.rateHz ?? 60,
      historyLimit: 2,
      schedule: tick,
      cancel: untick,
      milestones: { width: engine.commandWidth, encode: engine.encodeCommand, decode: engine.decodeCommand, snapshots: engine.milestoneSnapshots, onLift: () => {} },
      getInput: () => engine.decodeCommand(commands[player.getCurrentTick() - cut.from]),
      // A window on a stage whose art the presenter is reading holds until it has.
      onCommit: (_, frame) => {
        if (frame >= cut.from + cut.frames) {
          player.pause();
          session.next = tick(advance);
        } else if (presenter.reading > 0) {
          player.pause();
          presenter.settled().then(() => playback === session && player.play());
        }
      },
      onRender: (prev, curr, alpha, frame) => {
        presenter.frame({ frame, state: view(curr), prev: view(prev), alpha, historical: false, levels: sound ? sound.levels() : [], cut });
      },
    });
    const advance = () => {
      const index = cut === null ? 0 : cut.index + 1;
      if (index === windows.length) {
        stopReplay();
        raise("replayed", { race: String(race) });
        return;
      }
      const w = windows[index];
      commands = unpackInputs(w.commands, engine.commandWidth);
      if (commands.length < w.frames) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: replay window ${index} has ${commands.length} frames of commands for ${w.frames}`);
      cut = { index, count: windows.length, from: w.at.frame, frames: w.frames };
      player.loadMilestone([w.at], 0, race, engine.optionsOf(props));
      player.play();
    };
    const session = { player, next: tick(advance) };
    return session;
  };
  const stopReplay = () => {
    if (playback === null) return;
    untick(playback.next);
    playback.player.stop();
    playback = null;
    // The race's head is drawn again.
    host.seek(host.getCurrentTick());
  };

  const leave = () => {
    delete el.dataset.kineticConnecting;
    if (duel === null) return;
    clearTimeout(duel.connectTimer);
    duel.closed = true;
    duel.host?.dispose();
    duel.channel.close();
    duel = null;
  };

  polling = tick(poll);

  // A browser starts sound only from a gesture, and WebKit counts a touch's
  // end as one, not its start.
  const win = el.ownerDocument.defaultView;
  const unlock = () => sound?.resume();
  const GESTURES = ["keydown", "pointerdown", "pointerup", "click"];
  for (const type of GESTURES) win.addEventListener(type, unlock);
  // docs/kinetic.md "Touch": the switch an app's touch layout keys on.
  if (win.matchMedia("(pointer: coarse)").matches) screen.dataset.kineticTouch = "";
  const touched = (ev) => {
    if (ev.pointerType === "touch") screen.dataset.kineticTouch = "";
  };
  screen.addEventListener("pointerdown", touched, { passive: true });

  return {
    host,
    get frames() {
      return frames;
    },
    /** The row's props: a new seed resets the race from it. */
    update(next) {
      const was = props;
      props = next;
      sound?.props(next);
      if (next.input === "car" && was.input !== "car") clear();
      const fresh = next.seed !== was.seed;
      if (fresh || next.replay !== was.replay) stopReplay();
      if (next.replay && next.replay !== was.replay) playback = replay(JSON.parse(next.replay));
      if (fresh) {
        race = Number(next.seed);
        if (!Number.isInteger(race)) throw new ProgramError(`kinetic child ${el.dataset.kinetic}: seed ${JSON.stringify(next.seed)} is no integer`);
        leave();
        host.reset(race, engine.optionsOf(next));
        // The grid stands drawn until the session takes its first frame.
        if (next.mode === "online") duel = goOnline(race);
      }
      // An online race plays on the session's clock, which no row holds.
      if (duel !== null) return duel.peer(next.peer);
      // The clock acts when it turns, so a scrub or a step the host's own
      // controls made stands until the row says otherwise.
      if (holding || (!fresh && next.clock === was.clock)) return;
      if (next.clock === "hold") host.pause();
      else host.play();
    },
    destroy() {
      disposed = true;
      stopReplay();
      leave();
      untick(polling);
      for (const type of GESTURES) win.removeEventListener(type, unlock);
      screen.removeEventListener("pointerdown", touched, { passive: true });
      touch.detach();
      host.stop();
      for (const input of [car, menu, ...seats]) input.destroy();
      closeSound?.();
      presenter.destroy();
    },
  };
}

/**
 * Actor `name`'s child on `el`, once its graphs are loaded and its presenter
 * (already mounted on `el`) is up (kineticChild).
 * @param {HTMLElement} el
 * @param {{name: string, decl: any, presenter: any, appBase: string | URL, iceServers?: RTCIceServer[]}} opts
 */
export async function loadKinetic(el, { name, decl, presenter, appBase, iceServers }) {
  const graph = async (path, role) => {
    const res = await fetch(new URL(path, appBase));
    if (!res.ok) throw new ProgramError(`kinetic child ${name}: ${path} answered ${res.status}`);
    return evaluateEngine(await res.json(), role);
  };
  const [engine, voiced] = await Promise.all([
    graph(decl.engine, "engine"),
    decl.sound === undefined ? null : graph(decl.sound, "sound"),
    presenter.ready,
  ]);
  // `?synctest=N` runs the host's sync test, N frames back, as it plays.
  const syncTest = Number(new URLSearchParams(location.search).get("synctest") ?? 0);
  const seat = voiced && createSoundSeat(voiced);
  return kineticChild(el, { decl, engine, sound: seat && seat.role, closeSound: seat && seat.close, presenter, syncTest, iceServers });
}
