import { describe, test, expect } from "@test/harness"
import { createAuth } from "../src/index"
import { MemoryStorage } from "../src/auth/storage/memory"
import type { BiometricAdapter, BiometricCredential, UserInfo } from "../src/auth/types"

// Fake biometric adapter for testing (no real WebAuthn ceremony)
class FakeBiometricAdapter implements BiometricAdapter {
  type = "fake"
  private nextCredential: BiometricCredential | null = null

  setNextCredential(cred: BiometricCredential) {
    this.nextCredential = cred
  }

  async isAvailable() { return true }

  async startRegistration(_user: UserInfo) {
    return { challenge: "fake-challenge", options: {} }
  }

  async verifyRegistration(_response: unknown): Promise<BiometricCredential> {
    if (!this.nextCredential) throw new Error("No credential set")
    return this.nextCredential
  }

  async startAuthentication(_userId?: string) {
    return { challenge: "fake-challenge", options: {} }
  }

  async verifyAuthentication(_response: unknown, _context?: { publicKey: Uint8Array; counter: number; transports?: string[] }): Promise<BiometricCredential> {
    if (!this.nextCredential) throw new Error("No credential set")
    return this.nextCredential
  }
}

const SECRET = "test-secret-that-is-long-enough-for-hs256-signing-key"

function setup() {
  const biometric = new FakeBiometricAdapter()
  const storage = new MemoryStorage()
  const auth = createAuth({ biometric, storage, secret: SECRET })
  return { auth, biometric, storage }
}

describe("createAuth integration", () => {
  test("register flow: startRegistration → verifyRegistration → session cookie", async () => {
    const { auth, biometric } = setup()

    const startRes = await auth.handleRequest(
      new Request("http://localhost/auth/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice" }),
      })
    )
    expect(startRes.status).toBe(200)
    const startBody = await startRes.json()
    expect(startBody.challenge).toBeTruthy()

    biometric.setNextCredential({
      credentialId: "reg-cred-1",
      publicKey: new Uint8Array([10, 20, 30]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    })

    const verifyRes = await auth.handleRequest(
      new Request("http://localhost/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "fake-response", name: "Alice" }),
      })
    )
    expect(verifyRes.status).toBe(200)
    const cookie = verifyRes.headers.get("Set-Cookie")
    expect(cookie).toContain("omnishell_session=")
    expect(cookie).toContain("HttpOnly")
  })

  test("authenticate flow: startAuthentication → verifyAuthentication → session cookie", async () => {
    const { auth, biometric } = setup()

    biometric.setNextCredential({
      credentialId: "auth-cred-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    })
    await auth.handleRequest(
      new Request("http://localhost/auth/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      })
    )
    await auth.handleRequest(
      new Request("http://localhost/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "fake", name: "Bob" }),
      })
    )

    const startRes = await auth.handleRequest(
      new Request("http://localhost/auth/authenticate/start", { method: "POST" })
    )
    expect(startRes.status).toBe(200)

    const verifyRes = await auth.handleRequest(
      new Request("http://localhost/auth/authenticate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "fake" }),
      })
    )
    expect(verifyRes.status).toBe(200)
    expect(verifyRes.headers.get("Set-Cookie")).toContain("omnishell_session=")
  })

  test("getSession returns session from cookie", async () => {
    const { auth, biometric } = setup()

    biometric.setNextCredential({
      credentialId: "sess-cred",
      publicKey: new Uint8Array([5, 6, 7]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    })

    await auth.handleRequest(
      new Request("http://localhost/auth/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Carol" }),
      })
    )
    const verifyRes = await auth.handleRequest(
      new Request("http://localhost/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "fake", name: "Carol" }),
      })
    )

    const cookie = verifyRes.headers.get("Set-Cookie")!
    const token = cookie.split("=")[1]!.split(";")[0]!

    const session = await auth.getSession(
      new Request("http://localhost/any", {
        headers: { Cookie: `omnishell_session=${token}` },
      })
    )
    expect(session).not.toBeNull()
    expect(session!.userId).toBeTruthy()
  })

  test("getSession returns null without cookie", async () => {
    const { auth } = setup()
    const session = await auth.getSession(new Request("http://localhost/any"))
    expect(session).toBeNull()
  })

  test("GET /auth/session returns session data for valid cookie", async () => {
    const { auth, biometric } = setup()

    biometric.setNextCredential({
      credentialId: "session-ep-cred",
      publicKey: new Uint8Array([11, 22, 33]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    })

    await auth.handleRequest(
      new Request("http://localhost/auth/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "SessionUser" }),
      })
    )
    const verifyRes = await auth.handleRequest(
      new Request("http://localhost/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "fake", name: "SessionUser" }),
      })
    )

    const cookie = verifyRes.headers.get("Set-Cookie")!
    const token = cookie.split("=")[1]!.split(";")[0]!

    const sessionRes = await auth.handleRequest(
      new Request("http://localhost/auth/session", {
        method: "GET",
        headers: { Cookie: `omnishell_session=${token}` },
      })
    )
    expect(sessionRes.status).toBe(200)
    const body = await sessionRes.json()
    expect(body.userId).toBeTruthy()
    expect(body.expiresAt).toBeTruthy()
  })

  test("GET /auth/session returns 401 without cookie", async () => {
    const { auth } = setup()
    const res = await auth.handleRequest(
      new Request("http://localhost/auth/session", { method: "GET" })
    )
    expect(res.status).toBe(401)
  })

  test("POST /auth/logout clears session cookie", async () => {
    const { auth } = setup()
    const res = await auth.handleRequest(
      new Request("http://localhost/auth/logout", { method: "POST" })
    )
    expect(res.status).toBe(200)
    const cookie = res.headers.get("Set-Cookie")
    expect(cookie).toContain("omnishell_session=")
    expect(cookie).toContain("Max-Age=0")
  })

  test("verification failure returns 400 with error message", async () => {
    const { auth, biometric } = setup()

    // Start registration but don't set a credential so verify throws
    await auth.handleRequest(
      new Request("http://localhost/auth/register/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "FailUser" }),
      })
    )

    biometric.setNextCredential(null as any)

    const res = await auth.handleRequest(
      new Request("http://localhost/auth/register/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: "bad" }),
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  test("unknown route returns 404", async () => {
    const { auth } = setup()
    const res = await auth.handleRequest(
      new Request("http://localhost/auth/unknown", { method: "POST" })
    )
    expect(res.status).toBe(404)
  })
})
