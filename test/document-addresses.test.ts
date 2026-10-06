import { afterEach, describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { renderDocument } from "../interpreter/document.js"
import { screenEnv } from "../interpreter/fragment.js"
import { interpretScreen } from "../interpreter/screen.js"
import { routeAt } from "../interpreter/shell.js"
import { createRenderer } from "../server/render.ts"

const ORIGIN = "https://addresses.test"
const GAME_ID = "11111111-1111-4111-8111-111111111111"
const TEAM_ID = "22222222-2222-4222-8222-222222222222"
const CHAMPIONSHIP_ID = "33333333-3333-4333-8333-333333333333"
const ENTRY = '<html><head><title>Football</title></head><body><main id="app"></main><script type="module" src="/boot.js"></script></body></html>'
const templates: Record<string, string> = {
  game: `<section class="screen" data-screen="game">
    <div data-live="game_card" data-select="*,game:id!inner(slug),home:home_id(slug)" data-filter="game.slug=eq.{param.slug}" data-empty="No such game">
      <template data-item><article>
        <h1 data-text="{name}"></h1>
        <a class="team" data-route="team" data-param-slug="{home.slug}" data-text="{home_name}"></a>
        <ol class="goals" data-live="goal" data-filter="game_id=eq.{id}"><template data-item><li data-text="{scorer}"></li></template></ol>
        <ol class="comments" data-live="comment" data-filter="game_id=eq.{id}" data-empty="No comments"><template data-item><li data-text="{body}"></li></template></ol>
      </article></template>
    </div>
  </section>`,
  campaign: `<section class="screen" data-screen="campaign">
    <div data-live="team_championship" data-select="*,team!inner(slug),championship!inner(slug)" data-filter="team.slug=eq.{param.slug}&championship.slug=eq.{param.championship_slug}" data-empty="No such campaign">
      <template data-item><article><h1 data-text="{name}"></h1>
        <a class="team" data-route="team" data-param-slug="{team.slug}" data-text="{name}"></a>
        <ol class="games" data-live="team_game" data-select="*,game(slug)" data-filter="team_id=eq.{team_id}&championship_id=eq.{championship_id}" data-empty="No games">
          <template data-item><li><a data-route="game" data-param-slug="{game.slug}" data-text="{name}"></a></li></template>
        </ol>
      </article></template>
    </div>
  </section>`,
  games: '<section class="screen" data-screen="games"><h1>Games</h1><ol data-live="game_card" data-empty="No games"><template data-item><li data-text="{name}"></li></template></ol></section>',
}
const routes = [
  { screen: "game", path: "/jogo/:slug", paths: { "pt-BR": "/jogo/:slug", en: "/game/:slug" } },
  { screen: "campaign", path: "/equipe-campeonato/:slug/:championship_slug", paths: { "pt-BR": "/equipe-campeonato/:slug/:championship_slug", en: "/team-championship/:slug/:championship_slug" } },
  { screen: "team", path: "/equipe/:slug", paths: { "pt-BR": "/equipe/:slug", en: "/team/:slug" } },
  { screen: "games", path: "/jogos", paths: { "pt-BR": "/jogos", en: "/games" } },
].map(route => ({ ...route, nav: { strip: false }, files: { html: `screens/${route.screen}.html`, css: `screens/${route.screen}.css`, handlers: [] } }))
const cfg = {
  app: "Football",
  routes,
  tables: ["game_card", "goal", "comment", "team_championship", "team_game"],
  i18n: { default: "pt-BR", locales: { "pt-BR": { path: "pt-br" }, en: { path: "en" } } },
}
type Row = Record<string, unknown>
type Read = { table: string; filter?: string; select?: string }

function data() {
  const rows: Record<string, Row[]> = {
    game_card: [{ id: GAME_ID, name: "Final", home_name: "Flamengo", game: { slug: "final-2026" }, home: { slug: "flamengo" } }],
    goal: [{ id: "goal-1", game_id: GAME_ID, scorer: "Ana" }],
    comment: [],
    team_championship: [{ id: "campaign-1", team_id: TEAM_ID, championship_id: CHAMPIONSHIP_ID, name: "Flamengo", team: { slug: "flamengo" }, championship: { slug: "brasil-2026" } }],
    team_game: [{ id: "team-game-1", team_id: TEAM_ID, championship_id: CHAMPIONSHIP_ID, name: "Final", game: { slug: "final-2026" } }],
  }
  const reads: Read[] = []
  let failure: string | undefined
  let listening = 0
  return {
    rows,
    reads,
    fail: (table: string) => { failure = table },
    listening: () => listening,
    subscribe: () => { listening++; return () => { listening-- } },
    query: (table: string, _order: unknown, opts: { filter?: string; select?: string } = {}) => {
      reads.push({ table, ...opts })
      if (table === failure) return Promise.reject(new Error(`read failed: ${table}`))
      return Promise.resolve(rows[table].filter(row => (opts.filter ?? "").split("&").filter(Boolean).every(clause => {
        const match = /^([\w.]+)=eq\.(.+)$/.exec(clause)
        if (!match) throw new Error(`unexpected test filter: ${clause}`)
        const value = match[1].split(".").reduce<unknown>((value, key) => (value as Row)[key], row)
        return value === match[2]
      })))
    },
  }
}

const ambientFetch = globalThis.fetch
const ambientDocument = globalThis.document
afterEach(() => {
  globalThis.fetch = ambientFetch
  globalThis.document = ambientDocument
})

function renderer(store = data()) {
  globalThis.fetch = ((url: URL | string) => {
    const path = new URL(url).pathname
    return Promise.resolve(new Response(path.endsWith(".html") ? templates[path.split("/").pop()!.replace(".html", "")] : ""))
  }) as typeof fetch
  const renderer = createRenderer({
    store, origin: ORIGIN, capacity: 2, queue: 8,
    cacheableRead: () => false,
    route: (path, search) => {
      const found = routeAt(cfg, path, search, [])
      return found && { ...found, params: { ...found.params } }
    },
    async render(found, store, base) {
      const result = await renderDocument({
        entry: ENTRY, parse: html => parseHTML(html).document,
        cfg, appBase: new URL(`${ORIGIN}/`), ...found, store, messages: {}, rows: true,
        origin: ORIGIN, here: base.pathname,
      })
      result.handle.stop()
      return result
    },
  })
  return { store, renderer, get: (path: string) => renderer.handle(new Request(`${ORIGIN}${path}`)) }
}

describe("documents addressed by ordinary slug queries", () => {
  it("renders embedded readable links and UUID-dependent children in the requested locale", async () => {
    const h = renderer()
    const response = await h.get("/en/game/final-2026")
    expect(response.status).toBe(200)
    const { document } = parseHTML(await response.text())
    expect(document.querySelector("h1")?.textContent).toBe("Final")
    expect(document.querySelector("a.team")?.getAttribute("href")).toBe("/en/team/flamengo")
    expect(document.querySelector(".goals li")?.textContent).toBe("Ana")
    expect(document.querySelector(".comments")?.textContent).toContain("No comments")
    expect(document.documentElement.lang).toBe("en")
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(`${ORIGIN}/en/game/final-2026`)
    expect(h.store.reads).toContainEqual({ table: "goal", filter: `game_id=eq.${GAME_ID}` })
    expect(h.store.reads).toContainEqual({ table: "game_card", filter: "game.slug=eq.final-2026", select: "*,game:id!inner(slug),home:home_id(slug)" })
    expect(h.store.listening()).toBe(0)
  })

  it("resolves both readable route parameters before querying the campaign's UUID keys", async () => {
    const h = renderer()
    const response = await h.get("/equipe-campeonato/flamengo/brasil-2026")
    expect(response.status).toBe(200)
    const { document } = parseHTML(await response.text())
    expect(document.querySelector(".games a")?.getAttribute("href")).toBe("/jogo/final-2026")
    expect(h.store.reads).toContainEqual({ table: "team_game", filter: `team_id=eq.${TEAM_ID}&championship_id=eq.${CHAMPIONSHIP_ID}`, select: "*,game(slug)" })
    expect((await h.get("/equipe-campeonato/flamengo/missing")).status).toBe(404)
  })

  it("answers a missing slug 404 without treating an empty collection as a missing address", async () => {
    const h = renderer()
    expect((await h.get("/jogo/missing")).status).toBe(404)
    expect(h.store.reads.some(read => read.table === "goal")).toBe(false)
    h.store.rows.game_card = []
    const empty = await h.get("/jogos")
    expect(empty.status).toBe(200)
    expect(await empty.text()).toContain("No games")
    expect(h.renderer.held).toBe(0)
    expect(h.store.listening()).toBe(0)
  })

  for (const table of ["game_card", "goal"]) {
    it(`propagates a failed ${table} read instead of declaring the address absent`, async () => {
      const h = renderer()
      h.store.fail(table)
      await expect(h.get("/jogo/final-2026")).rejects.toThrow(`read failed: ${table}`)
      expect(h.renderer.held).toBe(0)
      expect(h.store.listening()).toBe(0)
    })
  }

  it("adopts the served slug document in place with the same locale and UUID-dependent reads", async () => {
    const h = renderer()
    const { document } = parseHTML(await (await h.get("/en/game/final-2026")).text())
    globalThis.document = document
    const mount = document.querySelector(".shell-screen[data-served]")!
    const screen = mount.firstElementChild!
    const link = screen.querySelector("a.team")!
    const found = routeAt(cfg, "/en/game/final-2026", "", [])!
    const live = data()
    live.rows.goal[0].scorer = "Beatriz"
    const handle = await interpretScreen(mount, `${ORIGIN}/`, found.route, live, found.params, {
      ...screenEnv(cfg, { locale: found.locale, messages: {}, mountUnits: false }),
      served: { screen, cas: document.querySelector('meta[name="pronto-cas"]')!.getAttribute("content") },
    })
    try {
      await handle.settle()
      expect(mount.firstElementChild).toBe(screen)
      expect(screen.querySelector("a.team")).toBe(link)
      expect(link.getAttribute("href")).toBe("/en/team/flamengo")
      expect(screen.querySelector(".goals li")?.textContent).toBe("Beatriz")
      expect(live.reads).toContainEqual({ table: "goal", filter: `game_id=eq.${GAME_ID}` })
    } finally { handle.stop() }
    expect(live.listening()).toBe(0)
  })
})
