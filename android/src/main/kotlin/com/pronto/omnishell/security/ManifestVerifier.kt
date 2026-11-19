package com.pronto.omnishell.security

import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

object ManifestVerifier {
    // RFC 8410 ASN.1 SubjectPublicKeyInfo prefix for a 32-byte raw Ed25519 public key.
    private val ED25519_X509_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    )

    private val ASSETS_SCRIPT_RE = Regex(
        """<script\b([^>]*\bid=["']pronto-assets["'][^>]*)>([\s\S]*?)</script>""",
        RegexOption.IGNORE_CASE
    )
    private val DATA_SIG_RE = Regex(
        """\bdata-signature=["']([^"']+)["']""",
        RegexOption.IGNORE_CASE
    )

    fun decodeBase64Flexible(raw: String): ByteArray {
        val normalized = raw.replace('-', '+').replace('_', '/')
        val padded = when (val rem = normalized.length % 4) {
            0 -> normalized
            else -> normalized + "=".repeat(4 - rem)
        }
        return Base64.getDecoder().decode(padded)
    }

    fun verifyEd25519(
        publicKeyRawOrX509: ByteArray,
        payload: ByteArray,
        signature: ByteArray
    ): Boolean {
        if (signature.size != 64) return false
        val x509Bytes = when (publicKeyRawOrX509.size) {
            32 -> ED25519_X509_PREFIX + publicKeyRawOrX509
            44 -> publicKeyRawOrX509
            else -> throw IllegalArgumentException("Expected 32-byte raw or 44-byte X.509 Ed25519 public key, got ${publicKeyRawOrX509.size} bytes")
        }
        val keyFactory = KeyFactory.getInstance("Ed25519")
        val pubKey = keyFactory.generatePublic(X509EncodedKeySpec(x509Bytes))
        val verifier = Signature.getInstance("Ed25519")
        verifier.initVerify(pubKey)
        verifier.update(payload)
        return verifier.verify(signature)
    }

    fun verifyEd25519Base64(
        publicKeyBase64: String,
        messageUtf8: String,
        signatureBase64: String
    ): Boolean {
        return try {
            val pubBytes = decodeBase64Flexible(publicKeyBase64)
            val sigBytes = decodeBase64Flexible(signatureBase64)
            verifyEd25519(pubBytes, messageUtf8.toByteArray(StandardCharsets.UTF_8), sigBytes)
        } catch (_: IllegalArgumentException) {
            false
        }
    }

    fun verifyEntryHtml(entryHtml: String, publicKeyBase64: String): String {
        val match = ASSETS_SCRIPT_RE.find(entryHtml)
            ?: throw SecurityException("Entry HTML is missing <script id=\"pronto-assets\">")
        val attrs = match.groupValues[1]
        val manifestJson = match.groupValues[2]

        val sigMatch = DATA_SIG_RE.find(attrs)
            ?: throw SecurityException("#pronto-assets is missing data-signature attribute")
        val sigBytes = decodeBase64Flexible(sigMatch.groupValues[1])
        val pubBytes = decodeBase64Flexible(publicKeyBase64)

        val valid = verifyEd25519(
            pubBytes,
            manifestJson.toByteArray(StandardCharsets.UTF_8),
            sigBytes
        )
        if (!valid) {
            throw SecurityException("Ed25519 signature verification failed for #pronto-assets")
        }
        return manifestJson
    }
}
