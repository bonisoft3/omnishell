// Native host AuthBridge contract shared across Kotlin (CredentialManager + Custom Tabs),
// Swift (ASAuthorizationController + ASWebAuthenticationSession), and headless JS isolates.

export interface KeyValueStoreLike {
  get(key: string): string | null | undefined;
  set(key: string, value: string): void;
  delete(key: string): boolean;
  clear(): void;
  keys(): string[];
}

export interface SqlStoreLike {
  exec(sql: string, params?: unknown[]): { rowsAffected: number; lastInsertRowId?: number };
  query(sql: string, params?: unknown[]): Record<string, unknown>[];
}

export interface StorageBridgeLike {
  kv: KeyValueStoreLike;
  sql: SqlStoreLike;
}

export interface AuthSession {
  token: string;
  refreshToken?: string | null;
  userId: string;
  handle?: string | null;
  isGuest: boolean;
  expiresAtEpochS?: number | null;
}

export interface PasskeySignInOptions {
  rpId: string;
  challenge: string;
  allowCredentials?: Array<{ id: string; type?: string; transports?: string[] }>;
  timeoutMs?: number;
}

export interface PasskeyRegisterOptions {
  rpId: string;
  rpName: string;
  challenge: string;
  userId: string;
  userName: string;
  userDisplayName?: string;
  promote?: boolean;
  guestBearerToken?: string;
  timeoutMs?: number;
}

export interface OidcStartOptions {
  origin: string;
  callbackScheme?: string;
  guestBearerToken?: string;
  codeVerifier?: string;
}

export interface OidcCeremonyResult {
  ticket: string;
  codeVerifier: string;
  callbackUrl: string;
  session?: AuthSession;
}

export interface AppleSignInOptions {
  origin: string;
  nonce?: string;
  requestedScopes?: Array<"fullName" | "email">;
  guestBearerToken?: string;
}

export interface AppleSignInResult {
  identityToken: string;
  authorizationCode: string;
  userIdentifier: string;
  fullName?: string | null;
  email?: string | null;
  session?: AuthSession;
}

export interface DeleteAccountOptions {
  origin: string;
  bearerToken?: string;
  fetcher?: typeof fetch;
  sql?: SqlStoreLike;
}

export interface NativeCredentialHandler {
  passkeySignIn(options: PasskeySignInOptions): Promise<Record<string, unknown>>;
  passkeyRegister(options: PasskeyRegisterOptions): Promise<Record<string, unknown>>;
  oidcStart(
    provider: string,
    startUrl: string,
    codeVerifier: string,
    options: OidcStartOptions,
  ): Promise<OidcCeremonyResult>;
  appleSignIn?(options: AppleSignInOptions): Promise<AppleSignInResult>;
}

export interface AuthBridge {
  passkeySignIn(options: PasskeySignInOptions): Promise<Record<string, unknown>>;
  passkeyRegister(options: PasskeyRegisterOptions): Promise<Record<string, unknown>>;
  oidcStart(provider: string, options: OidcStartOptions): Promise<OidcCeremonyResult>;
  appleSignIn(options: AppleSignInOptions): Promise<AppleSignInResult | OidcCeremonyResult>;
  deleteAccount(options: DeleteAccountOptions): Promise<{ deleted: true; wipedTables: string[] }>;
  loadSession(): AuthSession | null;
  saveSession(session: AuthSession): void;
  clearSession(): void;
}

const SESSION_KV_KEY = "omnishell_auth_session_v1";

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function generatePkceVerifier(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export async function computePkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

export function buildNativeOidcStartUrl(
  origin: string,
  provider: string,
  codeChallenge: string,
): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  const params = new URLSearchParams({
    return: "native",
    code_challenge: codeChallenge,
  });
  return `${cleanOrigin}/auth/oidc/${encodeURIComponent(provider)}/start?${params.toString()}`;
}

export function validateAuthSession(raw: unknown): AuthSession {
  if (!raw || typeof raw !== "object") {
    throw new Error("AuthSession must be a non-null object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.token !== "string" || obj.token.length === 0) {
    throw new Error("AuthSession.token must be a non-empty string");
  }
  if (typeof obj.userId !== "string" || obj.userId.length === 0) {
    throw new Error("AuthSession.userId must be a non-empty string");
  }
  if (typeof obj.isGuest !== "boolean") {
    throw new Error("AuthSession.isGuest must be a boolean");
  }
  return {
    token: obj.token,
    refreshToken: typeof obj.refreshToken === "string" ? obj.refreshToken : null,
    userId: obj.userId,
    handle: typeof obj.handle === "string" ? obj.handle : null,
    isGuest: obj.isGuest,
    expiresAtEpochS: typeof obj.expiresAtEpochS === "number" ? obj.expiresAtEpochS : null,
  };
}

export function createProvisionalOfflineGuestSession(uuid: string = crypto.randomUUID()): AuthSession {
  return {
    token: `provisional-offline:${uuid}`,
    refreshToken: null,
    userId: uuid,
    handle: null,
    isGuest: true,
    expiresAtEpochS: null,
  };
}

export function wipeAccountSqlState(sql: SqlStoreLike, deletedSubject?: string | null): string[] {
  const wiped: string[] = [];
  const existing = new Set(
    sql
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => String(r.name ?? "")),
  );
  if (existing.has("mecha_outbox")) {
    sql.exec("DELETE FROM mecha_outbox");
    wiped.push("mecha_outbox");
  }
  if (existing.has("mecha_shape_row")) {
    if (deletedSubject && deletedSubject !== "anon") {
      sql.exec("DELETE FROM mecha_shape_row WHERE subject = ?", [deletedSubject]);
    } else {
      sql.exec("DELETE FROM mecha_shape_row WHERE subject != '' AND subject != 'anon'");
    }
    wiped.push("mecha_shape_row");
  }
  if (existing.has("mecha_shape_meta")) {
    if (deletedSubject && deletedSubject !== "anon") {
      sql.exec("DELETE FROM mecha_shape_meta WHERE subject = ?", [deletedSubject]);
    } else {
      sql.exec("DELETE FROM mecha_shape_meta WHERE subject != '' AND subject != 'anon'");
    }
    wiped.push("mecha_shape_meta");
  }
  if (existing.has("__omnishell_kv")) {
    sql.exec("DELETE FROM __omnishell_kv");
    wiped.push("__omnishell_kv");
  }
  return wiped;
}

export function createAuthBridge(options: {
  kv: KeyValueStoreLike;
  sql?: SqlStoreLike;
  credentialHandler?: NativeCredentialHandler;
  fetcher?: typeof fetch;
}): AuthBridge {
  const { kv, sql: configuredSql, credentialHandler, fetcher: configuredFetcher } = options;

  function requireCredentialHandler(op: string): NativeCredentialHandler {
    if (!credentialHandler) {
      throw new Error(`AuthBridge.${op} requires a configured NativeCredentialHandler`);
    }
    return credentialHandler;
  }

  return {
    async passkeySignIn(signInOpts: PasskeySignInOptions): Promise<Record<string, unknown>> {
      if (!signInOpts.rpId || !signInOpts.challenge) {
        throw new Error("passkeySignIn requires rpId and challenge");
      }
      return await requireCredentialHandler("passkeySignIn").passkeySignIn(signInOpts);
    },

    async passkeyRegister(regOpts: PasskeyRegisterOptions): Promise<Record<string, unknown>> {
      if (!regOpts.rpId || !regOpts.challenge || !regOpts.userId || !regOpts.userName) {
        throw new Error("passkeyRegister requires rpId, challenge, userId, and userName");
      }
      return await requireCredentialHandler("passkeyRegister").passkeyRegister(regOpts);
    },

    async oidcStart(provider: string, oidcOpts: OidcStartOptions): Promise<OidcCeremonyResult> {
      if (!provider) throw new Error("oidcStart requires a provider name");
      if (!oidcOpts?.origin) throw new Error("oidcStart requires origin");
      const verifier = oidcOpts.codeVerifier ?? generatePkceVerifier();
      const challenge = await computePkceChallengeS256(verifier);
      const startUrl = buildNativeOidcStartUrl(oidcOpts.origin, provider, challenge);
      const result = await requireCredentialHandler("oidcStart").oidcStart(
        provider,
        startUrl,
        verifier,
        oidcOpts,
      );
      if (result.session) {
        const validated = validateAuthSession(result.session);
        kv.set(SESSION_KV_KEY, JSON.stringify(validated));
      }
      return result;
    },

    async appleSignIn(appleOpts: AppleSignInOptions): Promise<AppleSignInResult | OidcCeremonyResult> {
      if (!appleOpts?.origin) throw new Error("appleSignIn requires origin");
      const handler = requireCredentialHandler("appleSignIn");
      if (typeof handler.appleSignIn === "function") {
        const result = await handler.appleSignIn(appleOpts);
        if (result.session) {
          const validated = validateAuthSession(result.session);
          kv.set(SESSION_KV_KEY, JSON.stringify(validated));
        }
        return result;
      }
      return await this.oidcStart("apple", {
        origin: appleOpts.origin,
        guestBearerToken: appleOpts.guestBearerToken,
      });
    },

    async deleteAccount(delOpts: DeleteAccountOptions): Promise<{ deleted: true; wipedTables: string[] }> {
      if (!delOpts?.origin) throw new Error("deleteAccount requires origin");
      const stored = this.loadSession();
      const bearer = delOpts.bearerToken ?? stored?.token;
      if (!bearer) {
        throw new Error("deleteAccount requires an active session token");
      }
      const doFetch = delOpts.fetcher ?? configuredFetcher ?? fetch;
      const cleanOrigin = delOpts.origin.replace(/\/+$/, "");
      const res = await doFetch(`${cleanOrigin}/auth/account`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${bearer}`,
        },
      });
      if (!res.ok) {
        throw new Error(`DELETE /auth/account failed with status ${res.status}`);
      }
      kv.clear();
      const targetSql = delOpts.sql ?? configuredSql;
      const wipedTables = targetSql ? wipeAccountSqlState(targetSql, stored?.userId) : [];
      return { deleted: true, wipedTables };
    },

    loadSession(): AuthSession | null {
      const raw = kv.get(SESSION_KV_KEY);
      if (raw === null || raw === undefined || raw === "") return null;
      return validateAuthSession(JSON.parse(raw));
    },

    saveSession(session: AuthSession): void {
      const validated = validateAuthSession(session);
      kv.set(SESSION_KV_KEY, JSON.stringify(validated));
    },

    clearSession(): void {
      kv.delete(SESSION_KV_KEY);
    },
  };
}
