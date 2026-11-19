package com.pronto.omnishell.bridge

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
    val session: AuthSession? = null
)

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
            codeChallenge: String
        ): String {
            val cleanOrigin = origin.trimEnd('/')
            val encProvider = URLEncoder.encode(provider, StandardCharsets.UTF_8)
            val encChallenge = URLEncoder.encode(codeChallenge, StandardCharsets.UTF_8)
            return "$cleanOrigin/auth/oidc/$encProvider/start?return=native&code_challenge=$encChallenge"
        }
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
        val startUrl = buildNativeOidcStartUrl(opts.origin, provider, challenge)

        handler.oidcStart(
            provider = provider,
            startUrl = startUrl,
            codeVerifier = verifier,
            options = opts,
            onSuccess = { ceremony ->
                if (ceremony.session != null) {
                    saveSession(ceremony.session)
                }
                onResolve(json.encodeToString(ceremony))
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
