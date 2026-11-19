package com.pronto.omnishell.bridge

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

@Serializable
data class PrintJobRequest(
    val jobName: String = "Snapcards",
    val source: String = "window-print",
    val format: String = "sheet",
    val deckId: String = "",
    val vendor: String = "print_at_home",
    val paper: String = "a4",
    val orientation: String = "portrait",
    val cardSize: String = "standard",
    val layout: String = "fold",
    val cutLines: String = "yes",
    val dpi: Int = 300,
    val htmlContent: String? = null,
    val pdfBase64: String? = null
)

@Serializable
data class PrintJobResult(
    val jobId: String,
    val jobName: String,
    val adapterType: String,
    val dpi: Int,
    val accepted: Boolean
)

@Serializable
data class CheckoutTabRequest(
    val orderId: String,
    val deckId: String = "",
    val checkoutUrl: String,
    val returnUrl: String = "snapcards://print/return?order=$orderId"
)

@Serializable
data class CheckoutReturnResult(
    val orderId: String,
    val outcome: String,
    val callbackUrl: String
)

@Serializable
data class PrintReturnDeepLink(
    val orderId: String,
    val outcome: String? = null
)

interface NativePrintHandler {
    /**
     * Delegates to Android `PrintManager.print(jobName, webView.createPrintDocumentAdapter("Snapcards"), attributes)`
     * or streams raw 300 DPI PDF bytes (`PrintDocumentAdapter.PdfBytes`).
     */
    fun printDocument(
        request: PrintJobRequest,
        onSuccess: (PrintJobResult) -> Unit,
        onFailure: (Throwable) -> Unit
    )

    /**
     * Launches Stripe Checkout inside Chrome Custom Tabs (`CustomTabsIntent`),
     * returning to `snapcards://print/return?order=<id>` (or Universal/App Link `/print?order=<id>`).
     */
    fun openCheckoutCustomTab(
        request: CheckoutTabRequest,
        onSuccess: (CheckoutReturnResult) -> Unit,
        onFailure: (Throwable) -> Unit
    )

    /**
     * Mirrors `WebChromeClient.onGeolocationPermissionsShowPrompt(origin, callback)`:
     * invoked only when the realm declares `"geolocation"` in its Pronto unit grants.
     */
    fun requestGeolocationPermission(
        origin: String,
        unit: String,
        callback: (allow: Boolean, retain: Boolean) -> Unit
    ) {
        callback(true, false)
    }
}

class PrintBridge(
    private val handler: NativePrintHandler? = null,
    private val networkBridge: NetworkBridge? = null,
    val origin: String = "https://snapcards.fun",
    private val json: Json = Json { ignoreUnknownKeys = true }
) {
    companion object {
        fun parseQueryParams(rawQuery: String?): Map<String, String> {
            if (rawQuery.isNullOrBlank()) return emptyMap()
            val out = LinkedHashMap<String, String>()
            for (pair in rawQuery.split("&")) {
                if (pair.isBlank()) continue
                val eq = pair.indexOf('=')
                if (eq == -1) continue
                val key = URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8)
                val value = URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8)
                out[key] = value
            }
            return out
        }

        fun parsePrintReturnDeepLink(rawUrl: String): PrintReturnDeepLink? {
            val uri = try {
                URI(rawUrl)
            } catch (_: Throwable) {
                return null
            }
            val query = parseQueryParams(uri.rawQuery)
            val orderId = query["order"]?.trim().orEmpty()
            if (orderId.isEmpty()) return null
            val outcome = query["checkout"]?.takeIf { it.isNotBlank() }

            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme == "snapcards") {
                val route = "${uri.host.orEmpty()}${uri.path.orEmpty()}".trim('/')
                if (route == "print/return" || route == "print") {
                    return PrintReturnDeepLink(orderId = orderId, outcome = outcome)
                }
                return null
            }
            if (scheme == "https" || scheme == "http") {
                val segments = uri.path.orEmpty().split("/").filter { it.isNotBlank() }
                if (segments.lastOrNull() == "print") {
                    return PrintReturnDeepLink(orderId = orderId, outcome = outcome)
                }
            }
            return null
        }

        fun buildPrintReturnUri(orderId: String): String {
            val enc = URLEncoder.encode(orderId, StandardCharsets.UTF_8)
            return "snapcards://print/return?order=$enc"
        }
    }

    fun delegateGeolocationPrompt(
        originUrl: String,
        unit: String,
        grants: List<String>,
        callback: (origin: String, allow: Boolean, retain: Boolean) -> Unit
    ) {
        if (!grants.contains("geolocation")) {
            callback(originUrl, false, false)
            return
        }
        val h = handler
        if (h == null) {
            callback(originUrl, true, false)
            return
        }
        h.requestGeolocationPermission(originUrl, unit) { allow, retain ->
            callback(originUrl, allow, retain)
        }
    }

    fun printSheet(
        optionsJson: String,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val h = handler ?: run {
            onReject("PrintBridge.printSheet requires a configured NativePrintHandler")
            return
        }
        val req = try {
            json.decodeFromString<PrintJobRequest>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid PrintJobRequest JSON: ${t.message}")
            return
        }
        h.printDocument(
            request = req,
            onSuccess = { result -> onResolve(json.encodeToString(result)) },
            onFailure = { err -> onReject(err.message ?: err.javaClass.simpleName) }
        )
    }

    fun openCheckout(
        optionsJson: String,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val h = handler ?: run {
            onReject("PrintBridge.openCheckout requires a configured NativePrintHandler")
            return
        }
        val req = try {
            json.decodeFromString<CheckoutTabRequest>(optionsJson)
        } catch (t: Throwable) {
            onReject("Invalid CheckoutTabRequest JSON: ${t.message}")
            return
        }
        if (req.orderId.isBlank() || req.checkoutUrl.isBlank()) {
            onReject("openCheckout requires non-empty orderId and checkoutUrl")
            return
        }
        val normalized = if (req.returnUrl.isBlank()) {
            req.copy(returnUrl = buildPrintReturnUri(req.orderId))
        } else {
            req
        }
        h.openCheckoutCustomTab(
            request = normalized,
            onSuccess = { outcome -> onResolve(json.encodeToString(outcome)) },
            onFailure = { err -> onReject(err.message ?: err.javaClass.simpleName) }
        )
    }

    fun handleActionUri(
        actionUri: String,
        onComplete: ((String) -> Unit)? = null,
        onError: ((String) -> Unit)? = null
    ): Boolean {
        if (actionUri.startsWith("omnishell://print")) {
            val query = parseQueryParams(URI(actionUri).rawQuery)
            val req = PrintJobRequest(
                jobName = query["job"]?.takeIf { it.isNotBlank() } ?: "Snapcards",
                source = query["source"] ?: "window-print",
                format = query["format"] ?: "sheet",
                deckId = query["deck"] ?: "",
                vendor = query["vendor"] ?: "print_at_home",
                paper = query["paper"] ?: "a4",
                orientation = query["orientation"] ?: "portrait",
                cardSize = query["card_size"] ?: "standard",
                layout = query["layout"] ?: "fold",
                cutLines = query["cut_lines"] ?: "yes",
                dpi = query["dpi"]?.toIntOrNull() ?: 300
            )
            val h = handler ?: return true
            h.printDocument(
                request = req,
                onSuccess = { res -> onComplete?.invoke(json.encodeToString(res)) },
                onFailure = { err -> onError?.invoke(err.message ?: err.javaClass.simpleName) }
            )
            return true
        }
        if (actionUri.startsWith("omnishell://checkout")) {
            val query = parseQueryParams(URI(actionUri).rawQuery)
            val orderId = query["order"].orEmpty()
            val checkoutUrl = query["checkout_url"].orEmpty()
            val deckId = query["deck"].orEmpty()
            val returnUrl = query["return_url"]?.takeIf { it.isNotBlank() }
                ?: if (orderId.isNotBlank()) buildPrintReturnUri(orderId) else "snapcards://print/return"
            val h = handler ?: return true
            if (orderId.isNotBlank() && checkoutUrl.isNotBlank()) {
                h.openCheckoutCustomTab(
                    request = CheckoutTabRequest(
                        orderId = orderId,
                        deckId = deckId,
                        checkoutUrl = checkoutUrl,
                        returnUrl = returnUrl
                    ),
                    onSuccess = { res -> onComplete?.invoke(json.encodeToString(res)) },
                    onFailure = { err -> onError?.invoke(err.message ?: err.javaClass.simpleName) }
                )
            }
            return true
        }
        return false
    }

    /**
     * Handles `snapcards://print/return?order=<id>` and `https://snapcards.fun/print?order=<id>`,
     * running the `PrintOrder` `recheck` transition (`awaiting_payment` -> `checking`, `checks + 1`)
     * when `networkBridge` is attached.
     */
    fun handlePrintReturnDeepLink(
        deepLinkUrl: String,
        bearerToken: String? = null
    ): Pair<PrintReturnDeepLink, JsonObject?>? {
        val parsed = parsePrintReturnDeepLink(deepLinkUrl) ?: return null
        val net = networkBridge ?: return parsed to null

        val cleanOrigin = origin.trimEnd('/')
        val encId = URLEncoder.encode(parsed.orderId, StandardCharsets.UTF_8)
        val headersObj = buildJsonObject {
            put("content-type", "application/json")
            put("Prefer", "return=representation")
            if (!bearerToken.isNullOrBlank()) {
                put("Authorization", "Bearer $bearerToken")
            }
        }
        val getOpts = buildJsonObject {
            put("method", "GET")
            put("headers", headersObj)
        }.toString()

        val rawGet = net.nativeFetch("$cleanOrigin/crud/print_order?id=eq.$encId", getOpts)
        val getEnvelope = json.parseToJsonElement(rawGet).jsonObject
        val getStatus = (getEnvelope["status"] as? JsonPrimitive)?.intOrNull ?: 500
        if (getStatus !in 200..299) {
            throw IllegalStateException("print_order lookup failed ($getStatus)")
        }
        val bodyStr = (getEnvelope["body"] as? JsonPrimitive)?.contentOrNull ?: "[]"
        val rows = json.parseToJsonElement(bodyStr) as? JsonArray ?: JsonArray(emptyList())
        var row = rows.firstOrNull()?.jsonObject ?: return parsed to null

        val status = (row["status"] as? JsonPrimitive)?.contentOrNull
        if (status == "awaiting_payment") {
            val checks = ((row["checks"] as? JsonPrimitive)?.intOrNull ?: 0) + 1
            val patchBody = buildJsonObject {
                put("status", "checking")
                put("checks", checks)
            }.toString()
            val patchOpts = buildJsonObject {
                put("method", "PATCH")
                put("headers", headersObj)
                put("body", patchBody)
            }.toString()
            val rawPatch = net.nativeFetch("$cleanOrigin/crud/print_order?id=eq.$encId", patchOpts)
            val patchEnv = json.parseToJsonElement(rawPatch).jsonObject
            val patchStatus = (patchEnv["status"] as? JsonPrimitive)?.intOrNull ?: 500
            if (patchStatus !in 200..299) {
                throw IllegalStateException("print_order recheck PATCH failed ($patchStatus)")
            }
            val patchBodyStr = (patchEnv["body"] as? JsonPrimitive)?.contentOrNull ?: "[]"
            val patchedRows = json.parseToJsonElement(patchBodyStr) as? JsonArray
            patchedRows?.firstOrNull()?.jsonObject?.let { row = it }
        }
        return parsed to row
    }
}
