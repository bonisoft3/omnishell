import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { morphScreen } from "../interpreter/screen.js"

type DomGlobal = typeof globalThis & { document: Document }

describe("morphScreen with morphlex", () => {
  it("surgically morphs static skeleton while preserving dynamic regions untouched", async () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <div id="screen" class="shell-screen">
          <header>
            <h1 class="title">Old Title</h1>
            <p class="subtitle">Old Subtitle</p>
          </header>
          <main class="feed" data-live="article">
            <div data-id="art-1"><span>Live Article 1</span></div>
            <div data-id="art-2"><span>Live Article 2</span></div>
          </main>
          <footer class="footer">
            <span class="copy">Old Copyright</span>
          </footer>
        </div>
      </body></html>`,
    ) as unknown as { document: Document }
    ;(globalThis as unknown as DomGlobal).document = document

    const liveScreen = document.getElementById("screen")!

    const newHtml = `
      <div id="screen" class="shell-screen">
        <header>
          <h1 class="title">New Brand Title</h1>
          <p class="subtitle">New Subtitle</p>
        </header>
        <main class="feed" data-live="article">
          <template data-item>
            <div><span data-text="{title}"></span></div>
          </template>
        </main>
        <footer class="footer">
          <span class="copy">New Copyright 2026</span>
        </footer>
      </div>
    `

    await morphScreen(liveScreen, newHtml)

    expect(liveScreen.querySelector("h1.title")?.textContent).toBe("New Brand Title")
    expect(liveScreen.querySelector("p.subtitle")?.textContent).toBe("New Subtitle")

    // Morphlex descends into child subtrees unless beforeChildrenVisited vetoes:
    // data-live islands must retain rendered rows rather than adopting template markup.
    const liveItems = liveScreen.querySelectorAll("main[data-live] > div[data-id]")
    expect(liveItems.length).toBe(2)
    expect(liveItems[0].textContent).toContain("Live Article 1")
    expect(liveItems[1].textContent).toContain("Live Article 2")

    expect(liveScreen.querySelector("footer .copy")?.textContent).toBe("New Copyright 2026")
  })

  it("morphs skeleton and updates root attributes", async () => {
    const { document } = parseHTML(
      `<!doctype html><html><body>
        <div id="screen" class="shell-screen" data-theme="boteco">
          <header><h1 class="title">Round 1</h1></header>
          <div class="content"><p>Old content</p></div>
        </div>
      </body></html>`,
    ) as unknown as { document: Document }
    ;(globalThis as unknown as DomGlobal).document = document
    const liveScreen = document.getElementById("screen")!

    const newHtml = `
      <div id="screen" class="shell-screen updated" data-theme="boteco-v2" data-round="2">
        <header><h1 class="title">Round 2</h1></header>
        <div class="content"><p>New live content</p></div>
      </div>
    `
    await morphScreen(liveScreen, newHtml)
    expect(liveScreen.querySelector("h1.title")?.textContent).toBe("Round 2")
    expect(liveScreen.querySelector(".content p")?.textContent).toBe("New live content")
    expect(liveScreen.classList.contains("updated")).toBe(true)
    expect(liveScreen.getAttribute("data-theme")).toBe("boteco-v2")
    expect(liveScreen.getAttribute("data-round")).toBe("2")
  })

  it("fails loudly when incoming markup contains no root element", async () => {
    const { document } = parseHTML(`<!doctype html><html><body><div id="screen"></div></body></html>`) as unknown as { document: Document }
    ;(globalThis as unknown as DomGlobal).document = document
    const liveScreen = document.getElementById("screen")!

    await expect(morphScreen(liveScreen, "   ")).rejects.toThrow("morphScreen: incoming markup has no root element")
  })

  it("fails loudly when target screen element is missing", async () => {
    await expect(morphScreen(null as unknown as Element, "<div></div>")).rejects.toThrow("morphScreen: liveScreen element missing")
  })
})
