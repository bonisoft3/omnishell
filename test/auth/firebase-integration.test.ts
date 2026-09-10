import { describe, test, expect } from "@test/harness"
import { createAuth, FirebaseAdapter, MemoryStorage } from "../../src/index"

function makeFakeAuth(uid: string) {
  return {
    verifyIdToken: async (token: string) => {
      if (token !== "valid-token") throw new Error("Firebase: token invalid")
      return { uid } as any
    },
  } as unknown as import("firebase-admin/auth").Auth
}

describe("FirebaseAdapter integration via createAuth", () => {
  test("authenticate/verify with valid ID token mints a session for the Firebase UID", async () => {
    const auth = createAuth({
      biometric: new FirebaseAdapter({ auth: makeFakeAuth("firebase-uid-e2e") }),
      storage: new MemoryStorage(),
      secret: "test-secret-please-change",
    })

    // Firebase UIDs are new users — register first
    const regRes = await auth.handleRequest(new Request("http://test/auth/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: { idToken: "valid-token" }, name: "Alice" }),
    }))
    expect(regRes.status).toBe(200)
    const regBody = await regRes.json()
    expect(regBody.userId).toBeTruthy()
    const regCookie = regRes.headers.get("set-cookie")
    expect(regCookie).toBeTruthy()
    expect(regCookie).toContain("omnishell_session=")

    const authRes = await auth.handleRequest(new Request("http://test/auth/authenticate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: { idToken: "valid-token" } }),
    }))
    expect(authRes.status).toBe(200)
    const authBody = await authRes.json()
    expect(authBody.userId).toBe(regBody.userId)
    const authCookie = authRes.headers.get("set-cookie")
    expect(authCookie).toBeTruthy()
    expect(authCookie).toContain("omnishell_session=")
  })

  test("authenticate/verify with invalid ID token returns 400", async () => {
    const auth = createAuth({
      biometric: new FirebaseAdapter({ auth: makeFakeAuth("x") }),
      storage: new MemoryStorage(),
      secret: "test-secret-please-change",
    })
    const res = await auth.handleRequest(new Request("http://test/auth/authenticate/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: { idToken: "wrong-token" } }),
    }))
    expect(res.status).toBe(400)
  })
})
