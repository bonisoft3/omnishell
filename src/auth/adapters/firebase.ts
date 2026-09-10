import type {
  BiometricAdapter,
  UserInfo,
  RegistrationResult,
  BiometricCredential,
  AuthenticationChallenge,
} from "../types"

/**
 * The slice of firebase-admin's `Auth` this adapter calls. Structural on
 * purpose: firebase-admin is an optional peer, so each consumer resolves its
 * own copy, and `Auth` carries private members that make two copies mutually
 * unassignable however closely their versions match.
 */
export interface FirebaseIdTokenVerifier {
  verifyIdToken(idToken: string): Promise<{ uid: string }>
}

export interface FirebaseAdapterConfig {
  auth: FirebaseIdTokenVerifier
}

export class FirebaseAdapter implements BiometricAdapter {
  type = "firebase" as const

  constructor(private config: FirebaseAdapterConfig) {}

  async isAvailable(): Promise<boolean> {
    return true
  }

  async startRegistration(_user: UserInfo): Promise<RegistrationResult> {
    return { challenge: "", options: {} }
  }

  async verifyRegistration(response: unknown): Promise<BiometricCredential> {
    return this.verifyAuthentication(response)
  }

  async startAuthentication(_userId?: string): Promise<AuthenticationChallenge> {
    return { challenge: "", options: {} }
  }

  async verifyAuthentication(response: unknown): Promise<BiometricCredential> {
    const idToken = (response as { idToken?: unknown })?.idToken
    if (typeof idToken !== "string") {
      throw new Error("FirebaseAdapter: response must include an idToken string")
    }
    const decoded = await this.config.auth.verifyIdToken(idToken)
    return {
      credentialId: decoded.uid,
      publicKey: new Uint8Array(0),
      counter: 0,
      deviceType: "firebase",
      backedUp: true,
    }
  }
}
