// Standalone ESM build of game-inputs (Andy Hall / ISC License)
// Augmented with dual code/key fallback, Gamepad API polling, and destroy() cleanup.

class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this._listeners.get(event);
    if (!list) return this;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }

  emit(event, ...args) {
    const list = this._listeners.get(event);
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      list[i](...args);
    }
    return true;
  }
}

function DefaultOptions() {
  this.preventDefaults = false;
  this.stopPropagation = false;
  this.allowContextMenu = false;
  this.disabled = false;
  this.gamepad = true;
}

export class GameInputs {
  /**
   * Abstract key, mouse, and gamepad inputs manager.
   * @param {HTMLElement|Document} domElement
   * @param {object} options
   */
  constructor(domElement, options) {
    const opts = Object.assign({}, new DefaultOptions(), options || {});

    this.element = domElement || (typeof document !== "undefined" ? document : null);
    this.preventDefaults = !!opts.preventDefaults;
    this.stopPropagation = !!opts.stopPropagation;
    this.allowContextMenu = !!opts.allowContextMenu;
    this.disabled = !!opts.disabled;
    this.enableGamepad = opts.gamepad !== false;

    this.filterEvents = (ev, bindingName) => true;

    this.down = new EventEmitter();
    this.up = new EventEmitter();

    /** @type {Record<string, boolean>} */
    this.state = {};
    this.pointerState = {
      dx: 0,
      dy: 0,
      scrollx: 0,
      scrolly: 0,
      scrollz: 0,
    };
    /** @type {Record<string, number>} */
    this.pressCount = {};
    /** @type {Record<string, number>} */
    this.releaseCount = {};

    this._keyBindmap = {};
    this._keyStates = {};
    this._bindPressCount = {};
    this._touches = { lastX: 0, lastY: 0, currID: null };
    this._pressedDuringMeta = {};
    this._gamepadStates = {};
    this._cleanups = [];

    if (typeof window !== "undefined") {
      this._initEvents();
    }
  }

  bind(bindingName, ...keys) {
    keys.forEach((code) => {
      const normalized = String(code).toLowerCase();
      const bindings = this._keyBindmap[normalized] || [];
      if (!bindings.includes(bindingName)) {
        bindings.push(bindingName);
      }
      this._keyBindmap[normalized] = bindings;

      // Also record verbatim code (e.g. "KeyW", "ArrowUp")
      if (code !== normalized) {
        const verbatimBindings = this._keyBindmap[code] || [];
        if (!verbatimBindings.includes(bindingName)) {
          verbatimBindings.push(bindingName);
        }
        this._keyBindmap[code] = verbatimBindings;
      }
    });

    this.state[bindingName] = !!this.state[bindingName];
    this.pressCount[bindingName] = this.pressCount[bindingName] || 0;
    this.releaseCount[bindingName] = this.releaseCount[bindingName] || 0;
  }

  unbind(bindingName) {
    for (const code in this._keyBindmap) {
      const bindings = this._keyBindmap[code];
      const i = bindings.indexOf(bindingName);
      if (i > -1) bindings.splice(i, 1);
    }
  }

  getBindings() {
    const res = {};
    for (const code in this._keyBindmap) {
      const bindings = this._keyBindmap[code];
      bindings.forEach((bindingName) => {
        res[bindingName] = res[bindingName] || [];
        if (!res[bindingName].includes(code)) res[bindingName].push(code);
      });
    }
    return res;
  }

  tick() {
    this._pollGamepads();
    zeroAllProperties(this.pointerState);
    zeroAllProperties(this.pressCount);
    zeroAllProperties(this.releaseCount);
  }

  destroy() {
    for (const fn of this._cleanups) fn();
    this._cleanups.length = 0;
  }

  _initEvents() {
    const onKey = (isDown, ev) => {
      if (ev.isComposing) return;
      this._handleKeyEvent(ev.code, isDown, ev);
      if (ev.key) this._handleKeyEvent(ev.key.toLowerCase(), isDown, ev);
      this._workaroundMacBug(isDown, ev);
    };

    const keydownHandler = (ev) => onKey(true, ev);
    const keyupHandler = (ev) => onKey(false, ev);
    window.addEventListener("keydown", keydownHandler, false);
    window.addEventListener("keyup", keyupHandler, false);
    this._cleanups.push(() => {
      window.removeEventListener("keydown", keydownHandler, false);
      window.removeEventListener("keyup", keyupHandler, false);
    });

    const pointerOpts = { passive: true };
    const onPointer = (isDown, ev) => {
      if ("pointerId" in ev) {
        if (isDown) {
          if (this._touches.currID !== null) return;
          this._touches.currID = ev.pointerId;
        } else {
          if (this._touches.currID !== ev.pointerId) return;
          this._touches.currID = null;
        }
      }
      const button = "button" in ev ? ev.button + 1 : 1;
      this._handleKeyEvent("mouse" + button, isDown, ev);
    };

    const onPointerMove = (ev) => {
      if ("pointerId" in ev && this._touches.currID !== null) {
        if (this._touches.currID !== ev.pointerId) return;
      }
      const dx = ev.movementX || ev.mozMovementX || 0;
      const dy = ev.movementY || ev.mozMovementY || 0;
      this.pointerState.dx += dx;
      this.pointerState.dy += dy;
    };

    const targetEl = this.element || window;
    if (typeof window.PointerEvent !== "undefined" && targetEl.addEventListener) {
      targetEl.addEventListener("pointerdown", (e) => onPointer(true, e), pointerOpts);
      window.document.addEventListener("pointerup", (e) => onPointer(false, e), pointerOpts);
      targetEl.addEventListener("pointermove", onPointerMove, pointerOpts);
    }

    const blurHandler = () => this._onWindowBlur();
    window.addEventListener("blur", blurHandler, false);
    this._cleanups.push(() => window.removeEventListener("blur", blurHandler, false));

    const visibilityHandler = () => {
      if (document.hidden) this._onWindowBlur();
    };
    document.addEventListener("visibilitychange", visibilityHandler, false);
    this._cleanups.push(() => document.removeEventListener("visibilitychange", visibilityHandler, false));
  }

  _handleKeyEvent(code, nowDown, ev) {
    const bindings = this._keyBindmap[code];
    if (!bindings) return;

    const prevState = this._keyStates[code];
    if (xor(prevState, nowDown)) {
      this._keyStates[code] = nowDown;
      for (const bindingName of bindings) {
        const allow = this.filterEvents ? this.filterEvents(ev, bindingName) : true;
        if (!allow) continue;
        this._handleBindingEvent(bindingName, nowDown, ev);
      }
    }

    if (ev && !("button" in ev)) {
      if (this.preventDefaults && !ev.defaultPrevented && ev.cancelable && code !== "Tab") {
        ev.preventDefault();
      }
      if (this.stopPropagation) ev.stopPropagation();
    }
  }

  _handleBindingEvent(bindingName, pressed, ev) {
    const counter = pressed ? this.pressCount : this.releaseCount;
    counter[bindingName] = (counter[bindingName] || 0) + 1;

    let ct = this._bindPressCount[bindingName] || 0;
    ct += pressed ? 1 : -1;
    if (ct < 0) ct = 0;
    this._bindPressCount[bindingName] = ct;

    const currState = this.state[bindingName];
    if (xor(currState, ct > 0)) {
      this.state[bindingName] = ct > 0;
      const emitter = pressed ? this.down : this.up;
      if (!this.disabled) emitter.emit(bindingName, ev);
    }
  }

  _onWindowBlur() {
    for (const code in this._keyStates) {
      if (!this._keyStates[code]) continue;
      if (/^mouse\d/i.test(code)) continue;
      this._handleKeyEvent(code, false, {
        code,
        preventDefault: () => {},
        stopPropagation: () => {},
      });
    }
  }

  _workaroundMacBug(down, ev) {
    const isMeta = /^Meta/.test(ev.code);
    if (ev.metaKey && !isMeta && down) {
      this._pressedDuringMeta[ev.code] = true;
    } else if (isMeta && !down) {
      for (const code in this._pressedDuringMeta) {
        if (!this._keyStates[code]) continue;
        if (/^mouse\d/i.test(code)) continue;
        this._handleKeyEvent(code, false, {
          code,
          preventDefault: () => {},
          stopPropagation: () => {},
        });
      }
      this._pressedDuringMeta = {};
    }
  }

  _pollGamepads() {
    if (!this.enableGamepad || typeof navigator === "undefined" || !navigator.getGamepads) return;
    const gamepads = navigator.getGamepads();
    if (!gamepads) return;

    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp || !gp.connected) continue;

      // Buttons (0..16)
      for (let b = 0; b < gp.buttons.length; b++) {
        const isPressed = gp.buttons[b].pressed;
        const tag = `gamepad:button:${b}`;
        const prev = !!this._gamepadStates[tag];
        if (xor(prev, isPressed)) {
          this._gamepadStates[tag] = isPressed;
          this._handleKeyEvent(tag, isPressed, { code: tag });
        }
      }

      // Analog Axes (-1.0 .. 1.0, deadzone 0.25)
      const axesMap = [
        { axis: 0, neg: "gamepad:axis:0:-", pos: "gamepad:axis:0:+" },
        { axis: 1, neg: "gamepad:axis:1:-", pos: "gamepad:axis:1:+" },
      ];
      for (const mapping of axesMap) {
        const val = gp.axes[mapping.axis] || 0;
        const negPressed = val < -0.3;
        const posPressed = val > 0.3;

        if (xor(!!this._gamepadStates[mapping.neg], negPressed)) {
          this._gamepadStates[mapping.neg] = negPressed;
          this._handleKeyEvent(mapping.neg, negPressed, { code: mapping.neg });
        }
        if (xor(!!this._gamepadStates[mapping.pos], posPressed)) {
          this._gamepadStates[mapping.pos] = posPressed;
          this._handleKeyEvent(mapping.pos, posPressed, { code: mapping.pos });
        }
      }
    }
  }
}

function zeroAllProperties(obj) {
  for (const key in obj) obj[key] = 0;
}

function xor(a, b) {
  return a ? !b : !!b;
}
