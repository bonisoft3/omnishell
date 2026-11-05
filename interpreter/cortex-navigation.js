import { createActor, createMachine, fromCallback, fromPromise } from "./vendor/xstate.js";

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
