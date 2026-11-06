import Foundation

/// iOS CoreAudio / `AVAudioEngine` Native Audio Role Bridge implementing the tamed `AudioContext`
/// synthesis graph for `apps/apexrun/shell/engine/sound.js`.
public final class NativeAudioBridge: @unchecked Sendable {
    public static let engineRatios: [Float] = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0]
    public static let engineWeights: [Float] = [0.45, 1.0, 0.55, 0.70, 0.35, 0.20]

    public let sampleRate: Int
    public private(set) var enabled: Bool = true
    public private(set) var volume: Float = 0.8
    public private(set) var masterGain: Float = 0.8
    public private(set) var engineMasterGain: Float = 0.0
    public private(set) var engineFilterFreq: Float = 220.0

    public private(set) var harmonicFrequencies: [Float]
    public private(set) var harmonicGains: [Float]
    private var harmonicPhases: [Float] = Array(repeating: 0.0, count: 6)

    public private(set) var roadNoiseGain: Float = 0.0
    public private(set) var windNoiseGain: Float = 0.0
    public private(set) var tireSquealGain: Float = 0.0
    public private(set) var offroadGain: Float = 0.0
    public private(set) var curbGain: Float = 0.0

    public private(set) var musicPlaying: Bool = false
    public private(set) var currentTrack: String = "magical_sound_shower"
    private var musicStep: Int = 0
    public private(set) var musicLeadFreq: Float = 440.0
    public private(set) var musicBassFreq: Float = 110.0
    private var musicPhaseLead: Float = 0.0
    private var musicPhaseBass: Float = 0.0

    private var analyserBins: [Int] = Array(repeating: 0, count: 32)
    private var activeCues: [(kind: String, freqHz: Float, gain: Float, remainingSec: Float, phase: Float)] = []
    private var prngState: UInt32 = 0x5A17_2026

    public init(sampleRate: Int = 48_000) {
        self.sampleRate = sampleRate
        self.harmonicFrequencies = Self.engineRatios.map { 35.0 * $0 }
        self.harmonicGains = Self.engineWeights.map { $0 * 0.12 }
    }

    public func setMasterVolume(_ value: Float) {
        volume = min(max(value, 0.0), 1.0)
        enabled = volume > 0.0
        masterGain = enabled ? volume : 0.0
    }

    public func updateEngine(
        speed: Float,
        isDrifting: Bool,
        isNitro: Bool,
        rpm: Float,
        offRoad: Bool = false,
        curb: Float = 0.0
    ) {
        guard enabled else { return }
        let clampedRpm = min(max(rpm, 800.0), 8500.0)
        let rpmNorm = (clampedRpm - 800.0) / 7700.0
        let speedNorm = min(max(speed / 295.0, 0.0), 1.2)
        let baseFreq: Float = 22.0 + (clampedRpm / 8000.0) * 165.0 + (isNitro ? 18.0 : 0.0)

        for i in 0..<6 {
            harmonicFrequencies[i] = rampToward(harmonicFrequencies[i], baseFreq * Self.engineRatios[i], 0.35)
            let targetGain = Self.engineWeights[i] * (0.08 + 0.14 * rpmNorm)
            harmonicGains[i] = rampToward(harmonicGains[i], targetGain, 0.35)
        }

        let targetFilter: Float = 180.0 + rpmNorm * 2400.0 + (isNitro ? 600.0 : 0.0)
        engineFilterFreq = rampToward(engineFilterFreq, targetFilter, 0.35)

        let targetEngineGain: Float = (speed <= 0.5 && clampedRpm <= 1050.0)
            ? 0.05
            : (0.12 + 0.22 * rpmNorm + (isNitro ? 0.08 : 0.0))
        engineMasterGain = rampToward(engineMasterGain, targetEngineGain, 0.35)

        roadNoiseGain = rampToward(roadNoiseGain, speedNorm * 0.09, 0.35)
        windNoiseGain = rampToward(windNoiseGain, speedNorm * speedNorm * 0.12, 0.35)
        tireSquealGain = rampToward(tireSquealGain, (isDrifting && speed > 60.0) ? 0.16 * speedNorm : 0.0, 0.35)
        offroadGain = rampToward(offroadGain, (offRoad && speed > 5.0) ? 0.18 * speedNorm : 0.0, 0.35)
        curbGain = rampToward(curbGain, min(max(curb, 0.0), 1.0) * 0.15 * speedNorm, 0.35)

        refreshSpectrum(speedNorm: speedNorm, rpmNorm: rpmNorm, isNitro: isNitro)
    }

    public func triggerCue(_ kind: String) {
        guard enabled else { return }
        let spec: (Float, Float, Float) = switch kind {
        case "splash": (320.0, 0.22, 0.28)
        case "crash": (110.0, 0.35, 0.45)
        case "bump": (145.0, 0.25, 0.18)
        case "horn": (415.0, 0.20, 0.32)
        case "checkpoint": (880.0, 0.28, 0.40)
        case "slipstream": (520.0, 0.16, 0.25)
        case "countdown": (660.0, 0.24, 0.15)
        case "go": (1320.0, 0.30, 0.35)
        case "gear": (290.0, 0.14, 0.08)
        default: preconditionFailure("Unknown audio cue: \(kind)")
        }
        activeCues.append((kind: kind, freqHz: spec.0, gain: spec.1, remainingSec: spec.2, phase: 0.0))
    }

    public func startMusic(_ trackName: String = "magical_sound_shower") {
        currentTrack = trackName
        musicPlaying = true
        musicStep = 0
        stepMusicSequencer()
    }

    public func stopMusic() {
        musicPlaying = false
    }

    public func stepMusicSequencer() {
        guard musicPlaying else { return }
        let notes: [Float] = switch currentTrack {
        case "passing_breeze": [392.0, 440.0, 523.25, 659.25, 587.33, 523.25, 440.0, 392.0]
        case "splash_wave": [523.25, 659.25, 783.99, 659.25, 587.33, 698.46, 783.99, 880.0]
        case "last_wave": [293.66, 349.23, 440.0, 523.25, 440.0, 349.23, 329.63, 293.66]
        default: [440.0, 554.37, 659.25, 880.0, 783.99, 659.25, 587.33, 554.37]
        }
        let f = notes[musicStep % notes.count]
        musicLeadFreq = f
        musicBassFreq = f * 0.25
        musicStep += 1
    }

    public func levels(count: Int = 6) -> [Float] {
        guard count > 0 else { return [] }
        guard enabled else { return Array(repeating: 0.0, count: count) }
        let usable = max((analyserBins.count * 3) / 4, count)
        let step = max(usable / count, 1)
        var out = Array(repeating: Float(0.0), count: count)
        for i in 0..<count {
            let start = i * step
            let end = min((i + 1) * step, analyserBins.count)
            guard start < end else { continue }
            var sum = 0
            for b in start..<end { sum += analyserBins[b] }
            let avg = Float(sum) / (Float(end - start) * 255.0)
            out[i] = (avg * 100.0).rounded() / 100.0
        }
        return out
    }

    public func renderPcmStereo(frames: Int) -> [Float] {
        var out = Array(repeating: Float(0.0), count: frames * 2)
        guard enabled && masterGain > 0.0001 else { return out }
        let dt = 1.0 / Float(sampleRate)

        for f in 0..<frames {
            var engineSum: Float = 0.0
            for i in 0..<6 {
                harmonicPhases[i] = (harmonicPhases[i] + harmonicFrequencies[i] * dt).truncatingRemainder(dividingBy: 1.0)
                let p = harmonicPhases[i]
                let wave: Float = (i % 2 == 0) ? (2.0 * p - 1.0) : (1.0 - 4.0 * abs(p - 0.5))
                engineSum += wave * harmonicGains[i]
            }
            let engineSample = tanh(engineSum * engineMasterGain)

            prngState = prngState &* 1_664_525 &+ 1_013_904_223
            let white = (Float(prngState) / Float(UInt32.max)) * 2.0 - 1.0
            let noiseSample = white * (roadNoiseGain + windNoiseGain + offroadGain + curbGain)

            var musicSample: Float = 0.0
            if musicPlaying {
                musicPhaseLead = (musicPhaseLead + musicLeadFreq * dt).truncatingRemainder(dividingBy: 1.0)
                musicPhaseBass = (musicPhaseBass + musicBassFreq * dt).truncatingRemainder(dividingBy: 1.0)
                let lead: Float = 2.0 * musicPhaseLead - 1.0
                let bass: Float = musicPhaseBass < 0.5 ? 1.0 : -1.0
                musicSample = lead * 0.10 + bass * 0.12
            }

            var cueSample: Float = 0.0
            for idx in activeCues.indices {
                if activeCues[idx].remainingSec > 0.0 {
                    activeCues[idx].phase = (activeCues[idx].phase + activeCues[idx].freqHz * dt).truncatingRemainder(dividingBy: 1.0)
                    cueSample += sin(activeCues[idx].phase * 2.0 * Float.pi) * activeCues[idx].gain
                    activeCues[idx].remainingSec = max(0.0, activeCues[idx].remainingSec - dt)
                }
            }

            let mix = min(max((engineSample + noiseSample + musicSample + cueSample) * masterGain, -1.0), 1.0)
            out[f * 2] = mix
            out[f * 2 + 1] = mix
        }
        activeCues.removeAll { $0.remainingSec <= 0.0 }
        return out
    }

    private func rampToward(_ current: Float, _ target: Float, _ alpha: Float) -> Float {
        return current + (target - current) * alpha
    }

    private func refreshSpectrum(speedNorm: Float, rpmNorm: Float, isNitro: Bool) {
        let musicBoost: Float = musicPlaying ? 0.35 : 0.0
        let nitroBoost: Float = isNitro ? 0.25 : 0.0
        for i in analyserBins.indices {
            let bandPos = Float(i) / Float(analyserBins.count)
            let engineEnergy = min(max(1.0 - abs(bandPos - rpmNorm * 0.7) * 1.4, 0.0), 1.0) * engineMasterGain * 2.2
            let roadEnergy = (1.0 - bandPos * 0.8) * speedNorm * 0.35
            let total = min(max((engineEnergy + roadEnergy + musicBoost + nitroBoost) * volume, 0.0), 1.0)
            analyserBins[i] = Int((total * 255.0).rounded())
        }
    }
}
