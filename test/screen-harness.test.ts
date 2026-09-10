import { describe, expect, it } from "@test/harness"
import { memoryStore, mountScreen } from "./screen-harness.ts"

describe("the harness store", () => {
  it("reads through the fragment grammar's own parsers", async () => {
    const store = memoryStore({
      note: [
        { id: "a", title: "alpha", done: false, position: 3 },
        { id: "b", title: "beta", done: true, position: 1 },
        { id: "c", title: "gamma", done: false, position: 2 },
      ],
    })
    expect((await store.query("note", "position.asc")).map((r) => r.id)).toEqual(["b", "c", "a"])
    expect((await store.query("note", "position.desc")).map((r) => r.id)).toEqual(["a", "c", "b"])
    expect((await store.query("note", "position.asc", { filter: "done=is.false" })).map((r) => r.id))
      .toEqual(["c", "a"])
    expect((await store.query("note", "position.asc", { filter: "title=ilike.ALP*" })).map((r) => r.id))
      .toEqual(["a"])
    // The cap falls after the ordering, which is the only reading of a limit
    // that answers the same question the server's does.
    expect((await store.query("note", "position.asc", { filter: "limit=2" })).map((r) => r.id))
      .toEqual(["b", "c"])
  })

  it("sorts nulls last ascending and first descending", async () => {
    const store = memoryStore({
      note: [{ id: "a", at: "2024-01-01" }, { id: "b", at: null }, { id: "c", at: "2023-01-01" }],
    })
    expect((await store.query("note", "at.asc")).map((r) => r.id)).toEqual(["c", "a", "b"])
    expect((await store.query("note", "at.desc")).map((r) => r.id)).toEqual(["b", "a", "c"])
  })

  it("refuses a fragment the grammar cannot state, rather than widening the read", async () => {
    const store = memoryStore({ note: [] })
    await expect(store.query("note", null, { filter: "title=fts.hello" })).rejects.toThrow(
      /outside the grammar/,
    )
    await expect(store.query("ghost")).rejects.toThrow(/no table "ghost"/)
  })

  it("resolves a flat embed through the row's own foreign key", async () => {
    const store = memoryStore({
      note: [{ id: "n1", label_id: "l1" }, { id: "n2", label_id: "gone" }],
      label: [{ id: "l1", name: "urgent" }],
    })
    const rows = await store.query("note", "id.asc", { select: "*,label(name)" })
    expect(rows[0].label).toEqual({ name: "urgent" })
    // An unresolvable embed binds null and is never omitted: a region reading
    // {label.name} would otherwise render the brace text.
    expect(rows[1].label).toBe(null)
  })

  it("wakes with the change set, and never on subscribe itself", async () => {
    const store = memoryStore({ note: [{ id: "a", title: "alpha" }] })
    const seen: unknown[] = []
    const stop = store.subscribe("note", (changes) => seen.push(changes))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([])

    await store.put("note", { id: "a", title: "ALPHA" })
    await store.put("note", { id: "b", title: "beta" })
    // Both writes land in one wake: the interpreter re-reads once per burst,
    // and a wake per write would hide a coalescing bug behind the extra pass.
    expect(seen.length).toBe(0)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.length).toBe(1)
    expect(seen[0]).toEqual([
      { value: { id: "a", title: "ALPHA" }, previousValue: { id: "a", title: "alpha" } },
      { value: { id: "b", title: "beta" } },
    ])

    stop()
    await store.put("note", { id: "c" })
    await new Promise((r) => setTimeout(r, 0))
    expect(seen.length).toBe(1)
  })

  it("states a row without replacing it, and patches one that is there", async () => {
    const store = memoryStore({ note: [{ id: "a", title: "alpha", body: "kept" }] })
    await store.put("note", { id: "a", title: "ALPHA" })
    expect(store.rows("note")[0]).toEqual({ id: "a", title: "ALPHA", body: "kept" })
    await store.update("note", "a", { body: "new" })
    expect(store.rows("note")[0]).toEqual({ id: "a", title: "ALPHA", body: "new" })
    await expect(store.update("note", "zz", {})).rejects.toThrow(/no row zz/)
  })
})

const SCREEN = `<section class="screen" data-screen="counter">
  <div class="tally" data-live="tick" data-filter="id=eq.t1"
       data-on-mutation="beat" data-reads="tick">
    <span class="beats" data-text="{beats}"></span>
  </div>
</section>`

// A fold that writes its own collection and asks for a pause between beats:
// the smallest screen that cannot finish without the clock being driven.
const BEAT = `(state, event) => {
  const row = (state.rows.tick ?? []).find((r) => r.id === "t1");
  const beats = Number(row.beats);
  if (beats >= 3) return { updates: [] };
  return {
    updates: [{ op: "patch", entity: "tick", id: row.id, row: { beats: String(beats + 1) } }],
    then: { type: "mutation", delay: 500 },
  };
}`

const ROUTE = {
  screen: "counter",
  files: {
    html: "shell/screens/counter.html",
    css: "shell/screens/counter.css",
    handlers: ["shell/handlers/beat.js"],
  },
  states: ["loading", "empty", "populated"],
}

const FILES = {
  "shell/screens/counter.html": SCREEN,
  "shell/screens/counter.css": "",
  "shell/handlers/beat.js": BEAT,
}

describe("a whole screen under the harness", () => {
  it("holds every wait until the test says time has passed", async () => {
    const m = await mountScreen({
      route: ROUTE,
      files: FILES,
      seed: 7,
      tables: { tick: [{ id: "t1", beats: "0" }] },
    })
    await m.quiet()
    // The first beat rides the mount's own wake; the second is behind a pause
    // that no amount of yielding can retire. A harness that raced the clock
    // would show 3 here, and would show it flakily.
    expect(m.rows("tick")[0].beats).toBe("1")
    expect(m.advance(0)).toBe(1)
    await m.quiet()
    expect(m.rows("tick")[0].beats).toBe("1")

    await m.settle()
    expect(m.rows("tick")[0].beats).toBe("3")
    expect(m.one(".beats").textContent).toBe("3")
    expect(m.advance(0)).toBe(0)
    await m.stop()
  })

  it("refuses a fetch the route does not name", async () => {
    await expect(mountScreen({
      route: { ...ROUTE, files: { ...ROUTE.files, css: "shell/screens/missing.css" } },
      files: FILES,
      seed: 7,
      tables: { tick: [{ id: "t1", beats: "0" }] },
    })).rejects.toThrow(/does not name/)
  })

  it("keeps the clock and the seed the file's", async () => {
    await expect(mountScreen({
      route: ROUTE,
      files: FILES,
      seed: 99,
      tables: { tick: [{ id: "t1", beats: "0" }] },
    })).rejects.toThrow(/belong to the test file/)
  })
})
