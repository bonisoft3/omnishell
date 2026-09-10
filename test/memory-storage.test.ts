import { describe, test, expect } from "@test/harness"
import { MemoryStorage } from "../src/auth/storage/memory"
import type { StoredCredential } from "../src/auth/types"

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

describe("MemoryStorage", () => {
  test("createUser returns a user with generated id and createdAt", async () => {
    const storage = new MemoryStorage()
    const user = await storage.createUser({ name: "Alice" })
    expect(user.id).toBeTruthy()
    expect(user.name).toBe("Alice")
    expect(user.createdAt).toBeInstanceOf(Date)
  })

  test("getUser returns null for unknown id", async () => {
    const storage = new MemoryStorage()
    const user = await storage.getUser("nonexistent")
    expect(user).toBeNull()
  })

  test("getUser returns previously created user", async () => {
    const storage = new MemoryStorage()
    const created = await storage.createUser({ name: "Bob" })
    const found = await storage.getUser(created.id)
    expect(found).toEqual(created)
  })

  test("storeCredential and getCredentials round-trip", async () => {
    const storage = new MemoryStorage()
    const user = await storage.createUser({ name: "Carol" })
    const cred = makeCredential()
    await storage.storeCredential(user.id, cred)
    const creds = await storage.getCredentials(user.id)
    expect(creds).toHaveLength(1)
    expect(creds[0]!.credentialId).toBe("cred-1")
  })

  test("getUserByCredentialId finds user by stored credential", async () => {
    const storage = new MemoryStorage()
    const user = await storage.createUser({ name: "Dave" })
    await storage.storeCredential(user.id, makeCredential({ credentialId: "cred-99" }))
    const found = await storage.getUserByCredentialId("cred-99")
    expect(found).toEqual(user)
  })

  test("getUserByCredentialId returns null for unknown credential", async () => {
    const storage = new MemoryStorage()
    const found = await storage.getUserByCredentialId("nonexistent")
    expect(found).toBeNull()
  })

  test("deleteCredential removes a credential", async () => {
    const storage = new MemoryStorage()
    const user = await storage.createUser({ name: "Eve" })
    await storage.storeCredential(user.id, makeCredential({ credentialId: "to-delete" }))
    await storage.deleteCredential("to-delete")
    const creds = await storage.getCredentials(user.id)
    expect(creds).toHaveLength(0)
  })

  test("multiple credentials per user", async () => {
    const storage = new MemoryStorage()
    const user = await storage.createUser({ name: "Frank" })
    await storage.storeCredential(user.id, makeCredential({ credentialId: "c1" }))
    await storage.storeCredential(user.id, makeCredential({ credentialId: "c2" }))
    const creds = await storage.getCredentials(user.id)
    expect(creds).toHaveLength(2)
  })
})
