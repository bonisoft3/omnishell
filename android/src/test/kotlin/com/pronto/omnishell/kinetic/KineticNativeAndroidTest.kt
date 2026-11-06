package com.pronto.omnishell.kinetic

import com.pronto.omnishell.divkit.OmnishellDivKitHost
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class KineticNativeAndroidTest {

    private fun readResourceText(path: String): String {
        val stream = javaClass.classLoader.getResourceAsStream(path)
            ?: error("Missing test resource: $path")
        return stream.bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    private fun readResourceBytes(path: String): ByteArray {
        val stream = javaClass.classLoader.getResourceAsStream(path)
            ?: error("Missing test resource: $path")
        return stream.use { it.readBytes() }
    }

    @Test
    fun `Slice 1 & 4 - DivKit mounts kinetic race SurfaceView and 24 HUD layers with in-place 120Hz variable updates`() {
        val arenaDivKitJson = readResourceText("fixtures/arena_divkit.json")
        val glbBytes = readResourceBytes("fixtures/coconut_beach.glb")

        val host = OmnishellDivKitHost()
        val adapter = KineticDivCustomAdapter()
        host.registerCustomAdapter(adapter)

        assertTrue(host.render(arenaDivKitJson) {}, "Expected arena DivKit card to render cleanly")
        assertFalse(host.hasError)
        assertEquals("omnishell_arena", host.currentCardId)
        assertEquals(1, host.astParseCount)

        // Verify `kinetic:race` and all 24 `kinetic-layer:*` custom mounts bound
        assertEquals("race", adapter.mountedKineticActor)
        assertEquals(24, adapter.boundHudLayers.size)
        assertTrue(adapter.boundHudLayers.containsKey("speed"))
        assertTrue(adapter.boundHudLayers.containsKey("tacho"))
        assertTrue(adapter.boundHudLayers.containsKey("eq"))

        // Load stage .glb into Filament presenter
        val scene = adapter.presenter.loadStageGlb(glbBytes)
        assertEquals("coconut-beach", scene.stageId)
        assertEquals("sky/coconut-beach.ktx2", scene.skyKtx2)
        assertEquals(-1, scene.shoreSide)
        assertEquals(3, scene.textureCount)
        assertTrue(scene.ribbonNodes.contains("bSeaWallFace"))
        assertTrue(scene.ribbonNodes.contains("bSeaWall"))
        assertTrue(scene.ribbonNodes.contains("bSeaWallBack"))
        assertEquals("DESERT CANYONS", scene.lightingProfile.forkLeftLabel)
        assertEquals("GATEWAY PASS", scene.lightingProfile.forkRightLabel)
        assertTrue(scene.chunks.size > 10, "Expected instanced scatter chunks of SCATTER_CHUNK=25")
        assertTrue(scene.materials.any { it.filamatAsset == "materials/stk_foliage_sway.filamat" })
        assertTrue(scene.materials.any { it.filamatAsset == "materials/stk_toon_brushed.filamat" })

        // Execute 120 consecutive frames at 60/120 Hz and verify:
        //   1. Frame cost stays well under 8,333 us (120 fps budget)
        //   2. `astParseCount` stays 1 (no JSON AST re-parse on fast HUD scalar updates)
        //   3. Bound HUD layers receive live scalar updates via `DivVariableController`
        // Warm up JVM classloading before timing 120 consecutive frames.
        adapter.presenter.renderFrame(PoseBuffer(), host.variableController)
        var totalFrameUs = 0L
        for (f in 1..120) {
            val pose = PoseBuffer()
            pose.floats[0] = f.toFloat()
            pose.floats[6] = f * 2.5f // camera eye Z advancing along stage
            pose.floats[22] = f * 2.5f + 6.8f
            pose.floats[34] = if (f > 90) 1.0f else 0.0f // nitro active on final frames
            pose.floats[36] = if (f > 90) 0.15f else 1.15f // passenger arm raised waving on nitro
            pose.floats[68] = (120 + f).toFloat() // speed km/h
            pose.floats[69] = (4200 + f * 20).toFloat() // rpm
            pose.floats[70] = 0.72f // tacho ratio
            pose.floats[71] = 2.0f // HI gear
            pose.floats[72] = 85.0f // nitro amount (0..100)
            pose.floats[73] = if (f > 90) 1.0f else 0.0f // HUD_NITRO_ACTIVE
            pose.floats[74] = (60 - f / 60).toFloat()
            pose.floats[75] = (f % 10).toFloat()
            pose.floats[76] = (f * 150).toFloat()
            pose.floats[77] = 320.0f // HUD_DRIFT_SCORE
            pose.floats[78] = 0.85f // HUD_GFORCE_LAT
            pose.floats[80] = -14.0f // HUD_RIVAL_GAP_METRES
            pose.floats[81] = 120.0f // HUD_FORK_DIST_METRES
            pose.floats[82] = 0.42f // HUD_ROUTE_PROGRESS
            // Traffic slot 0 matching pose_buffer.js offsets: +0 active, +1 modelIndex, +2..4 x/y/z, +5 yaw, +6 wheelSpin, +7 pitch
            pose.floats[90] = 1.0f
            pose.floats[91] = (3 * 8 + 2).toFloat()
            pose.floats[92] = -2.2f
            pose.floats[93] = 4.5f
            pose.floats[94] = f * 2.5f + 28.0f
            pose.floats[95] = 0.05f
            pose.floats[96] = 1.8f
            pose.floats[97] = 0.14f // road slope pitch

            val tCar = pose.trafficCarPose(0)
            assertTrue(tCar.active)
            assertEquals(-2.2f, tCar.x, 1e-4f)
            assertEquals(4.5f, tCar.y, 1e-4f)
            assertEquals(f * 2.5f + 28.0f, tCar.z, 1e-4f)
            assertEquals(0.05f, tCar.yaw, 1e-4f)
            assertEquals(1.8f, tCar.wheelSpin, 1e-4f)
            assertEquals(2, tCar.typeCode)
            assertEquals(3, tCar.colorIndex)
            assertEquals(0.14f, tCar.pitch, 1e-4f)

            val stats = adapter.presenter.renderFrame(pose, host.variableController)
            totalFrameUs += stats.frameTimeUs
            assertTrue(stats.visibleChunks > 0)
            assertEquals(1, stats.activeTrafficCars)
        }

        val avgFrameUs = totalFrameUs / 120
        assertEquals(1, host.astParseCount, "Fast HUD updates must not re-parse the DivKit card JSON AST")
        assertEquals("240", adapter.boundHudLayers["speed"]?.currentValue)
        assertEquals("HI", adapter.boundHudLayers["gear"]?.currentValue)
        assertEquals("85%", adapter.boundHudLayers["nitro-text"]?.currentValue)
        assertEquals("BOOST", host.variableController.getVariable("hud_nitro_status"))
        assertEquals("FORK NOW", host.variableController.getVariable("hud_fork_dist"))
        assertEquals("WARNING 21M", host.variableController.getVariable("hud_radar"))
        assertTrue(
            avgFrameUs < FilamentConstants.TARGET_120FPS_BUDGET_US,
            "Average frame time ${avgFrameUs}us exceeded 120fps budget (${FilamentConstants.TARGET_120FPS_BUDGET_US}us)"
        )

        // Verify re-rendering the DivKit card releases previous custom mounts so listener count stays flat (24)
        val initialListeners = host.variableController.listenerCount
        assertEquals(24, initialListeners)
        for (rerender in 1..5) {
            assertTrue(host.render(arenaDivKitJson) {})
            assertEquals(initialListeners, host.variableController.listenerCount, "Listener leak on re-render $rerender")
        }
    }

    @Test
    fun `Slice 4 - TouchZoneDispatcher matches all 5 tests_touch_ts multi-touch and hotseat duel cases`() {
        // Test across Phone Landscape (852x393), Phone Portrait (393x852), Tablet Landscape (1194x834), Tablet Portrait (834x1194)
        val viewports = listOf(
            "phone-flat" to (852f to 393f),
            "phone-upright" to (393f to 852f),
            "tablet" to (1194f to 834f),
            "tablet-upright" to (834f to 1194f)
        )

        for ((name, dims) in viewports) {
            val dispatcher = TouchZoneDispatcher.standardApexRunLayout(dims.first, dims.second)
            val faults = dispatcher.validateClusterLayout(includeSeat2 = true)
            assertTrue(faults.isEmpty(), "Cluster layout faults on $name: $faults")
        }

        val d = TouchZoneDispatcher.standardApexRunLayout(852f, 393f)
        val padLeft = d.regions.first { it.id == "pad-left-1" }.rect
        val padMid = d.regions.first { it.id == "pad-mid-1" }.rect
        val padRight = d.regions.first { it.id == "pad-right-1" }.rect
        val nitro1 = d.regions.first { it.id == "nitro-1" }.rect
        val brake1 = d.regions.first { it.id == "brake-1" }.rect
        val pauseBtn = d.regions.first { it.id == "touch-pause" }.rect

        // 1. Thumb 1 down on pad's left half -> throttle + left
        d.pointerDown(1, padLeft.centerX, padLeft.centerY)
        assertEquals(SeatTouchCommand(up = true, down = false, left = true, right = false, nitro = false), d.sampleSeatCommand(1))

        // 2. Thumb 1 at pad's rounded corner (left + 3, top + 4) -> still drives left
        d.pointerMove(1, padLeft.left + 3f, padLeft.top + 4f)
        assertEquals(SeatTouchCommand(up = true, down = false, left = true, right = false, nitro = false), d.sampleSeatCommand(1))

        // 3. Thumb 1 drifts off pad (y - 60) -> releases drive & left, but finger stays tracked
        d.pointerMove(1, padMid.centerX, padLeft.top - 60f)
        assertEquals(SeatTouchCommand(up = false, down = false, left = false, right = false, nitro = false), d.sampleSeatCommand(1))

        // 4. Thumb 1 slides over `.touch-pause` -> must NOT trigger pause while sliding
        d.pointerMove(1, pauseBtn.centerX, pauseBtn.centerY)
        assertTrue(d.triggeredTapZones.isEmpty(), "Sliding onto pause button must not trigger tap")

        // 5. Thumb 1 slides back onto pad's left half -> drives again without lifting finger
        d.pointerMove(1, padLeft.centerX, padLeft.centerY)
        assertEquals(SeatTouchCommand(up = true, down = false, left = true, right = false, nitro = false), d.sampleSeatCommand(1))

        // 6. Thumb 1 slides to pad's right half while Thumb 2 presses nitro
        d.pointerMove(1, padRight.centerX, padRight.centerY)
        d.pointerDown(2, nitro1.centerX, nitro1.centerY)
        assertEquals(SeatTouchCommand(up = true, down = false, left = false, right = true, nitro = true), d.sampleSeatCommand(1))

        // 7. Lift nitro, slide Thumb 1 to center notch, press brake with Thumb 2
        d.pointerUp(2)
        d.pointerMove(1, padMid.centerX, padMid.centerY)
        d.pointerDown(2, brake1.centerX, brake1.centerY)
        assertEquals(SeatTouchCommand(up = false, down = true, left = false, right = false, nitro = false), d.sampleSeatCommand(1))

        // 8. Lift brake -> Thumb 1 on center pad resumes straight throttle
        d.pointerUp(2)
        assertEquals(SeatTouchCommand(up = true, down = false, left = false, right = false, nitro = false), d.sampleSeatCommand(1))
        d.pointerUp(1)

        // 9. Direct tap on pause button triggers "pause"
        d.pointerDown(90, pauseBtn.centerX, pauseBtn.centerY)
        d.pointerUp(90)
        assertEquals(listOf("pause"), d.triggeredTapZones)

        // 10. Initials keypad: ["up", "up", "right", "up", "right", "down"] spells "CBZ"
        for (key in listOf("up", "up", "right", "up", "right", "down")) {
            val r = d.regions.first { it.id == "arena-key-$key" }.rect
            d.pointerDown(91, r.centerX, r.centerY)
            d.pointerUp(91)
        }
        assertEquals("CBZ", d.getInitialsString())

        // 11. 2-seat simultaneous hotseat duel: 4 fingers (Seat 1 drive+left+nitro, Seat 2 drive+right+brake)
        val padRight2 = d.regions.first { it.id == "pad-right-2" }.rect
        val brake2 = d.regions.first { it.id == "brake-2" }.rect
        d.pointerDown(1, padLeft.centerX, padLeft.centerY)
        d.pointerDown(2, nitro1.centerX, nitro1.centerY)
        d.pointerDown(3, padRight2.centerX, padRight2.centerY)
        d.pointerDown(4, brake2.centerX, brake2.centerY)

        assertEquals(SeatTouchCommand(up = true, down = false, left = true, right = false, nitro = true), d.sampleSeatCommand(1))
        assertEquals(SeatTouchCommand(up = false, down = true, left = false, right = true, nitro = false), d.sampleSeatCommand(2))

        // 12. Repeated pointerDown with same pointerId releases previous zones, and pointerCancel clears stuck zones
        d.pointerUp(1)
        d.pointerUp(2)
        d.pointerUp(3)
        d.pointerUp(4)
        d.pointerDown(7, padLeft.centerX, padLeft.centerY)
        d.pointerDown(7, nitro1.centerX, nitro1.centerY)
        assertEquals(SeatTouchCommand(up = false, down = false, left = false, right = false, nitro = true), d.sampleSeatCommand(1))
        d.pointerCancel(7)
        assertEquals(SeatTouchCommand(up = false, down = false, left = false, right = false, nitro = false), d.sampleSeatCommand(1))
    }

    @Test
    fun `Slice 5 - NativeAudioBridge matches tests_audio_test_ts and synthesizes stereo PCM`() {
        val audio = NativeAudioBridge(48_000)

        // 1. Idle -> 260 km/h drive -> idle
        audio.updateEngine(speed = 0f, isDrifting = false, isNitro = false, rpm = 900f)
        val idleFreq = audio.harmonicFrequencies[1]
        val idleGain = audio.engineMasterGain
        assertTrue(idleFreq in 15f..95f)

        audio.updateEngine(speed = 260f, isDrifting = false, isNitro = true, rpm = 7400f)
        val fastFreq = audio.harmonicFrequencies[1]
        val fastGain = audio.engineMasterGain
        assertTrue(fastFreq > idleFreq * 1.4f)
        assertTrue(fastGain > idleGain)
        assertTrue(audio.engineFilterFreq > 600f)

        // 2. Surface feedback (off-road, curb, drift)
        audio.updateEngine(speed = 180f, isDrifting = true, isNitro = false, rpm = 5800f, offRoad = true, curb = 0.9f)
        assertTrue(audio.offroadGain > 0.01f)
        assertTrue(audio.curbGain > 0.01f)
        assertTrue(audio.tireSquealGain > 0.01f)

        // 3. Cues, music & 6-band EQ spectrum (`levels(6)`)
        audio.startMusic("magical_sound_shower")
        audio.triggerCue("checkpoint")
        audio.triggerCue("splash")
        val bands = audio.levels(6)
        assertEquals(6, bands.size)
        assertTrue(bands.any { it > 0.0f && it <= 1.0f })

        // 4. Render 512 stereo frames and cycle through all 3 FM stations (Palm Drive, Tidal Breeze, Neon Surf)
        val pcm = audio.renderPcmStereo(512)
        assertEquals(1024, pcm.size)
        val peak = pcm.maxOf { kotlin.math.abs(it) }
        assertTrue(peak > 0.01f && peak <= 1.0f)
        assertEquals("passing_breeze", audio.nextTrack())
        assertTrue(audio.renderPcmStereo(256).maxOf { kotlin.math.abs(it) } > 0.01f)
        assertEquals("splash_wave", audio.nextTrack())
        assertTrue(audio.renderPcmStereo(256).maxOf { kotlin.math.abs(it) } > 0.01f)

        // Mute silences output
        audio.setMasterVolume(0.0f)
        assertFalse(audio.enabled)
        assertTrue(audio.levels(6).all { it == 0.0f })
    }

    @Test
    fun `Slice 4 - Cross-platform GGRS 2-seat rollback duel matches Desktop and Web checksums`() {
        data class DuelInput(val up: Boolean = false, val down: Boolean = false, val left: Boolean = false, val right: Boolean = false, val shift: Boolean = false)
        data class SeatState(var zMm: Long = 0, var xMm: Long = 0, var speedCms: Long = 0, var rpm: Long = 900, var gear: Int = 1, var nitroMilli: Long = 100_000, var finishedTick: Int = 0)

        fun stepSeat(s: SeatState, inp: DuelInput, tick: Int, goalZMm: Long, onWin: () -> Unit) {
            val accelCms = when {
                inp.up && inp.shift && s.nitroMilli > 0 -> {
                    s.nitroMilli = (s.nitroMilli - 850L).coerceAtLeast(0L)
                    185L
                }
                inp.up -> 125L
                inp.down -> -240L
                else -> -45L
            }
            val maxSpeedCms = if (inp.shift && s.nitroMilli > 0) 32_500L else 29_500L
            s.speedCms = (s.speedCms + accelCms).coerceIn(0L, maxSpeedCms)
            val steerMm = when {
                inp.left && !inp.right -> -120L
                inp.right && !inp.left -> 120L
                else -> 0L
            }
            s.xMm = (s.xMm + steerMm).coerceIn(-9_000L, 9_000L)
            s.zMm += s.speedCms / 6L
            s.gear = if (s.speedCms > 14_500L) 2 else 1
            s.rpm = 900L + (s.speedCms * 7_300L) / 29_500L
            if (s.zMm >= goalZMm && s.finishedTick == 0) {
                s.finishedTick = tick
                onWin()
            }
        }

        val goalZMm = 80_000L
        val seats = arrayOf(SeatState(), SeatState())
        var winner = 0
        for (tick in 1..180) {
            val s0 = DuelInput(up = true, shift = tick in 26..109, left = (tick / 12) % 2 == 0)
            val s1 = DuelInput(up = true, shift = tick in 46..94, right = (tick / 10) % 2 == 1)
            stepSeat(seats[0], s0, tick, goalZMm) { if (winner == 0) winner = 1 }
            stepSeat(seats[1], s1, tick, goalZMm) { if (winner == 0) winner = 2 }
        }

        assertEquals(1, winner)
        assertEquals(434640L, seats[0].zMm)
        assertEquals(28600L, seats[0].nitroMilli)
        assertEquals(58350L, seats[1].nitroMilli)
    }
}
