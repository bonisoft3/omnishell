// The picker's trigger names the chosen option in a real engine, with no app
// stylesheet: the component carries the rules that show one label per value.
// linkedom computes no style, so which label is visible is this tier's claim.
import { describe, expect, it, withPage } from "./harness.ts"

const OPTIONS = [
  { name: "a", label: "Alpha" },
  { name: "b", label: "Beta" },
  { name: "c", label: "Gamma" },
]

/** The markup #Picker emits for OPTIONS, exported by the pinned cue. */
async function pickerMarkup(): Promise<string> {
  const options = OPTIONS.map((o) => `{name: "${o.name}", label: "${o.label}"}`).join(", ")
  const expr = `(#Picker & {collection: "prefs", label: "Team", readout: "text", options: [${options}]}).markup`
  const out = await new Deno.Command("cue", {
    args: ["export", "./components", "-e", expr, "--out", "text"],
    cwd: new URL("../", import.meta.url),
    stdout: "piped",
    stderr: "piped",
  }).output()
  if (!out.success) throw new Error(`cue export of #Picker failed: ${new TextDecoder().decode(out.stderr)}`)
  return new TextDecoder().decode(out.stdout)
}

describe("picker", () => {
  it("shows only the chosen option's label, with no app stylesheet", () =>
    withPage(async (page) => {
      const markup = await pickerMarkup()
      const bound = 'data-value="{choice}"'
      if (!markup.includes(bound)) throw new Error(`the picker no longer binds ${bound}`)
      for (const o of OPTIONS) {
        await page.setContent(markup.replace(bound, `data-value="${o.name}"`))
        expect(await page.locator(".pick-label").innerText()).toBe(o.label)
      }
    }))
})
