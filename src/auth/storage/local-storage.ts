import type { StorageAdapter, NewUser, User, StoredCredential } from "../types"

const USERS_KEY = "omnishell:users"
const CREDENTIALS_KEY = "omnishell:credentials"

interface SerializedCredential {
  userId: string
  credential: {
    credentialId: string
    publicKey: number[]
    counter: number
    deviceType: string
    backedUp: boolean
    transports?: string[]
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private store: Storage) {}

  private readUsers(): Record<string, User> {
    const raw = this.store.getItem(USERS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    for (const key of Object.keys(parsed)) {
      parsed[key].createdAt = new Date(parsed[key].createdAt)
    }
    return parsed
  }

  private writeUsers(users: Record<string, User>): void {
    this.store.setItem(USERS_KEY, JSON.stringify(users))
  }

  private readCredentials(): Record<string, SerializedCredential> {
    const raw = this.store.getItem(CREDENTIALS_KEY)
    if (!raw) return {}
    return JSON.parse(raw)
  }

  private writeCredentials(creds: Record<string, SerializedCredential>): void {
    this.store.setItem(CREDENTIALS_KEY, JSON.stringify(creds))
  }

  async createUser(data: NewUser): Promise<User> {
    const users = this.readUsers()
    const user: User = { id: crypto.randomUUID(), name: data.name, createdAt: new Date() }
    users[user.id] = user
    this.writeUsers(users)
    return user
  }

  async getUser(id: string): Promise<User | null> {
    return this.readUsers()[id] ?? null
  }

  async getUserByCredentialId(credentialId: string): Promise<User | null> {
    const creds = this.readCredentials()
    const entry = creds[credentialId]
    if (!entry) return null
    return this.getUser(entry.userId)
  }

  async storeCredential(userId: string, credential: StoredCredential): Promise<void> {
    const creds = this.readCredentials()
    creds[credential.credentialId] = {
      userId,
      credential: { ...credential, publicKey: Array.from(credential.publicKey) },
    }
    this.writeCredentials(creds)
  }

  async getCredentials(userId: string): Promise<StoredCredential[]> {
    const creds = this.readCredentials()
    const result: StoredCredential[] = []
    for (const entry of Object.values(creds)) {
      if (entry.userId === userId) {
        result.push({ ...entry.credential, publicKey: new Uint8Array(entry.credential.publicKey) })
      }
    }
    return result
  }

  async deleteCredential(credentialId: string): Promise<void> {
    const creds = this.readCredentials()
    delete creds[credentialId]
    this.writeCredentials(creds)
  }
}
