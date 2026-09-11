import { describe, expect, it } from "@test/harness"
import { ftsWords, type Reader, resolveParams, tiersFrom } from "../check-visual.ts"
import type { ParamPlan } from "../interpreter/lint.ts"

// The battery fills a `:param` with a row the route's read can match, and the
// row lives where the app's program put the entity: shell.yaml `local:` names
// the browser tiers the store builds from a local factory and fills from
// `seed:`, and every other table is read through /crud. That is the decision
// createStore (interpreter/data-crud.js) takes on the same two keys, so the
// battery resolves the same way — a device-tier app has no crud service to ask,
// and asking it anyway is a 502 dressed as a coverage hole.
describe("check-visual param resolution follows the app's declared tier", () => {
  const plan = (route: string, param: string, table: string, column: string, op = "eq", filter?: string): ParamPlan => ({
    route,
    param,
    table,
    column,
    op,
    filter: filter ?? `${column}=${op}.{param.${param}}`,
  })

  /** A shell.yaml of the given tier, with whatever else the case declares. */
  const tier = (server: boolean, yaml = "") => tiersFrom(`server: ${server}\n${yaml}`)

  /** A reader that records every query and answers from a table of canned rows. */
  const reader = (answers: Record<string, Record<string, unknown>[]> = {}) => {
    const calls: string[] = []
    const api: Reader = (query) => {
      calls.push(query)
      const table = query.split("?")[0]
      const rows = answers[table]
      if (rows === undefined) return Promise.reject(new Error(`GET /crud/${query} -> 502`))
      return Promise.resolve(rows)
    }
    return { api, calls }
  }

  it("reads the tier off shell.yaml: the server fact, and the local tables with their seed", () => {
    const device = tier(false, "local:\n  theme: tab\nseed:\n  theme:\n    - id: light\n")
    expect(device).toEqual({ local: { theme: "tab" }, seed: { theme: [{ id: "light" }] }, server: false })
    // pronto emits `local:` and `seed:` only when non-empty, so their absence
    // is the emitted statement that every table is a server one; `server:` is
    // always emitted, and a file without it is not a shell.yaml.
    expect(() => tiersFrom("local:\n  theme: tab\n")).toThrow("no server:")
    expect(tier(true)).toEqual({ local: {}, seed: {}, server: true })
  })

  it("resolves a device table from its seed and never asks the API", async () => {
    const tiers = tier(
      false,
      [
        "local:",
        "  theme: tab",
        "  reading: device",
        "seed:",
        "  theme:",
        "    - id: light",
        "    - id: dark",
        "  reading:",
        "    - id: r1",
        "      pos: 3",
        "    - id: r2",
        "      pos: 7",
        "    - id: r3",
        "      pos: 5",
      ].join("\n"),
    )
    const { api, calls } = reader()
    const { params, unresolved } = await resolveParams(
      [
        plan("/theme/:theme", "theme", "theme", "id"),
        plan("/newer/:pos", "pos", "reading", "pos", "gt"),
        plan("/older/:pos", "pos", "reading", "pos", "lt"),
      ],
      tiers,
      api,
    )
    expect(params.get("/theme/:theme")).toEqual({ theme: "light" })
    // A cursor takes the extreme so the rest of the set remains, as it does
    // over the API's ordered read.
    expect(params.get("/newer/:pos")).toEqual({ pos: "3" })
    expect(params.get("/older/:pos")).toEqual({ pos: "7" })
    expect(unresolved).toEqual([])
    expect(calls).toEqual([])
  })

  it("a device table with no seed row is a reported hole", async () => {
    const tiers = tier(false, "local:\n  theme: tab\n")
    const { api, calls } = reader()
    const { params, unresolved } = await resolveParams([plan("/theme/:theme", "theme", "theme", "id")], tiers, api)
    expect(params.size).toBe(0)
    expect(unresolved).toEqual([{ route: "/theme/:theme", param: "theme" }])
    expect(calls).toEqual([])
  })

  it("resolves a server table through the API, one ordered read per plan", async () => {
    const tiers = tier(true)
    const { api, calls } = reader({ note: [{ id: "n1" }] })
    const { params, unresolved } = await resolveParams([plan("/note/:id", "id", "note", "id")], tiers, api)
    expect(params.get("/note/:id")).toEqual({ id: "n1" })
    expect(unresolved).toEqual([])
    expect(calls).toEqual(["note?select=id&limit=1"])
  })

  it("a read the store computes on the server goes through the API even over a device table", async () => {
    // fragment.js translates neither an fts expression nor an embed path, so the
    // terminal reads those through /crud whatever the table's tier is.
    const tiers = tier(false, "local:\n  article: tab\nseed:\n  article:\n    - id: a1\n      title: Dragons\n")
    // The words the index answers are read off the indexed column itself — a
    // tsvector prints its lexemes — never off a `title` the table may not have.
    const { api, calls } = reader({
      article: [{ id: "a1", title: "Dragons", search: "'dragon':1 'lair':2", article_tag: [{ tag: "t" }] }],
    })
    const { params } = await resolveParams(
      [
        plan("/tag/:name", "name", "article", "article_tag.tag"),
        plan("/search/:q", "q", "article", "search", "plfts(simple)"),
      ],
      tiers,
      api,
    )
    expect(params.get("/tag/:name")).toEqual({ name: "t" })
    expect(params.get("/search/:q")).toEqual({ q: "dragon" })
    expect(calls[0]).toBe("article?select=article_tag(tag)&limit=1")
    expect(calls[1]).toBe("article?select=search&limit=40")
  })

  it("the whole region filter decides the tier, and an `is` binding reads locally", async () => {
    const tiers = tier(false, "local:\n  note: tab\nseed:\n  note:\n    - id: n1\n      done: true\n")
    const { api, calls } = reader({ note: [{ id: "srv" }] })
    const { params } = await resolveParams(
      [
        plan("/done/:flag", "flag", "note", "done", "is"),
        // One `cs` clause beside the param's sends the whole read to the server.
        plan("/tagged/:id", "id", "note", "id", "eq", "tags=cs.{x}&id=eq.{param.id}"),
      ],
      tiers,
      api,
    )
    expect(params.get("/done/:flag")).toEqual({ flag: "true" })
    expect(params.get("/tagged/:id")).toEqual({ id: "srv" })
    expect(calls).toEqual(["note?select=id&limit=1"])
  })

  it("ftsWords keeps words in any script, and nothing that is not a word", () => {
    expect(ftsWords(["'farmácia':1 'a&b':2 'café':3 'xy':4", "Plain Text here"])).toEqual(["farmácia", "café", "plain", "text", "here"])
  })

  it("an embedded relation with nothing behind it is a hole, and a row without the column is an error", async () => {
    const tiers = tier(true)
    const empty = reader({ article: [{ id: "a1", article_tag: [] }] })
    const { params, unresolved } = await resolveParams([plan("/tag/:name", "name", "article", "article_tag.tag")], tiers, empty.api)
    expect(params.get("/tag/:name")).toBeUndefined()
    expect(unresolved).toEqual([{ route: "/tag/:name", param: "name" }])
    // embedValue's null hop.
    const nulled = reader({ article: [{ id: "a1", author: null }] })
    const r2 = await resolveParams([plan("/by/:handle", "handle", "article", "author.handle")], tiers, nulled.api)
    expect(r2.unresolved).toEqual([{ route: "/by/:handle", param: "handle" }])
    const keyless = reader({ article: [{ id: "a1" }] })
    await expect(resolveParams([plan("/tag/:name", "name", "article", "article_tag.tag")], tiers, keyless.api)).rejects.toThrow(
      "answered a row without article_tag.tag",
    )
  })

  it("a seed row that omits the column does not answer, and a cursor takes the extreme of the rest", async () => {
    // resolveParams's open-map rule: n1 omits pos, n4 carries it null.
    const tiers = tier(false, "local:\n  note: tab\nseed:\n  note:\n    - id: n1\n    - id: n2\n      pos: 3\n    - id: n3\n      pos: 7\n    - id: n4\n      pos: null\n")
    const { api, calls } = reader()
    const { params, unresolved } = await resolveParams(
      [
        plan("/after/:pos", "pos", "note", "pos", "gt"),
        plan("/before/:pos", "pos", "note", "pos", "lt"),
        plan("/at/:pos", "pos", "note", "pos"),
      ],
      tiers,
      api,
    )
    expect(params.get("/after/:pos")).toEqual({ pos: "3" })
    expect(params.get("/before/:pos")).toEqual({ pos: "7" })
    expect(params.get("/at/:pos")).toEqual({ pos: "3" })
    expect(unresolved).toEqual([])
    expect(calls).toEqual([])
    const bare = tier(false, "local:\n  note: tab\nseed:\n  note:\n    - id: n1\n")
    const r2 = await resolveParams([plan("/at/:pos", "pos", "note", "pos")], bare, api)
    expect(r2.unresolved).toEqual([{ route: "/at/:pos", param: "pos" }])
  })

  it("an API that cannot answer is an error, not a hole", async () => {
    const tiers = tier(true)
    const { api } = reader()
    await expect(resolveParams([plan("/note/:id", "id", "note", "id")], tiers, api)).rejects.toThrow(
      "GET /crud/note?select=id&limit=1 -> 502",
    )
  })
})
