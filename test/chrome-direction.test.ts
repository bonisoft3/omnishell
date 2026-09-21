// The terminal's own chrome is written once and worn by every app, so a
// left-or-right in it is a left-or-right nobody can override from an app: the
// signed-in identity sat at the strip's right end in Hebrew too. An app's own
// stylesheet is the app's to get wrong; these two are the platform's.
//
// Absolute coordinates are deliberately not asked about. `top/right/bottom/left`
// and `background-position` are a coordinate system rather than a reading
// order — a card fan pinned at `left: 50%` is right where it belongs in every
// language — and a rule that reported them would be a rule nobody could keep.
import { describe, expect, it } from "@test/harness"

const FLOW_PHYSICAL =
  /(?:^|[;{\s])(?:margin|padding)-(?:left|right)\s*:|(?:^|[;{\s])border-(?:left|right)(?:-(?:width|style|color))?\s*:|(?:^|[;{\s])border-(?:top|bottom)-(?:left|right)-radius\s*:|text-align\s*:\s*(?:left|right)\b|(?:float|clear)\s*:\s*(?:left|right)\b/

const cssOf = (path: string) => Deno.readTextFile(new URL(path, import.meta.url))

describe("the terminal's own stylesheets", () => {
  it("state no side a right-to-left reader would have to fight", async () => {
    expect(FLOW_PHYSICAL.test(await cssOf("../shell.css"))).toBe(false)
  })

  it("keep the emitted chrome logical, in every app that ships it", async () => {
    // emit.cue writes this file per app and pronto/derive.ts deliberately does
    // not scan it, so nothing else would notice the emitter reintroducing a
    // `margin-left: auto` on the identity block.
    const apps = []
    for await (const entry of Deno.readDir(new URL("../../../apps/", import.meta.url))) {
      if (entry.isDirectory) apps.push(entry.name)
    }
    expect(apps.length).toBeGreaterThan(0)
    // An app that ships the terminal's chrome is one that declares a shell, and
    // every one of those owes a design.css. Reading it is part of the check
    // rather than a precondition for it: swallowing the read would let the
    // emitter rename or relocate the file and leave this case green over
    // nothing. A directory with no shell is not a pronto app at all.
    const dressed: string[] = []
    for (const app of apps.sort()) {
      try {
        await Deno.stat(new URL(`../../../apps/${app}/shell/shell.yaml`, import.meta.url))
      } catch {
        continue
      }
      dressed.push(app)
      const css = await cssOf(`../../../apps/${app}/shell/design.css`)
      expect(`${app}: ${FLOW_PHYSICAL.test(css)}`).toBe(`${app}: false`)
    }
    expect(`${dressed.length} apps wear the chrome`).not.toBe("0 apps wear the chrome")
  })
})
