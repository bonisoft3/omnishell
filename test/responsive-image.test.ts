// data-image-src: a blob plane picture offered at each width the edge will answer,
// so the browser chooses by the space it has and a screen names no size.
import { describe, expect, it } from "@test/harness"
import { type El, mountScreen } from "./screen-harness.ts"

const ROUTE = { screen: "gallery", files: { html: "gallery.html", css: "gallery.css", handlers: [] } }
const FILES = {
  "gallery.css": "",
  "gallery.html": `<section class="screen" data-screen="gallery">
    <div data-live="picture" data-order="pos.asc">
      <template data-item><img data-image-src="{src}" sizes="auto, 100vw" loading="lazy" alt="" /></template>
    </div>
  </section>`,
}
const mount = (rows: Record<string, unknown>[]) => mountScreen({ route: ROUTE, files: FILES, tables: { picture: rows }, seed: 1 })
const images = (m: { all(s: string): unknown[] }) => m.all("img") as El[]

describe("data-image-src", () => {
  it("offers a blob plane picture at each width, with one as its src", async () => {
    const m = await mount([{ id: "a", pos: 1, src: "/img/insecure/plain/s3://bucket/a.png" }])
    await m.settle()
    const [img] = images(m)
    expect(img.getAttribute("src")).toBe("/img/insecure/rs:fit:640:640/plain/s3://bucket/a.png")
    expect(img.getAttribute("srcset")).toBe([320, 640, 960].map((w) => `/img/insecure/rs:fit:${w}:${w}/plain/s3://bucket/a.png ${w}w`).join(", "))
    await m.stop()
  })
  // A seeded picture is inline, and a srcset of it would ask the blob plane for a path it never held.
  it("leaves anything else a plain src, and a blank the terminal's blank", async () => {
    const m = await mount([{ id: "b", pos: 1, src: "data:image/webp;base64,AA" }, { id: "c", pos: 2, src: "" }])
    await m.settle()
    const [inline, blank] = images(m)
    expect(inline.getAttribute("src")).toBe("data:image/webp;base64,AA")
    expect(inline.getAttribute("srcset")).toBe(null)
    expect(blank.getAttribute("src")?.startsWith("data:image/gif")).toBe(true)
    await m.stop()
  })
  // Each of these still renders a picture, at the largest size or none, so nothing else would say.
  it("refuses a markup that would waste the choice", async () => {
    const bad = async (img: string) => {
      const files = { ...FILES, "gallery.html": FILES["gallery.html"].replace(/<img[^>]*>/, img) }
      let error = ""
      try {
        const m = await mountScreen({ route: ROUTE, files, tables: { picture: [{ id: "a", pos: 1, src: "/img/insecure/plain/s3://b/a.png" }] }, seed: 1 })
        await m.settle()
        error = String(m.all("pre").map((el) => (el as El).textContent).join(" "))
        await m.stop()
      } catch (e) {
        error = String(e)
      }
      return error
    }
    expect(await bad('<img data-image-src="{src}" alt="" />')).toMatch(/needs sizes/)
    expect(await bad('<img data-image-src="{src}" sizes="auto, 100vw" alt="" />')).toMatch(/auto needs loading="lazy"/)
    expect(await bad('<img data-image-src="/img/insecure/plain/s3://b/a.png" sizes="100vw" alt="" />')).toMatch(/binds a column/)
    // The refusal cannot depend on where the attribute falls among the bound ones.
    expect(await bad('<img class="{id}" data-image-src="/img/insecure/plain/s3://b/a.png" sizes="100vw" alt="" />')).toMatch(/binds a column/)
  })
  it("encodes what a srcset would split on", async () => {
    const m = await mount([{ id: "a", pos: 1, src: "/img/insecure/plain/s3://bucket/my picture,1.png" }])
    await m.settle()
    expect(images(m)[0].getAttribute("srcset")?.split(", ")[0]).toBe("/img/insecure/rs:fit:320:320/plain/s3://bucket/my%20picture%2C1.png 320w")
    await m.stop()
  })
  it("follows the row, dropping the srcset a picture no longer has", async () => {
    const m = await mount([{ id: "a", pos: 1, src: "/img/insecure/plain/s3://bucket/a.png" }])
    await m.settle()
    await m.store.update("picture", "a", { src: "data:image/webp;base64,AA" })
    await m.settle()
    const [img] = images(m)
    expect(img.getAttribute("srcset")).toBe(null)
    expect(img.getAttribute("src")).toBe("data:image/webp;base64,AA")
    await m.stop()
  })
})
