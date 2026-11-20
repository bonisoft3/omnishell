package com.pronto.omnishell.bridge

import com.pronto.omnishell.network.NativeFetchResponse
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

@Serializable
data class AuthSession(
    val token: String,
    val refreshToken: String? = null,
    val userId: String,
    val handle: String? = null,
    val isGuest: Boolean,
    val expiresAtEpochS: Long? = null
)

@Serializable
data class PasskeySignInOptions(
    val rpId: String,
    val challenge: String,
    val timeoutMs: Int? = null
)

@Serializable
data class PasskeyRegisterOptions(
    val rpId: String,
    val rpName: String,
    val challenge: String,
    val userId: String,
    val userName: String,
    val userDisplayName: String? = null,
    val promote: Boolean? = null,
    val guestBearerToken: String? = null
)

@Serializable
data class OidcStartOptions(
    val origin: String,
    val callbackScheme: String? = "snapcards",
    val guestBearerToken: String? = null,
    val codeVerifier: String? = null
)

@Serializable
data class OidcCeremonyResult(
    val ticket: String,
    val codeVerifier: String,
    val callbackUrl: String,
    val session: AuthSession? = null,
    val held: Held? = null
)

// The sign-in answers of runtime/auth-bridge.ts, whose `Held` says what the
// runtime does with one.
@Serializable
data class HeldUser(val handle: String, val name: String? = null)

@Serializable
data class Held(val user: HeldUser, val ticket: String? = null, val codeVerifier: String? = null)

@Serializable
data class SignInResult(val session: AuthSession? = null, val held: Held? = null)

@Serializable
data class RedeemTicketOptions(val origin: String, val ticket: String, val codeVerifier: String)

@Serializable
data class PasskeyLoginOptions(val origin: String, val guestBearerToken: String? = null)

@Serializable
private data class IssuedUser(val id: String, val handle: String, val guest: Boolean = false)

@Serializable
private data class Issued(
    val token: String,
    @SerialName("refresh_token") val refreshToken: String? = null,
    val user: IssuedUser
)

@Serializable
private data class LoginRequired(val user: HeldUser, val ticket: String? = null)

@Serializable
private data class LoginStart(val rpId: String, val challenge: String, val state: String)

@Serializable
data class DeleteAccountRequest(
    val origin: String,
    val bearerToken: String? = null
)

@Serializable
data class DeleteAccountResult(
    val deleted: Boolean,
    val wipedTables: List<String> = emptyList()
)

interface SecureSessionStore {
    fun loadSessionJson(): String?
    fun saveSessionJson(json: String)
    fun clearSession()
}

class KeyValueSessionStore(
    private val storageBridge: StorageBridge
) : SecureSessionStore {
    companion object {
        private const val SESSION_KEY = "omnishell_auth_session_v1"
    }

    override fun loadSessionJson(): String? = storageBridge.kvGet(SESSION_KEY)

    override fun saveSessionJson(json: String) {
        storageBridge.kvSet(SESSION_KEY, json)
    }

    override fun clearSession() {
        storageBridge.kvDelete(SESSION_KEY)
    }
}

interface NativeCredentialHandler {
    fun passkeySignIn(
        options: PasskeySignInOptions,
        onSuccess: (String) -> Unit,
        onFailure: (Throwable) -> Unit
    )

    fun passkeyRegister(
        options: PasskeyRegisterOptions,
        onSuccess: (String) -> Unit,
        onFailure: (Throwable) -> Unit
    )

    fun oidcStart(
        provider: String,
        startUrl: String,
        codeVerifier: String,
        options: OidcStartOptions,
        onSuccess: (OidcCeremonyResult) -> Unit,
        onFailure: (Throwable) -> Unit
    )
}

class AuthBridge(
    private val sessionStore: SecureSessionStore,
    private val credentialHandler: NativeCredentialHandler? = null,
    private val json: Json = Json { ignoreUnknownKeys = true }
) {
    companion object {
        private val secureRandom = SecureRandom()
        private const val PROVISIONAL = "provisional-offline:"

        fun base64UrlEncode(bytes: ByteArray): String =
            Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

        fun generatePkceVerifier(byteLength: Int = 32): String {
            val bytes = ByteArray(byteLength)
            secureRandom.nextBytes(bytes)
            return base64UrlEncode(bytes)
        }

        fun computePkceChallengeS256(verifier: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
                .digest(verifier.toByteArray(StandardCharsets.UTF_8))
            return base64UrlEncode(digest)
        }

        fun buildNativeOidcStartUrl(
            origin: String,
            provider: String,
            codeChallenge: String,
            guestBearerToken: String? = null
        ): String {
            val cleanOrigin = origin.trimEnd('/')
            val encProvider = URLEncoder.encode(provider, StandardCharsets.UTF_8)
            val encChallenge = URLEncoder.encode(codeChallenge, StandardCharsets.UTF_8)
            // A guest's token is the browser's id_token_hint: an auth sheet sets no
            // header. A provisional guest, minted offline, has no account to hint at.
            val hint = guestBearerToken?.takeIf { it.isNotBlank() && !it.startsWith(PROVISIONAL) }
                ?.let { "&promote_token=${URLEncoder.encode(it, StandardCharsets.UTF_8)}" }
                .orEmpty()
            return "$cleanOrigin/auth/oidc/$encProvider/start?return=native&code_challenge=$encChallenge$hint"
        }
    }

    private fun post(
        networkBridge: NetworkBridge,
        url: String,
        body: String,
        bearer: String?,
        onResponse: (NativeFetchResponse) -> Unit,
        onReject: (String) -> Unit
    ) {
        val fetchOpts = buildJsonObject {
            put("method", "POST")
            put("headers", buildJsonObject {
                put("content-type", "application/json")
                if (bearer != null) put("Authorization", "Bearer $bearer")
            })
            put("body", body)
        }.toString()
        networkBridge.nativeFetchAsync(
            url = url,
            optionsJson = fetchOpts,
            onResolve = { raw ->
                val response = try {
                    json.decodeFromString<NativeFetchResponse>(raw)
                } catch (t: Throwable) {
                    onReject("Invalid response from $url: ${t.message}")
                    return@nativeFetchAsync
                }
                onResponse(response)
            },
            onReject = onReject
        )
    }

    /** A 2xx is this bridge's session, saved; a 409 is the account held. */
    private fun answer(
        path: String,
        response: NativeFetchResponse,
        codeVerifier: String?,
        onAnswer: (SignInResult) -> Unit,
        onReject: (String) -> Unit
    ) {
        if (response.status != 409 && response.status !in 200..299) {
            onReject("POST $path failed with status ${response.status}")
            return
        }
        val result = try {
            if (response.status == 409) {
                val refused = json.decodeFromString<LoginRequired>(response.body)
                SignInResult(held = Held(refused.user, refused.ticket, codeVerifier))
            } else {
                val issued = json.decodeFromString<Issued>(response.body)
                val session = AuthSession(
                    token = issued.token,
                    refreshToken = issued.refreshToken,
                    userId = issued.user.id,
                    handle = issued.user.handle,
                    isGuest = issued.user.guest
                )
                saveSession(session)
                SignInResult(session = session)
            }
        } catch (t: Throwable) {
            onReject("Invalid POST $path answer: ${t.message}")
            return
        }
        onAnswer(result)
    }

    private fun redeem(
        opts: RedeemTicketOptions,
        networkBridge: NetworkBridge,
        onAnswer: (SignInResult) -> Unit,
        onReject: (String) -> Unit
    ) {
        if (opts.origin.isBlank() || opts.ticket.isBlank() || opts.codeVerifier.isBlank()) {
            onReject("redeemTicket requires origin, ticket, and codeVerifier")
            return
        }
        val body = buildJsonObject {
            put("ticket", opts.ticket)
            put("code_verifier", opts.codeVerifier)
        }.toString()
        post(
            networkBridge, "${opts.origin.trimEnd('/')}/auth/oidc/session", body, null,
            onResponse = { answer("/auth/oidc/session", it, opts.codeVerifier, onAnswer, onReject) },
            onReject = onReject
        )
    }

    /** A provider sign-in's ticket redeemed with the verifier it was started with. */
    fun redeemTicket(
        optionsJson: String,
        networkBridge: NetworkBridge,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val opts = try {
            json.decodeFromString<RedeemTicketOptions>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid redeemTicket options: ${t.message}")
            return
        }
        redeem(opts, networkBridge, { onResolve(json.encodeToString(it)) }, onReject)
    }

    /** A passkey sign-in, start to session: this bridge's session, or the account held. */
    fun passkeyLogin(
        optionsJson: String,
        networkBridge: NetworkBridge,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val handler = credentialHandler ?: run {
            onReject("AuthBridge.passkeyLogin requires a configured NativeCredentialHandler")
            return
        }
        val opts = try {
            json.decodeFromString<PasskeyLoginOptions>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid passkeyLogin options: ${t.message}")
            return
        }
        if (opts.origin.isBlank()) {
            onReject("passkeyLogin requires origin")
            return
        }
        val base = opts.origin.trimEnd('/')
        post(networkBridge, "$base/auth/login/start", "{}", null, onResponse = { started ->
            if (started.status !in 200..299) {
                onReject("POST /auth/login/start failed with status ${started.status}")
                return@post
            }
            val start = try {
                json.decodeFromString<LoginStart>(started.body)
            } catch (t: Throwable) {
                onReject("Invalid POST /auth/login/start answer: ${t.message}")
                return@post
            }
            handler.passkeySignIn(
                options = PasskeySignInOptions(rpId = start.rpId, challenge = start.challenge),
                onSuccess = { assertion ->
                    val body = try {
                        // A native host renews by refresh token, having no cookie.
                        JsonObject(mapOf(
                            "state" to JsonPrimitive(start.state),
                            "response" to json.parseToJsonElement(assertion),
                            "refresh" to JsonPrimitive(true)
                        )).toString()
                    } catch (t: Throwable) {
                        onReject("Invalid passkey assertion: ${t.message}")
                        return@passkeySignIn
                    }
                    post(
                        networkBridge, "$base/auth/login/verify", body,
                        opts.guestBearerToken?.takeIf { it.isNotBlank() },
                        onResponse = { answer("/auth/login/verify", it, null, { r -> onResolve(json.encodeToString(r)) }, onReject) },
                        onReject = onReject
                    )
                },
                onFailure = { onReject(it.message ?: it.javaClass.simpleName) }
            )
        }, onReject = onReject)
    }

    fun passkeySignIn(
        optionsJson: String,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val handler = credentialHandler ?: run {
            onReject("AuthBridge.passkeySignIn requires a configured NativeCredentialHandler")
            return
        }
        val opts = try {
            json.decodeFromString<PasskeySignInOptions>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid passkeySignIn options: ${t.message}")
            return
        }
        if (opts.rpId.isBlank() || opts.challenge.isBlank()) {
            onReject("passkeySignIn requires non-empty rpId and challenge")
            return
        }
        handler.passkeySignIn(
            options = opts,
            onSuccess = onResolve,
            onFailure = { onReject(it.message ?: it.javaClass.simpleName) }
        )
    }

    fun passkeyRegister(
        optionsJson: String,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val handler = credentialHandler ?: run {
            onReject("AuthBridge.passkeyRegister requires a configured NativeCredentialHandler")
            return
        }
        val opts = try {
            json.decodeFromString<PasskeyRegisterOptions>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid passkeyRegister options: ${t.message}")
            return
        }
        if (opts.rpId.isBlank() || opts.challenge.isBlank() || opts.userId.isBlank()) {
            onReject("passkeyRegister requires non-empty rpId, challenge, and userId")
            return
        }
        handler.passkeyRegister(
            options = opts,
            onSuccess = onResolve,
            onFailure = { onReject(it.message ?: it.javaClass.simpleName) }
        )
    }

    fun oidcStart(
        provider: String,
        optionsJson: String?,
        networkBridge: NetworkBridge,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val handler = credentialHandler ?: run {
            onReject("AuthBridge.oidcStart requires a configured NativeCredentialHandler")
            return
        }
        if (provider.isBlank() || optionsJson.isNullOrBlank()) {
            onReject("oidcStart requires provider and optionsJson")
            return
        }
        val opts = try {
            json.decodeFromString<OidcStartOptions>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid oidcStart options: ${t.message}")
            return
        }
        if (opts.origin.isBlank()) {
            onReject("oidcStart requires non-empty origin")
            return
        }
        val verifier = opts.codeVerifier ?: generatePkceVerifier()
        val challenge = computePkceChallengeS256(verifier)
        val startUrl = buildNativeOidcStartUrl(opts.origin, provider, challenge, opts.guestBearerToken)

        handler.oidcStart(
            provider = provider,
            startUrl = startUrl,
            codeVerifier = verifier,
            options = opts,
            onSuccess = { ceremony ->
                if (ceremony.session != null) {
                    saveSession(ceremony.session)
                    onResolve(json.encodeToString(ceremony))
                } else {
                    // The host returns the callback's ticket; the bridge redeems it.
                    redeem(
                        RedeemTicketOptions(opts.origin, ceremony.ticket, ceremony.codeVerifier),
                        networkBridge,
                        { r -> onResolve(json.encodeToString(ceremony.copy(session = r.session, held = r.held))) },
                        onReject
                    )
                }
            },
            onFailure = { onReject(it.message ?: it.javaClass.simpleName) }
        )
    }

    fun loadSession(): AuthSession? {
        val raw = sessionStore.loadSessionJson() ?: return null
        if (raw.isBlank()) return null
        return json.decodeFromString<AuthSession>(raw)
    }

    fun loadSessionJson(): String? = sessionStore.loadSessionJson()

    fun saveSession(session: AuthSession) {
        require(session.token.isNotBlank()) { "AuthSession.token must not be blank" }
        require(session.userId.isNotBlank()) { "AuthSession.userId must not be blank" }
        sessionStore.saveSessionJson(json.encodeToString(session))
    }

    fun saveSessionJson(sessionJson: String) {
        val decoded = json.decodeFromString<AuthSession>(sessionJson)
        saveSession(decoded)
    }

    fun clearSession() {
        sessionStore.clearSession()
    }

    fun deleteAccount(
        optionsJson: String,
        networkBridge: NetworkBridge,
        storageBridge: StorageBridge? = null,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val opts = try {
            json.decodeFromString<DeleteAccountRequest>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid DeleteAccountRequest options: ${t.message}")
            return
        }
        val current = loadSession()
        val bearer = opts.bearerToken?.takeIf { it.isNotBlank() } ?: current?.token
        if (opts.origin.isBlank() || bearer.isNullOrBlank()) {
            onReject("deleteAccount requires origin and active session token")
            return
        }
        val cleanOrigin = opts.origin.trimEnd('/')
        val fetchOpts = buildJsonObject {
            put("method", "DELETE")
            put("headers", buildJsonObject {
                put("Authorization", "Bearer $bearer")
            })
        }.toString()

        networkBridge.nativeFetchAsync(
            url = "$cleanOrigin/auth/account",
            optionsJson = fetchOpts,
            onResolve = { rawResp ->
                val env = json.parseToJsonElement(rawResp).jsonObject
                val status = (env["status"] as? JsonPrimitive)?.intOrNull ?: 500
                if (status !in 200..299) {
                    onReject("DELETE /auth/account failed with status $status")
                    return@nativeFetchAsync
                }
                clearSession()
                val wiped = mutableListOf<String>()
                if (storageBridge != null) {
                    storageBridge.kvClear()
                    val tablesRaw = storageBridge.sqlQuery(
                        "SELECT name FROM sqlite_master WHERE type = 'table';",
                        null
                    )
                    val existing = json.parseToJsonElement(tablesRaw).jsonArray
                        .mapNotNull { (it.jsonObject["name"] as? JsonPrimitive)?.content }
                        .toSet()
                    if (existing.contains("mecha_outbox")) {
                        storageBridge.sqlExec("DELETE FROM mecha_outbox;", null)
                        wiped.add("mecha_outbox")
                    }
                    val deletedUid = current?.userId
                    if (existing.contains("mecha_shape_row")) {
                        if (!deletedUid.isNullOrBlank() && deletedUid != "anon") {
                            storageBridge.sqlExec(
                                "DELETE FROM mecha_shape_row WHERE subject = ?;",
                                buildJsonArray { add(JsonPrimitive(deletedUid)) }.toString()
                            )
                        } else {
                            storageBridge.sqlExec("DELETE FROM mecha_shape_row WHERE subject != '' AND subject != 'anon';", null)
                        }
                        wiped.add("mecha_shape_row")
                    }
                    if (existing.contains("mecha_shape_meta")) {
                        if (!deletedUid.isNullOrBlank() && deletedUid != "anon") {
                            storageBridge.sqlExec(
                                "DELETE FROM mecha_shape_meta WHERE subject = ?;",
                                buildJsonArray { add(JsonPrimitive(deletedUid)) }.toString()
                            )
                        } else {
                            storageBridge.sqlExec("DELETE FROM mecha_shape_meta WHERE subject != '' AND subject != 'anon';", null)
                        }
                        wiped.add("mecha_shape_meta")
                    }
                    if (existing.contains("__omnishell_kv")) {
                        storageBridge.sqlExec("DELETE FROM __omnishell_kv;", null)
                        wiped.add("__omnishell_kv")
                    }
                }
                onResolve(json.encodeToString(DeleteAccountResult(deleted = true, wipedTables = wiped)))
            },
            onReject = { err -> onReject(err) }
        )
    }
}
