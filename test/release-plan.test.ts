import { strict as assert } from "node:assert"
import { filesMoved, planRelease } from "../interpreter/release-plan.js"

const screens = [{ html: "/shell/screens/team.html", css: "/shell/screens/team.css", handlers: ["/shell/handlers/team.js"] }]
const map = (over: Record<string, string> = {}): Record<string, string> => ({
  "/shell/screens/team.html": "/shell/screens/_immutable-a-team.html",
  "/shell/screens/team.css": "/shell/screens/_immutable-b-team.css",
  "/messages/pt-BR.json": "/messages/_immutable-c-pt-BR.json",
  "/shell/handlers/team.js": "/shell/handlers/_immutable-d-team.js",
  ...over,
})

Deno.test("the same map is the same release", () => {
  assert.deepEqual(planRelease(map(), map(), screens), { kind: "unchanged" })
})

Deno.test("a screen's template, its style and a catalogue are taken in place", () => {
  const next = map({ "/shell/screens/team.css": "/shell/screens/_immutable-e-team.css", "/messages/pt-BR.json": "/messages/_immutable-f-pt-BR.json" })
  assert.deepEqual(planRelease(map(), next, screens), {
    kind: "morph", screens: ["/shell/screens/team.html"], catalogues: ["/messages/pt-BR.json"], handlers: [],
  })
})

Deno.test("code the page runs restarts it, whatever else moved", () => {
  const next = map({ "/shell/screens/team.html": "/shell/screens/_immutable-e-team.html", "/shell/handlers/team.js": "/shell/handlers/_immutable-g-team.js", "/omnishell/interpreter/screen.js": "/omnishell/interpreter/_immutable-k-screen.js" })
  assert.deepEqual(planRelease(map({ "/omnishell/interpreter/screen.js": "/omnishell/interpreter/_immutable-j-screen.js" }), next, screens), { kind: "restart" })
})

// A one-line handler once reloaded every reader, the same as a new interpreter.
Deno.test("a handler is taken in place", () => {
  const next = map({ "/shell/handlers/team.js": "/shell/handlers/_immutable-g-team.js" })
  assert.deepEqual(planRelease(map(), next, screens), { kind: "morph", screens: [], catalogues: [], handlers: ["/shell/handlers/team.js"] })
})

Deno.test("a handler no route lists restarts, since nothing would take it", () => {
  const next = map({ "/shell/handlers/team.js": "/shell/handlers/_immutable-g-team.js" })
  assert.deepEqual(planRelease(map(), next, [{ html: "/shell/screens/team.html", css: "/shell/screens/team.css" }]), { kind: "restart" })
})

// The release map names every served file, so regenerating a doc reloaded every reader.
Deno.test("what the page only links to moves nothing", () => {
  const next = map({ "/docs/ir.html": "/docs/_immutable-m-ir.html", "/shell/favicon.svg": "/shell/_immutable-n-favicon.svg", "/robots.txt": "/_immutable-o-robots.txt" })
  assert.deepEqual(planRelease(map({ "/docs/ir.html": "/docs/_immutable-l-ir.html" }), next, screens), { kind: "morph", screens: [], catalogues: [], handlers: [] })
})

// A file one release names and the other does not is a change too: a screen
// added or removed moves the config, which the page runs.
Deno.test("a file added or removed is a change", () => {
  assert.deepEqual(planRelease(map(), map({ "/shell/screens/game.html": "/shell/screens/_immutable-h-game.html" }), screens), { kind: "restart" })
})

// A file the release dropped stayed in the page's held text, and a later mount read the retired copy.
Deno.test("what moved includes a file the new release dropped", () => {
  assert.deepEqual(filesMoved({ "/a.css": "1", "/b.css": "2" }, { "/a.css": "1" }), ["/b.css"]);
});
