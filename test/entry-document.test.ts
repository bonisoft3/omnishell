// The entry document answers at every route, so where it LIVES and the address
// it arrived under are different things. Everything it references relatively —
// its stylesheet, its boot module — resolves against the first; the router
// reads the second. Both claims below were broken at once and no unit test
// noticed: build, lint and every suite passed over a platform on which no
// JavaScript ran at any route, and only the browser tier said so.
import { describe, expect, it } from "@test/harness"

const template = await Deno.readTextFile(new URL("../shell.html", import.meta.url))
const shell = await Deno.readTextFile(new URL("../interpreter/shell.js", import.meta.url))

describe("the entry document", () => {
  it("says where it lives", () => {
    // Without this, ./boot.js is /boot.js at /games and the page is inert.
    expect(/<base\s+href="\/shell\/"\s*>/.test(template)).toBe(true)
  })

  it("keeps its base ahead of everything that resolves against it", () => {
    // A base declared after a reference does not apply to it.
    const base = template.indexOf("<base ")
    const firstRelative = template.search(/(?:href|src)="\.\//)
    expect(base).toBeGreaterThan(-1)
    expect(base).toBeLessThan(firstRelative)
  })
})

describe("the entry document's language", () => {
  it("is a hole the emitter fills, not a literal", () => {
    // It said `en` for every app of every language. describe() rewrites it once
    // a screen resolves its locale, but the paint before boot and a crawler
    // that never runs one read this attribute and nothing else.
    expect(/<html lang="\{language\}" dir="\{direction\}">/.test(template)).toBe(true)
  })

  it("is the app's declared default, and en only where nothing is declared", async () => {
    const langOf = async (app: string) =>
      (await Deno.readTextFile(new URL(`../../../apps/${app}/shell/index.html`, import.meta.url)))
        .match(/<html lang="([^"]+)"/)?.[1]
    expect(await langOf("truco")).toBe("pt-BR")
    expect(await langOf("chess")).toBe("en")
  })

  it("says which way that language reads, for the paint before boot", async () => {
    // A crawler that renders nothing and the first paint both read this and
    // nothing else, so an RTL app laid out left-to-right until boot is what
    // its absence costs.
    const dirOf = async (app: string) =>
      (await Deno.readTextFile(new URL(`../../../apps/${app}/shell/index.html`, import.meta.url)))
        .match(/<html [^>]*dir="([^"]+)"/)?.[1]
    expect(await dirOf("truco")).toBe("ltr")
    expect(await dirOf("chess")).toBe("ltr")
  })
})

describe("the shell's own config read", () => {
  it("resolves against the document's base, not the address it arrived under", () => {
    // location.href names its base explicitly, so <base> cannot reach it: at
    // /games it asks for a shell.yaml sitting beside the route, and the shell
    // throws before a screen exists to report it.
    expect(shell).toContain("new URL(config, document.baseURI)")
    expect(shell).not.toContain("new URL(config, location.href)")
  })
})
