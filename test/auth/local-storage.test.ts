import { describe, test, expect, beforeEach } from "@test/harness"
import { LocalStorageAdapter } from "../../src/auth/storage/local-storage"
import type { StoredCredential } from "../../src/auth/types"

class MockStorage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  clear() { this.data.clear() }
  getItem(key: string) { return this.data.get(key) ?? null }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  removeItem(key: string) { this.data.delete(key) }
  setItem(key: string, value: string) { this.data.set(key, value) }
}

function makeCredential(overrides?: Partial<StoredCredential>): StoredCredential {
  return {
    credentialId: "cred-1",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    deviceType: "singleDevice",
    backedUp: false,
    ...overrides,
  }
}

describe("LocalStorageAdapter", () => {
  let storage: LocalStorageAdapter
  let mockLS: MockStorage

  beforeEach(() => {
    mockLS = new MockStorage()
    storage = new LocalStorageAdapter(mockLS as any)
  })

  test("createUser persists to localStorage", async () => {
    const user = await storage.createUser({ name: "Alice" })
    expect(user.id).toBeTruthy()
    expect(user.name).toBe("Alice")
    const raw = mockLS.getItem("omnishell:users")
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(Object.keys(parsed)).toHaveLength(1)
  })

  test("getUser returns persisted user", async () => {
    const created = await storage.createUser({ name: "Bob" })
    const found = await storage.getUser(created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe("Bob")
  })

  test("getUser returns null for unknown id", async () => {
    const found = await storage.getUser("nonexistent")
    expect(found).toBeNull()
  })

  test("storeCredential and getCredentials round-trip", async () => {
    const user = await storage.createUser({ name: "Carol" })
    await storage.storeCredential(user.id, makeCredential())
    const creds = await storage.getCredentials(user.id)
    expect(creds).toHaveLength(1)
    expect(creds[0]!.credentialId).toBe("cred-1")
  })

  test("getUserByCredentialId finds user", async () => {
    const user = await storage.createUser({ name: "Dave" })
    await storage.storeCredential(user.id, makeCredential({ credentialId: "c-99" }))
    const found = await storage.getUserByCredentialId("c-99")
    expect(found).not.toBeNull()
    expect(found!.name).toBe("Dave")
  })

  test("deleteCredential removes credential", async () => {
    const user = await storage.createUser({ name: "Eve" })
    await storage.storeCredential(user.id, makeCredential({ credentialId: "del" }))
    await storage.deleteCredential("del")
    const creds = await storage.getCredentials(user.id)
    expect(creds).toHaveLength(0)
  })

  test("data survives re-instantiation with same storage backend", async () => {
    await storage.createUser({ name: "Frank" })
    const storage2 = new LocalStorageAdapter(mockLS as any)
    const users = mockLS.getItem("omnishell:users")
    expect(users).toContain("Frank")
  })
})
