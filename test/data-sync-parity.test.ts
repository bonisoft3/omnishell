// The shipped store and its fake, driven by the same writes, end with the same
// rows, wake for the same keys and refuse the same writes. App screen tests
// mount the fake, so a difference here is a screen that passes its tests and
// fails in the browser. The fake wrote the rows of a batch before the one it
// refused, where the shipped store writes none, and stayed silent on a write
// that changed nothing, where the shipped store wakes the keys it settled.
//
// The shipped store runs here over browser-owned tables, which need no cluster;
// a table synced from the server settles through the gateway instead.
import { expect } from "@test/harness"
import { createStore } from "../interpreter/data-sync.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"
import { fakeDataSync } from "./data-sync-fake.ts"
import { load as parseYaml } from "../interpreter/vendor/js-yaml.js"

type Row = Record<string, unknown>
type Store = {
  query(table: string, order: string | null, opts: Row): Promise<Row[]>
  subscribe(table: string, fn: (changes?: { value?: Row; previousValue?: Row }[]) => void, opts: Row): () => void
  add(table: string, rows: Row[]): Promise<void>
  write(table: string, edits: { key: string; row: Row }[]): Promise<void>
  patch(table: string, edits: { key: string; changes: Row }[]): Promise<void>
  drop(table: string, keys: string[]): Promise<void>
  dropWhere(table: string, filter: string): Promise<void>
  upsertBy(table: string, values: Row): Promise<void>
}
type Op = { [K in Exclude<keyof Store, "query" | "subscribe">]: [K, ...Parameters<Store[K]> extends [string, ...infer A] ? A : never] }[
  Exclude<keyof Store, "query" | "subscribe">
]

/** What one write did, as a reader of the table sees it. */
type Seen = { refused: boolean; rows: Row[]; woke: string[] }

/** A table as an app declares it: its key and the uniques an upsert resolves. */
type Table = { name: string; key: string; uniques?: string[][] }

const NOTE: Table = { name: "note", key: "id" }
/** The keys a sequence names; any other the store minted itself, and the
 * shipped store mints a uuid where the fake counts. */
const POOL = ["a", "b", "c", "d"]

async function quiet() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0))
}

async function run(store: Store, table: Table, ops: Op[]): Promise<Seen[]> {
  const woke = new Set<string>()
  // A wake names its rows by `id`, as the screen reads them.
  const stop = store.subscribe(table.name, (changes) => {
    if (changes === undefined) woke.add("*")
    else for (const c of changes) woke.add(String((c.value ?? c.previousValue)?.id))
  }, {})
  await quiet()
  const columns = [...new Set([table.key, ...(table.uniques ?? []).flat(), "title", "n"])]
  const seen: Seen[] = []
  for (const [op, ...args] of ops) {
    woke.clear()
    let refused = false
    try {
      await (store[op] as (t: string, ...a: unknown[]) => Promise<void>)(table.name, ...args)
    } catch {
      refused = true
    }
    await quiet()
    const rows = (await store.query(table.name, null, {}))
      .map((r) => Object.fromEntries(columns.map((c) => [c, c === table.key && !POOL.includes(String(r[c])) ? "<minted>" : r[c] ?? null])))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    seen.push({ refused, rows, woke: [...woke].map((k) => POOL.includes(k) || k === "*" || k === "undefined" ? k : "<minted>").sort() })
  }
  stop()
  return seen
}

async function both(ops: Op[], table: Table = NOTE): Promise<{ shipped: Seen[]; fake: Seen[] }> {
  const declared = { keys: { [table.name]: table.key }, ...(table.uniques ? { uniques: { [table.name]: table.uniques } } : {}) }
  const shipped = await createStore("", { carriers: FIXTURE_CARRIERS, local: { [table.name]: "tab" }, ...declared }) as Store
  const fake = fakeDataSync({ [table.name]: [] }, declared) as unknown as Store
  return { shipped: await run(shipped, table, ops), fake: await run(fake, table, ops) }
}

const CASES: Record<string, Op[]> = {
  "an add, then the same key added again": [
    ["add", [{ id: "a", title: "x", n: 1 }]],
    ["add", [{ id: "a", title: "y", n: 2 }]],
  ],
  "a batch add whose second row is already there": [
    ["add", [{ id: "a", title: "x", n: 1 }]],
    ["add", [{ id: "b", title: "y", n: 2 }, { id: "a", title: "z", n: 3 }]],
  ],
  "a write that inserts, then states only one field": [
    ["write", [{ key: "a", row: { title: "x", n: 1 } }]],
    ["write", [{ key: "a", row: { n: 2 } }]],
  ],
  "a write restating the row as it stands": [
    ["write", [{ key: "a", row: { title: "x", n: 1 } }]],
    ["write", [{ key: "a", row: { title: "x", n: 1 } }]],
  ],
  "a patch restating the row as it stands": [
    ["add", [{ id: "a", title: "x", n: 1 }]],
    ["patch", [{ key: "a", changes: { n: 1 } }]],
  ],
  "a patch of a row that is not there": [
    ["patch", [{ key: "a", changes: { n: 1 } }]],
  ],
  "a drop, then the same key dropped again": [
    ["add", [{ id: "a", title: "x", n: 1 }, { id: "b", title: "y", n: 2 }]],
    ["drop", ["a"]],
    ["drop", ["a"]],
  ],
  "a batch drop naming a key that is not there": [
    ["add", [{ id: "a", title: "x", n: 1 }]],
    ["drop", ["a", "b"]],
  ],
  "a batch patch naming a key that is not there": [
    ["add", [{ id: "a", title: "x", n: 1 }]],
    ["patch", [{ key: "a", changes: { n: 2 } }, { key: "b", changes: { n: 3 } }]],
  ],
  "a batch write that inserts one row and changes another": [
    ["add", [{ id: "a", title: "x", n: 1 }]],
    ["write", [{ key: "a", row: { n: 2 } }, { key: "b", row: { title: "y" } }]],
  ],
  // The shipped store refuses the batch before it writes any of it.
  "a batch write whose second edit names no key": [
    ["write", [{ key: "a", row: { title: "x" } }, { key: undefined as unknown as string, row: { title: "y" } }]],
  ],
  "a drop by filter, and one carrying a limit": [
    ["add", [{ id: "a", title: "x", n: 1 }, { id: "b", title: "y", n: 2 }, { id: "c", title: "x", n: 3 }]],
    ["dropWhere", "title=eq.x"],
    ["dropWhere", "n=gt.0&limit=1"],
  ],
  "an upsert by its own key, inserted then updated": [
    ["upsertBy", { id: "a", title: "x" }],
    ["upsertBy", { id: "a", title: "y" }],
    ["upsertBy", { id: "a", title: "y" }],
  ],
}

for (const [name, ops] of Object.entries(CASES)) {
  // The shipped store's offline executor runs until page exit.
  Deno.test({ name: `parity: ${name}`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const { shipped, fake } = await both(ops)
    expect(fake).toEqual(shipped)
  } })
}

/** A sequence of writes over a few keys of `table`, the same for a seed on
 * every run. An upsert names the table's unique where it declares one, and its
 * key where it does not. */
function sequence(seed: number, length: number, table: Table = NOTE): Op[] {
  let s = seed
  const next = (n: number) => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s % n
  }
  const key = () => POOL[next(POOL.length)]
  const unique = table.uniques?.[0]
  const naming = () => Object.fromEntries((unique ?? []).map((c) => [c, `u${next(2)}`]))
  const row = () => next(2) === 0 ? { title: "xy"[next(2)] } : { n: next(3) }
  const ops: (() => Op)[] = [
    () => ["add", Array.from({ length: 1 + next(2) }, () => ({ [table.key]: key(), ...naming(), ...row() }))],
    () => ["write", Array.from({ length: 1 + next(2) }, () => ({ key: key(), row: row() }))],
    () => ["patch", [{ key: key(), changes: row() }]],
    () => ["drop", [key()]],
    () => ["dropWhere", next(2) === 0 ? "title=eq.x" : "n=gt.1"],
    () => ["upsertBy", unique ? { ...naming(), ...row() } : { [table.key]: key(), ...row() }],
  ]
  return Array.from({ length }, () => ops[next(ops.length)]())
}

for (const seed of [1, 2, 3, 5, 8, 13, 21, 34]) {
  Deno.test({ name: `parity: the writes seed ${seed} draws`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const ops = sequence(seed, 24)
    const { shipped, fake } = await both(ops)
    expect(fake.map((seen, i) => ({ op: ops[i], ...seen }))).toEqual(shipped.map((seen, i) => ({ op: ops[i], ...seen })))
  } })
}

const schema = parseYaml(Deno.readTextFileSync(new URL("fixtures/data-sync-schema.yaml", import.meta.url))) as {
  keys: Record<string, string>
  uniques: Record<string, string[][]>
}
const declared: Table[] = [...new Set([...Object.keys(schema.keys), ...Object.keys(schema.uniques)])]
  .map((name) => ({ name, key: schema.keys[name] ?? "id", uniques: schema.uniques[name] }))

Deno.test("parity covers ordinary keys, non-id keys and composite uniques", () => {
  expect(declared.some((table) => table.key === "id" && table.uniques === undefined)).toBe(true)
  expect(declared.some((table) => table.key !== "id")).toBe(true)
  expect(declared.some((table) => table.uniques?.some((columns) => columns.length > 1))).toBe(true)
})

for (const table of declared) {
  Deno.test({ name: `parity: ${table.name}, keyed on ${table.key}`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
    for (const seed of [1, 2, 3]) {
      const ops = sequence(seed, 16, table)
      const { shipped, fake } = await both(ops, table)
      expect(fake.map((seen, i) => ({ op: ops[i], ...seen }))).toEqual(shipped.map((seen, i) => ({ op: ops[i], ...seen })))
    }
  } })
}

// A region torn down was still woken by a write it had subscribed to before.
Deno.test({ name: "parity: a subscription stopped before its wake hears nothing", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const heard = async (store: Store) => {
    let woken = 0
    const stop = store.subscribe(NOTE.name, () => void woken++, {})
    await quiet()
    await store.add(NOTE.name, [{ id: "a", title: "x" }])
    stop()
    await quiet()
    return woken
  }
  const shipped = await createStore("", { carriers: FIXTURE_CARRIERS, local: { [NOTE.name]: "tab" } }) as Store
  const fake = fakeDataSync({ [NOTE.name]: [] }) as unknown as Store
  expect(await heard(fake)).toBe(await heard(shipped))
} })
