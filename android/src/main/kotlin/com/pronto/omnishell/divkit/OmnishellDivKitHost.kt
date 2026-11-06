package com.pronto.omnishell.divkit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Upstream DivKit (`com.yandex.div:div`) variable controller bridge allowing
 * 60–120 Hz scalar updates (such as kinetic HUD telemetry and form input bindings)
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
 * Descriptor for a `div-custom` mount (`custom_type: "kinetic:<actor>"` or `"kinetic-layer:<layer>"`).
 */
data class DivCustomMountSpec(
    val id: String,
    val customType: String,
    val customProps: JsonObject
)

/**
 * Adapter interface matching upstream `com.yandex.div.core.DivCustomContainerViewAdapter`
 * for mounting native views (`FilamentKineticPresenter` `SurfaceView` and HUD layers)
 * inside a DivKit card layout.
 */
interface DivCustomContainerViewAdapter {
    fun isCustomTypeSupported(type: String): Boolean
    fun onBindCustomView(spec: DivCustomMountSpec, variableController: DivVariableController)
    fun onReleaseCustomView(spec: DivCustomMountSpec)
}

/**
 * Shared Omnishell DivKit Host (`com.yandex.div:div` card lifecycle, `DivVariableController`,
 * `DivCustomContainerViewAdapter` registry, and error boundary fallback).
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

    val variableController = DivVariableController()
    private val customAdapters = CopyOnWriteArrayList<DivCustomContainerViewAdapter>()
    private val activeCustomMounts = CopyOnWriteArrayList<DivCustomMountSpec>()

    fun registerCustomAdapter(adapter: DivCustomContainerViewAdapter) {
        customAdapters.add(adapter)
    }

    fun getActiveCustomMounts(): List<DivCustomMountSpec> = ArrayList(activeCustomMounts)

    fun render(astJson: String, onAction: (String) -> Unit): Boolean {
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
                }
            }

            val mounts = mutableListOf<DivCustomMountSpec>()
            for (stateEl in states) {
                val stObj = stateEl as? JsonObject ?: continue
                collectCustomMounts(stObj["div"], mounts)
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

    private fun collectCustomMounts(el: JsonElement?, out: MutableList<DivCustomMountSpec>) {
        val obj = el as? JsonObject ?: return
        val type = (obj["type"] as? JsonPrimitive)?.contentOrNull
        if (type == "custom") {
            val id = (obj["id"] as? JsonPrimitive)?.contentOrNull ?: "custom"
            val customType = (obj["custom_type"] as? JsonPrimitive)?.contentOrNull ?: ""
            val customProps = (obj["custom_props"] as? JsonObject) ?: JsonObject(emptyMap())
            out.add(DivCustomMountSpec(id = id, customType = customType, customProps = customProps))
        }
        for (arrayKey in listOf("items", "states")) {
            val arr = obj[arrayKey] as? JsonArray ?: continue
            for (child in arr) {
                collectCustomMounts(child, out)
            }
        }
        val nested = obj["div"] as? JsonObject
        if (nested != null) {
            collectCustomMounts(nested, out)
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
