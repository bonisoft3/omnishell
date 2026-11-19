package com.pronto.omnishell.divkit

import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * Upstream DivKit `DivCustomContainerViewAdapter` mounting `custom_type: "flip-card"`:
 * drives 3D `rotationY` (`0f` <-> `180f`) + scaled Android `View.setCameraDistance`
 * (`perspectiveDp * density * CAMERA_DISTANCE_SCALE`) and inactive-face visibility/clickability
 * gating from `DivVariableController` without re-parsing the DivKit card AST.
 */
class FlipCardDivCustomAdapter(
    private val density: Float = 3.0f,
    var isRtl: Boolean = false
) : DivCustomContainerViewAdapter {

    companion object {
        const val CAMERA_DISTANCE_SCALE = 8.0f

        fun computeCameraDistancePx(perspectiveDp: Float, density: Float): Float =
            perspectiveDp.coerceAtLeast(100f) * density.coerceAtLeast(1f) * CAMERA_DISTANCE_SCALE

        fun isTruthyFlip(raw: String): Boolean {
            val lower = raw.trim().lowercase()
            return lower == "yes" || lower == "true" || lower == "1"
        }
    }

    data class BoundFlipCard(
        val id: String,
        val flippedVariable: String,
        val perspectivePx: Float,
        val cameraDistancePx: Float,
        val durationMs: Int,
        val itemsCount: Int,
        val isFlipped: Boolean,
        val frontRotationYDeg: Float,
        val backRotationYDeg: Float,
        val frontVisible: Boolean,
        val backVisible: Boolean,
        val frontClickable: Boolean,
        val backClickable: Boolean
    )

    val boundFlipCards = ConcurrentHashMap<String, BoundFlipCard>()
    private val cardUnsubscribes = ConcurrentHashMap<String, () -> Unit>()

    override fun isCustomTypeSupported(type: String): Boolean = type == "flip-card"

    private fun buildState(
        id: String,
        flippedVar: String,
        perspectivePx: Float,
        durationMs: Int,
        itemsCount: Int,
        rawValue: String
    ): BoundFlipCard {
        val flipped = isTruthyFlip(rawValue)
        val dir = if (isRtl) -1f else 1f
        val frontRot = if (flipped) dir * 180f else 0f
        val backRot = if (flipped) 0f else -dir * 180f
        return BoundFlipCard(
            id = id,
            flippedVariable = flippedVar,
            perspectivePx = perspectivePx,
            cameraDistancePx = computeCameraDistancePx(perspectivePx, density),
            durationMs = durationMs,
            itemsCount = itemsCount,
            isFlipped = flipped,
            frontRotationYDeg = frontRot,
            backRotationYDeg = backRot,
            frontVisible = !flipped,
            backVisible = flipped,
            frontClickable = !flipped,
            backClickable = flipped
        )
    }

    override fun onBindCustomView(
        spec: DivCustomMountSpec,
        variableController: DivVariableController
    ) {
        if (spec.customType != "flip-card") return

        cardUnsubscribes.remove(spec.id)?.invoke()

        val explicitVar = (spec.customProps["flipped_variable"] as? JsonPrimitive)?.contentOrNull
        val exprVar = (spec.customProps["flipped"] as? JsonPrimitive)?.contentOrNull
            ?.removePrefix("@{")
            ?.removeSuffix("}")
        val flippedVar = when {
            !explicitVar.isNullOrBlank() -> explicitVar
            !exprVar.isNullOrBlank() -> exprVar
            else -> "flipped"
        }

        val perspectivePx = ((spec.customProps["perspective_px"] as? JsonPrimitive)?.doubleOrNull ?: 1200.0).toFloat()
        val durationMs = (spec.customProps["duration_ms"] as? JsonPrimitive)?.intOrNull ?: 600
        val initialVal = variableController.getString(flippedVar, "no")

        boundFlipCards[spec.id] = buildState(
            id = spec.id,
            flippedVar = flippedVar,
            perspectivePx = perspectivePx,
            durationMs = durationMs,
            itemsCount = spec.items.size,
            rawValue = initialVal
        )

        val unsubscribe = variableController.addListener { changedVar, newValue ->
            if (changedVar == flippedVar) {
                boundFlipCards[spec.id] = buildState(
                    id = spec.id,
                    flippedVar = flippedVar,
                    perspectivePx = perspectivePx,
                    durationMs = durationMs,
                    itemsCount = spec.items.size,
                    rawValue = newValue.toString()
                )
            }
        }
        cardUnsubscribes[spec.id] = unsubscribe
    }

    override fun onReleaseCustomView(spec: DivCustomMountSpec) {
        if (spec.customType != "flip-card") return
        cardUnsubscribes.remove(spec.id)?.invoke()
        boundFlipCards.remove(spec.id)
    }
}
