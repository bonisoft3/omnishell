import { SignJWT, jwtVerify } from "jose"

const STORAGE_KEY = "omnishell:session"
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60

interface BrowserSessionConfig {
  secret: string
  maxAge?: number
  storage: Storage
}

interface SessionPayload {
  userId: string
  expiresAt: Date
}

export interface BrowserSessionManager {
  createToken(userId: string): Promise<string>
  verifyToken(token: string): Promise<SessionPayload | null>
  getStoredToken(): string | null
  clearToken(): void
}

export function createBrowserSessionManager(config: BrowserSessionConfig): BrowserSessionManager {
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE
  const secretKey = new TextEncoder().encode(config.secret)

  return {
    async createToken(userId: string): Promise<string> {
      const token = await new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(`${maxAge}s`)
        .sign(secretKey)
      config.storage.setItem(STORAGE_KEY, token)
      return token
    },

    async verifyToken(token: string): Promise<SessionPayload | null> {
      try {
        const { payload } = await jwtVerify(token, secretKey)
        if (!payload.sub) return null
        return {
          userId: payload.sub,
          expiresAt: payload.exp ? new Date(payload.exp * 1000) : new Date(Date.now() + maxAge * 1000),
        }
      } catch {
        return null
      }
    },

    getStoredToken(): string | null {
      return config.storage.getItem(STORAGE_KEY)
    },

    clearToken(): void {
      config.storage.removeItem(STORAGE_KEY)
    },
  }
}
