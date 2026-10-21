import { describe, expect, it } from "@test/harness"
import { mountScreen, type Mounted, type Row } from "./screen-harness.ts"
const project = '{"day_start":{"changed":["reader_day"]},"group_start":{"changed":["reader_day","competition"]},"reader_day":{"date":["kickoff","day"]},"position":"index","next":"next"}'
const rows = (): Row[] => [
  { id: "a", kickoff: "2026-10-16T00:30:00Z", day: "2026-10-16", competition: "B" },
  { id: "b", kickoff: "2026-10-16T01:30:00Z", day: "2026-10-16", competition: "A" },
  { id: "c", kickoff: "2026-10-16T02:30:00Z", day: "2026-10-16", competition: "B" },
  { id: "d", kickoff: "2026-10-16T08:30:00Z", day: "2026-10-16", competition: "A" },
  { id: "e", kickoff: null, day: "2026-10-17", competition: "A" },
]
const mount = (timeZone = "America/Los_Angeles", projection = project, order = "reader_day.asc,competition.asc,kickoff.asc,id.asc", data = rows(), nested = false) => mountScreen({
  route: { screen: "feed", files: { html: "feed.html", css: "feed.css", handlers: [] } },
  files: {
    "feed.html": `<section data-screen="feed">${nested ? '<div data-live="parent"><template data-item><article>' : ''}
      <ol data-live="game" data-order="kickoff.asc,id.asc" data-filter="limit=40" ${nested ? 'data-owner="{label}"' : ""} data-display-order="${order}" data-project='${projection}'>
        <template data-item><li id="g-{id}" data-day="{reader_day}" data-start="{day_start}" data-group="{group_start}" data-position="{position}" data-next="{next}">
          <time data-text="{kickoff}" data-text-format="time"></time><span data-text="{reader_day}" data-text-format="date"></span>
        </li></template>
      </ol>${nested ? '</article></template></div>' : ''}</section>`,
    "feed.css": "",
  }, tables: { game: data, parent: [{ id: "parent", label: "before" }] }, seed: 1, timeZone,
})
const snapshot = (m: Mounted) => m.all("li").map((el) => ["id", "data-day", "data-start", "data-group", "data-position", "data-next"].map((key) => el.getAttribute(key)))
describe("reader-day projection and bounded display order", () => {
  it("groups midnight games after the scalar pass, including nested regions", async () => {
    const m = await mount("America/Los_Angeles", project, undefined, rows(), true)
    await m.settle()
    expect(snapshot(m)).toEqual([
      ["g-b", "2026-10-15", "true", "true", "1", "a"],
      ["g-a", "2026-10-15", "false", "true", "2", "c"],
      ["g-c", "2026-10-15", "false", "false", "3", "d"],
      ["g-d", "2026-10-16", "true", "true", "4", "e"],
      ["g-e", "2026-10-17", "true", "true", "5", "e"],
    ])
    expect(m.all("#g-b time")[0].textContent).toBe("18:30")
    expect(m.all("#g-b span")[0].textContent).toBe("10/15/2026")
    expect(m.all("#g-e time")[0].textContent).toBe("")
    expect(m.store.rows("game")).toEqual(rows())
    const a = m.all("#g-a")[0]
    await m.store.update("parent", "parent", { label: "after" })
    await m.settle()
    expect(m.all("#g-a")[0]).toBe(a)
    expect(snapshot(m).map((row) => row[0])).toEqual(["g-b", "g-a", "g-c", "g-d", "g-e"])
    const originalQuery = m.store.query.bind(m.store)
    const reads: unknown[] = []
    m.store.query = (table, order, opts) => { reads.push([table, order, opts?.filter]); return originalQuery(table, order, opts) }
    const b = m.all("#g-b")[0]
    await m.store.update("game", "b", { kickoff: "2026-10-16T09:30:00Z" })
    await m.settle()
    expect(m.all("#g-b")[0]).toBe(b)
    expect(snapshot(m).map((row) => row[0])).toEqual(["g-a", "g-c", "g-d", "g-b", "g-e"])
    expect(reads).toEqual([["game", "kickoff.asc,id.asc", "limit=40"]])
    expect(m.store.rows("game").every((row) => !("reader_day" in row))).toBe(true)
    await m.stop()
  })
  it("keeps ties stable and handles descending null placement", async () => {
    const m = await mount("UTC", project, "kickoff.desc.nullsfirst")
    await m.settle()
    expect(snapshot(m).map((row) => row[0])).toEqual(["g-e", "g-d", "g-c", "g-b", "g-a"])
    await m.stop()
    const tie = await mount("UTC", project, "competition.asc")
    await tie.settle()
    expect(snapshot(tie).map((row) => row[0])).toEqual(["g-b", "g-d", "g-e", "g-a", "g-c"])
    await tie.stop()
  })
  it("sorts only the forty fetched rows", async () => {
    const data = Array.from({ length: 41 }, (_, i) => ({ id: String(i).padStart(2, "0"), kickoff: `2026-10-16T${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}:00Z`, day: "2026-10-16", competition: i === 40 ? "A" : "B" }))
    const m = await mount("UTC", project, "competition.asc,id.desc", data)
    await m.settle()
    expect(m.all("li").length).toBe(40)
    expect(m.all("li")[0].getAttribute("id")).toBe("g-39")
    expect(m.all("#g-40").length).toBe(0)
    await m.stop()
  })
  it("rejects display order on a slot", async () => {
    await expect(mountScreen({
      route: { screen: "feed", files: { html: "feed.html", css: "feed.css", handlers: [] } },
      files: { "feed.html": '<section data-screen="feed"><div data-live="game" data-display-order="id.asc"></div></section>', "feed.css": "" },
      tables: { game: rows() }, seed: 1,
    })).rejects.toThrow(/is a slot and declares data-display-order/)
  })
  it("refuses missing sources, stored-column collisions, bad dates and order terms", async () => {
    await expect(mount("UTC", '{"reader_day":{"date":["kickoff","missing"]}}')).rejects.toThrow(/reads \{missing\}/)
    await expect(mount("UTC", '{"day":{"date":["kickoff"]}}')).rejects.toThrow(/already a column/)
    await expect(mount("UTC", project, "missing.asc")).rejects.toThrow(/data-display-order reads \{missing\}/)
    await expect(mount("UTC", project, "id.sideways")).rejects.toThrow(/invalid data-display-order/)
    await expect(mount("UTC", project, undefined, [{ ...rows()[0], kickoff: "broken" }])).rejects.toThrow(/invalid date/)
  })
})
