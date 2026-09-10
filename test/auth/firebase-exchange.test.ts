import { describe, test, expect, mock } from "@test/harness"
import { exchangeFirebaseToken } from "../../src/auth/client/firebase-exchange"

describe("exchangeFirebaseToken", () => {
  test("POSTs the idToken to /auth/authenticate/verify and returns userId", async () => {
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url)
      expect(url).toBe("/auth/authenticate/verify")
      expect(init?.method).toBe("POST")
      expect(init?.headers).toEqual({ "Content-Type": "application/json" })
      const body = JSON.parse(init!.body as string)
      expect(body).toEqual({ credential: { idToken: "firebase-id-token" } })
      return new Response(JSON.stringify({ userId: "firebase-uid-abc" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
    const result = await exchangeFirebaseToken("firebase-id-token", { fetch: fetchMock as unknown as typeof fetch })
    expect(result.userId).toBe("firebase-uid-abc")
  })

  test("passes through a custom endpoint when provided", async () => {
    const fetchMock = mock(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url)
      expect(url).toBe("https://snapcards.fun/api/auth/authenticate/verify")
      return new Response(JSON.stringify({ userId: "u" }), { status: 200 })
    })
    await exchangeFirebaseToken("t", {
      fetch: fetchMock as unknown as typeof fetch,
      endpoint: "https://snapcards.fun/api/auth/authenticate/verify",
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test("throws when server returns non-2xx", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ error: "Unknown credential" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await expect(
      exchangeFirebaseToken("t", { fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toThrow(/401/)
  })
})
