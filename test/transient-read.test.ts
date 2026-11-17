import { expect } from "@test/harness"
import { http } from "../interpreter/data-sync.js"
import { TransientRead, Unanswered } from "../interpreter/fragment.js"

// A read the stack did not answer is an outage the reader asks again, never the program's error;
// a refusal (a 4xx but 408 and 429) is the program's.
const answering = async (answer: () => Promise<Response>) => {
  const real = globalThis.fetch
  globalThis.fetch = (() => answer()) as typeof fetch
  try {
    return await http("/crud/t").then((r) => r, (e) => e)
  } finally {
    globalThis.fetch = real
  }
}

for (const status of [503, 500, 408, 429]) {
  Deno.test({ name: `a ${status} from a read is a TransientRead`, sanitizeOps: false, sanitizeResources: false, fn: async () => {
    const err = await answering(() => Promise.resolve(new Response("", { status })))
    expect(err).toBeInstanceOf(TransientRead)
    expect(err).toBeInstanceOf(Unanswered)
  } })
}

Deno.test({ name: "a 400 from a read is not a TransientRead", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const err = await answering(() => Promise.resolve(new Response("", { status: 400 })))
  expect(err).toBeInstanceOf(Error)
  expect(err).not.toBeInstanceOf(Unanswered)
} })

Deno.test({ name: "a dropped connection (fetch's TypeError) is a TransientRead keeping its cause", sanitizeOps: false, sanitizeResources: false, fn: async () => {
  const cause = new TypeError("Failed to fetch")
  const err = await answering(() => Promise.reject(cause))
  expect(err).toBeInstanceOf(TransientRead)
  expect((err as Error).cause).toBe(cause)
} })
