const matches = (row, values) => Object.entries(values).every(([field, value]) => row[field] === value);

export function observationIdentity(binding, row) {
  if (!row) return;
  const fields = [...Object.values(binding.match), ...(binding.require ?? [])];
  if (fields.some((field) => row[field] === undefined || row[field] === null || row[field] === "")) return;
  return { key: Object.fromEntries(Object.entries(binding.match).map(([field, column]) => [field, row[column]])), required: (binding.require ?? []).map((field) => row[field]) };
}

export function observationSnapshot(binding, identity, rows, cursors) {
  if (!Array.isArray(rows)) throw new Error(`Observation needs a read of ${binding.table}`);
  const found = rows.filter((row) => matches(row, identity.key));
  if (found.length > 1) throw new Error(`Observation ${binding.table} has more than one source`);
  const row = found[0];
  if (!row && !binding.missing || row && binding.field === undefined) return;
  const key = JSON.stringify(identity);
  const value = row ? row[binding.field] : null;
  if (row && typeof value !== "string") throw new Error(`Observation ${binding.table}.${binding.field} is not a string`);
  let revision;
  if (row?.txid !== undefined) {
    if (!/^[0-9]+$/.test(String(row.txid))) throw new Error(`Observation ${binding.table} has an invalid revision`);
    revision = BigInt(row.txid);
  }
  const prior = cursors.get(key);
  if (prior && (revision !== undefined && prior.revision !== undefined ? revision < prior.revision || revision === prior.revision && prior.value === value : prior.value === value)) return;
  return {
    event: row ? { type: `${binding.event}${value}`, value } : { type: binding.missing },
    acknowledge() { cursors.set(key, { revision, value }); },
  };
}

// The actor owns only an attachment. Its source rows retain their own lifetime.
export function observeActor(binding, { store, readRow, send, track, failed }) {
  let active = true;
  let identity;
  let generation = 0;
  let running = false;
  let queued = false;
  const cursors = new Map();
  const current = () => observationIdentity(binding, readRow());
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const read = async () => {
    const held = current();
    if (!active || !held) return;
    const turn = generation;
    const attached = () => active && turn === generation && same(held, current());
    const filter = Object.entries(held.key).map(([column, value]) => `${column}=eq.${encodeURIComponent(String(value))}`).join("&");
    let rows;
    try {
      rows = await store.query(binding.table, null, { filter, current: true, ...(binding.missing ? { confirmed: true } : {}) });
    } catch (error) {
      if (!attached()) return;
      throw error;
    }
    if (!attached()) return;
    const delivery = observationSnapshot(binding, held, rows, cursors);
    if (delivery && await send(delivery.event, attached)) delivery.acknowledge();
  };
  const refresh = () => {
    if (!active) return;
    if (running) { queued = true; return; }
    running = true;
    const pending = (async () => {
      try {
        do { queued = false; await read(); } while (active && queued);
      } finally { running = false; }
    })();
    track(pending).catch(failed);
  };
  // Subscribe before the first snapshot so no change is lost at attachment.
  const unsubscribe = store.subscribe(binding.table, refresh);
  return {
    update() {
      const next = current();
      if (same(identity, next)) return;
      identity = next;
      cursors.clear();
      generation += 1;
      refresh();
    },
    stop() { active = false; generation += 1; unsubscribe(); },
  };
}
