import { assign, createActor, createMachine, fromCallback, fromPromise } from "./vendor/xstate.js";

function plain(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(plain);
  return typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(plain);
}

function transition(value, action) {
  const spec = typeof value === "string" ? { target: value } : value;
  if (!spec || Array.isArray(spec) || !spec.target || "guard" in spec || "actions" in spec) {
    throw new Error("Navigation transition requires a target without guards or actions");
  }
  return { ...spec, actions: action };
}

function passiveTransition(value, path) {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    value.forEach((candidate, index) => passiveTransition(candidate, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`Invalid navigation transition at ${path}`);
  for (const key of ["guard", "actions"]) {
    if (key in value) throw new Error(`Unsupported navigation ${key} at ${path}`);
  }
}

export function createCortexNavigation({ config, actors }, activate, attach) {
  if (!plain(config) || !plain(actors) || typeof activate !== "function" || !config.states || !config.on || !config.initial || !config.states[config.initial]) {
    throw new Error("Invalid navigation machine configuration");
  }
  const actorNames = Object.keys(actors);
  if (!actorNames.length || actorNames.some(name => {
    const binding = actors[name];
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) return true;
    if (binding.via === "navigation") return Object.keys(binding).length !== 1;
    return binding.via !== "rows" || Object.keys(binding).some(key => !["via", "screen", "lifetime", "charts"].includes(key)) ||
      typeof binding.screen !== "string" || !binding.screen || binding.lifetime !== "attachment" || typeof attach !== "function";
  })) {
    throw new Error("Invalid navigation actor configuration");
  }
  const pending = new Map();
  let token = 0;
  let stopped = false;
  let actor;
  let committed;
  let activeToken;
  let restoring = false;
  const finish = (id, error, value, failed = false) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (failed) entry.reject(error);
    else entry.resolve(value);
  };
  const settle = (id, error, value, failed = false) => {
    const entry = pending.get(id);
    if (entry) entry.completion = { error, value, failed };
    queueMicrotask(() => {
      if (!pending.has(id) || stopped || activeToken !== id) return;
      try {
        if (failed && committed) {
          actor.stop();
          restoring = true;
          try { start(committed); } finally { restoring = false; }
        } else if (!failed) {
          committed = actor.getPersistedSnapshot();
        }
      } catch (restoreError) {
        activeToken = undefined;
        finish(id, new AggregateError([error, restoreError], "Navigation recovery failed"), undefined, true);
        return;
      }
      activeToken = undefined;
      finish(id, error, value, failed);
    });
  };
  const navigation = fromPromise(async ({ input, signal }) => {
    if (!input || !pending.has(input.token)) throw new Error("Navigation invocation requires a route request");
    if (pending.get(input.token).started) {
      const error = new Error("Multiple navigation invocations for one request");
      finish(input.token, error, undefined, true);
      throw { token: input.token, error };
    }
    pending.get(input.token).started = true;
    const cancel = () => finish(input.token);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const value = await activate(input, { signal });
      return { token: input.token, value };
    } catch (error) {
      throw { token: input.token, error };
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  });
  const sources = Object.fromEntries(actorNames.map(name => [name, actors[name].via === "navigation" ? navigation : fromCallback(({ input }) => {
    const cleanup = attach(actors[name], input);
    if (typeof cleanup !== "function") throw new Error(`Rows actor ${name} requires a cleanup function`);
    return cleanup;
  })]));
  const routes = new Set();
  for (const [key, spec] of Object.entries(config.on)) {
    if (!key.startsWith("route:")) continue;
    if (!key.slice(6) || !spec || Array.isArray(spec) || typeof spec !== "object" ||
        !spec.target || spec.reenter !== true || "guard" in spec || "actions" in spec) {
      throw new Error(`Invalid route configuration for ${key}`);
    }
    routes.add(key.slice(6));
  }
  function mapState(node, path = [], invoked = false) {
    const at = path.join(".") || "root";
    for (const key of ["entry", "exit"]) {
      if (key in node) throw new Error(`Unsupported navigation ${key} at ${at}`);
    }
    for (const key of ["always", "onDone"]) {
      if (key in node) passiveTransition(node[key], `${at}.${key}`);
    }
    for (const [event, value] of Object.entries(node.on || {})) passiveTransition(value, `${at}.on.${event}`);
    for (const [delay, value] of Object.entries(node.after || {})) {
      if (!/^\d+$/.test(delay) || !Number.isFinite(Number(delay))) throw new Error(`Unsupported navigation delay ${delay} at ${at}`);
      passiveTransition(value, `${at}.after.${delay}`);
    }
    if (node.type === "parallel") throw new Error("Parallel navigation states are unsupported");

    if (path.length && Object.keys(node.on || {}).some(key => key.startsWith("route:") || key === "*")) {
      throw new Error("Navigation routes must be handled at the root");
    }
    const mapped = { ...node };
    const invocations = node.invoke === undefined ? [] : Array.isArray(node.invoke) ? node.invoke : [node.invoke];
    if (invocations.some(invoke => !invoke || typeof invoke !== "object" || !actorNames.includes(invoke.src))) throw new Error(`Invalid navigation invocation at ${at}`);
    const navigations = invocations.filter(invoke => actors[invoke.src].via === "navigation");
    if (navigations.length > 1 || (invoked && navigations.length)) throw new Error("Nested navigation invocations are unsupported");
    if (node.states) mapped.states = Object.fromEntries(Object.entries(node.states).map(([name, child]) => [name, mapState(child, [...path, name], invoked || !!navigations.length)]));
    if (node.invoke !== undefined) {
      const mappedInvocations = invocations.map(invoke => {
        if (actors[invoke.src].via === "rows") {
          if (Object.keys(invoke).some(key => !["src", "id"].includes(key))) throw new Error(`Invalid rows invocation at ${at}`);
          return { ...invoke, input: invoke };
        }
        if ("input" in invoke || Object.keys(invoke).some(key => !["src", "onDone", "onError", "id"].includes(key))) throw new Error(`Invalid navigation invocation at ${at}`);
        return {
        ...invoke,
        input: ({ event }) => {
          if (!event.request || !pending.has(event.request.token)) throw new Error("Navigation invocation requires a route request");
          return event.request;
        },
        onDone: transition(invoke.onDone, ({ event }) => settle(event.output.token, null, event.output.value)),
        onError: transition(invoke.onError, ({ event }) => settle(event.error.token, event.error.error, undefined, true)),
        };
      });
      mapped.invoke = Array.isArray(node.invoke) ? mappedInvocations : mappedInvocations[0];
    }
    return mapped;
  }
  const machine = createMachine(mapState(config), { actors: sources });
  function start(snapshot) {
    actor = createActor(machine, snapshot ? { snapshot } : undefined);
    if (actor.getSnapshot().status === "error") throw actor.getSnapshot().error;
    actor.subscribe({
      next() { if (committed && activeToken === undefined) committed = actor.getPersistedSnapshot(); },
      error(error) { if (!restoring) for (const id of pending.keys()) finish(id, error, undefined, true); },
    });
    actor.start();
    if (actor.getSnapshot().status === "error") throw actor.getSnapshot().error;
  }
  start();
  return {
    navigate(request) {
      if (stopped) return Promise.reject(new Error("Navigation coordinator is stopped"));
      if (!plain(request) || typeof request.screen !== "string" || typeof request.navigationType !== "string" || "token" in request) return Promise.reject(new Error("Invalid navigation request"));
      const event = { type: `route:${request.screen}`, request: { ...request, token: ++token } };
      if (!routes.has(request.screen) || !actor.getSnapshot().can(event)) return Promise.reject(new Error(`Unhandled navigation route ${request.screen}`));
      const previous = pending.get(activeToken);
      if (previous) {
        if (previous.completion && !previous.completion.failed) {
          committed = actor.getPersistedSnapshot();
          finish(activeToken, null, previous.completion.value);
        } else finish(activeToken);
      }
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, started: false };
        pending.set(event.request.token, entry);
        activeToken = event.request.token;
        actor.send(event);
        if (pending.has(event.request.token) && !entry.started) {
          activeToken = undefined;
          finish(event.request.token, new Error(`Route ${request.screen} did not invoke navigation`), undefined, true);
        }
      });
    },
    snapshot: () => actor.getSnapshot(),
    stop() {
      if (stopped) return;
      stopped = true;
      actor.stop();
      for (const id of pending.keys()) finish(id);
    },
  };
}

export function authPosture(session, promote = false) {
  if (!session) return "anonymous";
  if (session.user?.guest) return promote && !session.committed ? "anonymous" : "guest";
  return "user";
}

function sessionOwnerOf(session) {
  return session?.user?.id === undefined ? undefined : String(session.user.id);
}

export const SESSION_LIFECYCLE_CHART = Object.freeze({
  id: "session",
  states: {
    anonymous: {
      initial: "idle",
      states: {
        idle: {},
        authenticating: {},
        registering: {},
        failed: {},
      },
    },
    guest: {
      initial: "idle",
      states: {
        idle: {},
        authenticating: {},
        registering: {},
        failed: {},
      },
    },
    user: {
      initial: "idle",
      states: {
        idle: {},
        authenticating: {},
        registering: {},
        failed: {},
      },
    },
    signingOut: {},
  },
});

export function createSessionLifecycle(options = {}) {
  const {
    session: initialSession = null,
    promote = false,
    required = false,
    ensureSession = null,
    passkeySignin = null,
    passkeyRegister = null,
    signOut = null,
    hasKnownPasskeys = null,
    isProviderHinted = null,
  } = options;

  const pending = new Map();
  let seq = 0;
  let stopped = false;

  const finish = (token, outcome, rejected = false) => {
    const entry = pending.get(token);
    if (!entry) return;
    pending.delete(token);
    if (rejected) entry.reject(outcome);
    else entry.resolve(outcome);
  };

  const runCeremony = (runner) => fromPromise(async ({ input }) => {
    if (typeof runner !== "function") {
      throw { token: input.token, error: new Error("Passkey ceremony runner is not configured"), recoveryOffered: false, activeSession: input.session ?? null };
    }
    let activeSession = input.session ?? null;
    try {
      if (!activeSession && typeof ensureSession === "function") {
        activeSession = await ensureSession();
      }
      const next = await runner(activeSession);
      const sameOwner = sessionOwnerOf(next) !== undefined && sessionOwnerOf(next) === sessionOwnerOf(activeSession);
      const transitionMode = !required && input.origin === "action" && sameOwner ? "in-place" : "reload";
      return { token: input.token, session: next, activeSession, sameOwner, transitionMode };
    } catch (error) {
      const recoveryOffered = Boolean(
        error?.unknownCredential === true ||
          (error?.name === "NotAllowedError" && typeof hasKnownPasskeys === "function" && hasKnownPasskeys(error?.rpId)),
      );
      throw { token: input.token, error, recoveryOffered, activeSession };
    }
  });

  const signOutActor = fromPromise(async ({ input }) => {
    try {
      if (typeof signOut === "function") await signOut();
      return { token: input.token };
    } catch (error) {
      throw { token: input.token, error };
    }
  });

  const applySessionSet = [
    {
      guard: ({ event }) => authPosture(event.session, promote) === "user",
      target: "#session.user.idle",
      actions: assign({
        session: ({ event }) => event.session,
        error: () => null,
        recoveryOffered: () => false,
      }),
    },
    {
      guard: ({ event }) => authPosture(event.session, promote) === "guest",
      target: "#session.guest.idle",
      actions: assign({
        session: ({ event }) => event.session,
        error: () => null,
        recoveryOffered: () => false,
      }),
    },
    {
      target: "#session.anonymous.idle",
      actions: assign({
        session: ({ event }) => event.session ?? null,
        error: () => null,
        recoveryOffered: () => false,
      }),
    },
  ];

  const ceremonyStates = (postureName) => {
    const readyTransitions = {
      "session.set": applySessionSet,
      "guest.commit": {
        guard: ({ context }) => Boolean(context.session?.user?.guest),
        target: "#session.guest.idle",
        actions: assign({
          session: ({ context }) => context.session ? { ...context.session, committed: true } : context.session,
          transitionMode: () => "in-place",
        }),
      },
      "passkey.signin": {
        target: "authenticating",
        actions: assign({
          error: () => null,
          recoveryOffered: () => false,
        }),
      },
      "passkey.register": {
        target: "registering",
        actions: assign({
          error: () => null,
          recoveryOffered: () => false,
        }),
      },
      signout: postureName === "guest"
        ? [
          {
            guard: () => !required && promote && !(typeof isProviderHinted === "function" && isProviderHinted()),
            target: "#session.anonymous.idle",
            actions: [
              assign({
                session: ({ context }) => {
                  if (!context.session) return null;
                  const { committed: _, ...rest } = context.session;
                  return rest;
                },
                error: () => null,
                recoveryOffered: () => false,
                transitionMode: () => "in-place",
              }),
              ({ context, event }) => queueMicrotask(() => finish(event.token, { mode: "in-place", session: context.session })),
            ],
          },
          {
            target: "#session.signingOut",
            actions: assign({ returnPosture: () => "guest" }),
          },
        ]
        : {
          target: "#session.signingOut",
          actions: assign({ returnPosture: () => postureName }),
        },
    };

    const doneTransition = [
      {
        guard: ({ event }) => authPosture(event.output.session, promote) === "guest",
        target: "#session.guest.idle",
        actions: [
          assign({
            session: ({ event }) => event.output.session,
            error: () => null,
            recoveryOffered: () => false,
            transitionMode: ({ event }) => event.output.transitionMode,
          }),
          ({ event }) => queueMicrotask(() => finish(event.output.token, {
            status: "authenticated",
            session: event.output.session,
            activeSession: event.output.activeSession,
            sameOwner: event.output.sameOwner,
            transitionMode: event.output.transitionMode,
          })),
        ],
      },
      {
        target: "#session.user.idle",
        actions: [
          assign({
            session: ({ event }) => event.output.session,
            error: () => null,
            recoveryOffered: () => false,
            transitionMode: ({ event }) => event.output.transitionMode,
          }),
          ({ event }) => queueMicrotask(() => finish(event.output.token, {
            status: "authenticated",
            session: event.output.session,
            activeSession: event.output.activeSession,
            sameOwner: event.output.sameOwner,
            transitionMode: event.output.transitionMode,
          })),
        ],
      },
    ];

    const errorActions = [
      assign({
        session: ({ context, event }) => context.session ?? event.error.activeSession ?? null,
        error: ({ event }) => event.error.error,
        recoveryOffered: ({ event }) => Boolean(event.error.recoveryOffered),
      }),
      ({ event }) => queueMicrotask(() => finish(event.error.token, {
        status: "failed",
        error: event.error.error,
        recoveryOffered: Boolean(event.error.recoveryOffered),
      })),
    ];

    const errorTransition = [
      {
        guard: ({ context, event }) => authPosture(context.session ?? event.error.activeSession ?? null, promote) === "user",
        target: "#session.user.failed",
        actions: errorActions,
      },
      {
        guard: ({ context, event }) => authPosture(context.session ?? event.error.activeSession ?? null, promote) === "guest",
        target: "#session.guest.failed",
        actions: errorActions,
      },
      {
        target: "#session.anonymous.failed",
        actions: errorActions,
      },
    ];

    const inFlightTransitions = {
      "session.set": {
        actions: assign({ session: ({ event }) => event.session }),
      },
      "guest.commit": {
        guard: ({ context }) => Boolean(context.session?.user?.guest),
        actions: assign({
          session: ({ context }) => context.session ? { ...context.session, committed: true } : context.session,
          transitionMode: () => "in-place",
        }),
      },
    };

    return {
      initial: "idle",
      states: {
        idle: { on: readyTransitions },
        failed: { on: readyTransitions },
        authenticating: {
          on: inFlightTransitions,
          invoke: {
            src: "passkeySignin",
            input: ({ context, event }) => ({
              token: event.token,
              origin: event.origin ?? "action",
              session: context.session,
            }),
            onDone: doneTransition,
            onError: errorTransition,
          },
        },
        registering: {
          on: inFlightTransitions,
          invoke: {
            src: "passkeyRegister",
            input: ({ context, event }) => ({
              token: event.token,
              origin: event.origin ?? "action",
              session: context.session,
            }),
            onDone: doneTransition,
            onError: errorTransition,
          },
        },
      },
    };
  };

  const initialPosture = authPosture(initialSession, promote);
  const machine = createMachine(
    {
      id: "session",
      initial: initialPosture,
      context: {
        session: initialSession,
        error: null,
        recoveryOffered: false,
        transitionMode: null,
        returnPosture: initialPosture,
      },
      states: {
        anonymous: ceremonyStates("anonymous"),
        guest: ceremonyStates("guest"),
        user: ceremonyStates("user"),
        signingOut: {
          invoke: {
            src: "signOut",
            input: ({ event }) => ({ token: event.token }),
            onDone: {
              target: "#session.anonymous.idle",
              actions: [
                assign({
                  session: () => null,
                  error: () => null,
                  recoveryOffered: () => false,
                  transitionMode: () => "reload",
                }),
                ({ event }) => queueMicrotask(() => finish(event.output.token, { mode: "reload" })),
              ],
            },
            onError: [
              {
                guard: ({ context }) => context.returnPosture === "user",
                target: "#session.user.idle",
                actions: ({ event }) => queueMicrotask(() => finish(event.error.token, event.error.error, true)),
              },
              {
                guard: ({ context }) => context.returnPosture === "guest",
                target: "#session.guest.idle",
                actions: ({ event }) => queueMicrotask(() => finish(event.error.token, event.error.error, true)),
              },
              {
                target: "#session.anonymous.idle",
                actions: ({ event }) => queueMicrotask(() => finish(event.error.token, event.error.error, true)),
              },
            ],
          },
        },
      },
    },
    {
      actors: {
        passkeySignin: runCeremony(passkeySignin),
        passkeyRegister: runCeremony(passkeyRegister),
        signOut: signOutActor,
      },
    },
  );

  const actor = createActor(machine);
  actor.start();

  const posture = () => {
    const snap = actor.getSnapshot();
    const val = snap.value;
    if (val === "signingOut") return snap.context.returnPosture || "anonymous";
    if (typeof val === "object" && val !== null) {
      if ("user" in val) return "user";
      if ("guest" in val) return "guest";
      if ("anonymous" in val) {
        return snap.context.session ? authPosture(snap.context.session, promote) : "anonymous";
      }
    }
    return authPosture(snap.context.session, promote);
  };

  const ceremonyState = () => {
    const val = actor.getSnapshot().value;
    if (val === "signingOut") return "signingOut";
    if (typeof val === "object" && val !== null) {
      return val.anonymous ?? val.guest ?? val.user ?? "idle";
    }
    return "idle";
  };

  const busy = () => {
    const state = ceremonyState();
    return state === "authenticating" || state === "registering" || state === "signingOut";
  };

  const dispatchCeremony = (type, origin = "action") => {
    if (stopped || busy()) return Promise.resolve({ status: "busy" });
    const event = { type, token: ++seq, origin };
    if (!actor.getSnapshot().can(event)) return Promise.resolve({ status: "busy" });
    return new Promise((resolve, reject) => {
      pending.set(event.token, { resolve, reject });
      actor.send(event);
    });
  };

  return {
    posture,
    ceremonyState,
    busy,
    session: () => actor.getSnapshot().context.session,
    setSession(nextSession) {
      if (stopped) return;
      actor.send({ type: "session.set", session: nextSession });
    },
    async commitGuest() {
      if (stopped) return null;
      let current = actor.getSnapshot().context.session;
      if (!current && typeof ensureSession === "function") {
        current = await ensureSession();
        if (stopped) return current;
        if (current && !actor.getSnapshot().context.session) {
          actor.send({ type: "session.set", session: current });
        }
      }
      current = actor.getSnapshot().context.session ?? current;
      if (!current?.user?.guest) return current;
      if (actor.getSnapshot().can({ type: "guest.commit" })) {
        actor.send({ type: "guest.commit" });
      }
      return actor.getSnapshot().context.session ?? current;
    },
    signInPasskey({ origin = "action" } = {}) {
      return dispatchCeremony("passkey.signin", origin);
    },
    registerPasskey({ origin = "action" } = {}) {
      return dispatchCeremony("passkey.register", origin);
    },
    signOut() {
      if (stopped || busy()) return Promise.resolve({ mode: "busy" });
      const event = { type: "signout", token: ++seq };
      if (!actor.getSnapshot().can(event)) return Promise.resolve({ mode: "busy" });
      return new Promise((resolve, reject) => {
        pending.set(event.token, { resolve, reject });
        actor.send(event);
      });
    },
    subscribe(listener) {
      const sub = actor.subscribe(() => listener(actor.getSnapshot()));
      return () => sub.unsubscribe();
    },
    snapshot: () => actor.getSnapshot(),
    stop() {
      if (stopped) return;
      stopped = true;
      actor.stop();
      for (const id of pending.keys()) finish(id, { status: "stopped", mode: "stopped" });
    },
  };
}
