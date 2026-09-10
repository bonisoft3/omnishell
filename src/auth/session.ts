import { SignJWT, jwtVerify } from "jose"

const COOKIE_NAME = "omnishell_session"
const DEFAULT_MAX_AGE = 30 * 24 * 60 * 60 // 30 days in seconds

interface SessionManagerConfig {
  secret: string
  maxAge?: number // seconds
}

interface SessionPayload {
  userId: string
  expiresAt: Date
}

export interface SessionManager {
  createToken(userId: string): Promise<string>
  verifyToken(token: string): Promise<SessionPayload | null>
  setCookie(headers: Headers, token: string): void
  getCookie(req: Request): string | null
  clearCookie(headers: Headers): void
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const maxAge = config.maxAge ?? DEFAULT_MAX_AGE
  const secretKey = new TextEncoder().encode(config.secret)

  return {
    async createToken(userId: string): Promise<string> {
      return new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(`${maxAge}s`)
        .sign(secretKey)
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

    setCookie(headers: Headers, token: string): void {
      headers.set(
        "Set-Cookie",
        `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`
      )
    },

    getCookie(req: Request): string | null {
      const cookie = req.headers.get("Cookie")
      if (!cookie) return null
      const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`))
      return match?.[1] ?? null
    },

    clearCookie(headers: Headers): void {
      headers.set(
        "Set-Cookie",
        `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
      )
    },
  }
}
