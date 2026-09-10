import { describe, test, expect } from "@test/harness"
import { FirebaseAdapter } from "../../src/auth/adapters/firebase"

function makeFakeAuth() {
  return {
    verifyIdToken: async (_token: string) => ({ uid: "stub", iss: "stub", aud: "stub", auth_time: 0, exp: 0, iat: 0, sub: "stub" }),
  } as unknown as import("firebase-admin/auth").Auth
}

describe("FirebaseAdapter", () => {
  test("type is 'firebase'", () => {
    const adapter = new FirebaseAdapter({ auth: makeFakeAuth() })
    expect(adapter.type).toBe("firebase")
  })

  test("isAvailable returns true", async () => {
    const adapter = new FirebaseAdapter({ auth: makeFakeAuth() })
    expect(await adapter.isAvailable()).toBe(true)
  })

  test("verifyAuthentication verifies ID token and returns credential keyed by Firebase UID", async () => {
    const fakeAuth = {
      verifyIdToken: async (token: string) => {
        if (token !== "valid-token") throw new Error("Firebase: token invalid")
        return { uid: "firebase-uid-abc123", email: "alice@example.com" } as any
      },
    } as unknown as import("firebase-admin/auth").Auth

    const adapter = new FirebaseAdapter({ auth: fakeAuth })
    const credential = await adapter.verifyAuthentication({ idToken: "valid-token" })

    expect(credential.credentialId).toBe("firebase-uid-abc123")
    expect(credential.deviceType).toBe("firebase")
    expect(credential.backedUp).toBe(true)
    expect(credential.counter).toBe(0)
    expect(credential.publicKey.length).toBe(0)
  })

  test("verifyAuthentication rejects invalid ID token", async () => {
    const fakeAuth = {
      verifyIdToken: async (_t: string) => { throw new Error("Firebase: token invalid") },
    } as unknown as import("firebase-admin/auth").Auth

    const adapter = new FirebaseAdapter({ auth: fakeAuth })
    await expect(adapter.verifyAuthentication({ idToken: "bad" })).rejects.toThrow()
  })

  test("verifyAuthentication rejects malformed response", async () => {
    const adapter = new FirebaseAdapter({ auth: makeFakeAuth() })
    await expect(adapter.verifyAuthentication({ wrongShape: true })).rejects.toThrow(/idToken/)
  })

  test("verifyRegistration behaves identically to verifyAuthentication", async () => {
    const fakeAuth = {
      verifyIdToken: async (token: string) => {
        if (token !== "valid-token") throw new Error("Firebase: token invalid")
        return { uid: "firebase-uid-xyz", email: "bob@example.com" } as any
      },
    } as unknown as import("firebase-admin/auth").Auth

    const adapter = new FirebaseAdapter({ auth: fakeAuth })
    const credential = await adapter.verifyRegistration({ idToken: "valid-token" })

    expect(credential.credentialId).toBe("firebase-uid-xyz")
    expect(credential.deviceType).toBe("firebase")
  })

  test("startRegistration returns an empty challenge (Firebase owns the ceremony)", async () => {
    const adapter = new FirebaseAdapter({ auth: makeFakeAuth() })
    const result = await adapter.startRegistration({ id: "u1", name: "User" })
    expect(result.challenge).toBe("")
    expect(result.options).toEqual({})
  })

  test("startAuthentication returns an empty challenge", async () => {
    const adapter = new FirebaseAdapter({ auth: makeFakeAuth() })
    const result = await adapter.startAuthentication()
    expect(result.challenge).toBe("")
    expect(result.options).toEqual({})
  })
})
