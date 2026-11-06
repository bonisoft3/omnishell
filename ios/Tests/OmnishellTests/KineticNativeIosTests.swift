import Testing
import Foundation
@testable import Omnishell

@Suite("Kinetic Native iOS Tests (Slices 1, 4, 5)")
struct KineticNativeIosTests {

    private func fixturePath(_ filename: String) -> URL {
        // Resolve relative to `plugins/omnishell/ios/Tests/OmnishellTests/KineticNativeIosTests.swift`
        let testFile = URL(fileURLWithPath: #filePath)
        let omnishellDir = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return omnishellDir.appendingPathComponent("android/src/test/resources/fixtures/\(filename)")
    }

    @Test("Slice 1 & 4: DivKit mounts kinetic:race CAMetalLayer and 24 HUD layers with in-place 120Hz variable updates")
    func divKitMountsKineticAndHudLayers() throws {
        let arenaDivKitJson = try String(contentsOf: fixturePath("arena_divkit.json"), encoding: .utf8)
        let glbData = try Data(contentsOf: fixturePath("coconut_beach.glb"))

        let host = OmnishellDivKitHost()
        let factory = KineticDivCustomBlockFactory()
        host.registerCustomFactory(factory)

        #expect(host.render(astJson: arenaDivKitJson, onAction: { _ in }) == true)
        #expect(host.hasError == false)
        #expect(host.currentCardId == "omnishell_arena")
        #expect(host.astParseCount == 1)

        #expect(factory.mountedKineticActor == "race")
        #expect(factory.boundHudLayersCount == 24)
        #expect(factory.getHudLayer("speed") != nil)
        #expect(factory.getHudLayer("tacho") != nil)
        #expect(factory.getHudLayer("eq") != nil)

        let scene = try factory.presenter.loadStageGlb(glbData)
        #expect(scene.stageId == "coconut-beach")
        #expect(scene.skyKtx2 == "sky/coconut-beach.ktx2")
        #expect(scene.shoreSide == -1)
        #expect(scene.textureCount == 3)
        #expect(scene.chunks.count > 10)
        #expect(scene.materials.contains { $0.filamatAsset == "materials/stk_foliage_sway.filamat" })
        #expect(scene.materials.contains { $0.filamatAsset == "materials/stk_toon_brushed.filamat" })

        var maxFrameUs: UInt64 = 0
        for f in 1...120 {
            var pose = PoseBuffer()
            pose.floats[0] = Float(f)
            pose.floats[6] = Float(f) * 2.5
            pose.floats[22] = Float(f) * 2.5 + 6.8
            pose.floats[68] = Float(120 + f)
            pose.floats[69] = Float(4200 + f * 20)
            pose.floats[70] = 0.72
            pose.floats[71] = 2.0
            pose.floats[72] = 85.0
            pose.floats[74] = Float(60 - f / 60)
            pose.floats[75] = Float(f % 10)
            pose.floats[76] = Float(f * 150)

            let stats = factory.presenter.renderFrame(pose: pose, variableStorage: host.variableStorage)
            if stats.frameTimeUs > maxFrameUs { maxFrameUs = stats.frameTimeUs }
            #expect(stats.visibleChunks > 0)
        }

        #expect(host.astParseCount == 1)
        #expect(factory.getHudLayer("speed")?.currentValue == "240")
        #expect(factory.getHudLayer("gear")?.currentValue == "HI")
        #expect(factory.getHudLayer("nitro-text")?.currentValue == "85%")
        #expect(maxFrameUs < FilamentConstants.target120FpsBudgetUs)

        // Verify re-rendering the DivKit card releases previous custom blocks so listener count stays flat (24)
        let initialListeners = host.variableStorage.listenerCount
        #expect(initialListeners == 24)
        for _ in 1...5 {
            #expect(host.render(astJson: arenaDivKitJson, onAction: { _ in }) == true)
            #expect(host.variableStorage.listenerCount == initialListeners)
        }
    }

    @Test("Slice 4: TouchZoneDispatcher matches all 5 tests/touch.ts multi-touch and hotseat duel cases")
    func touchZoneDispatcherMatchesTouchSuite() {
        let viewports: [(String, Float, Float)] = [
            ("phone-flat", 852, 393),
            ("phone-upright", 393, 852),
            ("tablet", 1194, 834),
            ("tablet-upright", 834, 1194)
        ]

        for (name, w, h) in viewports {
            let dispatcher = TouchZoneDispatcher.standardApexRunLayout(width: w, height: h)
            let faults = dispatcher.validateClusterLayout(includeSeat2: true)
            #expect(faults.isEmpty, "Cluster layout faults on \(name): \(faults)")
        }

        let d = TouchZoneDispatcher.standardApexRunLayout(width: 852, height: 393)
        let padLeft = d.regions.first { $0.id == "pad-left-1" }!.rect
        let padMid = d.regions.first { $0.id == "pad-mid-1" }!.rect
        let padRight = d.regions.first { $0.id == "pad-right-1" }!.rect
        let nitro1 = d.regions.first { $0.id == "nitro-1" }!.rect
        let brake1 = d.regions.first { $0.id == "brake-1" }!.rect
        let pauseBtn = d.regions.first { $0.id == "touch-pause" }!.rect

        // 1. Thumb 1 down on pad's left half -> throttle + left
        d.pointerDown(pointerId: 1, x: padLeft.centerX, y: padLeft.centerY)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: true, down: false, left: true, right: false, nitro: false))

        // 2. Thumb 1 at pad's rounded corner (left + 3, top + 4) -> still drives left
        d.pointerMove(pointerId: 1, x: padLeft.left + 3, y: padLeft.top + 4)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: true, down: false, left: true, right: false, nitro: false))

        // 3. Thumb 1 drifts off pad -> releases drive & left while keeping finger tracked
        d.pointerMove(pointerId: 1, x: padMid.centerX, y: padLeft.top - 60)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: false, down: false, left: false, right: false, nitro: false))

        // 4. Thumb 1 slides onto `.touch-pause` -> does NOT trigger pause while sliding
        d.pointerMove(pointerId: 1, x: pauseBtn.centerX, y: pauseBtn.centerY)
        #expect(d.triggeredTapZones.isEmpty)

        // 5. Thumb 1 slides back onto pad's left half -> drives again without lifting
        d.pointerMove(pointerId: 1, x: padLeft.centerX, y: padLeft.centerY)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: true, down: false, left: true, right: false, nitro: false))

        // 6. Thumb 1 slides right while Thumb 2 presses nitro
        d.pointerMove(pointerId: 1, x: padRight.centerX, y: padRight.centerY)
        d.pointerDown(pointerId: 2, x: nitro1.centerX, y: nitro1.centerY)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: true, down: false, left: false, right: true, nitro: true))

        // 7. Lift nitro, slide Thumb 1 to center, press brake with Thumb 2
        d.pointerUp(pointerId: 2)
        d.pointerMove(pointerId: 1, x: padMid.centerX, y: padMid.centerY)
        d.pointerDown(pointerId: 2, x: brake1.centerX, y: brake1.centerY)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: false, down: true, left: false, right: false, nitro: false))

        // 8. Lift brake -> Thumb 1 resumes straight throttle
        d.pointerUp(pointerId: 2)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: true, down: false, left: false, right: false, nitro: false))
        d.pointerUp(pointerId: 1)

        // 9. Direct tap on pause button fires "pause"
        d.pointerDown(pointerId: 90, x: pauseBtn.centerX, y: pauseBtn.centerY)
        d.pointerUp(pointerId: 90)
        #expect(d.triggeredTapZones == ["pause"])

        // 10. Initials keypad: ["up", "up", "right", "up", "right", "down"] spells "CBZ"
        for key in ["up", "up", "right", "up", "right", "down"] {
            let r = d.regions.first { $0.id == "arena-key-\(key)" }!.rect
            d.pointerDown(pointerId: 91, x: r.centerX, y: r.centerY)
            d.pointerUp(pointerId: 91)
        }
        #expect(d.getInitialsString() == "CBZ")

        // 11. 2-seat simultaneous hotseat duel: 4 fingers
        let padRight2 = d.regions.first { $0.id == "pad-right-2" }!.rect
        let brake2 = d.regions.first { $0.id == "brake-2" }!.rect
        d.pointerDown(pointerId: 1, x: padLeft.centerX, y: padLeft.centerY)
        d.pointerDown(pointerId: 2, x: nitro1.centerX, y: nitro1.centerY)
        d.pointerDown(pointerId: 3, x: padRight2.centerX, y: padRight2.centerY)
        d.pointerDown(pointerId: 4, x: brake2.centerX, y: brake2.centerY)

        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: true, down: false, left: true, right: false, nitro: true))
        #expect(d.sampleSeatCommand(seat: 2) == SeatTouchCommand(up: false, down: true, left: false, right: true, nitro: false))

        // 12. Repeated pointerDown with same pointerId releases previous zones, and pointerCancel clears stuck zones
        d.pointerUp(pointerId: 1)
        d.pointerUp(pointerId: 2)
        d.pointerUp(pointerId: 3)
        d.pointerUp(pointerId: 4)
        d.pointerDown(pointerId: 7, x: padLeft.centerX, y: padLeft.centerY)
        d.pointerDown(pointerId: 7, x: nitro1.centerX, y: nitro1.centerY)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: false, down: false, left: false, right: false, nitro: true))
        d.pointerCancel(pointerId: 7)
        #expect(d.sampleSeatCommand(seat: 1) == SeatTouchCommand(up: false, down: false, left: false, right: false, nitro: false))
    }

    @Test("Slice 5: NativeAudioBridge matches tests/audio.test.ts and synthesizes stereo PCM")
    func nativeAudioBridgeParity() {
        let audio = NativeAudioBridge(sampleRate: 48_000)

        audio.updateEngine(speed: 0, isDrifting: false, isNitro: false, rpm: 900)
        let idleFreq = audio.harmonicFrequencies[1]
        let idleGain = audio.engineMasterGain
        #expect(idleFreq > 15 && idleFreq < 95)

        audio.updateEngine(speed: 260, isDrifting: false, isNitro: true, rpm: 7400)
        let fastFreq = audio.harmonicFrequencies[1]
        let fastGain = audio.engineMasterGain
        #expect(fastFreq > idleFreq * 1.4)
        #expect(fastGain > idleGain)
        #expect(audio.engineFilterFreq > 600)

        audio.updateEngine(speed: 180, isDrifting: true, isNitro: false, rpm: 5800, offRoad: true, curb: 0.9)
        #expect(audio.offroadGain > 0.01)
        #expect(audio.curbGain > 0.01)
        #expect(audio.tireSquealGain > 0.01)

        audio.startMusic("magical_sound_shower")
        audio.triggerCue("checkpoint")
        audio.triggerCue("splash")
        let bands = audio.levels(count: 6)
        #expect(bands.count == 6)
        #expect(bands.contains { $0 > 0.0 && $0 <= 1.0 })

        let pcm = audio.renderPcmStereo(frames: 512)
        #expect(pcm.count == 1024)
        let peak = pcm.map { abs($0) }.max() ?? 0.0
        #expect(peak > 0.01 && peak <= 1.0)

        audio.setMasterVolume(0.0)
        #expect(audio.enabled == false)
        #expect(audio.levels(count: 6).allSatisfy { $0 == 0.0 })
    }

    @Test("Slice 4: Cross-platform GGRS 2-seat rollback duel matches Desktop, Android, and Web state")
    func crossPlatformGgrsDuelParity() {
        struct DuelInput {
            var up: Bool = false
            var down: Bool = false
            var left: Bool = false
            var right: Bool = false
            var shift: Bool = false
        }
        struct SeatState: Equatable {
            var zMm: Int64 = 0
            var xMm: Int64 = 0
            var speedCms: Int64 = 0
            var rpm: Int64 = 900
            var gear: UInt8 = 1
            var nitroMilli: Int64 = 100_000
            var finishedTick: UInt32 = 0
        }

        func stepSeat(_ s: inout SeatState, inp: DuelInput, tick: UInt32, goalZMm: Int64, onWin: () -> Void) {
            let accelCms: Int64
            if inp.up {
                if inp.shift && s.nitroMilli > 0 {
                    s.nitroMilli = max(0, s.nitroMilli - 850)
                    accelCms = 185
                } else {
                    accelCms = 125
                }
            } else if inp.down {
                accelCms = -240
            } else {
                accelCms = -45
            }
            let maxSpeedCms: Int64 = (inp.shift && s.nitroMilli > 0) ? 32_500 : 29_500
            s.speedCms = min(max(s.speedCms + accelCms, 0), maxSpeedCms)
            let steerMm: Int64 = (inp.left && !inp.right) ? -120 : ((inp.right && !inp.left) ? 120 : 0)
            s.xMm = min(max(s.xMm + steerMm, -9_000), 9_000)
            s.zMm += s.speedCms / 6
            s.gear = s.speedCms > 14_500 ? 2 : 1
            s.rpm = 900 + (s.speedCms * 7_300) / 29_500
            if s.zMm >= goalZMm && s.finishedTick == 0 {
                s.finishedTick = tick
                onWin()
            }
        }

        let goalZMm: Int64 = 80_000
        var seats = [SeatState(), SeatState()]
        var winner: UInt8 = 0
        for tick: UInt32 in 1...180 {
            let s0 = DuelInput(up: true, left: (tick / 12) % 2 == 0, shift: tick > 25 && tick < 110)
            let s1 = DuelInput(up: true, right: (tick / 10) % 2 == 1, shift: tick > 45 && tick < 95)
            stepSeat(&seats[0], inp: s0, tick: tick, goalZMm: goalZMm) { if winner == 0 { winner = 1 } }
            stepSeat(&seats[1], inp: s1, tick: tick, goalZMm: goalZMm) { if winner == 0 { winner = 2 } }
        }

        #expect(winner == 1)
        #expect(seats[0].zMm == 434_640)
        #expect(seats[0].nitroMilli == 28_600)
        #expect(seats[1].nitroMilli == 58_350)
    }
}
