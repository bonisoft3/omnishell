import type { AuthProvider, BiometricCredential, Session, StorageAdapter } from "./types"
import type { SessionManager } from "./session"

export class DefaultAuthProvider implements AuthProvider {
  private maxAgeMs: number

  constructor(
    private storage: StorageAdapter,
    private sessions: SessionManager,
    maxAge?: number // seconds, default 30 days
  ) {
    this.maxAgeMs = (maxAge ?? 30 * 24 * 60 * 60) * 1000
  }

  async register(credential: BiometricCredential, name?: string): Promise<Session> {
    const user = await this.storage.createUser({ name: name ?? "User" })
    await this.storage.storeCredential(user.id, {
      credentialId: credential.credentialId,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credential.deviceType,
      backedUp: credential.backedUp,
      transports: credential.transports,
    })
    return this.createSession(user.id)
  }

  async authenticate(credential: BiometricCredential): Promise<Session> {
    const user = await this.storage.getUserByCredentialId(credential.credentialId)
    if (!user) throw new Error("Unknown credential")
    return this.createSession(user.id)
  }

  async getSession(token: string): Promise<Session | null> {
    const payload = await this.sessions.verifyToken(token)
    if (!payload) return null
    return {
      userId: payload.userId,
      token,
      expiresAt: payload.expiresAt,
    }
  }

  async revokeSession(_token: string): Promise<void> {
    // Stateless JWT — revocation is a no-op.
    // Active tokens remain valid until expiry.
  }

  private async createSession(userId: string): Promise<Session> {
    const token = await this.sessions.createToken(userId)
    return {
      userId,
      token,
      expiresAt: new Date(Date.now() + this.maxAgeMs),
    }
  }
}
