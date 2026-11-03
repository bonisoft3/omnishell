import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { replayEarlyGestures, takeEarlyGestures } from "../interpreter/early-replay.js"

// A reader on a served form typed a title and pressed Create before the terminal arrived:
// nothing answered, no deck was made, and the binding wiped the title. linkedom has no
// capture phase, so what holds the gestures (early-gestures.js) is a browser's to check:
// the release's verify presses Create the moment the screen is in the document.
const held = (gestures: unknown[]) => {
  (globalThis as { __prontoEarlyGestures?: () => unknown[] }).__prontoEarlyGestures = () => {
    delete (globalThis as { __prontoEarlyGestures?: unknown }).__prontoEarlyGestures
    return gestures
  }
}
const page = () => {
  const { document } = parseHTML(`<!doctype html><html><body><main id="app">
    <input id="title"><button id="create" type="button">Create</button><a id="out" href="/x">Out</a>
  </main></body></html>`)
  delete (globalThis as { __prontoLive?: unknown }).__prontoLive
  return { root: document.getElementById("app")!, by: (id: string) => document.getElementById(id) as unknown as HTMLInputElement }
}

describe("replaying what was held", () => {
  it("hands the screen each gesture in order, with the value typed", async () => {
    const { root, by } = page()
    const heard: string[] = []
    root.addEventListener("input", (e: Event) => heard.push(`input ${(e.target as HTMLInputElement).value}`))
    root.addEventListener("click", (e: Event) => heard.push(`click ${(e.target as Element).id}`))
    root.addEventListener("keydown", (e: Event) => heard.push(`key ${(e as KeyboardEvent).key} ${(e as KeyboardEvent).shiftKey}`))
    // The adopting binding wrote the row's value over what was typed.
    by("title").value = ""
    held([
      { type: "input", target: by("title"), value: "Moedas" },
      { type: "keydown", target: by("title"), key: "Tab", shiftKey: true },
      { type: "click", target: by("create") },
    ])
    let settled = 0
    await replayEarlyGestures(root.ownerDocument, async () => { settled++ })
    expect(heard).toEqual(["input Moedas", "key Tab true", "click create"])
    expect(by("title").value).toBe("Moedas")
    expect(settled).toBe(3)
  })

  it("leaves a default that already happened, and a link on its way out, alone", async () => {
    const { root, by } = page()
    const heard: [string, boolean][] = []
    root.addEventListener("click", (e: Event) => heard.push([(e.target as Element).id, e.defaultPrevented]))
    held([{ type: "click", target: by("out") }, { type: "click", target: by("create") }])
    await replayEarlyGestures(root.ownerDocument, async () => {})
    expect(heard).toEqual([["create", true]])
  })

  it("does nothing on a document that holds none, or for a node since gone", async () => {
    const { root, by } = page()
    await replayEarlyGestures(root.ownerDocument, async () => {})
    const heard: string[] = []
    root.addEventListener("click", () => heard.push("heard"))
    const create = by("create")
    create.remove()
    held([{ type: "click", target: create }])
    await replayEarlyGestures(root.ownerDocument, async () => {})
    expect(heard).toEqual([])
  })

  it("says it is live however the mount went, and leaves a file input's value alone", async () => {
    const { root, by } = page()
    held([{ type: "click", target: by("create") }])
    expect(takeEarlyGestures().length).toBe(1)
    expect((globalThis as { __prontoLive?: boolean }).__prontoLive).toBe(true)
    const file = by("title")
    Object.defineProperty(file, "type", { value: "file" })
    Object.defineProperty(file, "value", { get: () => "fake", set: () => { throw new Error("InvalidStateError") } })
    held([{ type: "change", target: file, value: "fake" }])
    await replayEarlyGestures(root.ownerDocument, async () => {})
  })
})
