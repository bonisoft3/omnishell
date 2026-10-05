import { strict as assert } from "node:assert"
import { planRelease } from "../interpreter/release-plan.js"

const release = (id: string, contract = "code-1", html = "screen-1"): {
  format: 1; id: string; contract: string; screens: Record<string, { html: string; css: string }>
} => ({
  format: 1,
  id,
  contract,
  screens: { "shell/screens/team.html": { html, css: "style-1" } },
})

Deno.test("a changed template morphs only while code and store match", () => {
  assert.deepEqual(planRelease(release("one"), release("two", "code-1", "screen-2")), {
    kind: "morph", screens: ["shell/screens/team.html"],
  })
})

Deno.test("a code or store change restarts", () => {
  assert.deepEqual(planRelease(release("one"), release("two", "code-2", "screen-2")), { kind: "restart" })
})

Deno.test("a changed screen set restarts", () => {
  const next = release("two")
  next.screens["shell/screens/game.html"] = { html: "game", css: "style" }
  assert.deepEqual(planRelease(release("one"), next), { kind: "restart" })
})

Deno.test("invalid release metadata cannot be classified", () => {
  assert.throws(() => planRelease(null, release("two")), /invalid app release manifest/)
})
