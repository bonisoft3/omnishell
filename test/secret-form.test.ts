// A secret field (pronto's #Field.secret) leaves the page sealed to the
// airlock's key and bound to its row, and no control keeps it once the submit
// settles.
import { expect } from "@test/harness"
import { parseHTML } from "linkedom"
import { createStore } from "../interpreter/data-sync.js"
import { batched } from "../interpreter/batched-store.js"
import { FIXTURE_CARRIERS } from "../interpreter/fixture-types.js"

const locationBeforeImport = Object.getOwnPropertyDescriptor(globalThis, "location")
Object.defineProperty(globalThis, "location", { value: { search: "?clock=manual" }, configurable: true, writable: true })
const { interpretScreen } = await import("../interpreter/screen.js")
if (locationBeforeImport) Object.defineProperty(globalThis, "location", locationBeforeImport)
else delete (globalThis as any).location

async function until(test: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (test()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error("the form did not settle")
}

const schema = { payment: { durability: "server", fields: [
  { name: "id", type: "uuid", pk: true, required: true },
  { name: "amount", type: "int32", required: true },
  { name: "pin", type: "string", required: false, secret: true },
] } }
const route = { screen: "pay", files: { html: "pay.html", css: "pay.css", handlers: [] }, states: ["loading", "empty", "populated"] }
const html = (action: string) => `<section class="screen" data-screen="pay">
  <form data-entity="payment" data-action="${action}">
    <input type="hidden" name="amount" value="990">
    <input type="password" name="pin" value="">
    <button type="submit">Pay</button>
  </form>
</section>`

async function mount(pin: string) {
  const { document, Event } = parseHTML("<html><head></head><body><main id=app></main></body></html>")
  globalThis.document = document as any
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://pay.test")
    return new Response(url.pathname === "/pay.html" ? html("create") : "")
  }) as typeof fetch
  const writes: any[] = []
  const store = batched({ query: async () => [], subscribe: () => () => {}, create: async (_table: string, row: unknown) => { writes.push(row) } })
  const handle = await interpretScreen(document.getElementById("app"), "https://pay.test/", route, store, {}, { handlers: false, schema })
  const form = document.querySelector("form") as any
  form.checkValidity = () => true
  // A reset would empty the control too; this holds the terminal's own emptying.
  form.reset = () => {}
  const input = document.querySelector('input[type="password"]') as any
  input.value = pin
  return { writes, input,
    submit: () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    submitting: () => form.dataset.submitting !== undefined,
    stop: () => { (globalThis as any).__prontoClock.advance(600); handle.stop(); globalThis.fetch = prior },
  }
}

Deno.test({ name: "a form's password control is emptied once its submit settles", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const app = await mount("4321")
  try {
    app.submit()
    await until(() => app.writes.length === 1 && !app.submitting())
    expect(app.input.value).toBe("")
  } finally { app.stop() }
} })

/** A store over a server table holding a secret field, its requests answered
 * here: the seal key at airlock_seal, and every write recorded. */
async function sealingStore() {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", hash: "SHA-256", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["encrypt", "decrypt"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const { sealKid } = await import("../interpreter/data-sync.js")
  const kid = await sealKid(jwk)
  const sent: { method: string; url: URL; body: any }[] = []
  const request = async (url: string, init: RequestInit = {}) => {
    const u = new URL(url, "https://pay.test")
    if (u.pathname === "/crud/airlock_seal") return Response.json([{ kid, key: jwk }])
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    sent.push({ method: init.method ?? "GET", url: u, body })
    if ((init.method ?? "GET") === "GET") return Response.json([])
    const rows = Array.isArray(body) ? body : [{ ...body, id: u.searchParams.get("id")!.slice(3) }]
    return Response.json(rows)
  }
  const store = createStore("https://pay.test", { carriers: FIXTURE_CARRIERS, schema, tables: [] }, { request })
  const open = async (sealed: string, pk: string) => {
    const [, sealedKid, body] = sealed.split(".")
    expect(sealedKid).toBe(kid)
    const bytes = Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))
    const label = new TextEncoder().encode(`pronto-secret\npayment\npin\n${pk}`)
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "RSA-OAEP", label }, pair.privateKey, bytes))
  }
  return { store, sent, open }
}

Deno.test({ name: "every write of a secret field leaves sealed to its row, whichever writer states it", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const { store, sent, open } = await sealingStore()
  try {
    await store.patch("payment", [{ key: "p1", changes: { amount: 990, pin: "4321" } }])
    await store.add("payment", [{ id: "p2", amount: 990, pin: "8765" }])
    const writes = sent.filter((r) => r.method !== "GET")
    expect(writes.map((r) => r.method)).toEqual(["PATCH", "POST"])
    // Ciphertext alone in the pin; the rest of each body is the writer's.
    expect(writes[0].body.pin).toMatch(/^seal1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{512}$/)
    expect(writes[1].body[0].pin).toMatch(/^seal1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{512}$/)
    expect(await open(writes[0].body.pin, "p1")).toBe("4321")
    expect(await open(writes[1].body[0].pin, "p2")).toBe("8765")
    // Left blank, it is not sent.
    await store.patch("payment", [{ key: "p1", changes: { amount: 1, pin: "" } }])
    expect("pin" in sent.at(-1)!.body).toBe(false)
  } finally { await store.close() }
} })

Deno.test("the store seals to the key the cluster publishes, for the row, with RSA-OAEP", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSA-OAEP", hash: "SHA-256", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["encrypt", "decrypt"])
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey)
  const { sealKid } = await import("../interpreter/data-sync.js")
  const kid = await sealKid(jwk)
  const prior = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    expect(new URL(String(input), "https://pay.test").pathname).toBe("/crud/airlock_seal")
    return Response.json([{ kid, key: jwk }])
  }) as typeof fetch
  try {
    const sealed = await createStore("https://pay.test").seal("payment", "pin", "p1", "4321")
    const [, sealedKid, body] = sealed.split(".")
    expect(sealedKid).toBe(kid)
    const bytes = Uint8Array.from(atob(body.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0))
    const label = new TextEncoder().encode("pronto-secret\npayment\npin\np1")
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "RSA-OAEP", label }, pair.privateKey, bytes))).toBe("4321")
  } finally { globalThis.fetch = prior }
})
