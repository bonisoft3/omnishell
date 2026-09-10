import { describe, test, expect, beforeEach } from "@test/harness"
import { createBrowserSessionManager } from "../../src/auth/session-browser"

class MockStorage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  removeItem(key: string) { this.data.delete(key) }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

const SECRET = "test-secret-that-is-long-enough-for-hs256-signing-key"

describe("BrowserSessionManager", () => {
  let mockLS: MockStorage
  let sm: ReturnType<typeof createBrowserSessionManager>

  beforeEach(() => {
    mockLS = new MockStorage()
    sm = createBrowserSessionManager({ secret: SECRET, storage: mockLS as any })
  })

  test("createToken produces a JWT string", async () => {
    const token = await sm.createToken("user-123")
    expect(typeof token).toBe("string")
    expect(token.split(".")).toHaveLength(3)
  })

  test("createToken stores token in localStorage", async () => {
    await sm.createToken("user-456")
    const stored = mockLS.getItem("omnishell:session")
    expect(stored).toBeTruthy()
  })

  test("verifyToken returns userId for valid token", async () => {
    const token = await sm.createToken("user-789")
    const payload = await sm.verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload!.userId).toBe("user-789")
  })

  test("verifyToken returns null for tampered token", async () => {
    const token = await sm.createToken("user-abc")
    const tampered = token.slice(0, -5) + "XXXXX"
    const payload = await sm.verifyToken(tampered)
    expect(payload).toBeNull()
  })

  test("getStoredToken returns token from localStorage", async () => {
    const token = await sm.createToken("user-def")
    const stored = sm.getStoredToken()
    expect(stored).toBe(token)
  })

  test("getStoredToken returns null when empty", () => {
    const stored = sm.getStoredToken()
    expect(stored).toBeNull()
  })

  test("clearToken removes from localStorage", async () => {
    await sm.createToken("user-ghi")
    sm.clearToken()
    expect(sm.getStoredToken()).toBeNull()
  })
})
