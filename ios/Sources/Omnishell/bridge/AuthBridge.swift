import Foundation
import CryptoKit
import Security
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif

public struct AuthSession: Codable, Equatable, Sendable {
    public let token: String
    public let refreshToken: String?
    public let userId: String
    public let handle: String?
    public let isGuest: Bool
    public let expiresAtEpochS: Int64?

    public init(
        token: String,
        refreshToken: String? = nil,
        userId: String,
        handle: String? = nil,
        isGuest: Bool,
        expiresAtEpochS: Int64? = nil
    ) {
        self.token = token
        self.refreshToken = refreshToken
        self.userId = userId
        self.handle = handle
        self.isGuest = isGuest
        self.expiresAtEpochS = expiresAtEpochS
    }
}

public struct PasskeySignInOptions: Codable, Sendable {
    public let rpId: String
    public let challenge: String
    public let timeoutMs: Int?

    public init(rpId: String, challenge: String, timeoutMs: Int? = nil) {
        self.rpId = rpId
        self.challenge = challenge
        self.timeoutMs = timeoutMs
    }
}

public struct PasskeyRegisterOptions: Codable, Sendable {
    public let rpId: String
    public let rpName: String
    public let challenge: String
    public let userId: String
    public let userName: String
    public let userDisplayName: String?
    public let promote: Bool?
    public let guestBearerToken: String?

    public init(
        rpId: String,
        rpName: String,
        challenge: String,
        userId: String,
        userName: String,
        userDisplayName: String? = nil,
        promote: Bool? = nil,
        guestBearerToken: String? = nil
    ) {
        self.rpId = rpId
        self.rpName = rpName
        self.challenge = challenge
        self.userId = userId
        self.userName = userName
        self.userDisplayName = userDisplayName
        self.promote = promote
        self.guestBearerToken = guestBearerToken
    }
}

public struct OidcStartOptions: Codable, Sendable {
    public let origin: String
    public let callbackScheme: String?
    public let guestBearerToken: String?
    public let codeVerifier: String?

    public init(
        origin: String,
        callbackScheme: String? = "snapcards",
        guestBearerToken: String? = nil,
        codeVerifier: String? = nil
    ) {
        self.origin = origin
        self.callbackScheme = callbackScheme
        self.guestBearerToken = guestBearerToken
        self.codeVerifier = codeVerifier
    }
}

public struct OidcCeremonyResult: Codable, Equatable, Sendable {
    public let ticket: String
    public let codeVerifier: String
    public let callbackUrl: String
    public let session: AuthSession?

    public init(
        ticket: String,
        codeVerifier: String,
        callbackUrl: String,
        session: AuthSession? = nil
    ) {
        self.ticket = ticket
        self.codeVerifier = codeVerifier
        self.callbackUrl = callbackUrl
        self.session = session
    }
}

public struct AppleSignInOptions: Codable, Equatable, Sendable {
    public let origin: String
    public let nonce: String?
    public let requestedScopes: [String]?
    public let guestBearerToken: String?

    public init(
        origin: String,
        nonce: String? = nil,
        requestedScopes: [String]? = ["fullName", "email"],
        guestBearerToken: String? = nil
    ) {
        self.origin = origin
        self.nonce = nonce
        self.requestedScopes = requestedScopes
        self.guestBearerToken = guestBearerToken
    }
}

public struct AppleSignInResult: Codable, Equatable, Sendable {
    public let identityToken: String
    public let authorizationCode: String
    public let userIdentifier: String
    public let fullName: String?
    public let email: String?
    public let session: AuthSession?

    public init(
        identityToken: String,
        authorizationCode: String,
        userIdentifier: String,
        fullName: String? = nil,
        email: String? = nil,
        session: AuthSession? = nil
    ) {
        self.identityToken = identityToken
        self.authorizationCode = authorizationCode
        self.userIdentifier = userIdentifier
        self.fullName = fullName
        self.email = email
        self.session = session
    }
}

public struct DeleteAccountRequest: Codable, Equatable, Sendable {
    public let origin: String
    public let bearerToken: String?

    public init(origin: String, bearerToken: String? = nil) {
        self.origin = origin
        self.bearerToken = bearerToken
    }
}

public struct DeleteAccountResult: Codable, Equatable, Sendable {
    public let deleted: Bool
    public let wipedTables: [String]

    public init(deleted: Bool, wipedTables: [String]) {
        self.deleted = deleted
        self.wipedTables = wipedTables
    }
}

public protocol SecureSessionStore: Sendable {
    func loadSessionJson() -> String?
    func saveSessionJson(_ json: String)
    func clearSession()
}

public final class KeyValueSessionStore: SecureSessionStore, @unchecked Sendable {
    private static let sessionKey = "omnishell_auth_session_v1"
    private let storageBridge: StorageBridge

    public init(storageBridge: StorageBridge) {
        self.storageBridge = storageBridge
    }

    public func loadSessionJson() -> String? {
        return storageBridge.kvGet(key: Self.sessionKey)
    }

    public func saveSessionJson(_ json: String) {
        storageBridge.kvSet(key: Self.sessionKey, value: json)
    }

    public func clearSession() {
        _ = storageBridge.kvDelete(key: Self.sessionKey)
    }
}

public final class KeychainSessionStore: SecureSessionStore, Sendable {
    private let service: String
    private let account: String

    public init(service: String = "com.pronto.omnishell", account: String = "auth_session_v1") {
        self.service = service
        self.account = account
    }

    public func loadSessionJson() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public func saveSessionJson(_ json: String) {
        let data = Data(json.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        precondition(status == errSecSuccess, "Keychain SecItemAdd failed with OSStatus \(status)")
    }

    public func clearSession() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        precondition(status == errSecSuccess || status == errSecItemNotFound, "Keychain SecItemDelete failed with OSStatus \(status)")
    }
}

public protocol NativeCredentialHandler: Sendable {
    func passkeySignIn(
        options: PasskeySignInOptions,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    )
    func passkeyRegister(
        options: PasskeyRegisterOptions,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    )
    func oidcStart(
        provider: String,
        startUrl: URL,
        codeVerifier: String,
        options: OidcStartOptions,
        completion: @escaping @Sendable (Result<OidcCeremonyResult, Error>) -> Void
    )
    func appleSignIn(
        options: AppleSignInOptions,
        completion: @escaping @Sendable (Result<AppleSignInResult, Error>) -> Void
    )
}

public extension NativeCredentialHandler {
    func appleSignIn(
        options: AppleSignInOptions,
        completion: @escaping @Sendable (Result<AppleSignInResult, Error>) -> Void
    ) {
        completion(.failure(AuthBridgeError.missingCredentialHandler("appleSignIn")))
    }
}

#if canImport(AuthenticationServices)
@available(macOS 10.15, iOS 13.0, *)
public enum AppleIDAuthorizationBuilder {
    public static func makeRequest(options: AppleSignInOptions) -> ASAuthorizationAppleIDRequest {
        let provider = ASAuthorizationAppleIDProvider()
        let req = provider.createRequest()
        let rawScopes = options.requestedScopes ?? ["fullName", "email"]
        var scopes: [ASAuthorization.Scope] = []
        if rawScopes.contains("fullName") { scopes.append(.fullName) }
        if rawScopes.contains("email") { scopes.append(.email) }
        req.requestedScopes = scopes
        if let nonce = options.nonce, !nonce.isEmpty {
            let digest = SHA256.hash(data: Data(nonce.utf8))
            req.nonce = digest.map { String(format: "%02x", $0) }.joined()
        }
        return req
    }
}
#endif

public enum AuthBridgeError: Error, LocalizedError {
    case missingCredentialHandler(String)
    case invalidPayload(String)

    public var errorDescription: String? {
        switch self {
        case .missingCredentialHandler(let op):
            return "AuthBridge.\(op) requires a configured NativeCredentialHandler"
        case .invalidPayload(let detail):
            return "Invalid AuthBridge payload: \(detail)"
        }
    }
}

public final class AuthBridge: @unchecked Sendable {
    private let sessionStore: SecureSessionStore
    private let credentialHandler: NativeCredentialHandler?
    private let jsonDecoder = JSONDecoder()
    private let jsonEncoder = JSONEncoder()

    public init(
        sessionStore: SecureSessionStore,
        credentialHandler: NativeCredentialHandler? = nil
    ) {
        self.sessionStore = sessionStore
        self.credentialHandler = credentialHandler
    }

    public static func base64UrlEncode(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func generatePkceVerifier(byteCount: Int = 32) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        for i in 0..<byteCount {
            bytes[i] = UInt8.random(in: 0...255)
        }
        return base64UrlEncode(Data(bytes))
    }

    public static func computePkceChallengeS256(_ verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64UrlEncode(Data(digest))
    }

    public static func buildNativeOidcStartUrl(
        origin: String,
        provider: String,
        codeChallenge: String
    ) throws -> URL {
        let cleanOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let encodedProvider = provider.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? provider
        var comps = URLComponents(string: "\(cleanOrigin)/auth/oidc/\(encodedProvider)/start")
        comps?.queryItems = [
            URLQueryItem(name: "return", value: "native"),
            URLQueryItem(name: "code_challenge", value: codeChallenge)
        ]
        guard let url = comps?.url else {
            throw AuthBridgeError.invalidPayload("Malformed OIDC start origin '\(origin)'")
        }
        return url
    }

    public func passkeySignIn(
        optionsJson: String,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let handler = credentialHandler else {
            onReject(AuthBridgeError.missingCredentialHandler("passkeySignIn").localizedDescription)
            return
        }
        guard let data = optionsJson.data(using: .utf8),
              let opts = try? jsonDecoder.decode(PasskeySignInOptions.self, from: data),
              !opts.rpId.isEmpty, !opts.challenge.isEmpty else {
            onReject(AuthBridgeError.invalidPayload("passkeySignIn requires rpId and challenge").localizedDescription)
            return
        }
        handler.passkeySignIn(options: opts) { result in
            switch result {
            case .success(let assertionJson):
                onResolve(assertionJson)
            case .failure(let error):
                onReject(error.localizedDescription)
            }
        }
    }

    public func passkeyRegister(
        optionsJson: String,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let handler = credentialHandler else {
            onReject(AuthBridgeError.missingCredentialHandler("passkeyRegister").localizedDescription)
            return
        }
        guard let data = optionsJson.data(using: .utf8),
              let opts = try? jsonDecoder.decode(PasskeyRegisterOptions.self, from: data),
              !opts.rpId.isEmpty, !opts.challenge.isEmpty, !opts.userId.isEmpty else {
            onReject(AuthBridgeError.invalidPayload("passkeyRegister requires rpId, challenge, and userId").localizedDescription)
            return
        }
        handler.passkeyRegister(options: opts) { result in
            switch result {
            case .success(let attestationJson):
                onResolve(attestationJson)
            case .failure(let error):
                onReject(error.localizedDescription)
            }
        }
    }

    public func oidcStart(
        provider: String,
        optionsJson: String?,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let handler = credentialHandler else {
            onReject(AuthBridgeError.missingCredentialHandler("oidcStart").localizedDescription)
            return
        }
        guard !provider.isEmpty,
              let jsonStr = optionsJson,
              let data = jsonStr.data(using: .utf8),
              let opts = try? jsonDecoder.decode(OidcStartOptions.self, from: data),
              !opts.origin.isEmpty else {
            onReject(AuthBridgeError.invalidPayload("oidcStart requires provider and origin").localizedDescription)
            return
        }

        let verifier = opts.codeVerifier ?? Self.generatePkceVerifier()
        let challenge = Self.computePkceChallengeS256(verifier)
        let startUrl: URL
        do {
            startUrl = try Self.buildNativeOidcStartUrl(
                origin: opts.origin,
                provider: provider,
                codeChallenge: challenge
            )
        } catch {
            onReject(error.localizedDescription)
            return
        }

        handler.oidcStart(
            provider: provider,
            startUrl: startUrl,
            codeVerifier: verifier,
            options: opts
        ) { [weak self, jsonEncoder] result in
            switch result {
            case .success(let ceremony):
                if let session = ceremony.session, let self = self {
                    try? self.saveSession(session)
                }
                do {
                    let encoded = try jsonEncoder.encode(ceremony)
                    onResolve(String(data: encoded, encoding: .utf8) ?? "{}")
                } catch {
                    onReject(error.localizedDescription)
                }
            case .failure(let error):
                onReject(error.localizedDescription)
            }
        }
    }

    public func loadSession() throws -> AuthSession? {
        guard let raw = sessionStore.loadSessionJson(), !raw.isEmpty else {
            return nil
        }
        guard let data = raw.data(using: .utf8) else {
            throw AuthBridgeError.invalidPayload("Stored session is not valid UTF-8")
        }
        return try jsonDecoder.decode(AuthSession.self, from: data)
    }

    public func loadSessionJson() -> String? {
        return sessionStore.loadSessionJson()
    }

    public func saveSession(_ session: AuthSession) throws {
        guard !session.token.isEmpty, !session.userId.isEmpty else {
            throw AuthBridgeError.invalidPayload("AuthSession token and userId must be non-empty")
        }
        let data = try jsonEncoder.encode(session)
        guard let str = String(data: data, encoding: .utf8) else {
            throw AuthBridgeError.invalidPayload("Failed to serialize AuthSession")
        }
        sessionStore.saveSessionJson(str)
    }

    public func saveSessionJson(_ sessionJson: String) throws {
        guard let data = sessionJson.data(using: .utf8) else {
            throw AuthBridgeError.invalidPayload("Session JSON is not valid UTF-8")
        }
        let decoded = try jsonDecoder.decode(AuthSession.self, from: data)
        try saveSession(decoded)
    }

    public func clearSession() {
        sessionStore.clearSession()
    }

    public func signInWithApple(
        optionsJson: String,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let handler = credentialHandler else {
            onReject(AuthBridgeError.missingCredentialHandler("signInWithApple").localizedDescription)
            return
        }
        guard let data = optionsJson.data(using: .utf8),
              let opts = try? jsonDecoder.decode(AppleSignInOptions.self, from: data),
              !opts.origin.isEmpty else {
            onReject(AuthBridgeError.invalidPayload("signInWithApple requires origin").localizedDescription)
            return
        }
        handler.appleSignIn(options: opts) { [weak self, jsonEncoder] result in
            switch result {
            case .success(let appleRes):
                if let session = appleRes.session, let self = self {
                    try? self.saveSession(session)
                }
                if let encoded = try? jsonEncoder.encode(appleRes),
                   let str = String(data: encoded, encoding: .utf8) {
                    onResolve(str)
                } else {
                    onReject("Failed to serialize AppleSignInResult")
                }
            case .failure(let error):
                if case AuthBridgeError.missingCredentialHandler = error, let self = self {
                    let oidcPayload = OidcStartOptions(
                        origin: opts.origin,
                        guestBearerToken: opts.guestBearerToken
                    )
                    if let oidcData = try? jsonEncoder.encode(oidcPayload),
                       let oidcStr = String(data: oidcData, encoding: .utf8) {
                        self.oidcStart(
                            provider: "apple",
                            optionsJson: oidcStr,
                            onResolve: onResolve,
                            onReject: onReject
                        )
                        return
                    }
                }
                onReject(error.localizedDescription)
            }
        }
    }

    public func deleteAccount(
        optionsJson: String,
        networkBridge: NetworkBridge,
        storageBridge: StorageBridge? = nil,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let data = optionsJson.data(using: .utf8),
              let opts = try? jsonDecoder.decode(DeleteAccountRequest.self, from: data),
              !opts.origin.isEmpty else {
            onReject(AuthBridgeError.invalidPayload("deleteAccount requires origin").localizedDescription)
            return
        }
        let current = try? loadSession()
        let bearer = (opts.bearerToken?.isEmpty == false ? opts.bearerToken : nil) ?? current?.token
        guard let activeBearer = bearer, !activeBearer.isEmpty else {
            onReject(AuthBridgeError.invalidPayload("deleteAccount requires an active session token").localizedDescription)
            return
        }
        let cleanOrigin = opts.origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let fetchOptsData = try? JSONSerialization.data(withJSONObject: [
            "method": "DELETE",
            "headers": ["Authorization": "Bearer \(activeBearer)"]
        ])
        let fetchOptsStr = fetchOptsData.flatMap { String(data: $0, encoding: .utf8) }

        networkBridge.nativeFetchAsync(
            url: "\(cleanOrigin)/auth/account",
            optionsJson: fetchOptsStr,
            onResolve: { [weak self, jsonEncoder] rawResp in
                guard let envData = rawResp.data(using: .utf8),
                      let env = try? JSONSerialization.jsonObject(with: envData) as? [String: Any],
                      let status = (env["status"] as? NSNumber)?.intValue,
                      (200...299).contains(status) else {
                    onReject("DELETE /auth/account failed")
                    return
                }
                self?.clearSession()
                var wiped: [String] = []
                if let sb = storageBridge {
                    sb.kvClear()
                    let tablesRaw = sb.sqlQuery(
                        sql: "SELECT name FROM sqlite_master WHERE type = 'table';",
                        paramsJson: nil
                    )
                    var existing = Set<String>()
                    if let tData = tablesRaw.data(using: .utf8),
                       let arr = try? JSONSerialization.jsonObject(with: tData) as? [[String: Any]] {
                        for item in arr {
                            if let n = item["name"] as? String {
                                existing.insert(n)
                            }
                        }
                    }
                    if existing.contains("mecha_outbox") {
                        _ = sb.sqlExec(sql: "DELETE FROM mecha_outbox;", paramsJson: nil)
                        wiped.append("mecha_outbox")
                    }
                    let subjectParams: String? = {
                        guard let uid = current?.userId, !uid.isEmpty, uid != "anon",
                              let d = try? JSONSerialization.data(withJSONObject: [uid]) else {
                            return nil
                        }
                        return String(data: d, encoding: .utf8)
                    }()
                    if existing.contains("mecha_shape_row") {
                        if let sp = subjectParams {
                            _ = sb.sqlExec(sql: "DELETE FROM mecha_shape_row WHERE subject = ?;", paramsJson: sp)
                        } else {
                            _ = sb.sqlExec(sql: "DELETE FROM mecha_shape_row WHERE subject != '' AND subject != 'anon';", paramsJson: nil)
                        }
                        wiped.append("mecha_shape_row")
                    }
                    if existing.contains("mecha_shape_meta") {
                        if let sp = subjectParams {
                            _ = sb.sqlExec(sql: "DELETE FROM mecha_shape_meta WHERE subject = ?;", paramsJson: sp)
                        } else {
                            _ = sb.sqlExec(sql: "DELETE FROM mecha_shape_meta WHERE subject != '' AND subject != 'anon';", paramsJson: nil)
                        }
                        wiped.append("mecha_shape_meta")
                    }
                    if existing.contains("__omnishell_kv") {
                        _ = sb.sqlExec(sql: "DELETE FROM __omnishell_kv;", paramsJson: nil)
                        wiped.append("__omnishell_kv")
                    }
                }
                let res = DeleteAccountResult(deleted: true, wipedTables: wiped)
                if let encoded = try? jsonEncoder.encode(res),
                   let str = String(data: encoded, encoding: .utf8) {
                    onResolve(str)
                } else {
                    onResolve("{\"deleted\":true,\"wipedTables\":[]}")
                }
            },
            onReject: { errMsg in
                onReject(errMsg)
            }
        )
    }
}
