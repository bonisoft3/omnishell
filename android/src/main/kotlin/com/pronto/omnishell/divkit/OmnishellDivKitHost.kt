package com.pronto.omnishell.divkit

import com.pronto.omnishell.bridge.PrintBridge
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Upstream DivKit (`com.yandex.div:div`) variable controller bridge allowing
 * 60–120 Hz scalar updates (such as kinetic HUD telemetry, 3D card flips, and form input bindings)
 * to mutate bound `@{variable}` values in-place without re-parsing the card JSON AST.
 */
class DivVariableController {
    private val variables = ConcurrentHashMap<String, Any>()
    private val listeners = CopyOnWriteArrayList<(String, Any) -> Unit>()

    fun declare(name: String, initialValue: Any) {
        variables.putIfAbsent(name, initialValue)
    }

    fun setVariable(name: String, value: Any) {
        val prev = variables.put(name, value)
        if (prev != value) {
            for (listener in listeners) {
                listener(name, value)
            }
        }
    }

    fun setVariables(batch: Map<String, Any>) {
        for ((k, v) in batch) {
            setVariable(k, v)
        }
    }

    fun getVariable(name: String): Any? = variables[name]

    fun getString(name: String, default: String = ""): String =
        variables[name]?.toString() ?: default

    fun snapshot(): Map<String, Any> = HashMap(variables)

    val listenerCount: Int get() = listeners.size

    fun addListener(listener: (String, Any) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    fun removeListener(listener: (String, Any) -> Unit) {
        listeners.remove(listener)
    }
}

/**
 * Descriptor for a `div-custom` mount (`"flip-card"`, `"kinetic:<actor>"`, or `"kinetic-layer:<layer>"`).
 */
data class DivCustomMountSpec(
    val id: String,
    val customType: String,
    val customProps: JsonObject,
    val items: List<JsonObject> = emptyList()
)

/**
 * Descriptor for a `div-state` block (`[popover]` and `<dialog>` sheets).
 */
data class DivStateBlockSpec(
    val id: String,
    val defaultStateId: String,
    val stateIdVariable: String?,
    val stateIds: List<String>
)

/**
 * Adapter interface matching upstream `com.yandex.div.core.DivCustomContainerViewAdapter`
 * for mounting native views (`FlipCardDivCustomAdapter`, `FilamentKineticPresenter` `SurfaceView`,
 * and HUD layers) inside a DivKit card layout.
 */
interface DivCustomContainerViewAdapter {
    fun isCustomTypeSupported(type: String): Boolean
    fun onBindCustomView(spec: DivCustomMountSpec, variableController: DivVariableController)
    fun onReleaseCustomView(spec: DivCustomMountSpec)
}

/**
 * Shared Omnishell DivKit Host (`com.yandex.div:div` card lifecycle, `DivVariableController`,
 * `DivCustomContainerViewAdapter` registry, `div-state` blocks, and error boundary fallback).
 */
class OmnishellDivKitHost {
    var currentCardId: String = ""
        private set

    var lastRenderedAst: String = ""
        private set

    var hasError: Boolean = false
        private set

    /** Monotonically incremented only when the full card JSON AST is parsed. */
    var astParseCount: Int = 0
        private set

    var viewportWidthDp: Int = 390
        private set

    var themeMode: String = "auto"
        private set

    var layoutDirection: String = "ltr"
        private set

    val isRtl: Boolean
        get() = layoutDirection == "rtl"

    val formFactor: String
        get() = if (viewportWidthDp >= 768) "tablet" else "phone"

    var printBridge: PrintBridge? = null

    val variableController = DivVariableController()
    private val customAdapters = CopyOnWriteArrayList<DivCustomContainerViewAdapter>()
    private val activeCustomMounts = CopyOnWriteArrayList<DivCustomMountSpec>()
    private val activeStateBlocks = ConcurrentHashMap<String, DivStateBlockSpec>()
    private val explicitStateSelections = ConcurrentHashMap<String, String>()
    private val activePalette = ConcurrentHashMap<String, Pair<String, String>>()
    private var onActionCallback: ((String) -> Unit)? = null

    fun configureDisplay(
        viewportWidthDp: Int = this.viewportWidthDp,
        themeMode: String = this.themeMode,
        layoutDirection: String = this.layoutDirection
    ) {
        this.viewportWidthDp = viewportWidthDp
        this.themeMode = themeMode
        this.layoutDirection = layoutDirection
        variableController.setVariable("form_factor", formFactor)
        variableController.setVariable("theme_mode", themeMode)
        if (themeMode == "light" || themeMode == "dark") {
            variableController.setVariable("resolved_theme", themeMode)
        }
        variableController.setVariable("layout_direction", layoutDirection)
        for (adapter in customAdapters) {
            if (adapter is FlipCardDivCustomAdapter) {
                adapter.isRtl = isRtl
            }
        }
    }

    fun getPaletteColors(): Map<String, Pair<String, String>> = HashMap(activePalette)

    fun registerCustomAdapter(adapter: DivCustomContainerViewAdapter) {
        customAdapters.add(adapter)
    }

    fun getActiveCustomMounts(): List<DivCustomMountSpec> = ArrayList(activeCustomMounts)

    fun getStateBlocks(): List<DivStateBlockSpec> = ArrayList(activeStateBlocks.values)

    fun currentStateId(blockId: String): String? {
        explicitStateSelections[blockId]?.let { return it }
        val spec = activeStateBlocks[blockId] ?: return null
        if (spec.stateIdVariable != null) {
            return variableController.getString(spec.stateIdVariable, spec.defaultStateId)
        }
        return spec.defaultStateId
    }

    fun dispatchActionUri(actionUri: String) {
        if (actionUri.startsWith("div-action://set_variable?")) {
            val query = parseQueryParams(URI(actionUri).rawQuery ?: "")
            val name = query["name"]
            val value = query["value"]
            if (name != null && value != null) {
                variableController.setVariable(name, value)
            }
            return
        }
        if (actionUri.startsWith("div-action://set_state?")) {
            val query = parseQueryParams(URI(actionUri).rawQuery ?: "")
            val statePath = query["state_id"]
            if (statePath != null) {
                val parts = statePath.split("/")
                if (parts.size >= 2) {
                    val blockId = parts[parts.size - 2]
                    val nextState = parts[parts.size - 1]
                    explicitStateSelections[blockId] = nextState
                    val spec = activeStateBlocks[blockId]
                    if (spec?.stateIdVariable != null) {
                        variableController.setVariable(spec.stateIdVariable, nextState)
                    }
                }
            }
            return
        }
        if (actionUri.startsWith("omnishell://print") || actionUri.startsWith("omnishell://checkout")) {
            printBridge?.handleActionUri(actionUri)
            onActionCallback?.invoke(actionUri)
            return
        }
        onActionCallback?.invoke(actionUri)
    }

    private fun parseQueryParams(rawQuery: String): Map<String, String> {
        val out = mutableMapOf<String, String>()
        for (pair in rawQuery.split("&")) {
            if (pair.isBlank()) continue
            val idx = pair.indexOf('=')
            if (idx == -1) continue
            val k = URLDecoder.decode(pair.substring(0, idx), StandardCharsets.UTF_8)
            val v = URLDecoder.decode(pair.substring(idx + 1), StandardCharsets.UTF_8)
            out[k] = v
        }
        return out
    }

    fun render(astJson: String, onAction: (String) -> Unit): Boolean {
        onActionCallback = onAction
        return try {
            val jsonObj = Json.parseToJsonElement(astJson).jsonObject
            val cardEl = jsonObj["card"]
            if (cardEl !is JsonObject) {
                renderErrorFallback("Missing 'card' root in DivKit JSON AST")
                return false
            }

            val logId = (cardEl["log_id"] as? JsonPrimitive)?.contentOrNull ?: "unknown_card"
            val states = cardEl["states"] as? JsonArray
            if (states == null || states.isEmpty()) {
                renderErrorFallback("DivKit 'card' contains no 'states'")
                return false
            }

            val vars = cardEl["variables"] as? JsonArray
            if (vars != null) {
                for (el in vars) {
                    val v = el as? JsonObject ?: continue
                    val name = (v["name"] as? JsonPrimitive)?.contentOrNull ?: continue
                    val valueEl = v["value"]
                    val value: Any = when (valueEl) {
                        null, is JsonNull -> ""
                        is JsonPrimitive -> {
                            valueEl.booleanOrNull
                                ?: valueEl.longOrNull
                                ?: valueEl.doubleOrNull
                                ?: valueEl.content
                        }
                        else -> valueEl.toString()
                    }
                    variableController.declare(name, value)
                    if (name == "layout_direction" && value is String) {
                        layoutDirection = value
                        for (adapter in customAdapters) {
                            if (adapter is FlipCardDivCustomAdapter) {
                                adapter.isRtl = (value == "rtl")
                            }
                        }
                    }
                }
            }

            activePalette.clear()
            val paletteArr = cardEl["palette"] as? JsonArray
            if (paletteArr != null) {
                for (el in paletteArr) {
                    val pObj = el as? JsonObject ?: continue
                    val pName = (pObj["name"] as? JsonPrimitive)?.contentOrNull ?: continue
                    val pLight = (pObj["light"] as? JsonPrimitive)?.contentOrNull ?: continue
                    val pDark = (pObj["dark"] as? JsonPrimitive)?.contentOrNull ?: pLight
                    activePalette[pName] = pLight to pDark
                }
            }

            val mounts = mutableListOf<DivCustomMountSpec>()
            val stateBlocks = mutableMapOf<String, DivStateBlockSpec>()
            for (stateEl in states) {
                val stObj = stateEl as? JsonObject ?: continue
                collectDescriptors(stObj["div"], mounts, stateBlocks)
            }
            for (prevMount in activeCustomMounts) {
                for (adapter in customAdapters) {
                    if (adapter.isCustomTypeSupported(prevMount.customType)) {
                        adapter.onReleaseCustomView(prevMount)
                    }
                }
            }
            activeCustomMounts.clear()
            activeCustomMounts.addAll(mounts)
            activeStateBlocks.clear()
            activeStateBlocks.putAll(stateBlocks)
            for (mount in mounts) {
                for (adapter in customAdapters) {
                    if (adapter.isCustomTypeSupported(mount.customType)) {
                        adapter.onBindCustomView(mount, variableController)
                    }
                }
            }

            currentCardId = logId
            lastRenderedAst = astJson
            hasError = false
            astParseCount += 1
            true
        } catch (e: Exception) {
            renderErrorFallback("Invalid DivKit JSON AST: ${e.message}")
            false
        }
    }

    fun updateVariable(name: String, value: Any) {
        variableController.setVariable(name, value)
    }

    fun parseAstOrFallback(astJson: String): String {
        if (render(astJson) {}) {
            return astJson
        }
        return lastRenderedAst
    }

    private fun collectDescriptors(
        el: JsonElement?,
        mounts: MutableList<DivCustomMountSpec>,
        stateBlocks: MutableMap<String, DivStateBlockSpec>
    ) {
        val obj = el as? JsonObject ?: return
        val type = (obj["type"] as? JsonPrimitive)?.contentOrNull
        if (type == "custom") {
            val id = (obj["id"] as? JsonPrimitive)?.contentOrNull ?: "custom"
            val customType = (obj["custom_type"] as? JsonPrimitive)?.contentOrNull ?: ""
            val customProps = (obj["custom_props"] as? JsonObject) ?: JsonObject(emptyMap())
            val itemsList = (obj["items"] as? JsonArray)
                ?.mapNotNull { it as? JsonObject }
                ?: emptyList()
            mounts.add(
                DivCustomMountSpec(
                    id = id,
                    customType = customType,
                    customProps = customProps,
                    items = itemsList
                )
            )
        } else if (type == "state") {
            val id = (obj["div_id"] as? JsonPrimitive)?.contentOrNull
                ?: (obj["id"] as? JsonPrimitive)?.contentOrNull
                ?: "state"
            val defaultStateId = (obj["default_state_id"] as? JsonPrimitive)?.contentOrNull ?: "closed"
            val stateIdVar = (obj["state_id_variable"] as? JsonPrimitive)?.contentOrNull
            val stIds = (obj["states"] as? JsonArray)
                ?.mapNotNull { ((it as? JsonObject)?.get("state_id") as? JsonPrimitive)?.contentOrNull }
                ?: emptyList()
            stateBlocks[id] = DivStateBlockSpec(
                id = id,
                defaultStateId = defaultStateId,
                stateIdVariable = stateIdVar,
                stateIds = stIds
            )
        }
        for (arrayKey in listOf("items", "states")) {
            val arr = obj[arrayKey] as? JsonArray ?: continue
            for (child in arr) {
                collectDescriptors(child, mounts, stateBlocks)
            }
        }
        val nested = obj["div"] as? JsonObject
        if (nested != null) {
            collectDescriptors(nested, mounts, stateBlocks)
        }
    }

    private fun renderErrorFallback(errorMessage: String) {
        hasError = true
        currentCardId = "error_boundary_fallback"
        val escaped = errorMessage
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        lastRenderedAst = """
            {
              "card": {
                "log_id": "error_boundary_fallback",
                "states": [
                  {
                    "state_id": 0,
                    "div": {
                      "type": "text",
                      "text": "Native Render Error: $escaped",
                      "text_color": "#A93226"
                    }
                  }
                ]
              }
            }
        """.trimIndent()
    }
}
