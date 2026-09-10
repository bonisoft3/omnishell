import type { StorageAdapter, NewUser, User, StoredCredential } from "../types"

export class MemoryStorage implements StorageAdapter {
  private users = new Map<string, User>()
  private credentials = new Map<string, { userId: string; credential: StoredCredential }>()

  async createUser(data: NewUser): Promise<User> {
    const user: User = {
      id: crypto.randomUUID(),
      name: data.name,
      createdAt: new Date(),
    }
    this.users.set(user.id, user)
    return user
  }

  async getUser(id: string): Promise<User | null> {
    return this.users.get(id) ?? null
  }

  async getUserByCredentialId(credentialId: string): Promise<User | null> {
    const entry = this.credentials.get(credentialId)
    if (!entry) return null
    return this.users.get(entry.userId) ?? null
  }

  async storeCredential(userId: string, credential: StoredCredential): Promise<void> {
    this.credentials.set(credential.credentialId, { userId, credential })
  }

  async getCredentials(userId: string): Promise<StoredCredential[]> {
    const result: StoredCredential[] = []
    for (const entry of this.credentials.values()) {
      if (entry.userId === userId) {
        result.push(entry.credential)
      }
    }
    return result
  }

  async deleteCredential(credentialId: string): Promise<void> {
    this.credentials.delete(credentialId)
  }
}
