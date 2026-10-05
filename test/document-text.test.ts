import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { parse } from "parse5"
import { serialize } from "../interpreter/document.js"

// A document's title is its screen's h1, which a route rendered on request
// binds to a row. linkedom writes a title's text as it stands, so a row named
// `</title><script>…` closed the title in the browser that parsed the page and
// ran as script in the app's origin, from a page held and served to everyone.
// The browser's own parser reads the page back here: what it finds is what a
// reader's tab would.

type Node = { nodeName: string; childNodes?: Node[]; value?: string }
const all = (node: Node): Node[] => [node, ...(node.childNodes ?? []).flatMap(all)]
const textOf = (node: Node) => (node.childNodes ?? []).map((c) => c.value ?? "").join("")

function roundTrip(text: string) {
  const { document } = parseHTML("<!doctype html><html><head><title></title></head><body><textarea></textarea></body></html>")
  document.querySelector("title")!.textContent = text
  document.querySelector("textarea")!.textContent = text
  return all(parse(serialize(document)) as unknown as Node)
}

describe("a document's text", () => {
  for (const text of ["</title><script>alert(document.domain)</script>", "</textarea><img src=x onerror=alert(1)>", "AT&amp;T < \"quoted\" & 'single'"]) {
    it(`reads back as the text it was, not as markup: ${text}`, () => {
      const nodes = roundTrip(text)
      expect(nodes.filter((n) => n.nodeName === "script").length).toBe(0)
      expect(nodes.filter((n) => n.nodeName === "img").length).toBe(0)
      const titles = nodes.filter((n) => n.nodeName === "title")
      expect(titles.length).toBe(1)
      expect(textOf(titles[0])).toBe(text)
      const areas = nodes.filter((n) => n.nodeName === "textarea")
      expect(areas.length).toBe(1)
      expect(textOf(areas[0])).toBe(text)
    })
  }
})
