function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function createRowAttachments(bindings) {
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) throw new Error("Row attachment bindings are required");
  const stopAll = (group, prior, failed = false) => {
    const errors = failed ? [prior] : [];
    for (const listener of group) {
      try { listener.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Row attachment startup or cleanup failed");
  };
  const leases = new Map();
  const listeners = new Map();
  const declared = name => {
    if (!Object.hasOwn(bindings, name) || bindings[name]?.via !== "rows" || bindings[name]?.lifetime !== "attachment" || typeof bindings[name]?.screen !== "string" || !bindings[name].screen) throw new Error(`Undeclared row attachment ${name}`);
    const charts = bindings[name].charts;
    if (!charts || typeof charts !== "object" || Array.isArray(charts) || !Object.keys(charts).length) throw new Error(`Row attachment ${name} needs declared charts`);
    return bindings[name];
  };
  const active = name => { declared(name); return (leases.get(name) ?? 0) > 0; };
  return {
    active,
    validate(name, screen, declaration) {
      const binding = declared(name);
      if (binding.screen !== screen) throw new Error(`Row attachment ${name} has the wrong screen`);
      const signature = JSON.stringify(canonical(declaration));
      if (!Object.values(binding.charts).some(chart => JSON.stringify(canonical(chart)) === signature)) throw new Error(`Row attachment ${name} has an undeclared chart`);
    },
    attach(binding, spec) {
      const name = spec?.src;
      if (binding?.via !== "rows" || binding.lifetime !== "attachment" || typeof binding.screen !== "string" || !binding.screen || typeof name !== "string" || !name) {
        throw new Error("Invalid row attachment");
      }
      const expected = declared(name);
      if (binding.screen !== expected.screen) throw new Error(`Row attachment ${name} has the wrong screen`);
      const count = leases.get(name) ?? 0;
      leases.set(name, count + 1);
      if (count === 0) {
        const started = [];
        try {
          for (const listener of listeners.get(name) ?? []) {
            started.push(listener);
            listener.start();
          }
        } catch (error) {
          leases.delete(name);
          stopAll(started.reverse(), error, true);
        }
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        const remaining = leases.get(name) - 1;
        if (remaining) leases.set(name, remaining);
        else {
          leases.delete(name);
          stopAll(listeners.get(name) ?? []);
        }
      };
    },
    register(name, listener, screen) {
      if (typeof name !== "string" || !name || typeof listener?.start !== "function" || typeof listener?.stop !== "function") throw new Error("Invalid row attachment listener");
      const binding = declared(name);
      if (screen !== undefined && binding.screen !== screen) throw new Error(`Row attachment ${name} has the wrong screen`);
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
      if (active(name)) {
        try { listener.start(); }
        catch (error) {
          group.delete(listener);
          if (!group.size) listeners.delete(name);
          stopAll([listener], error, true);
        }
      }
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        group.delete(listener);
        if (!group.size) listeners.delete(name);
        if (active(name)) listener.stop();
      };
    },
  };
}
