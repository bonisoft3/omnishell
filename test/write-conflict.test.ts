import { expect } from "@test/harness"
import { http } from "../interpreter/data-sync.js"

// The gateway reports a serialization conflict as a 500 naming 40001 and no
// longer runs the transaction again: the writer does, a bounded number of
// times, and a conflict that never clears is the server's refusal, not an
// outbox entry retried without end.
const conflict = () => new Response(JSON.stringify({ code: "40001", message: "could not serialize access" }), { status: 500 })
const stubbed = async (answers: (() => Response)[], fn: () => Promise<unknown>) => {
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => Promise.resolve(answers[Math.min(calls++, answers.length - 1)]())) as typeof fetch
  try {
    return { result: await fn().then((r) => r, (e) => e), calls }
  } finally {
    globalThis.fetch = real
  }
}

Deno.test({ name: "a write a serialization conflict aborted is sent again until it lands", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const { result, calls } = await stubbed([conflict, conflict, () => new Response("[]", { status: 201 })],
    () => http("/crud/t", { method: "POST", body: "[]" }))
  expect((result as Response).status).toBe(201)
  expect(calls).toBe(3)
} })

Deno.test({ name: "a conflict that never clears is refused after a bounded number of sends", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const { result, calls } = await stubbed([conflict], () => http("/crud/t", { method: "POST", body: "[]" }))
  expect((result as Error).name).toBe("NonRetriableError")
  expect(calls).toBe(5)
} })
