import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { navFeedback } from "../interpreter/nav-feedback.js"

// A cold navigation left the old screen up for seconds with no sign the click was heard.
describe("a link's feedback", () => {
  const links = () => {
    const { document } = parseHTML(`<a id="a" href="/a"></a><a id="b" href="/b"></a>`)
    const canceled: string[] = []
    const of = (id: string) => {
      const link = document.getElementById(id) as unknown as HTMLAnchorElement
      Object.assign(link, { animate: () => ({ cancel: () => canceled.push(id) }) })
      return link
    }
    return { a: of("a"), b: of("b"), canceled }
  }

  it("holds until the screen is on show, and only ever on the last link pressed", () => {
    const { a, b, canceled } = links()
    const feedback = navFeedback(false)
    feedback.press(a)
    expect(a.getAttribute("aria-busy")).toBe("true")
    feedback.press(b)
    expect([a.hasAttribute("aria-busy"), b.getAttribute("aria-busy"), canceled]).toEqual([false, "true", ["a"]])
    feedback.settle()
    expect([b.hasAttribute("aria-busy"), canceled]).toEqual([false, ["a", "b"]])
    feedback.settle()
    expect(canceled.length).toBe(2)
  })

  it("does not pulse for a reader who asked for calm", () => {
    const { a } = links()
    let frames: { opacity: number }[] = []
    Object.assign(a, { animate: (f: { opacity: number }[]) => { frames = f; return { cancel() {} } } })
    navFeedback(true).press(a)
    expect(frames[0].opacity).toBe(frames[1].opacity)
  })
})
