import { describe, test, expect } from "@test/harness"
import { WebAuthnAdapter } from "../src/auth/adapters/webauthn"

const rpConfig = {
  rpName: "Test App",
  rpID: "localhost",
  origin: "http://localhost:3000",
}

describe("WebAuthnAdapter", () => {
  test("type is 'webauthn'", () => {
    const adapter = new WebAuthnAdapter(rpConfig)
    expect(adapter.type).toBe("webauthn")
  })

  test("isAvailable returns true (server-side always available)", async () => {
    const adapter = new WebAuthnAdapter(rpConfig)
    const available = await adapter.isAvailable()
    expect(available).toBe(true)
  })

  test("startRegistration returns challenge and options", async () => {
    const adapter = new WebAuthnAdapter(rpConfig)
    const result = await adapter.startRegistration({
      id: "user-1",
      name: "alice@example.com",
    })
    expect(result.challenge).toBeTruthy()
    expect(typeof result.challenge).toBe("string")
    expect(result.options).toBeTruthy()
  })

  test("startAuthentication returns challenge and options", async () => {
    const adapter = new WebAuthnAdapter(rpConfig)
    const result = await adapter.startAuthentication()
    expect(result.challenge).toBeTruthy()
    expect(typeof result.challenge).toBe("string")
    expect(result.options).toBeTruthy()
  })

  test("verifyRegistration rejects invalid response", async () => {
    const adapter = new WebAuthnAdapter(rpConfig)
    await adapter.startRegistration({ id: "user-1", name: "alice" })
    await expect(adapter.verifyRegistration({ garbage: true })).rejects.toThrow()
  })

  test("verifyAuthentication rejects invalid response", async () => {
    const adapter = new WebAuthnAdapter(rpConfig)
    await adapter.startAuthentication()
    await expect(
      adapter.verifyAuthentication({ garbage: true }, {
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
      })
    ).rejects.toThrow()
  })
})
