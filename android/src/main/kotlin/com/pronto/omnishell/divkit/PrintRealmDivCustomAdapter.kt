package com.pronto.omnishell.divkit

import com.pronto.omnishell.bridge.PrintBridge
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * Upstream DivKit `DivCustomContainerViewAdapter` mounting scoped WebView realms
 * (`custom_type: "web-realm"` for `delivery-map` / `print-payment` and `"print-realm"`
 * for `/print` 300 DPI `artwork.ts` OffscreenCanvas + `@media print` sheet preview).
 */
class PrintRealmDivCustomAdapter(
    private val printBridge: PrintBridge? = null
) : DivCustomContainerViewAdapter {

    data class BoundRealmState(
        val id: String,
        val customType: String,
        val unit: String,
        val isolation: String,
        val grants: List<String>,
        val src: String?,
        val subdomain: String?,
        val deckId: String,
        val orderId: String,
        val locale: String,
        val direction: String,
        val theme: String,
        val origin: String,
        val dpi: Int,
        val allowsGeolocation: Boolean,
        val allows300DpiCanvas: Boolean,
        val allowsMediaPrint: Boolean,
        val props: Map<String, String>,
        val events: Map<String, String>,
        val printActionUrl: String?,
        val checkoutActionUrl: String?
    )

    val boundRealms = ConcurrentHashMap<String, BoundRealmState>()
    private val realmUnsubscribes = ConcurrentHashMap<String, () -> Unit>()

    override fun isCustomTypeSupported(type: String): Boolean =
        type == "web-realm" || type == "print-realm"

    private fun resolveMaybeVariable(raw: String?, variableController: DivVariableController): String {
        if (raw.isNullOrBlank()) return ""
        if (raw.startsWith("@{") && raw.endsWith("}")) {
            val varName = raw.removePrefix("@{").removeSuffix("}")
            return variableController.getString(varName, "")
        }
        return raw
    }

    private fun buildRealmState(
        spec: DivCustomMountSpec,
        variableController: DivVariableController
    ): BoundRealmState {
        val p = spec.customProps
        val unit = (p["unit"] as? JsonPrimitive)?.contentOrNull ?: spec.id
        val isolation = (p["isolation"] as? JsonPrimitive)?.contentOrNull ?: "realm"
        val grants = (p["grants"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?: emptyList()
        val src = (p["src"] as? JsonPrimitive)?.contentOrNull
        val subdomain = (p["subdomain"] as? JsonPrimitive)?.contentOrNull

        val rawDeck = (p["deck_id"] as? JsonPrimitive)?.contentOrNull
        val rawOrder = (p["order_id"] as? JsonPrimitive)?.contentOrNull
        val deckId = resolveMaybeVariable(rawDeck, variableController)
        val orderId = resolveMaybeVariable(rawOrder, variableController)

        val locale = (p["locale"] as? JsonPrimitive)?.contentOrNull ?: "pt"
        val direction = variableController.getString(
            "layout_direction",
            (p["direction"] as? JsonPrimitive)?.contentOrNull ?: "ltr"
        )
        val theme = variableController.getString(
            "resolved_theme",
            (p["theme"] as? JsonPrimitive)?.contentOrNull ?: "light"
        )
        val origin = (p["origin"] as? JsonPrimitive)?.contentOrNull ?: "https://snapcards.fun"

        val propsMap = LinkedHashMap<String, String>()
        (p["props"] as? JsonObject)?.forEach { (k, v) ->
            propsMap[k] = (v as? JsonPrimitive)?.contentOrNull ?: v.toString()
        }
        val eventsMap = LinkedHashMap<String, String>()
        (p["events"] as? JsonObject)?.forEach { (k, v) ->
            eventsMap[k] = (v as? JsonPrimitive)?.contentOrNull ?: v.toString()
        }

        val dpi = propsMap["dpi"]?.toIntOrNull()
            ?: (p["dpi"] as? JsonPrimitive)?.intOrNull
            ?: 300

        val printActionUrl = (p["print_action_url"] as? JsonPrimitive)?.contentOrNull
        val checkoutActionUrl = (p["checkout_action_url"] as? JsonPrimitive)?.contentOrNull

        return BoundRealmState(
            id = spec.id,
            customType = spec.customType,
            unit = unit,
            isolation = isolation,
            grants = grants,
            src = src,
            subdomain = subdomain,
            deckId = deckId,
            orderId = orderId,
            locale = locale,
            direction = direction,
            theme = theme,
            origin = origin,
            dpi = dpi,
            allowsGeolocation = grants.contains("geolocation"),
            allows300DpiCanvas = spec.customType == "print-realm" || grants.contains("canvas-300dpi"),
            allowsMediaPrint = spec.customType == "print-realm" || grants.contains("print"),
            props = propsMap,
            events = eventsMap,
            printActionUrl = printActionUrl,
            checkoutActionUrl = checkoutActionUrl
        )
    }

    override fun onBindCustomView(
        spec: DivCustomMountSpec,
        variableController: DivVariableController
    ) {
        if (!isCustomTypeSupported(spec.customType)) return
        realmUnsubscribes.remove(spec.id)?.invoke()

        boundRealms[spec.id] = buildRealmState(spec, variableController)

        val unsub = variableController.addListener { changedVar, _ ->
            if (
                changedVar == "active_deck_id" ||
                changedVar == "active_order_id" ||
                changedVar == "resolved_theme" ||
                changedVar == "layout_direction"
            ) {
                boundRealms[spec.id] = buildRealmState(spec, variableController)
            }
        }
        realmUnsubscribes[spec.id] = unsub
    }

    override fun onReleaseCustomView(spec: DivCustomMountSpec) {
        if (!isCustomTypeSupported(spec.customType)) return
        realmUnsubscribes.remove(spec.id)?.invoke()
        boundRealms.remove(spec.id)
    }

    fun requestGeolocationForRealm(
        realmId: String,
        originUrl: String,
        callback: (origin: String, allow: Boolean, retain: Boolean) -> Unit
    ) {
        val state = boundRealms[realmId]
        if (state == null || !state.allowsGeolocation) {
            callback(originUrl, false, false)
            return
        }
        val bridge = printBridge
        if (bridge == null) {
            callback(originUrl, true, false)
            return
        }
        bridge.delegateGeolocationPrompt(originUrl, state.unit, state.grants, callback)
    }

    fun triggerRealmPrint(realmId: String, onComplete: ((String) -> Unit)? = null) {
        val state = boundRealms[realmId] ?: return
        val url = state.printActionUrl
            ?.replace("@{active_deck_id}", state.deckId)
            ?: "omnishell://print?job=Snapcards&unit=${state.unit}&deck=${state.deckId}&dpi=${state.dpi}"
        printBridge?.handleActionUri(url, onComplete = onComplete)
    }
}
