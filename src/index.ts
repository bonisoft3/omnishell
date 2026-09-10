import type { AuthConfig, Auth, Session } from "./auth/types"
import { DefaultAuthProvider } from "./auth/provider"
import { createSessionManager } from "./auth/session"

export { WebAuthnAdapter } from "./auth/adapters/webauthn"
export { FirebaseAdapter } from "./auth/adapters/firebase"
export type { FirebaseAdapterConfig } from "./auth/adapters/firebase"
export { MemoryStorage } from "./auth/storage/memory"
export type {
  AuthProvider,
  BiometricAdapter,
  StorageAdapter,
  AuthConfig,
  Auth,
  Session,
  User,
  UserInfo,
  BiometricCredential,
  StoredCredential,
} from "./auth/types"

export { LocalStorageAdapter } from "./auth/storage/local-storage"
export { createBrowserSessionManager } from "./auth/session-browser"
export type { BrowserSessionManager } from "./auth/session-browser"
export { exchangeFirebaseToken } from "./auth/client/firebase-exchange"
export type { ExchangeOptions, ExchangeResult } from "./auth/client/firebase-exchange"

export { createLayout } from "./layout/create-layout"
export type { NavItem, LayoutConfig, LayoutComponents, ResolvedLayoutConfig } from "./layout/types"

export { omnishellLint } from "./lint/eslint/index"
export { omnishellPreset } from "./lint/eslint/tailwind-preset"

export function createAuth(config: AuthConfig): Auth {
  const sessions = createSessionManager({
    secret: config.secret,
    maxAge: config.sessionMaxAge,
  })
  const provider = new DefaultAuthProvider(config.storage, sessions, config.sessionMaxAge)
  const biometric = config.biometric

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname

    try {
      if (path === "/auth/register/start" && req.method === "POST") {
        const body = await req.json()
        const userInfo = { id: crypto.randomUUID(), name: body.name ?? "User" }
        const result = await biometric.startRegistration(userInfo)
        return Response.json(result)
      }

      if (path === "/auth/register/verify" && req.method === "POST") {
        const body = await req.json()
        const credential = await biometric.verifyRegistration(body.credential)
        const session = await provider.register(credential, body.name)
        const headers = new Headers({ "Content-Type": "application/json" })
        sessions.setCookie(headers, session.token)
        return new Response(JSON.stringify({ userId: session.userId }), { headers })
      }

      if (path === "/auth/authenticate/start" && req.method === "POST") {
        const result = await biometric.startAuthentication()
        return Response.json(result)
      }

      if (path === "/auth/authenticate/verify" && req.method === "POST") {
        const body = await req.json()
        // Look up stored credential for WebAuthn verification
        const credentialId = body.credential?.id ?? body.credential?.rawId
        let storedContext: { publicKey: Uint8Array; counter: number; transports?: string[] } | undefined
        if (credentialId) {
          const user = await config.storage.getUserByCredentialId(credentialId)
          if (user) {
            const storedCreds = await config.storage.getCredentials(user.id)
            const match = storedCreds.find(c => c.credentialId === credentialId)
            if (match) {
              storedContext = {
                publicKey: match.publicKey,
                counter: match.counter,
                transports: match.transports,
              }
            }
          }
        }
        const credential = await biometric.verifyAuthentication(body.credential, storedContext)
        const session = await provider.authenticate(credential)
        const headers = new Headers({ "Content-Type": "application/json" })
        sessions.setCookie(headers, session.token)
        return new Response(JSON.stringify({ userId: session.userId }), { headers })
      }

      if (path === "/auth/session" && req.method === "GET") {
        const session = await getSession(req)
        if (!session) return new Response(null, { status: 401 })
        return Response.json({ userId: session.userId, expiresAt: session.expiresAt })
      }

      if (path === "/auth/logout" && req.method === "POST") {
        const headers = new Headers()
        sessions.clearCookie(headers)
        return new Response(null, { status: 200, headers })
      }

      return new Response("Not found", { status: 404 })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error"
      return Response.json({ error: message }, { status: 400 })
    }
  }

  async function getSession(req: Request): Promise<Session | null> {
    const token = sessions.getCookie(req)
    if (!token) return null
    return provider.getSession(token)
  }

  return { handleRequest, getSession }
}
