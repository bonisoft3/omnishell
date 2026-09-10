import { describe, expect, it } from "@test/harness"
import { parseHTML } from "linkedom"
import { interpretScreen } from "../interpreter/screen.js"
import { batched } from "../interpreter/batched-store.js"

// An item whose whole markup is one form — a row of per-choice buttons, each
// its own tiny mutation — is not inside itself, so a descendant-only search
// leaves it unwired and every click on it goes into silence. Nothing about the
// screen looks wrong when that happens, which is why it is asserted here.
const SCREEN_HTML = `<section class="screen" data-screen="note">
  <div class="choices" data-live="label" data-order="name.asc">
    <template data-item>
      <form data-form="file" data-entity="note_label" data-action="create">
        <input type="hidden" name="label_name" data-value="{name}">
        <button type="submit" data-text="{name}"></button>
      </form>
    </template>
  </div>
</section>`

const ROUTE = {
  screen: "note",
  files: { html: "shell/screens/note.html", css: "shell/screens/note.css", handlers: [] },
  states: ["loading", "empty", "populated"],
}

const tick = () => new Promise((r) => setTimeout(r, 5))

async function boot(rows: any[]) {
  const { document, Event } = parseHTML(
    "<!doctype html><html><head></head><body><div id=shell></div></body></html>",
  )
  globalThis.document = document as any
  globalThis.fetch = ((url: any) => {
    const u = String(url)
    if (u.endsWith(".html")) return Promise.resolve(new Response(SCREEN_HTML))
    if (u.endsWith(".css")) return Promise.resolve(new Response(""))
    return Promise.reject(new Error(`unexpected fetch ${u}`))
  }) as any

  const created: any[] = []
  const store = batched({
    query: async () => rows,
    subscribe: () => () => {},
    create: async (entity: string, values: any) => {
      created.push({ entity, values })
    },
    update: async () => {},
    remove: async () => {},
  }) as any
  const mount = document.getElementById("shell")
  await interpretScreen(mount, "http://localhost/", ROUTE, store, {}, { handlers: false })
  return { document, Event, created }
}

describe("an item node that is itself a form", () => {
  it("submits the row it was rendered from", async () => {
    const app = await boot([{ id: "l1", name: "work" }, { id: "l2", name: "boat" }])
    // deno-lint-ignore no-explicit-any
    const forms = [...app.document.querySelectorAll("form[data-form='file']")] as any[]
    expect(forms.length).toBe(2)
    // linkedom has no constraint API; the shell calls it before every submit.
    for (const f of forms) {
      f.checkValidity = () => true
      f.reset = () => {}
    }

    // The second row, so the value can only have come from that row: not the
    // template's placeholder, and not the first form's.
    forms[1].dispatchEvent(new app.Event("submit", { bubbles: true, cancelable: true }))
    await tick()

    expect(app.created.length).toBe(1)
    expect(app.created[0].entity).toBe("note_label")
    expect(app.created[0].values.label_name).toBe("boat")
    // The shell hands `success` back to the base state on a timer; let it run
    // rather than leave it outstanding at the end of the test.
    await new Promise((r) => setTimeout(r, 700))
  })
})
