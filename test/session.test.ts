import { describe, test, expect } from "@test/harness"
import { createSessionManager } from "../src/auth/session"

const SECRET = "test-secret-that-is-long-enough-for-hs256-signing-key"

describe("SessionManager", () => {
  test("createToken produces a JWT string", async () => {
    const sm = createSessionManager({ secret: SECRET })
    const token = await sm.createToken("user-123")
    expect(typeof token).toBe("string")
    expect(token.split(".")).toHaveLength(3)
  })

  test("verifyToken returns userId for valid token", async () => {
    const sm = createSessionManager({ secret: SECRET })
    const token = await sm.createToken("user-456")
    const payload = await sm.verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.userId).toBe("user-456")
  })

  test("verifyToken returns null for tampered token", async () => {
    const sm = createSessionManager({ secret: SECRET })
    const token = await sm.createToken("user-789")
    const tampered = token.slice(0, -5) + "XXXXX"
    const payload = await sm.verifyToken(tampered)
    expect(payload).toBeNull()
  })

  test("verifyToken returns null for expired token", async () => {
    const sm = createSessionManager({ secret: SECRET, maxAge: 0 })
    const token = await sm.createToken("user-expired")
    // JWT exp is in whole seconds, so a maxAge of 0 only bites once the
    // clock crosses the next second.
    await new Promise((r) => setTimeout(r, 1100))
    const payload = await sm.verifyToken(token)
    expect(payload).toBeNull()
  })

  test("setCookie sets HttpOnly Secure SameSite cookie", () => {
    const sm = createSessionManager({ secret: SECRET })
    const headers = new Headers()
    sm.setCookie(headers, "my-jwt-token")
    const cookie = headers.get("Set-Cookie")
    expect(cookie).toContain("omnishell_session=my-jwt-token")
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("Secure")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain("Path=/")
  })

  test("getCookie extracts token from Cookie header", () => {
    const sm = createSessionManager({ secret: SECRET })
    const req = new Request("http://localhost", {
      headers: { Cookie: "omnishell_session=abc123; other=val" },
    })
    expect(sm.getCookie(req)).toBe("abc123")
  })

  test("getCookie returns null when no session cookie", () => {
    const sm = createSessionManager({ secret: SECRET })
    const req = new Request("http://localhost")
    expect(sm.getCookie(req)).toBeNull()
  })

  test("clearCookie sets expired cookie", () => {
    const sm = createSessionManager({ secret: SECRET })
    const headers = new Headers()
    sm.clearCookie(headers)
    const cookie = headers.get("Set-Cookie")
    expect(cookie).toContain("omnishell_session=")
    expect(cookie).toContain("Max-Age=0")
  })
})
