// The path a `describe` does not cover: a spec that declares tests at the top
// level, which snapcards-visual-qa does.
//
// There is no block here to close the shared browser, so `it` closes its own.
// Nothing in these assertions says that — what says it is the SANITISER, which
// fails a test whose ops outlive it. Delete the fallback in harness.ts and both
// of these go red, which is the whole reason they are worth the two launches
// they cost.
import { expect, it, withPage } from "./harness.ts"

it("a test outside any block closes its own browser", async () => {
  await withPage(async (page) => {
    await page.setContent("<b id=x>hi</b>")
    expect(await page.textContent("#x")).toBe("hi")
  })
})

it("and the one after it still gets a browser", async () => {
  await withPage(async (page) => {
    await page.setContent("<b id=y>ok</b>")
    expect(await page.textContent("#y")).toBe("ok")
  })
})
