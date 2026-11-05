export function invocationSpecs(machine, state) {
  const active = [{ path: "", node: machine }];
  let node = machine;
  let path = "";
  for (const part of String(state ?? "").split(".").filter(Boolean)) {
    node = node.states?.[part];
    if (!node) throw new Error(`invoke: unknown state ${state}`);
    path = path ? `${path}.${part}` : part;
    active.push({ path, node });
  }
  const ids = new Set();
  return active.flatMap(({ path, node }) => (Array.isArray(node.invoke) ? node.invoke : node.invoke ? [node.invoke] : []).map((spec, index) => {
    if (!spec || typeof spec.src !== "string" || Object.keys(spec).some((key) => !["id", "src"].includes(key))) throw new Error(`invoke in ${path || "root"} supports only named src and id`);
    if (spec.id !== undefined && typeof spec.id !== "string") throw new Error("invoke id must be a string");
    const id = spec.id ?? `${path || "root"}:${index}`;
    if (ids.has(id)) throw new Error(`duplicate active invoke id ${id}`);
    ids.add(id);
    return { ...spec, id, path, key: JSON.stringify([path, id]) };
  }));
}

export function invokedActors(machine, implementations, start) {
  const running = new Map();
  const exits = (path, paths) => paths.some((parent) => parent === "" || path === parent || path.startsWith(`${parent}.`));
  const stopWhere = (matches) => {
    const errors = [];
    for (const [key, held] of running) {
      if (!matches(key, held)) continue;
      running.delete(key);
      try { held.actor.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Observer cleanup failed");
  };
  return {
    exit(paths) {
      stopWhere((_key, held) => exits(held.path, paths));
    },
    sync(state) {
      const specs = invocationSpecs(machine, state);
      const wanted = new Map(specs.map((spec) => [spec.key, spec]));
      stopWhere((key) => !wanted.has(key));
      for (const spec of specs) {
        if (!Object.hasOwn(implementations, spec.src)) throw new Error(`invoke ${spec.id}: undeclared actor ${spec.src}`);
        if (!running.has(spec.key)) running.set(spec.key, { path: spec.path, actor: start(implementations[spec.src], spec) });
        running.get(spec.key).actor.update();
      }
    },
    stop() {
      stopWhere(() => true);
    },
  };
}
