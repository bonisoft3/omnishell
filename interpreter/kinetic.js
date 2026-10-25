import { createMilestoneLift, loadMilestone } from "./kinetic-milestones.js";
import { parseMarkup } from "./markup.js";
// Kinetic Host: Fixed-step deterministic tick engine, snapshot history,
// and time-travel controller for Omnishell.
// Decouples kinetic simulation ticks from display rendering refresh rates.

export { prngStep, createPrng } from "./prng.js";
import { GameInputs } from "./vendor/game-inputs.js";
export { GameInputs };

export function lerp(a, b, alpha) {
  return a + (b - a) * alpha;
}

export function lerpAngle(a, b, alpha) {
  let diff = (b - a) % (Math.PI * 2);
  if (diff < -Math.PI) diff += Math.PI * 2;
  if (diff > Math.PI) diff -= Math.PI * 2;
  return a + diff * alpha;
}

const MAX_FRAME_MS = 250.0;

/** A snapshot as one string: object keys sorted, so two equal states that
 * built their objects in a different order still agree. */
export function canonical(value) {
  return JSON.stringify(value, (_, v) => (v !== null && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    : v));
}

/** cyrb53: a 53-bit hash of a string, a checksum and not a defence. */
export function checksum(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function createKineticHost(options) {
  const engine = options.engine;
  if (!engine) throw new Error("createKineticHost: engine is required");
  for (const m of ["initState", "advanceFrame", "saveState", "loadState"]) {
    if (typeof engine[m] !== "function") {
      throw new Error(`createKineticHost: engine.${m} is required`);
    }
  }

  const rateHz = options.rateHz ?? engine.rateHz ?? 60;
  if (!Number.isInteger(rateHz) || rateHz <= 0) {
    throw new RangeError(`createKineticHost: rateHz must be positive integer, got ${rateHz}`);
  }
  let currentRateHz = rateHz;
  let tickDurationMs = 1000.0 / currentRateHz;

  const historyLimit = options.historyLimit ?? 1000;
  if (!Number.isInteger(historyLimit) || historyLimit < 1) {
    throw new RangeError(`createKineticHost: invalid historyLimit ${historyLimit}`);
  }

  // Sync test (GGPO's SyncTestSession): after every tick, roll back this many
  // frames, load that snapshot, re-simulate the logged commands, and hold
  // each frame's checksum to the forward run's. Off at 0.
  const syncFrames = options.syncTest ?? 0;
  if (!Number.isInteger(syncFrames) || syncFrames < 0 || syncFrames >= historyLimit) {
    throw new RangeError(`createKineticHost: syncTest must be an integer in [0, ${historyLimit}), got ${syncFrames}`);
  }
  const sums = new Map();

  const seed = options.seed !== undefined ? options.seed : 0x1337;
  if (options.schedule && !options.cancel) {
    throw new Error("createKineticHost: cancel function is required when schedule is provided");
  }
  const onRender = options.onRender ?? (() => {});
  const onStep = options.onStep ?? null;
  const onCommit = options.onCommit ?? null;
  const onFault = options.onFault ?? null;
  const onBranch = options.onBranch ?? null;
  const onReset = options.onReset ?? null;
  // `milestones: {width, encode, decode, onLift, snapshots}` lifts the engine's
  // milestones (kinetic-milestones.js): a host steps one seat with all its
  // input here, so every committed frame is confirmed as it is taken.
  const lifting = options.milestones ?? null;
  const lift = (from) => lifting && createMilestoneLift({ engine, width: lifting.width, onLift: lifting.onLift, snapshots: lifting.snapshots, from });
  let lifter = lift(0);
  const getInput = options.getInput ?? (() => ({}));
  const schedule = options.schedule ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
  const cancel = options.cancel ?? (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : null);

  let initOptions = options.initOptions ?? {};
  let currentState = engine.initState(seed, initOptions);
  let previousState = currentState;
  let currentTick = 0;
  let displayTick = 0;
  let isPlaying = false;

  const snapshots = new Map();
  const inputLog = new Map();

  const minTick = () => snapshots.keys().next().value;

  function commitSnapshot(tick, snap, input) {
    snapshots.set(tick, snap);
    if (input !== undefined) inputLog.set(tick, { ...input });
    if (syncFrames) sums.set(tick, checksum(canonical(snap)));

    if (snapshots.size > historyLimit) {
      const oldest = minTick();
      snapshots.delete(oldest);
      inputLog.delete(oldest);
      sums.delete(oldest);
    }
  }

  /** The sync test over the frames up to `tick`, which fails on the first
   * frame whose re-simulation the forward run disagrees with. */
  function syncTest(tick) {
    const from = tick - syncFrames;
    if (!snapshots.has(from)) return;
    let state = engine.loadState(snapshots.get(from));
    for (let t = from + 1; t <= tick; t++) {
      state = engine.advanceFrame(state, inputLog.get(t));
      const again = checksum(canonical(engine.saveState(state)));
      if (again !== sums.get(t)) {
        throw new Error(`kinetic sync test: frame ${t}, re-simulated from ${from}, has checksum ${again}; the forward run had ${sums.get(t)}`);
      }
    }
  }

  function recordSnapshot(tick, state, input) {
    const snap = engine.saveState(state);
    commitSnapshot(tick, snap, input);
    return snap;
  }

  recordSnapshot(0, currentState, {});

  let accumulator = 0;
  let lastTime = null;
  let animId = null;
  let controlsSyncFn = null;

  function stepOnce(input) {
    const next = engine.advanceFrame(currentState, input);
    if (lifter) {
      lifter.observe(currentTick + 1, next, lifting.encode(input));
      lifter.confirm(currentTick + 1);
    }
    const snap = engine.saveState(next);
    onStep?.(next, currentTick + 1);
    previousState = currentState;
    currentTick++;
    commitSnapshot(currentTick, snap, input);
    if (syncFrames) syncTest(currentTick);
    currentState = engine.loadState(snap);
    displayTick = currentTick;
    onCommit?.(currentState, currentTick);
    return currentState;
  }

  function pump(elapsedMs) {
    if (!isPlaying) return;
    accumulator += Math.min(MAX_FRAME_MS, elapsedMs);
    // A commit may pause the host, which zeroes what is still due; the tick
    // is spent first, so that zero stands and the render takes no alpha < 0.
    while (isPlaying && accumulator >= tickDurationMs) {
      const input = getInput();
      accumulator -= tickDurationMs;
      stepOnce(input);
    }
    const alpha = accumulator / tickDurationMs;
    onRender(previousState, currentState, alpha, currentTick, false);
    controlsSyncFn?.();
  }

  function tickLoop(now) {
    if (lastTime === null) lastTime = now;
    const elapsed = now - lastTime;
    lastTime = now;

    try {
      pump(elapsed);
    } catch (err) {
      isPlaying = false;
      animId = null;
      controlsSyncFn?.();
      onFault?.(err);
      throw err;
    }

    if (isPlaying && schedule) {
      animId = schedule(tickLoop);
    } else {
      animId = null;
    }
  }

  return {
    start() {
      if (animId) return;
      if (!schedule) {
        throw new Error("createKineticHost.start: schedule function (e.g. requestAnimationFrame) is required");
      }
      lastTime = null;
      accumulator = 0;
      isPlaying = true;
      animId = schedule(tickLoop);
    },

    stop() {
      isPlaying = false;
      if (animId && cancel) {
        cancel(animId);
      }
      animId = null;
      controlsSyncFn?.();
    },

    pause() {
      isPlaying = false;
      if (animId && cancel) {
        cancel(animId);
      }
      animId = null;
      accumulator = 0;
      controlsSyncFn?.();
    },

    play() {
      if (isPlaying && animId) return;
      if (displayTick < currentTick) {
        this.seek(currentTick);
      }
      isPlaying = true;
      lastTime = null;
      accumulator = 0;
      if (!animId && schedule) {
        animId = schedule(tickLoop);
      }
      controlsSyncFn?.();
    },

    togglePlay() {
      if (isPlaying) this.pause();
      else this.play();
      return isPlaying;
    },

    setRateHz(newRate) {
      if (!Number.isInteger(newRate) || newRate <= 0) {
        throw new RangeError(`setRateHz: rate must be positive integer, got ${newRate}`);
      }
      currentRateHz = newRate;
      tickDurationMs = 1000.0 / currentRateHz;
      accumulator = 0;
    },

    getRateHz() {
      return currentRateHz;
    },

    pump(elapsedMs) {
      try {
        pump(elapsedMs);
      } catch (err) {
        this.pause();
        onFault?.(err);
        throw err;
      }
    },

    stepTick(cmd) {
      this.pause();
      if (displayTick < currentTick) {
        throw new RangeError(`stepTick: display ${displayTick} is behind head ${currentTick}; play() or branch() first`);
      }
      try {
        const input = cmd !== undefined ? cmd : getInput();
        const next = stepOnce(input);
        onRender(previousState, next, 1.0, currentTick, false);
        controlsSyncFn?.();
        return next;
      } catch (err) {
        onFault?.(err);
        throw err;
      }
    },

    seek(tick) {
      if (!Number.isInteger(tick)) {
        throw new RangeError(`seek: tick must be an integer, got ${tick}`);
      }
      const min = this.getMinTick();
      const max = currentTick;
      if (tick < min || tick > max) {
        throw new RangeError(`seek: tick ${tick} out of bounds [${min}, ${max}]`);
      }

      const snapshot = snapshots.get(tick);
      if (!snapshot) {
        throw new Error(`seek: missing snapshot for tick ${tick}`);
      }

      displayTick = tick;
      const restored = engine.loadState(snapshot);
      const isHistorical = displayTick < currentTick;

      onRender(restored, restored, 1.0, displayTick, isHistorical);
      controlsSyncFn?.();
      return restored;
    },

    stepBackward(n = 1) {
      this.pause();
      return this.seek(Math.max(this.getMinTick(), displayTick - n));
    },

    stepForward(n = 1) {
      this.pause();
      if (displayTick < currentTick) {
        return this.seek(Math.min(currentTick, displayTick + n));
      }
      return this.stepTick();
    },

    branch(tick) {
      lifter?.rewind(tick);
      onBranch?.(tick);
      this.pause();
      const restored = this.seek(tick);
      currentTick = displayTick;
      currentState = restored;
      previousState = restored;

      for (const k of [...snapshots.keys()]) {
        if (k > currentTick) {
          snapshots.delete(k);
          inputLog.delete(k);
          sums.delete(k);
        }
      }
      controlsSyncFn?.();
      return currentState;
    },

    getCurrentTick() {
      return currentTick;
    },

    getDisplayTick() {
      return displayTick;
    },

    getMinTick() {
      return minTick();
    },

    isPlaying() {
      return isPlaying;
    },

    getInputLog(tick) {
      return inputLog.get(tick);
    },

    getState() {
      if (displayTick < currentTick) {
        const snap = snapshots.get(displayTick);
        if (!snap) {
          throw new Error(`getState: missing snapshot for displayTick ${displayTick}`);
        }
        return engine.loadState(snap);
      }
      return engine.loadState(engine.saveState(currentState));
    },

    getStats() {
      return {
        currentTick,
        displayTick,
        minTick: this.getMinTick(),
        maxTick: currentTick,
        historyCount: snapshots.size,
        historyLimit,
        isPlaying,
        rateHz: currentRateHz
      };
    },

    reset(newSeed = seed, newOptions = initOptions) {
      onReset?.();
      const fresh = engine.initState(newSeed, newOptions);
      const snap = engine.saveState(fresh);
      this.stop();
      initOptions = newOptions;
      currentTick = 0;
      displayTick = 0;
      accumulator = 0;
      lastTime = null;
      isPlaying = false;
      snapshots.clear();
      inputLog.clear();
      sums.clear();
      currentState = engine.loadState(snap);
      previousState = currentState;
      commitSnapshot(0, snap, {});
      lifter = lift(0);
      onRender(currentState, currentState, 1.0, 0, false);
      controlsSyncFn?.();
      return currentState;
    },

    /** The race at lifted milestone `rows[i]` (of a run begun at `seed`),
     * its snapshot or the replay of every milestone's commands up to it, held
     * to the row's checksum: the head, and the ring's only frame. */
    loadMilestone(rows, i, newSeed = seed, newOptions = initOptions) {
      if (!lifting) throw new Error("loadMilestone: this host lifts no milestones");
      const at = loadMilestone(engine, { seed: newSeed, initOptions: newOptions, decode: lifting.decode }, rows, i);
      const snap = engine.saveState(at);
      this.stop();
      initOptions = newOptions;
      currentTick = rows[i].frame;
      displayTick = currentTick;
      accumulator = 0;
      lastTime = null;
      snapshots.clear();
      inputLog.clear();
      sums.clear();
      currentState = engine.loadState(snap);
      previousState = currentState;
      commitSnapshot(currentTick, snap, {});
      lifter = lift(currentTick);
      onRender(currentState, currentState, 1.0, currentTick, false);
      controlsSyncFn?.();
      return currentState;
    },

    mountControls(container) {
      if (!container) throw new Error("mountControls: container element is required");
      container.replaceChildren(parseMarkup(container.ownerDocument, `
        <div class="kinetic-controls">
          <div class="kc-playback">
            <button type="button" class="kc-btn kc-play">PAUSE</button>
            <button type="button" class="kc-btn kc-prev" title="Step Back">◀</button>
            <button type="button" class="kc-btn kc-next" title="Step Forward">▶</button>
          </div>

          <div class="kc-timeline">
            <span class="kc-min-tick">0</span>
            <input type="range" class="kc-scrubber" min="0" max="0" value="0">
            <span class="kc-cur-tick">T: 0</span>
          </div>

          <div class="kc-status">
            <span class="kc-live-badge">LIVE</span>
            <span class="kc-rate-badge">${currentRateHz} Hz</span>
          </div>
        </div>
      `));

      const btnPlay = container.querySelector(".kc-play");
      const btnPrev = container.querySelector(".kc-prev");
      const btnNext = container.querySelector(".kc-next");
      const scrubber = container.querySelector(".kc-scrubber");
      const lblMin = container.querySelector(".kc-min-tick");
      const lblCur = container.querySelector(".kc-cur-tick");
      const badgeLive = container.querySelector(".kc-live-badge");

      const updateUI = () => {
        const stats = this.getStats();
        lblMin.textContent = String(stats.minTick);
        lblCur.textContent = `T: ${stats.displayTick}`;
        scrubber.min = String(stats.minTick);
        scrubber.max = String(stats.maxTick);
        scrubber.value = String(stats.displayTick);

        if (stats.isPlaying) {
          btnPlay.textContent = "PAUSE";
          btnPlay.classList.add("playing");
          btnPlay.classList.remove("paused");
        } else {
          btnPlay.textContent = "PLAY";
          btnPlay.classList.add("paused");
          btnPlay.classList.remove("playing");
        }

        if (stats.displayTick < stats.maxTick) {
          badgeLive.textContent = "TIME-TRAVEL";
          badgeLive.classList.add("historical");
          badgeLive.classList.remove("live");
        } else {
          badgeLive.textContent = "LIVE";
          badgeLive.classList.add("live");
          badgeLive.classList.remove("historical");
        }
      };

      controlsSyncFn = updateUI;

      btnPlay.addEventListener("click", () => {
        this.togglePlay();
        updateUI();
      });

      btnPrev.addEventListener("click", () => {
        this.stepBackward(1);
        updateUI();
      });

      btnNext.addEventListener("click", () => {
        this.stepForward(1);
        updateUI();
      });

      scrubber.addEventListener("input", (e) => {
        const val = parseInt(e.target.value, 10);
        this.pause();
        this.seek(val);
        updateUI();
      });

      updateUI();

      return () => {
        controlsSyncFn = null;
        container.replaceChildren();
      };
    }
  };
}

// Touch, the input mapper's third source: docs/kinetic.md "Touch" is the
// contract.

export const TOUCH_ZONE = "data-touch-zone";
export const TOUCH_PREFIX = "touch:";

// What makes a zone a key to the browser: touch-action alone stops its pan
// and zoom (a pointerdown's preventDefault does not), so the platform sets
// it rather than each app's stylesheet.
const ZONE_CSS = `[${TOUCH_ZONE}] { touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }`;
const zoned = new WeakSet();
function adoptZoneStyle(doc) {
  if (zoned.has(doc)) return;
  const sheet = new doc.defaultView.CSSStyleSheet();
  sheet.replaceSync(ZONE_CSS);
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  zoned.add(doc);
}

/** The zones under a pointer event: the topmost element's nearest zone
 * within `root`; a sliding pointer enters no `data-touch-tap` zone. */
function zonesUnder(root) {
  return (ev, sliding) => {
    const hit = root.ownerDocument.elementFromPoint(ev.clientX, ev.clientY)?.closest(`[${TOUCH_ZONE}]`);
    if (!hit || !root.contains(hit) || (sliding && hit.hasAttribute("data-touch-tap"))) return [];
    return hit.getAttribute(TOUCH_ZONE).split(/\s+/).filter(Boolean);
  };
}

/**
 * The touch tracker of `root`, one per root however many mappers read it:
 * each `listen(press)` hears `press(code, down, ev)` once a zone is first
 * held and once it is last let go, and returns its unlisten.
 * @param {Element} root
 * @param {{zonesAt?: (ev: PointerEvent, sliding: boolean) => string[]}} [opts]
 */
export function attachTouch(root, { zonesAt = zonesUnder(root) } = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  adoptZoneStyle(doc);
  /** @type {Set<(code: string, down: boolean, ev: Event) => void>} */
  const listeners = new Set();
  /** @type {Map<number, string[]>} */
  const pointers = new Map();
  /** @type {Map<string, number>} */
  const held = new Map();
  let shown = "";

  const show = () => {
    const now = [...held.keys()].join(" ");
    if (now === shown) return;
    shown = now;
    root.setAttribute("data-touch-held", now);
  };
  const press = (zone, down, ev) => {
    for (const listener of listeners) listener(TOUCH_PREFIX + zone, down, ev);
  };
  const hold = (zone, ev) => {
    const n = (held.get(zone) ?? 0) + 1;
    held.set(zone, n);
    if (n === 1) press(zone, true, ev);
  };
  const letGo = (zone, ev) => {
    const n = held.get(zone) - 1;
    if (n > 0) return held.set(zone, n);
    held.delete(zone);
    press(zone, false, ev);
  };
  // Entered before left, so a slide between two zones that share one keeps
  // it held throughout.
  const place = (id, zones, ev) => {
    const was = pointers.get(id);
    for (const zone of zones) if (!was.includes(zone)) hold(zone, ev);
    for (const zone of was) if (!zones.includes(zone)) letGo(zone, ev);
    pointers.set(id, zones);
    show();
  };
  const lift = (id, ev) => {
    place(id, [], ev);
    pointers.delete(id);
  };

  const down = (ev) => {
    const zones = zonesAt(ev, false);
    if (zones.length === 0) return;
    if (ev.cancelable) ev.preventDefault();
    root.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, []);
    place(ev.pointerId, zones, ev);
  };
  const move = (ev) => {
    if (pointers.has(ev.pointerId)) place(ev.pointerId, zonesAt(ev, true), ev);
  };
  const up = (ev) => {
    if (pointers.has(ev.pointerId)) lift(ev.pointerId, ev);
  };
  // What GameInputs releases its keys on.
  const releaseAll = (ev) => {
    for (const id of [...pointers.keys()]) lift(id, ev);
  };
  const hidden = (ev) => {
    if (doc.hidden) releaseAll(ev);
  };

  const wired = [
    [root, "pointerdown", down, { passive: false }],
    [root, "pointermove", move, { passive: true }],
    [root, "pointerup", up, { passive: true }],
    [root, "pointercancel", up, { passive: true }],
    [root, "lostpointercapture", up, { passive: true }],
    [win, "blur", releaseAll, false],
    [doc, "visibilitychange", hidden, false],
  ];
  for (const [target, type, fn, opts] of wired) target.addEventListener(type, fn, opts);
  return {
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    detach() {
      for (const [target, type, fn, opts] of wired) target.removeEventListener(type, fn, opts);
    },
  };
}

/**
 * Creates a unified kinetic input manager with virtual action bindings,
 * edge latching, blur clearing, macOS meta key handling, Gamepad API support,
 * and with `touch`, an attachTouch tracker's zones as `touch:<zone>` keys.
 * @param {object} options
 * @param {HTMLElement|Document} [options.element]
 * @param {Record<string, string[]>} [options.bindings]
 * @param {boolean} [options.preventDefaults=true]
 * @param {boolean} [options.gamepad=true]
 * @param {ReturnType<typeof attachTouch>} [options.touch]
 */
export function createKineticInput(options = {}) {
  const inputs = new GameInputs(options.element, {
    preventDefaults: options.preventDefaults ?? true,
    gamepad: options.gamepad !== false,
  });

  const bindings = options.bindings || {};
  const latched = new Set();
  const unlisten = options.touch?.listen((code, down, ev) => inputs._handleKeyEvent(code, down, ev)) ?? (() => {});

  function registerBinding(action, ...keys) {
    inputs.bind(action, ...keys);
    inputs.down.on(action, () => {
      latched.add(action);
    });
  }

  for (const [action, keys] of Object.entries(bindings)) {
    registerBinding(action, ...(Array.isArray(keys) ? keys : [keys]));
  }

  return {
    inputs,
    bind: registerBinding,
    unbind: (action) => inputs.unbind(action),
    getBindings: () => inputs.getBindings(),
    isDown: (action) => !!inputs.state[action],
    wasPressed: (action) => (inputs.pressCount[action] || 0) > 0 || latched.has(action),
    poll: () => {
      /** @type {Record<string, boolean>} */
      const state = {};
      for (const action in inputs.state) {
        state[action] = !!inputs.state[action] || latched.has(action);
      }
      latched.clear();
      inputs.tick();
      return state;
    },
    clear: () => {
      latched.clear();
      for (const action in inputs.state) {
        inputs.state[action] = false;
      }
      for (const action in inputs.pressCount) {
        inputs.pressCount[action] = 0;
      }
    },
    destroy: () => {
      unlisten();
      inputs.destroy();
    },
  };
}
