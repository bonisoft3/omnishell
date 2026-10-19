import { strict as assert } from "node:assert"
import { planRelease } from "../interpreter/release-plan.js"

const screens = [{ html: "/shell/screens/team.html", css: "/shell/screens/team.css" }]
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
    kind: "morph", screens: ["/shell/screens/team.html"], catalogues: ["/messages/pt-BR.json"],
  })
})

Deno.test("code the page runs restarts it, whatever else moved", () => {
  const next = map({ "/shell/screens/team.html": "/shell/screens/_immutable-e-team.html", "/shell/handlers/team.js": "/shell/handlers/_immutable-g-team.js" })
  assert.deepEqual(planRelease(map(), next, screens), { kind: "restart" })
})

// A file one release names and the other does not is a change too: a screen
// added or removed moves the config, which the page runs.
Deno.test("a file added or removed is a change", () => {
  assert.deepEqual(planRelease(map(), map({ "/shell/screens/game.html": "/shell/screens/_immutable-h-game.html" }), screens), { kind: "restart" })
})
