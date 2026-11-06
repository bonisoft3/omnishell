import { describe, expect, it } from "@test/harness"
import { ftsWords, type Reader, renderedRouteParams, resolveRenderedFixture, resolveParams, resolveReadyParams, tiersFrom } from "../check-visual.ts"
import { paramPlans, type ParamPlan } from "../interpreter/lint.ts"

// The battery fills a `:param` with a row the route's read can match, and the
// row lives where the app's program put the entity: shell.yaml `local:` names
// the browser tiers the store builds from a local factory and fills from
// `seed:`, and every other table is read through /crud. That is the decision
// createStore (interpreter/data-sync.js) takes on the same two keys, so the
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

  it("waits for derived route fixtures without rereading ready routes or mixing related params", async () => {
    const route = "/jogador-campeonato/:slug/:team/:championship"
    const filter = "player.slug=eq.{param.slug}&team.slug=eq.{param.team}&championship.slug=eq.{param.championship}"
    const plans = [
      plan("/equipe/:slug", "slug", "team", "slug"),
      plan(route, "slug", "player_stat", "player.slug", "eq", filter),
      plan(route, "team", "player_stat", "team.slug", "eq", filter),
      plan(route, "championship", "player_stat", "championship.slug", "eq", filter),
      plan("/jogo/:slug", "slug", "game_card", "game.slug"),
      plan("/editar/:slug", "slug", "game_card", "game.slug"),
    ]
    const calls: string[] = []
    let published = false
    const api: Reader = (query) => {
      calls.push(query)
      if (query.startsWith("team?")) return Promise.resolve([{ slug: "ready" }])
      if (query.startsWith("player_stat?")) {
        if (!published) return Promise.resolve([])
        if (query.includes("select=team(")) expect(query).toContain("player.slug=eq.player")
        if (query.includes("select=championship(")) {
          expect(query).toContain("player.slug=eq.player")
          expect(query).toContain("team.slug=eq.team")
        }
        return Promise.resolve([{ player: { slug: "player" }, team: { slug: "team" }, championship: { slug: "cup" } }])
      }
      if (!published) {
        if (calls.length === plans.length) published = true
        return Promise.resolve([])
      }
      return Promise.resolve([{ game: { slug: "match" } }])
    }
    const once = await resolveParams(plans, tier(true), api)
    expect(once.unresolved.length).toBe(5)
    calls.length = 0
    published = false
    const ready = await resolveReadyParams(plans, tier(true), api, 2000)
    expect(ready.unresolved).toEqual([])
    expect(ready.params.get(route)).toEqual({ slug: "player", team: "team", championship: "cup" })
    expect(ready.params.get("/jogo/:slug")).toEqual({ slug: "match" })
    expect(ready.params.get("/editar/:slug")).toEqual({ slug: "match" })
    expect(calls.filter((query) => query.startsWith("team?")).length).toBe(1)
  })

  it("keeps absent fixtures as coverage holes after one shared readiness deadline", async () => {
    const plans = [plan("/a/:id", "id", "a", "id"), plan("/b/:id", "id", "b", "id")]
    const { api, calls } = reader({ a: [], b: [] })
    const result = await resolveReadyParams(plans, tier(true), api, 100)
    expect(result.unresolved).toEqual([{ route: "/a/:id", param: "id" }, { route: "/b/:id", param: "id" }])
    expect(calls.length).toBe(2)
  })

  it("does not retry immutable seed holes or failed API reads", async () => {
    const plans = [plan("/a/:id", "id", "a", "id")]
    const unavailable = reader()
    const result = await resolveReadyParams(plans, tier(false, "local:\n  a: device\n"), unavailable.api, 1000)
    expect(result.unresolved).toEqual([{ route: "/a/:id", param: "id" }])
    expect(unavailable.calls).toEqual([])
    await expect(resolveReadyParams(plans, tier(true), unavailable.api, 1000)).rejects.toThrow("502")
    expect(unavailable.calls.length).toBe(1)
  })

  it("bounds a pending retry read by the original deadline and propagates retry errors", async () => {
    const plans = [plan("/a/:id", "id", "a", "id")]
    let reads = 0
    await expect(resolveReadyParams(plans, tier(true), () => {
      reads++
      return reads === 1 ? Promise.resolve([]) : new Promise(() => {})
    }, 400)).rejects.toThrow("fixture readiness timed out")
    expect(reads).toBe(2)
    reads = 0
    await expect(resolveReadyParams(plans, tier(true), () => {
      reads++
      return reads === 1 ? Promise.resolve([]) : Promise.reject(new Error("GET failed"))
    }, 2000)).rejects.toThrow("GET failed")
    expect(reads).toBe(2)
  })

  it("fails an initial API read that never answers within the readiness deadline", async () => {
    await expect(resolveReadyParams(
      [plan("/a/:id", "id", "a", "id")], tier(true), () => new Promise(() => {}), 50,
    )).rejects.toThrow("fixture readiness timed out")
  })

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

  it("plans route params declared via data-read-* and constrains multi-param routes by already-resolved params", async () => {
    const html = `<section class="screen" data-screen="card">
      <div data-live="play_session" data-read-set="card_set?id=eq.{param.deck}" data-read-cards="flashcard?set_id=eq.{param.deck}&front=eq.{param.card}"></div>
    </section>`
    const { plans, unplanned } = paramPlans(
      [{ path: "/explore/:deck/:card" }],
      { "/explore/:deck/:card": html },
    )
    expect(unplanned).toEqual([])
    expect(plans).toEqual([
      { route: "/explore/:deck/:card", param: "deck", table: "card_set", column: "id", op: "eq", filter: "id=eq.{param.deck}" },
      { route: "/explore/:deck/:card", param: "card", table: "flashcard", column: "front", op: "eq", filter: "set_id=eq.{param.deck}&front=eq.{param.card}" },
    ])
    const tiers = tier(true)
    const { api, calls } = reader({
      card_set: [{ id: "deck-2" }],
      flashcard: [{ set_id: "deck-2", front: "hola" }],
    })
    const { params, unresolved } = await resolveParams(plans, tiers, api)
    expect(unresolved).toEqual([])
    expect(params.get("/explore/:deck/:card")).toEqual({ deck: "deck-2", card: "hola" })
    expect(calls).toEqual([
      "card_set?select=id&limit=1",
      "flashcard?select=front&set_id=eq.deck-2&limit=1",
    ])

    // On device tier, narrowing by already-resolved :deck picks the matching card
    // and reports an unresolved hole (without falling back) when no card matches :deck.
    const deviceMatching = tier(
      false,
      [
        "local:",
        "  card_set: device",
        "  flashcard: device",
        "seed:",
        "  card_set:",
        "    - id: deck-2",
        "  flashcard:",
        "    - set_id: deck-1",
        "      front: wrong",
        "    - set_id: deck-2",
        "      front: right",
      ].join("\n"),
    )
    const matched = await resolveParams(plans, deviceMatching, reader().api)
    expect(matched.unresolved).toEqual([])
    expect(matched.params.get("/explore/:deck/:card")).toEqual({ deck: "deck-2", card: "right" })

    const deviceDisjoint = tier(
      false,
      [
        "local:",
        "  card_set: device",
        "  flashcard: device",
        "seed:",
        "  card_set:",
        "    - id: deck-2",
        "  flashcard:",
        "    - set_id: deck-1",
        "      front: wrong",
      ].join("\n"),
    )
    const disjoint = await resolveParams(plans, deviceDisjoint, reader().api)
    expect(disjoint.unresolved).toEqual([{ route: "/explore/:deck/:card", param: "card" }])
    expect(disjoint.params.get("/explore/:deck/:card")).toEqual({ deck: "deck-2" })

    // Constant filter clauses (e.g. cover_emoji=eq.🎨) are preserved even on the first param when no prior params exist.
    const constPlans: ParamPlan[] = [
      { route: "/generated/:deck", param: "deck", table: "card_set", column: "id", op: "eq", filter: "cover_emoji=eq.🎨&id=eq.{param.deck}" },
    ]
    const constServer = reader({ card_set: [{ id: "set-gen-1", cover_emoji: "🎨" }] })
    const constRes = await resolveParams(constPlans, tier(true), constServer.api)
    expect(constRes.params.get("/generated/:deck")).toEqual({ deck: "set-gen-1" })
    expect(constServer.calls).toEqual(["card_set?select=id&cover_emoji=eq.🎨&limit=1"])

    // Dotted context filters embed their resource with !inner in select so PostgREST joins and filters by it.
    const embedPlans: ParamPlan[] = [
      { route: "/player/:slug/:team", param: "slug", table: "player_stat", column: "player.slug", op: "eq", filter: "player.slug=eq.{param.slug}&team.slug=eq.{param.team}" },
      { route: "/player/:slug/:team", param: "team", table: "player_stat", column: "team.slug", op: "eq", filter: "player.slug=eq.{param.slug}&team.slug=eq.{param.team}" },
    ]
    const embedServer = reader({ player_stat: [{ player: { slug: "everson" }, team: { slug: "atletico-mg" } }] })
    const embedRes = await resolveParams(embedPlans, tier(true), embedServer.api)
    expect(embedRes.params.get("/player/:slug/:team")).toEqual({ slug: "everson", team: "atletico-mg" })
    expect(embedServer.calls).toEqual([
      "player_stat?select=player(slug)&limit=1",
      "player_stat?select=team(slug),player!inner(slug)&player.slug=eq.everson&limit=1",
    ])
  })

  it("plans a card from a real rail link constrained to the same deck", async () => {
    const route = { path: "/explore/:deck/:card", screen: "card" };
    const html = `<section data-screen="card"><div data-live="card_set" data-filter="id=eq.{param.deck}"></div>
      <nav data-live="flashcard" data-filter="set_id=eq.{param.deck}"><template data-item>
      <a data-route="card" data-param-deck="{set_id}" data-param-card="{front}"></a></template></nav></section>`;
    const { plans, unplanned } = paramPlans([route], { [route.path]: html });
    expect(unplanned).toEqual([]);
    const { params, unresolved } = await resolveParams(plans, tier(true), reader({
      card_set: [{ id: "deck-2" }], flashcard: [{ set_id: "deck-2", front: "Pikachu" }],
    }).api);
    expect(unresolved).toEqual([]);
    expect(params.get(route.path)).toEqual({ deck: "deck-2", card: "Pikachu" });
    const unrelated = html.replace('data-param-deck="{set_id}"', 'data-param-deck="{other_set}"');
    expect(paramPlans([route], { [route.path]: unrelated }).unplanned).toEqual([{ route: route.path, param: "card" }]);
  })
})

Deno.test("rendered route fixtures retain the resolved parent and reject unrelated or malformed links", async () => {
  const route = { path: "/explore/:deck/:card", screen: "card" };
  const cfg = { routes: [route], i18n: { default: "pt", locales: { pt: { path: "pt" }, en: { path: "en" } } } };
  const known = { deck: "deck-1" }, origin = "https://app.test";
  expect(renderedRouteParams(cfg, route.path, `${origin}/en/explore/deck-1/Polar%20bear`, known, origin)).toEqual({ deck: "deck-1", card: "Polar bear", locale: "en" });
  for (const href of [`${origin}/en/explore/deck-2/Polar%20bear`, `${origin}/extra/explore/deck-1/Polar%20bear`, `${origin}/print/deck-1/Polar%20bear`, "not a URL", `${origin}/explore/deck-1/%ZZ`, "https://other.test/explore/deck-1/cat"]) {
    expect(renderedRouteParams(cfg, route.path, href, known, origin)).toEqual(undefined);
  }
  let reads = 0, opened = "";
  const page = { goto: (url: string) => { opened = url; return Promise.resolve(); }, evaluate: () => Promise.resolve(++reads === 1 ? [`${origin}/en/explore/deck-2/Cat`] : [`${origin}/en/explore/deck-1/Polar%20bear`]), waitForTimeout: () => Promise.resolve() };
  expect(await resolveRenderedFixture(page, cfg, origin, route, "/explore/:deck", known, "card", 1000)).toEqual({ deck: "deck-1", card: "Polar bear", locale: "en" });
  expect(opened).toEqual(`${origin}/explore/deck-1`);
  expect(reads).toEqual(2);
});
