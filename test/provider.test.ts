import { describe, test, expect } from "@test/harness"
import { DefaultAuthProvider } from "../src/auth/provider"
import { MemoryStorage } from "../src/auth/storage/memory"
import { createSessionManager } from "../src/auth/session"
import type { BiometricCredential } from "../src/auth/types"

const SECRET = "test-secret-that-is-long-enough-for-hs256-signing-key"

function makeProvider() {
  const storage = new MemoryStorage()
  const sessions = createSessionManager({ secret: SECRET })
  return { provider: new DefaultAuthProvider(storage, sessions), storage }
}

function makeCred(overrides?: Partial<BiometricCredential>): BiometricCredential {
  return {
    credentialId: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    ...overrides,
  }
}

describe("DefaultAuthProvider", () => {
  test("register creates user, stores credential, returns session", async () => {
    const { provider, storage } = makeProvider()
    const session = await provider.register(makeCred(), "Alice")
    expect(session.userId).toBeTruthy()
    expect(session.token).toBeTruthy()
    expect(session.expiresAt).toBeInstanceOf(Date)

    const user = await storage.getUser(session.userId)
    expect(user).not.toBeNull()
    expect(user!.name).toBe("Alice")

    const creds = await storage.getCredentials(session.userId)
    expect(creds).toHaveLength(1)
  })

  test("authenticate returns session for known credential", async () => {
    const { provider } = makeProvider()
    const regSession = await provider.register(makeCred({ credentialId: "auth-cred" }), "Bob")
    const authSession = await provider.authenticate(makeCred({ credentialId: "auth-cred" }))
    expect(authSession.userId).toBe(regSession.userId)
    expect(authSession.token).toBeTruthy()
  })

  test("authenticate throws for unknown credential", async () => {
    const { provider } = makeProvider()
    await expect(
      provider.authenticate(makeCred({ credentialId: "unknown" }))
    ).rejects.toThrow("Unknown credential")
  })

  test("getSession returns session for valid token", async () => {
    const { provider } = makeProvider()
    const regSession = await provider.register(makeCred(), "Carol")
    const session = await provider.getSession(regSession.token)
    expect(session).not.toBeNull()
    expect(session!.userId).toBe(regSession.userId)
  })

  test("getSession returns null for invalid token", async () => {
    const { provider } = makeProvider()
    const session = await provider.getSession("garbage-token")
    expect(session).toBeNull()
  })

  test("revokeSession is a no-op for stateless JWT", async () => {
    const { provider } = makeProvider()
    await provider.revokeSession("any-token")
  })
})
