// The lane clauses: the four that name a row for a gesture to write, and the
// partition that keeps a minor axis inside its own run.
//
// The grid here is the shape the calendar walks — one collection read twice,
// once per axis, the second axis being nothing but a second `data-order`. What
// the partition adds is the edge: without it the foot of a column names the
// HEAD OF THE NEXT ONE, which is a wrong answer rather than a missing one.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen, type Mounted } from "./screen-harness.ts"

const ROUTE = { screen: "grid", files: { html: "grid.html", css: "grid.css", handlers: [] } }

const screen = (project: string, order: string) => ({
  "grid.html": `<section class="screen" data-screen="grid">
    <div data-live="cell" data-order="${order}" data-project='${project}'>
      <template data-item>
        <b id="c-{id}" data-nx="{nx}" data-pv="{pv}" data-fs="{fs}" data-ls="{ls}"></b>
      </template>
    </div>
  </section>`,
  "grid.css": "",
})

// Three columns of three, so every cell has a distinct row and column and the
// two orders disagree everywhere but the corners.
const cells = () =>
  [1, 2, 3].flatMap((r) => [1, 2, 3].map((c) => ({ id: `r${r}c${c}`, row: `r${r}`, col: `c${c}`, pos: (r - 1) * 3 + c, colpos: (c - 1) * 3 + r })))

const mount = (project: string, order: string, rows = cells()) =>
  mountScreen({ route: ROUTE, files: screen(project, order), tables: { cell: rows }, seed: 1 })

const read = (m: Mounted, name: string) => (m.all("b") as El[]).map((el) => el.getAttribute(name))

const ALL = '{"nx":"next","pv":"prev","fs":"first","ls":"last"}'
const BY_COL = '{"nx":{"next":"col"},"pv":{"prev":"col"},"fs":{"first":"col"},"ls":{"last":"col"}}'

describe("both ends of the set are named", () => {
  it("answers the first and last row of the region's own order, on every row", async () => {
    const m = await mount(ALL, "pos.asc")
    await m.settle()
    // Home and End do not vary per row: the whole set has one of each.
    expect(read(m, "data-fs")).toEqual(new Array(9).fill("r1c1"))
    expect(read(m, "data-ls")).toEqual(new Array(9).fill("r3c3"))
    await m.stop()
  })

  it("follows the order the region declares, not the order rows arrived in", async () => {
    const m = await mount(ALL, "colpos.asc")
    await m.settle()
    // Column-major: the last cell is the foot of the LAST column, and in this
    // grid that is the same corner — so the first is what discriminates.
    expect(read(m, "data-fs")[0]).toBe("r1c1")
    expect(read(m, "data-ls")[0]).toBe("r3c3")
    await m.stop()
  })

  it("names itself at both ends when the region holds one row", async () => {
    const m = await mount(ALL, "pos.asc", [{ id: "only", row: "r1", col: "c1", pos: 1, colpos: 1 }])
    await m.settle()
    expect(read(m, "data-fs")).toEqual(["only"])
    expect(read(m, "data-ls")).toEqual(["only"])
    expect(read(m, "data-nx")).toEqual(["only"])
    expect(read(m, "data-pv")).toEqual(["only"])
    await m.stop()
  })
})

describe("a partitioned lane stays inside its own run", () => {
  it("walks the minor axis without running into the next lane", async () => {
    const m = await mount(BY_COL, "colpos.asc")
    await m.settle()
    // Column-major order is c1's three rows, then c2's, then c3's. The foot of
    // c1 is r3c1, and unpartitioned `next` would hand it r1c2 — the head of
    // the next column, which is the bug this clause exists for.
    const ids = (m.all("b") as El[]).map((el) => el.getAttribute("id"))
    expect(ids).toEqual(["c-r1c1", "c-r2c1", "c-r3c1", "c-r1c2", "c-r2c2", "c-r3c2", "c-r1c3", "c-r2c3", "c-r3c3"])
    expect(read(m, "data-nx")).toEqual([
      "r2c1", "r3c1", "r3c1", // c1: the foot names itself
      "r2c2", "r3c2", "r3c2",
      "r2c3", "r3c3", "r3c3",
    ])
    expect(read(m, "data-pv")).toEqual([
      "r1c1", "r1c1", "r2c1",
      "r1c2", "r1c2", "r2c2",
      "r1c3", "r1c3", "r2c3",
    ])
    await m.stop()
  })

  it("answers both ends of the lane rather than both ends of the set", async () => {
    const m = await mount(BY_COL, "colpos.asc")
    await m.settle()
    expect(read(m, "data-fs")).toEqual(["r1c1", "r1c1", "r1c1", "r1c2", "r1c2", "r1c2", "r1c3", "r1c3", "r1c3"])
    expect(read(m, "data-ls")).toEqual(["r3c1", "r3c1", "r3c1", "r3c2", "r3c2", "r3c2", "r3c3", "r3c3", "r3c3"])
    await m.stop()
  })

  it("partitions the same collection differently per axis, off one set of rows", async () => {
    // The two lanes the calendar mounts: reading order partitioned by row is
    // the horizontal walk, column-major partitioned by column the vertical.
    const across = await mount('{"nx":{"next":"row"},"pv":{"prev":"row"},"fs":{"first":"row"},"ls":{"last":"row"}}', "pos.asc")
    await across.settle()
    expect(read(across, "data-nx").slice(0, 3)).toEqual(["r1c2", "r1c3", "r1c3"])
    expect(read(across, "data-ls").slice(0, 3)).toEqual(["r1c3", "r1c3", "r1c3"])
    await across.stop()
  })

  it("holds the lane together when the rows between are filtered away", async () => {
    // The partition is a fact about the rows the region HOLDS, so a filtered
    // grid's neighbour is the next surviving cell of the same column.
    const m = await mount(BY_COL, "colpos.asc", cells().filter((c) => c.row !== "r2"))
    await m.settle()
    expect(read(m, "data-nx")).toEqual(["r3c1", "r3c1", "r3c2", "r3c2", "r3c3", "r3c3"])
    await m.stop()
  })
})

describe("a partition names a column every row carries", () => {
  it("refuses a partition column the rows lack", async () => {
    // Unlike `eq`, one unplaceable row shortens the lane every OTHER row walks,
    // so there is no answering it locally and no pending carve-out to make.
    await expect(mount('{"nx":{"next":"lane"}}', "pos.asc")).rejects.toThrow(/partitions by \{lane\}/)
  })
})
