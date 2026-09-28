// Every module the interpreter reaches is a module the door has to serve.
//
// The terminal declares its served set by name, and the browser resolves the
// import graph — so a module added to the graph and not to the list 404s on
// the first load of every app, with a blank screen and nothing else said. No
// other suite sees it: deno reads these files off the filesystem by path, so
// the suites pass over a set the door does not carry.
import { describe, expect, it } from "@test/harness"

const interpreter = new URL("../interpreter/", import.meta.url)

/** The terminal's declaration, read out of the CUE that owns it. */
async function declared(): Promise<Set<string>> {
  const cue = await Deno.readTextFile(new URL("../terminal.cue", import.meta.url))
  const block = cue.match(/modules:\s*\[\s*\.\.\.#Path\]\s*\n\s*modules:\s*\[([^\]]*)\]/)
  if (!block) throw new Error("terminal.cue declares no module list this test can read")
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
}

/** Every relative module reachable from the entry, static and dynamic alike:
 * the shell imports the storybook only when `?storybook` asks for it, and a
 * reader who asks gets the same 404 as anyone else if it is unserved. */
async function reachable(entry: string): Promise<Set<string>> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const src = await Deno.readTextFile(new URL(name, interpreter))
    for (const [, spec] of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
      const next = spec.slice(2)
      if (!seen.has(next)) queue.push(next)
    }
  }
  return seen
}

describe("the interpreter's served modules", () => {
  it("cover everything the entry's import graph reaches", async () => {
    const list = await declared()
    const absent = [...await reachable("shell.js")].filter((m) => !list.has(m)).sort()
    expect(absent).toEqual([])
  })

  it("names no module that is not on disk", async () => {
    // A name left in the list after its module goes is a COPY of a file that
    // is not there, which fails the image build rather than the page.
    const list = await declared()
    const missing: string[] = []
    for (const m of list) {
      try {
        await Deno.stat(new URL(m, interpreter))
      } catch {
        missing.push(m)
      }
    }
    expect(missing).toEqual([])
  })
})
