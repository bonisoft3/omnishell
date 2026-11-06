package com.pronto.omnishell.kinetic

import com.pronto.omnishell.divkit.DivVariableController
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Mobile Filament 3D Presenter (`com.google.android.filament:filament-android` + `gltfio-android`)
 * mounted inside DivKit's `custom_type: "kinetic:<actor>"` `SurfaceView` via `KineticDivCustomAdapter`.
 *
 * Consumes:
 *   1. Deterministic stage `.glb` binary bundles emitted by `apps/apexrun/shell/engine/stage_gltf.js`
 *      (`EXT_mesh_gpu_instancing` chunked by `SCATTER_CHUNK = 25`, `material.extras.stk` mapped to
 *      precompiled `.filamat` material instances, `.ktx2` IBL sky, procedural RGBA textures).
 *   2. The 186-float (744-byte) C-ABI `PoseBuffer` packed by `pose_buffer.js`.
 *   3. Updates DivKit `@{hud_<layer>}` variables in-place via `DivVariableController` without
 *      re-parsing the DivKit card JSON AST.
 */
object FilamentConstants {
    const val SCATTER_CHUNK: Int = 25
    const val SCATTER_BEHIND: Float = 30.0f
    const val SCATTER_AHEAD: Float = 360.0f
    val LOD_SPLITS: FloatArray = floatArrayOf(70.0f, 200.0f)
    const val LOD_FAR: Float = 520.0f
    const val MAX_TRAFFIC_CARS: Int = 12
    const val TRAFFIC_STRIDE: Int = 8
    const val POSE_BUFFER_FLOATS: Int = 186
    const val POSE_BUFFER_BYTES: Int = POSE_BUFFER_FLOATS * 4
    const val TARGET_60FPS_BUDGET_US: Long = 16_667L
    const val TARGET_120FPS_BUDGET_US: Long = 8_333L
}

data class FilamatMaterialInstance(
    val name: String,
    val filamatAsset: String,
    val toon: Boolean,
    val painted: Boolean,
    val brushed: Boolean,
    val sway: Boolean,
    val depthOffset: Float,
    val tint: String?,
    val lift: Float,
    val grain: String?
)

data class FilamentInstancedChunk(
    val name: String,
    val chunkIndex: Int,
    val startSegment: Int,
    val endSegment: Int,
    val zMin: Float,
    val zMax: Float,
    val kind: String,
    val instanceCount: Int
)

data class StageLookColors(
    val skyTop: String = "#1B6CA8",
    val skyHorizon: String = "#A8E0F0",
    val ground: String = "#EED6A4",
    val fog: String = "#C8E0EA",
    val water: String = "#0D7898",
    val sun: String = "#FFF6DC"
)

data class StageLightingProfile(
    val stageId: String,
    val forkLeftLabel: String,
    val forkRightLabel: String,
    val groundTileMetres: Float,
    val hasBackdrops: Boolean
) {
    companion object {
        fun forStage(stageId: String): StageLightingProfile = when (stageId) {
            "coconut-beach" -> StageLightingProfile(stageId, "DESERT CANYONS", "GATEWAY PASS", 12.0f, true)
            "desert-canyons" -> StageLightingProfile(stageId, "ALPINE PEAKS", "WILDERNESS RUN", 18.0f, true)
            "gateway-pass" -> StageLightingProfile(stageId, "WILDERNESS RUN", "TULIP GARDENS", 14.0f, true)
            "alpine-peaks", "alpine-heights" -> StageLightingProfile(stageId, "SUNSET HIGHWAY", "ANCIENT RUINS", 16.0f, true)
            "wilderness-run" -> StageLightingProfile(stageId, "ANCIENT RUINS", "METROPOLIS NIGHT", 14.0f, true)
            "tulip-gardens" -> StageLightingProfile(stageId, "METROPOLIS NIGHT", "COASTAL CLIFFS", 12.0f, true)
            "sunset-highway" -> StageLightingProfile(stageId, "MARINA BAY [A]", "DESERT OASIS [B]", 18.0f, true)
            "ancient-ruins" -> StageLightingProfile(stageId, "DESERT OASIS [B]", "GRAND CASTLE [C]", 14.0f, true)
            "metropolis-night" -> StageLightingProfile(stageId, "GRAND CASTLE [C]", "COLOSSEUM [D]", 8.0f, true)
            "coastal-cliffs" -> StageLightingProfile(stageId, "COLOSSEUM [D]", "AERODROME [E]", 14.0f, true)
            else -> StageLightingProfile(stageId, "FINISH LINE", "FINISH LINE", 14.0f, false)
        }
    }
}

data class TrafficCarPose(
    val slot: Int,
    val active: Boolean,
    val x: Float,
    val y: Float,
    val z: Float,
    val yaw: Float,
    val pitch: Float,
    val wheelSpin: Float,
    val typeCode: Int,
    val colorIndex: Int
)

data class FilamentStageScene(
    val stageId: String,
    val stageName: String,
    val segmentCount: Int,
    val segmentLengthMetres: Float,
    val skyKtx2: String,
    val backdropLayers: List<String>,
    val shoreSide: Int,
    val isNight: Boolean,
    val ribbonNodes: List<String>,
    val materials: List<FilamatMaterialInstance>,
    val chunks: List<FilamentInstancedChunk>,
    val textureCount: Int,
    val binByteLength: Int,
    val lookColors: StageLookColors = StageLookColors(),
    val lightingProfile: StageLightingProfile = StageLightingProfile.forStage(stageId)
)

class PoseBuffer(val floats: FloatArray = FloatArray(FilamentConstants.POSE_BUFFER_FLOATS)) {
    init {
        require(floats.size >= FilamentConstants.POSE_BUFFER_FLOATS) {
            "PoseBuffer requires ${FilamentConstants.POSE_BUFFER_FLOATS} floats"
        }
    }

    fun toLittleEndianBytes(): ByteArray {
        val buf = ByteBuffer.allocate(FilamentConstants.POSE_BUFFER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until FilamentConstants.POSE_BUFFER_FLOATS) {
            buf.putFloat(floats[i])
        }
        return buf.array()
    }

    val tick: Int get() = floats[0].toInt()
    val cameraEyeZ: Float get() = floats[6]
    val heroX: Float get() = floats[20]
    val heroY: Float get() = floats[21]
    val heroZ: Float get() = floats[22]
    val heroYaw: Float get() = floats[23]
    val heroPitch: Float get() = floats[24]
    val heroRoll: Float get() = floats[25]
    val heroNitroFlame: Float get() = floats[34]
    val heroHeadlightsOn: Boolean get() = floats[35] > 0.5f
    val riderPassengerArm: Float get() = floats[36]
    val riderPassengerHeadYaw: Float get() = floats[37]
    val speedKmh: Int get() = Math.round(floats[68])
    val rpm: Int get() = Math.round(floats[69])
    val tachoRatio: Float get() = floats[70]
    val gear: Int get() = Math.round(floats[71])
    val nitroAmount: Float get() = floats[72]
    val nitroCharges: Int get() = (floats[72] / 33.33f).toInt().coerceIn(0, 3)
    val nitroActive: Boolean get() = floats[73] > 0.5f || floats[34] > 0.05f
    val timerSec: Int get() = Math.round(floats[74])
    val timerDec: Int get() = Math.round(floats[75])
    val score: Int get() = Math.round(floats[76])
    val driftScore: Int get() = Math.round(floats[77])
    val gForceLat: Float get() = floats[78]
    val slipstream: Boolean get() = floats[79] > 0.5f
    val rivalDeltaMetres: Int get() = Math.round(floats[80])
    val distToForkMetres: Int get() = Math.round(floats[81].coerceAtLeast(0.0f))
    val stageProgressRatio: Float get() = floats[82].coerceIn(0.0f, 1.0f)

    fun trafficCarPose(slot: Int): TrafficCarPose {
        require(slot in 0 until FilamentConstants.MAX_TRAFFIC_CARS) { "Invalid traffic slot $slot" }
        val base = 90 + slot * FilamentConstants.TRAFFIC_STRIDE
        val active = floats[base] > 0.5f
        val packedModel = Math.round(floats[base + 1]).coerceAtLeast(0)
        return TrafficCarPose(
            slot = slot,
            active = active,
            x = floats[base + 2],
            y = floats[base + 3],
            z = floats[base + 4],
            yaw = floats[base + 5],
            pitch = floats[base + 7],
            wheelSpin = floats[base + 6],
            typeCode = packedModel % 8,
            colorIndex = (packedModel / 8) % 9
        )
    }

    companion object {
        fun fromLittleEndianBytes(bytes: ByteArray): PoseBuffer {
            require(bytes.size >= FilamentConstants.POSE_BUFFER_BYTES) {
                "PoseBuffer expected at least ${FilamentConstants.POSE_BUFFER_BYTES} bytes, got ${bytes.size}"
            }
            val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            val floats = FloatArray(FilamentConstants.POSE_BUFFER_FLOATS)
            for (i in 0 until FilamentConstants.POSE_BUFFER_FLOATS) {
                floats[i] = buf.getFloat(i * 4)
            }
            return PoseBuffer(floats)
        }
    }
}

data class FilamentFrameStats(
    val tick: Int,
    val frameTimeUs: Long,
    val visibleChunks: Int,
    val culledChunks: Int,
    val visibleInstances: Int,
    val lod0Chunks: Int,
    val lod1Chunks: Int,
    val lod2Chunks: Int,
    val activeTrafficCars: Int
)

class FilamentKineticPresenter(
    val graphicsBackend: String = "Vulkan"
) {
    var currentStage: FilamentStageScene? = null
        private set

    var frameCount: Long = 0L
        private set

    fun loadStageGlb(glbBytes: ByteArray): FilamentStageScene {
        require(glbBytes.size >= 20) { "Truncated GLB header" }
        val header = ByteBuffer.wrap(glbBytes, 0, 20).order(ByteOrder.LITTLE_ENDIAN)
        val magic = header.int
        require(magic == 0x46546C67) { "Invalid GLB magic: 0x${Integer.toHexString(magic)}" }
        val version = header.int
        require(version == 2) { "Unsupported GLB version: $version" }
        val totalLen = header.int
        require(totalLen == glbBytes.size) { "GLB length mismatch ($totalLen vs ${glbBytes.size})" }
        val jsonLen = header.int
        val jsonType = header.int
        require(jsonType == 0x4E4F534A) { "First GLB chunk is not JSON" }

        val jsonStr = String(glbBytes, 20, jsonLen, Charsets.UTF_8).trimEnd()
        val root = Json.parseToJsonElement(jsonStr).jsonObject

        val binHeaderOffset = 20 + jsonLen
        val binByteLength = if (binHeaderOffset + 8 <= glbBytes.size) {
            ByteBuffer.wrap(glbBytes, binHeaderOffset, 8).order(ByteOrder.LITTLE_ENDIAN).int
        } else {
            0
        }

        val scene0 = (root["scenes"] as? JsonArray)?.firstOrNull()?.jsonObject
            ?: error("Missing scenes[0] in stage GLB")
        val stk = scene0["extras"]?.jsonObject?.get("stk")?.jsonObject
            ?: error("Missing scene.extras.stk in stage GLB")

        val stageId = (stk["stageId"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
            ?: error("Missing stageId in scene.extras.stk")
        val stageName = (stk["stageName"] as? JsonPrimitive)?.contentOrNull ?: ""
        val segmentCount = (stk["segmentCount"] as? JsonPrimitive)?.intOrNull ?: 0
        val segmentLengthMetres = (stk["segmentLengthMetres"] as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: 0.72f
        val skyKtx2 = (stk["skyKtx2"] as? JsonPrimitive)?.contentOrNull ?: ""
        val shoreSide = (stk["shoreSide"] as? JsonPrimitive)?.intOrNull ?: 0
        val isNight = (stk["isNight"] as? JsonPrimitive)?.booleanOrNull ?: false
        val backdropLayers = (stk["backdropLayers"] as? JsonArray)?.mapNotNull {
            (it as? JsonPrimitive)?.contentOrNull
        } ?: emptyList()

        val materials = mutableListOf<FilamatMaterialInstance>()
        val matArr = root["materials"] as? JsonArray
        if (matArr != null) {
            for (mEl in matArr) {
                val m = mEl as? JsonObject ?: continue
                val name = (m["name"] as? JsonPrimitive)?.contentOrNull ?: "mat"
                val mStk = m["extras"]?.jsonObject?.get("stk")?.jsonObject
                val toon = (mStk?.get("toon") as? JsonPrimitive)?.booleanOrNull ?: true
                val painted = (mStk?.get("painted") as? JsonPrimitive)?.booleanOrNull ?: false
                val brushed = (mStk?.get("brushed") as? JsonPrimitive)?.booleanOrNull ?: false
                val sway = (mStk?.get("sway") as? JsonPrimitive)?.booleanOrNull ?: false
                val depthOffset = (mStk?.get("depthOffset") as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: 0.0f
                val tint = (mStk?.get("tint") as? JsonPrimitive)?.contentOrNull
                val lift = (mStk?.get("lift") as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: 1.0f
                val grain = (mStk?.get("grain") as? JsonPrimitive)?.contentOrNull

                val filamatAsset = when {
                    name.endsWith("#window") || name == "window" -> "materials/stk_window_grid.filamat"
                    !toon || name.endsWith("#lamp") || name == "lamp" -> "materials/stk_unlit_emissive.filamat"
                    sway && grain == "leaves" -> "materials/stk_foliage_sway.filamat"
                    brushed -> "materials/stk_toon_brushed.filamat"
                    painted -> "materials/stk_toon_painted.filamat"
                    else -> "materials/stk_toon_standard.filamat"
                }
                materials.add(
                    FilamatMaterialInstance(
                        name = name,
                        filamatAsset = filamatAsset,
                        toon = toon,
                        painted = painted,
                        brushed = brushed,
                        sway = sway,
                        depthOffset = depthOffset,
                        tint = tint,
                        lift = lift,
                        grain = grain
                    )
                )
            }
        }

        val ribbonNodes = mutableListOf<String>()
        val chunks = mutableListOf<FilamentInstancedChunk>()
        val nodeArr = root["nodes"] as? JsonArray
        if (nodeArr != null) {
            for (nEl in nodeArr) {
                val n = nEl as? JsonObject ?: continue
                val name = (n["name"] as? JsonPrimitive)?.contentOrNull ?: ""
                val hasInstancing = n["extensions"]?.jsonObject?.containsKey("EXT_mesh_gpu_instancing") == true
                if (hasInstancing) {
                    val ex = n["extras"]?.jsonObject ?: continue
                    chunks.add(
                        FilamentInstancedChunk(
                            name = name,
                            chunkIndex = (ex["chunkIndex"] as? JsonPrimitive)?.intOrNull ?: 0,
                            startSegment = (ex["startSegment"] as? JsonPrimitive)?.intOrNull ?: 0,
                            endSegment = (ex["endSegment"] as? JsonPrimitive)?.intOrNull ?: 0,
                            zMin = (ex["zMin"] as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: 0.0f,
                            zMax = (ex["zMax"] as? JsonPrimitive)?.doubleOrNull?.toFloat() ?: 0.0f,
                            kind = (ex["kind"] as? JsonPrimitive)?.contentOrNull ?: "",
                            instanceCount = (ex["instanceCount"] as? JsonPrimitive)?.intOrNull ?: 0
                        )
                    )
                } else {
                    ribbonNodes.add(name)
                }
            }
        }

        val lookObj = stk["lookColors"]?.jsonObject
        val lookColors = StageLookColors(
            skyTop = (lookObj?.get("skyTop") as? JsonPrimitive)?.contentOrNull ?: "#1B6CA8",
            skyHorizon = (lookObj?.get("skyHorizon") as? JsonPrimitive)?.contentOrNull ?: "#A8E0F0",
            ground = (lookObj?.get("ground") as? JsonPrimitive)?.contentOrNull ?: "#EED6A4",
            fog = (lookObj?.get("fog") as? JsonPrimitive)?.contentOrNull ?: "#C8E0EA",
            water = (lookObj?.get("water") as? JsonPrimitive)?.contentOrNull ?: "#0D7898",
            sun = (lookObj?.get("sun") as? JsonPrimitive)?.contentOrNull ?: "#FFF6DC"
        )

        val textureCount = (root["images"] as? JsonArray)?.size ?: 0
        val parsed = FilamentStageScene(
            stageId = stageId,
            stageName = stageName,
            segmentCount = segmentCount,
            segmentLengthMetres = segmentLengthMetres,
            skyKtx2 = skyKtx2,
            backdropLayers = backdropLayers,
            shoreSide = shoreSide,
            isNight = isNight,
            ribbonNodes = ribbonNodes,
            materials = materials,
            chunks = chunks,
            textureCount = textureCount,
            binByteLength = binByteLength,
            lookColors = lookColors,
            lightingProfile = StageLightingProfile.forStage(stageId)
        )
        currentStage = parsed
        return parsed
    }

    /**
     * Size-scaled LOD and distance reveal matching `lodFor(dist, size, visible)` in `art.js`.
     * Prevents far-away scenery from popping in component-by-component.
     */
    fun lodForChunk(distMetres: Float, kind: String): Int {
        val size = when {
            kind.contains("tower") -> 38.0f
            kind.contains("colosseum") || kind.contains("windmill") || kind.contains("lighthouse") -> 24.0f
            kind.contains("arch") || kind.contains("ForkGantry") || kind.contains("forkGantry") -> 16.0f
            kind.contains("palm") || kind.contains("pine") || kind.contains("cypress") || kind.contains("tree") -> 11.0f
            kind.startsWith("scatter:flower") || kind.startsWith("scatter:poppies") || kind.startsWith("scatter:tuft") -> 1.2f
            kind.startsWith("scatter:") -> 2.4f
            else -> 8.0f
        }
        val scale = (size / 10.0f).coerceIn(0.25f, 1.8f)
        val farCutoff = FilamentConstants.LOD_FAR * scale
        if (distMetres > farCutoff) return -1
        return when {
            distMetres < FilamentConstants.LOD_SPLITS[0] * scale -> 0
            distMetres < FilamentConstants.LOD_SPLITS[1] * scale -> 1
            else -> 2
        }
    }

    /**
     * Render one 60/120 Hz frame from `pose` and push fast HUD scalars in-place to
     * `variableController` without re-parsing the DivKit card JSON AST.
     */
    fun renderFrame(pose: PoseBuffer, variableController: DivVariableController? = null): FilamentFrameStats {
        val startNs = System.nanoTime()
        frameCount += 1L

        val camZ = pose.cameraEyeZ
        val zNear = camZ - FilamentConstants.SCATTER_BEHIND
        val zFar = camZ + FilamentConstants.SCATTER_AHEAD

        var visibleChunks = 0
        var culledChunks = 0
        var visibleInstances = 0
        var lod0 = 0
        var lod1 = 0
        var lod2 = 0

        val stage = currentStage
        if (stage != null) {
            for (chunk in stage.chunks) {
                if (chunk.zMax < zNear || chunk.zMin > zFar) {
                    culledChunks += 1
                    continue
                }
                val dist = (chunk.zMin - camZ).coerceAtLeast(0.0f)
                val lod = lodForChunk(dist, chunk.kind)
                if (lod < 0) {
                    culledChunks += 1
                    continue
                }
                visibleChunks += 1
                visibleInstances += chunk.instanceCount
                when (lod) {
                    0 -> lod0 += 1
                    1 -> lod1 += 1
                    else -> lod2 += 1
                }
            }
        }

        var activeTraffic = 0
        var nearestTrafficDist = Float.MAX_VALUE
        for (i in 0 until FilamentConstants.MAX_TRAFFIC_CARS) {
            val car = pose.trafficCarPose(i)
            if (car.active) {
                activeTraffic += 1
                val dz = kotlin.math.abs(car.z - pose.heroZ)
                if (dz < nearestTrafficDist) nearestTrafficDist = dz
            }
        }

        if (variableController != null) {
            val gearStr = if (pose.gear >= 2) "HI" else "LO"
            val nitroPct = "${Math.round(pose.nitroAmount.coerceIn(0.0f, 100.0f))}%"
            val nitroStatus = when {
                pose.nitroActive -> "BOOST"
                pose.nitroCharges > 0 -> "NITRO x${pose.nitroCharges}"
                else -> "CHARGING"
            }
            val radarText = when {
                nearestTrafficDist < 45.0f -> "WARNING ${Math.round(nearestTrafficDist)}M"
                nearestTrafficDist < 120.0f -> "TRAFFIC AHEAD"
                else -> "CLEAR"
            }
            variableController.setVariable("hud_speed", "${pose.speedKmh}")
            variableController.setVariable("hud_rpm", "${pose.rpm}")
            variableController.setVariable("hud_gear", gearStr)
            variableController.setVariable("hud_timer", "${pose.timerSec}")
            variableController.setVariable("hud_timer_dec", ".${pose.timerDec}")
            variableController.setVariable("hud_score", "${pose.score}")
            variableController.setVariable("hud_nitro_text", nitroPct)
            variableController.setVariable("hud_nitro_status", nitroStatus)
            variableController.setVariable("hud_tacho", "${pose.tachoRatio}")
            variableController.setVariable("hud_radar", radarText)
            if (stage != null) {
                variableController.setVariable("hud_stage_title", stage.stageName.uppercase())
                variableController.setVariable("hud_fork_left", "◀ [L] ${stage.lightingProfile.forkLeftLabel}")
                variableController.setVariable("hud_fork_right", "[R] ${stage.lightingProfile.forkRightLabel} ▶")
                variableController.setVariable(
                    "hud_fork_dist",
                    if (pose.distToForkMetres <= 180) "FORK NOW" else "${pose.distToForkMetres} m"
                )
            }
        }

        val elapsedUs = (System.nanoTime() - startNs) / 1_000L
        return FilamentFrameStats(
            tick = pose.tick,
            frameTimeUs = elapsedUs,
            visibleChunks = visibleChunks,
            culledChunks = culledChunks,
            visibleInstances = visibleInstances,
            lod0Chunks = lod0,
            lod1Chunks = lod1,
            lod2Chunks = lod2,
            activeTrafficCars = activeTraffic
        )
    }
}
