package com.pronto.omnishell.kinetic

import com.pronto.omnishell.divkit.DivCustomContainerViewAdapter
import com.pronto.omnishell.divkit.DivCustomMountSpec
import com.pronto.omnishell.divkit.DivVariableController
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * Upstream DivKit `DivCustomContainerViewAdapter` mounting:
 *   - `custom_type: "kinetic:<actor>"` -> `FilamentKineticPresenter` 3D `SurfaceView`
 *   - `custom_type: "kinetic-layer:<layer>"` -> Fast HUD layer bound to `@{hud_<layer>}`
 */
class KineticDivCustomAdapter(
    val presenter: FilamentKineticPresenter = FilamentKineticPresenter()
) : DivCustomContainerViewAdapter {

    data class BoundHudLayer(
        val id: String,
        val layer: String,
        val variableName: String,
        val fill: Boolean,
        var currentValue: String = ""
    )

    var mountedKineticActor: String? = null
        private set

    val boundHudLayers = ConcurrentHashMap<String, BoundHudLayer>()
    private val layerUnsubscribes = ConcurrentHashMap<String, () -> Unit>()

    override fun isCustomTypeSupported(type: String): Boolean {
        return type.startsWith("kinetic:") || type.startsWith("kinetic-layer:")
    }

    override fun onBindCustomView(spec: DivCustomMountSpec, variableController: DivVariableController) {
        if (spec.customType.startsWith("kinetic:")) {
            mountedKineticActor = spec.customType.removePrefix("kinetic:")
            return
        }
        if (spec.customType.startsWith("kinetic-layer:")) {
            val layer = spec.customType.removePrefix("kinetic-layer:")
            layerUnsubscribes.remove(layer)?.invoke()
            val rawVar = (spec.customProps["variable"] as? JsonPrimitive)?.contentOrNull ?: "@{hud_$layer}"
            val varName = rawVar.removePrefix("@{").removeSuffix("}")
            val fill = (spec.customProps["fill"] as? JsonPrimitive)?.booleanOrNull ?: false
            val initial = variableController.getString(varName, "")
            val bound = BoundHudLayer(
                id = spec.id,
                layer = layer,
                variableName = varName,
                fill = fill,
                currentValue = initial
            )
            boundHudLayers[layer] = bound
            val unsubscribe = variableController.addListener { changedVar, newValue ->
                if (changedVar == varName) {
                    bound.currentValue = newValue.toString()
                }
            }
            layerUnsubscribes[layer] = unsubscribe
        }
    }

    override fun onReleaseCustomView(spec: DivCustomMountSpec) {
        if (spec.customType.startsWith("kinetic:")) {
            mountedKineticActor = null
        } else if (spec.customType.startsWith("kinetic-layer:")) {
            val layer = spec.customType.removePrefix("kinetic-layer:")
            layerUnsubscribes.remove(layer)?.invoke()
            boundHudLayers.remove(layer)
        }
    }
}
