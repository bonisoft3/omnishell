// Domain types

export interface UserInfo {
  id: string
  name: string
}

export interface User {
  id: string
  name: string
  createdAt: Date
}

export interface NewUser {
  name: string
}

export interface StoredCredential {
  credentialId: string
  publicKey: Uint8Array
  counter: number
  deviceType: string
  backedUp: boolean
  transports?: string[]
}

export interface BiometricCredential {
  credentialId: string
  publicKey: Uint8Array
  counter: number
  deviceType: string
  backedUp: boolean
  transports?: string[]
  userId?: string
}

export interface Session {
  userId: string
  expiresAt: Date
  token: string
}

export interface RegistrationResult {
  challenge: string
  options: unknown
}

export interface AuthenticationChallenge {
  challenge: string
  options: unknown
}

// Pluggable interfaces

export interface BiometricAdapter {
  type: string
  isAvailable(): Promise<boolean>
  startRegistration(user: UserInfo): Promise<RegistrationResult>
  verifyRegistration(response: unknown): Promise<BiometricCredential>
  startAuthentication(userId?: string): Promise<AuthenticationChallenge>
  verifyAuthentication(response: unknown, context?: { publicKey: Uint8Array; counter: number; transports?: string[] }): Promise<BiometricCredential>
}

export interface StorageAdapter {
  createUser(data: NewUser): Promise<User>
  getUser(id: string): Promise<User | null>
  getUserByCredentialId(credentialId: string): Promise<User | null>
  storeCredential(userId: string, credential: StoredCredential): Promise<void>
  getCredentials(userId: string): Promise<StoredCredential[]>
  deleteCredential(credentialId: string): Promise<void>
}

export interface AuthProvider {
  register(credential: BiometricCredential, name?: string): Promise<Session>
  authenticate(credential: BiometricCredential): Promise<Session>
  getSession(token: string): Promise<Session | null>
  revokeSession(token: string): Promise<void>
}

export interface AuthConfig {
  biometric: BiometricAdapter
  storage: StorageAdapter
  secret: string
  sessionMaxAge?: number // seconds, default 30 days
}

export interface Auth {
  handleRequest(req: Request): Promise<Response>
  getSession(req: Request): Promise<Session | null>
}
