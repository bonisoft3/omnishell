import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const route = { screen: "feed", files: { html: "feed.html", css: "feed.css", handlers: [] } }
const rows = () => [
  { id: "a", pos: 1, day: "2026-10-01", competition: "A" },
  { id: "b", pos: 2, day: "2026-10-01", competition: "A" },
  { id: "c", pos: 3, day: "2026-10-01", competition: "B" },
  { id: "d", pos: 4, day: "2026-10-01", competition: "A" },
  { id: "e", pos: 5, day: "2026-10-02", competition: "A" },
]
const mount = (order = "pos.asc", filter = "", project = '{"day_start":{"changed":["day"]},"group_start":{"changed":["day","competition"]}}') =>
  mountScreen({
    route,
    files: {
      "feed.html": `<section class="screen" data-screen="feed">
        <ol data-live="match" data-order="${order}" data-filter="${filter}" data-project='${project}'>
          <template data-item><li id="m-{id}" data-day="{day_start}" data-group="{group_start}"></li></template>
        </ol>
      </section>`,
      "feed.css": "",
    },
    tables: { match: rows() },
    seed: 1,
  })
const boundaries = (m: Mounted) => (m.all("li") as El[]).map((el) => [el.getAttribute("id"), el.getAttribute("data-day"), el.getAttribute("data-group")])

describe("consecutive group boundaries", () => {
  it("reintroduces a championship after an interruption and at a new day", async () => {
    const m = await mount()
    await m.settle()
    expect(boundaries(m)).toEqual([
      ["m-a", "true", "true"], ["m-b", "false", "false"], ["m-c", "false", "true"],
      ["m-d", "false", "true"], ["m-e", "true", "true"],
    ])
    await m.stop()
  })

  it("starts the visible window afresh and follows descending order", async () => {
    const m = await mount("pos.desc", "pos=gte.2")
    await m.settle()
    expect(boundaries(m)).toEqual([
      ["m-e", "true", "true"], ["m-d", "true", "true"], ["m-c", "false", "true"], ["m-b", "false", "true"],
    ])
    await m.stop()
  })

  it("moves headings after corrections, removals and insertions while retaining match nodes", async () => {
    const m = await mount()
    await m.settle()
    const b = m.all("#m-b")[0]
    await m.store.remove("match", "a")
    await m.store.update("match", "c", { competition: "A" })
    await m.settle()
    expect(m.all("#m-b")[0]).toBe(b)
    expect(boundaries(m)).toEqual([
      ["m-b", "true", "true"], ["m-c", "false", "false"], ["m-d", "false", "false"], ["m-e", "true", "true"],
    ])
    await m.store.create("match", { id: "f", pos: 0, day: "2026-10-01", competition: "A" })
    await m.settle()
    expect(boundaries(m).slice(0, 2)).toEqual([["m-f", "true", "true"], ["m-b", "false", "false"]])
    expect(m.all("#m-b")[0]).toBe(b)
    await m.stop()
  })

  it("refuses missing boundary columns", async () => {
    await expect(mount("pos.asc", "", '{"day_start":{"changed":["missing"]},"group_start":"index"}'))
      .rejects.toThrow(/reads \{missing\}, not in row/)
  })
})
