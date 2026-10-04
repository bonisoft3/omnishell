import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"

// A screen is populated once what it shows is on it, nested regions included.
// Regression: a nested region's first read that failed resolved its `ready`
// anyway, through the same guard that keeps a region standing through an
// outage, and the screen said populated with every nested cell blank until
// the region's own retry two seconds on. golaberto's catalogue test waited for
// its category cells for that reason. A nested first read that failed now
// says network-error until the region reads again.
const SCREEN = `<section class="screen" data-screen="wall">
  <ul class="rows" data-live="championship" data-order="id.asc">
    <template data-item>
      <li><span class="name" data-text="{name}"></span>
        <span class="category" data-live="category" data-filter="id=eq.{category_id}" data-empty="none"><template data-item><b data-text="{name}"></b></template></span>
      </li>
    </template>
  </ul>
</section>`

const ROUTE = {
  screen: "wall",
  files: { html: "shell/screens/wall.html", css: "shell/screens/wall.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const TABLES: Record<string, Record<string, unknown>[]> = {
  championship: [{ id: "c1", name: "Série A", category_id: "k1" }, { id: "c2", name: "Feminino", category_id: "k2" }],
  category: [{ id: "k1", name: "Profissional" }, { id: "k2", name: "Feminino" }],
  season: [{ id: "s1", championship_id: "c1", category_id: "k1" }],
}

const stateOf = (mount: any) => mount.querySelector(".screen")!.getAttribute("data-state")
const cellsOf = (mount: any) => [...mount.querySelectorAll(".category")].map((el: any) => el.textContent.trim())
const namesOf = (mount: any) => [...mount.querySelectorAll(".name")].map((el: any) => el.textContent.trim())

const mountWith = async (store: unknown, screen = SCREEN) => {
  const { document } = parseHTML("<!doctype html><html><head></head><body><div id=shell></div></body></html>")
  globalThis.document = document as any
  globalThis.fetch = ((url: any) => Promise.resolve(new Response(String(url).endsWith(".html") ? screen : ""))) as any
  const mount = document.getElementById("shell")!
  let timer: ReturnType<typeof setTimeout> | undefined
  const handle = await Promise.race([
    interpretScreen(mount, "http://localhost/", ROUTE, store, {}, { handlers: false }),
    new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("hydration never settled")), 3000))),
  ]).finally(() => clearTimeout(timer))
  return { handle, mount, state: stateOf(mount), cells: cellsOf(mount), names: namesOf(mount) }
}

const until = async (cond: () => boolean, ms: number) => {
  for (let waited = 0; !cond(); waited += 20) {
    if (waited >= ms) throw new Error(`not within ${ms}ms`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

// The outages these provoke are said on the console, as a region says them.
const quietly = async (fn: () => Promise<void>) => {
  const logged = console.error
  console.error = () => {}
  try {
    await fn()
  } finally {
    console.error = logged
  }
}

const rows = (table: string, filter = "") => {
  const [, col, value] = /^(\w+)=eq\.(.*)$/.exec(filter) ?? []
  return TABLES[table].filter((r) => col === undefined || r[col] === value)
}

/** A store reading TABLES. `before` runs ahead of each read, and fails it by
 * throwing or holds it by waiting; `subscribe` is the store's, by default
 * one that never wakes. */
const storeWith = ({ before = () => {}, subscribe = () => () => {} }: {
  before?: (table: string, filter: string) => void | Promise<void>
  subscribe?: (table: string, fn: () => void, opts?: { filter?: string }) => () => void
}) => ({
  query: async (table: string, _order: unknown, opts: { filter?: string } = {}) => {
    await before(table, opts.filter ?? "")
    return rows(table, opts.filter)
  },
  subscribe,
})

describe("a nested region's first paint", () => {
  // Regression: a wake landing while the first read was in flight queued a
  // pass and returned at once, and the paint was taken as done there: on
  // golaberto's front page the featured season's row went in before its
  // nested standings had rendered, and grew under the lists beside it once
  // they did, a layout shift of 0.51.
  it("is not taken as done by a wake queued behind the first read", async () => {
    const store = storeWith({
      before: async (table) => {
        if (table === "category") await new Promise((r) => setTimeout(r, 30))
      },
      subscribe: (_table, fn) => {
        const t = setTimeout(fn, 5)
        return () => clearTimeout(t)
      },
    })
    const { handle, state, cells } = await mountWith(store)
    expect(state).toBe("populated")
    expect(cells).toEqual(["Profissional", "Feminino"])
    handle.stop()
  })

  it("is on the screen before the screen says populated, through a read that failed in transit", async () => {
    let failures = 1
    const store = storeWith({
      before: (table) => {
        if (table === "category" && failures > 0) {
          failures -= 1
          throw new Error("a subset of category failed in transit")
        }
      },
    })
    await quietly(async () => {
      const { handle, mount, state, cells } = await mountWith(store)
      expect(state).toBe("network-error")
      expect(cells).toEqual(["", "Feminino"])
      // The region's own retry, two seconds on.
      await until(() => stateOf(mount) === "populated", 4000)
      expect(cellsOf(mount)).toEqual(["Profissional", "Feminino"])
      handle.stop()
    })
  })

  // Regression: the enclosing row awaited a nested region's first paint, which
  // only a read that answered settled. A nested read that kept failing then
  // held hydration pending with the list's own rows never inserted, and held
  // the list's refresh, so every later wake of the list queued behind it and
  // none ran: a dead gateway froze the screen instead of degrading it.
  it("holds neither its row nor the list's later wakes through a read that never answers", async () => {
    const wakes: (() => void)[] = []
    const store = storeWith({
      before: (table) => {
        if (table === "category") throw new Error("the category gateway is down")
      },
      subscribe: (table, fn) => {
        if (table === "championship") wakes.push(fn)
        return () => {}
      },
    })
    await quietly(async () => {
      const { handle, mount, state, names } = await mountWith(store)
      expect(state).toBe("network-error")
      expect(names).toEqual(["Série A", "Feminino"])
      TABLES.championship.push({ id: "c3", name: "Copa", category_id: "k1" })
      try {
        for (const wake of wakes) wake()
        await until(() => namesOf(mount).length === 3, 1000)
        expect(namesOf(mount)).toEqual(["Série A", "Feminino", "Copa"])
        expect(stateOf(mount)).toBe("network-error")
      } finally {
        TABLES.championship.pop()
        handle.stop()
      }
    })
  })

  // Regression: only a top region's pass put a network-error back, and a
  // region two deep is hydrated by the pass of the region it hangs in. A
  // first read failing there, on a wake of that middle region alone, left the
  // screen saying network-error with everything on it, until something
  // unrelated woke the top region.
  it("puts the state back when it reads again, however deep it is", async () => {
    const DEEP = `<section class="screen" data-screen="wall">
      <ul class="rows" data-live="championship" data-order="id.asc">
        <template data-item>
          <li><span class="name" data-text="{name}"></span>
            <ol class="seasons" data-live="season" data-filter="championship_id=eq.{id}" data-order="id.asc">
              <template data-item><li><span class="category" data-live="category" data-filter="id=eq.{category_id}"><template data-item><b data-text="{name}"></b></template></span></li></template>
            </ol>
          </li>
        </template>
      </ul>
    </section>`
    const wakes = new Map<string, () => void>()
    let failures = 0
    const store = storeWith({
      before: (table, filter) => {
        if (table === "category" && filter === "id=eq.k2" && failures > 0) {
          failures -= 1
          throw new Error("a subset of category failed in transit")
        }
      },
      subscribe: (table, fn, opts = {}) => {
        wakes.set(`${table}?${opts.filter ?? ""}`, fn)
        return () => {}
      },
    })
    await quietly(async () => {
      const { handle, mount, state } = await mountWith(store, DEEP)
      expect(state).toBe("populated")
      TABLES.season.push({ id: "s2", championship_id: "c1", category_id: "k2" })
      try {
        failures = 1
        wakes.get("season?championship_id=eq.c1")!()
        await until(() => stateOf(mount) === "network-error", 1000)
        await until(() => stateOf(mount) === "populated", 4000)
        expect(cellsOf(mount)).toEqual(["Profissional", "Feminino"])
      } finally {
        TABLES.season.pop()
        handle.stop()
      }
    })
  })
})
