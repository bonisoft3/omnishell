import Foundation
import CryptoKit

public enum ManifestVerificationError: Error, LocalizedError, Equatable {
    case missingAssetsScript
    case missingSignature
    case invalidPublicKey
    case invalidSignatureEncoding
    case signatureMismatch

    public var errorDescription: String? {
        switch self {
        case .missingAssetsScript:
            return "Entry HTML is missing <script id=\"pronto-assets\">"
        case .missingSignature:
            return "#pronto-assets is missing data-signature attribute"
        case .invalidPublicKey:
            return "Invalid Ed25519 public key"
        case .invalidSignatureEncoding:
            return "Invalid base64 Ed25519 signature"
        case .signatureMismatch:
            return "Ed25519 signature verification failed for #pronto-assets"
        }
    }
}

public enum ManifestVerifier {
    public static func decodeBase64Flexible(_ raw: String) -> Data? {
        var normalized = raw
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = normalized.count % 4
        if rem > 0 {
            normalized += String(repeating: "=", count: 4 - rem)
        }
        return Data(base64Encoded: normalized)
    }

    public static func verifyEd25519(
        publicKeyRaw: Data,
        payload: Data,
        signature: Data
    ) throws -> Bool {
        guard signature.count == 64 else { return false }
        let pubKey: Curve25519.Signing.PublicKey
        do {
            pubKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyRaw)
        } catch {
            throw ManifestVerificationError.invalidPublicKey
        }
        return pubKey.isValidSignature(signature, for: payload)
    }

    public static func verifyEd25519Base64(
        publicKeyBase64: String,
        messageUtf8: String,
        signatureBase64: String
    ) -> Bool {
        guard let pubData = decodeBase64Flexible(publicKeyBase64),
              let sigData = decodeBase64Flexible(signatureBase64),
              let valid = try? verifyEd25519(
                  publicKeyRaw: pubData,
                  payload: Data(messageUtf8.utf8),
                  signature: sigData
              ) else {
            return false
        }
        return valid
    }

    public static func verifyEntryHtml(
        entryHtml: String,
        publicKeyBase64: String
    ) throws -> String {
        guard let pubData = decodeBase64Flexible(publicKeyBase64) else {
            throw ManifestVerificationError.invalidPublicKey
        }
        let pattern = #"<script\b([^>]*\bid=["']pronto-assets["'][^>]*)>([\s\S]*?)<\/script>"#
        let regex = try NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
        let nsRange = NSRange(entryHtml.startIndex..<entryHtml.endIndex, in: entryHtml)
        guard let match = regex.firstMatch(in: entryHtml, options: [], range: nsRange),
              let attrRange = Range(match.range(at: 1), in: entryHtml),
              let bodyRange = Range(match.range(at: 2), in: entryHtml) else {
            throw ManifestVerificationError.missingAssetsScript
        }
        let attrs = String(entryHtml[attrRange])
        let manifestJson = String(entryHtml[bodyRange])

        let sigPattern = #"\bdata-signature=["']([^"']+)["']"#
        let sigRegex = try NSRegularExpression(pattern: sigPattern, options: [.caseInsensitive])
        let attrNsRange = NSRange(attrs.startIndex..<attrs.endIndex, in: attrs)
        guard let sigMatch = sigRegex.firstMatch(in: attrs, options: [], range: attrNsRange),
              let sigValRange = Range(sigMatch.range(at: 1), in: attrs) else {
            throw ManifestVerificationError.missingSignature
        }
        guard let sigData = decodeBase64Flexible(String(attrs[sigValRange])) else {
            throw ManifestVerificationError.invalidSignatureEncoding
        }

        let isValid = try verifyEd25519(
            publicKeyRaw: pubData,
            payload: Data(manifestJson.utf8),
            signature: sigData
        )
        if !isValid {
            throw ManifestVerificationError.signatureMismatch
        }
        return manifestJson
    }
}
