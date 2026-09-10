import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server"
import type {
  BiometricAdapter,
  UserInfo,
  RegistrationResult,
  BiometricCredential,
  AuthenticationChallenge,
} from "../types"

interface WebAuthnConfig {
  rpName: string
  rpID: string
  origin: string
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const MAX_PENDING_CHALLENGES = 1000

export class WebAuthnAdapter implements BiometricAdapter {
  type = "webauthn" as const
  private pendingChallenges = new Map<string, number>() // challenge -> timestamp

  constructor(private config: WebAuthnConfig) {}

  private storeChallenge(challenge: string): void {
    // Evict expired challenges
    const now = Date.now()
    for (const [c, ts] of this.pendingChallenges) {
      if (now - ts > CHALLENGE_TTL_MS) this.pendingChallenges.delete(c)
    }
    // Cap size to prevent unbounded growth
    if (this.pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.pendingChallenges.keys().next().value!
      this.pendingChallenges.delete(oldest)
    }
    this.pendingChallenges.set(challenge, now)
  }

  private consumeChallenge(challenge: string): boolean {
    if (!this.pendingChallenges.has(challenge)) return false
    const ts = this.pendingChallenges.get(challenge)!
    this.pendingChallenges.delete(challenge)
    return Date.now() - ts <= CHALLENGE_TTL_MS
  }

  async isAvailable(): Promise<boolean> {
    return true // Server-side is always available; client checks browser support
  }

  async startRegistration(user: UserInfo): Promise<RegistrationResult> {
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName,
      rpID: this.config.rpID,
      userName: user.name,
      userID: new TextEncoder().encode(user.id) as Uint8Array<ArrayBuffer>,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    })
    this.storeChallenge(options.challenge)
    return { challenge: options.challenge, options }
  }

  async verifyRegistration(response: unknown): Promise<BiometricCredential> {
    // Find a valid pending challenge by trying each one.
    // In practice the set is small (one per concurrent ceremony).
    let matchedChallenge: string | null = null
    for (const [challenge] of this.pendingChallenges) {
      if (this.consumeChallenge(challenge)) {
        matchedChallenge = challenge
        break
      }
    }
    if (!matchedChallenge) throw new Error("No registration in progress")
    const verification: VerifiedRegistrationResponse = await verifyRegistrationResponse({
      response: response as any,
      expectedChallenge: matchedChallenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpID,
    })
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error("Registration verification failed")
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      transports: (response as any).response?.transports,
    }
  }

  async startAuthentication(_userId?: string): Promise<AuthenticationChallenge> {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpID,
      userVerification: "required",
    })
    this.storeChallenge(options.challenge)
    return { challenge: options.challenge, options }
  }

  async verifyAuthentication(
    response: unknown,
    storedCredential?: { publicKey: Uint8Array; counter: number; transports?: string[] }
  ): Promise<BiometricCredential> {
    let matchedChallenge: string | null = null
    for (const [challenge] of this.pendingChallenges) {
      if (this.consumeChallenge(challenge)) {
        matchedChallenge = challenge
        break
      }
    }
    if (!matchedChallenge) throw new Error("No authentication in progress")
    if (!storedCredential) throw new Error("Stored credential required for verification")
    const verification: VerifiedAuthenticationResponse = await verifyAuthenticationResponse({
      response: response as any,
      expectedChallenge: matchedChallenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpID,
      credential: {
        id: (response as any).id,
        publicKey: storedCredential.publicKey as Uint8Array<ArrayBuffer>,
        counter: storedCredential.counter,
        transports: storedCredential.transports as any,
      },
    })
    if (!verification.verified) {
      throw new Error("Authentication verification failed")
    }
    return {
      credentialId: (response as any).id,
      publicKey: storedCredential.publicKey,
      counter: verification.authenticationInfo.newCounter,
      deviceType: "singleDevice",
      backedUp: false,
    }
  }
}
