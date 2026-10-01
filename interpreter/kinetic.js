// Kinetic Host: Fixed-step deterministic tick engine, snapshot history,
// and time-travel controller for Omnishell.
// Decouples kinetic simulation ticks from display rendering refresh rates.

export { prngStep, createPrng } from "./prng.js";

const MAX_FRAME_MS = 250.0;

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

    if (snapshots.size > historyLimit) {
      const oldest = minTick();
      snapshots.delete(oldest);
      inputLog.delete(oldest);
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
    const snap = engine.saveState(next);
    onStep?.(next, currentTick + 1);
    previousState = currentState;
    currentTick++;
    commitSnapshot(currentTick, snap, input);
    currentState = engine.loadState(snap);
    displayTick = currentTick;
    onCommit?.(currentState, currentTick);
    return currentState;
  }

  function pump(elapsedMs) {
    if (!isPlaying) return;
    accumulator += Math.min(MAX_FRAME_MS, elapsedMs);
    while (accumulator >= tickDurationMs) {
      const input = getInput();
      stepOnce(input);
      accumulator -= tickDurationMs;
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
      currentState = engine.loadState(snap);
      previousState = currentState;
      commitSnapshot(0, snap, {});
      onRender(currentState, currentState, 1.0, 0, false);
      controlsSyncFn?.();
      return currentState;
    },

    mountControls(container) {
      if (!container) throw new Error("mountControls: container element is required");
      container.innerHTML = `
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
      `;

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
        container.innerHTML = "";
      };
    }
  };
}
