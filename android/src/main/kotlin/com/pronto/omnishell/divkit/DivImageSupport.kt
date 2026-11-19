package com.pronto.omnishell.divkit

import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Base64

object DivImageSupport {
    const val BLANK_SVG_DATA_URI =
        "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E"

    fun resolveImageUrl(rawSrc: String, origin: String = "https://snapcards.fun"): String {
        val trimmed = rawSrc.trim()
        if (trimmed.isEmpty()) return BLANK_SVG_DATA_URI
        if (trimmed.startsWith("data:") || trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
            return trimmed
        }
        val cleanOrigin = origin.trimEnd('/')
        return if (trimmed.startsWith("/")) "$cleanOrigin$trimmed" else "$cleanOrigin/$trimmed"
    }

    fun decodeSvgDataUri(uri: String): ByteArray? {
        return when {
            uri.startsWith("data:image/svg+xml;base64,") -> {
                val b64 = uri.removePrefix("data:image/svg+xml;base64,")
                Base64.getDecoder().decode(b64)
            }
            uri.startsWith("data:image/svg+xml;utf8,") -> {
                val encoded = uri.removePrefix("data:image/svg+xml;utf8,")
                val plusEscaped = encoded.replace("+", "%2B")
                URLDecoder.decode(plusEscaped, StandardCharsets.UTF_8).toByteArray(StandardCharsets.UTF_8)
            }
            uri.startsWith("data:image/svg+xml,") -> {
                val encoded = uri.removePrefix("data:image/svg+xml,")
                val plusEscaped = encoded.replace("+", "%2B")
                URLDecoder.decode(plusEscaped, StandardCharsets.UTF_8).toByteArray(StandardCharsets.UTF_8)
            }
            else -> null
        }
    }
}
