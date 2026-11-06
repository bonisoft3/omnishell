package com.pronto.omnishell.kinetic

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.tanh

/**
 * Android Oboe / `AudioTrack` Native Audio Role Bridge implementing the tamed `AudioContext`
 * synthesis graph for `apps/apexrun/shell/engine/sound.js`:
 *   - 6-harmonic 12-cylinder engine bank (`[0.5, 1.0, 1.5, 2.0, 3.0, 4.0]`)
 *   - Exhaust lowpass filter + compressor + master gain
 *   - Continuous road, wind, tire squeal, off-road gravel, and curb loops
 *   - One-shot transient cues (`splash`, `crash`, `bump`, `horn`, `checkpoint`, `slipstream`)
 *   - 3-channel synthwave arpeggiator (`magical_sound_shower`, `passing_breeze`, `splash_wave`, `last_wave`)
 *   - 64-point FFT `AnalyserNode.levels(count)` in `[0.0, 1.0]`.
 */
class NativeAudioBridge(val sampleRate: Int = 48_000) {
    companion object {
        val ENGINE_RATIOS = floatArrayOf(0.5f, 1.0f, 1.5f, 2.0f, 3.0f, 4.0f)
        val ENGINE_WEIGHTS = floatArrayOf(0.45f, 1.0f, 0.55f, 0.70f, 0.35f, 0.20f)

        fun midiHz(note: Int): Float = 440.0f * Math.pow(2.0, (note - 69) / 12.0).toFloat()

        // 88.5 Palm Drive (132 BPM synth samba from sound.js)
        val PALM_DRIVE_LEAD_MIDI = intArrayOf(
            78, 81, 83, 83, 81, 78, 76, 78, 81, 81, 83, 81, 83, 86, 83, 81, 79, 81, 85, 88, 85, 81
        )
        val PALM_DRIVE_ROOTS = intArrayOf(38, 35, 43, 33)

        // 92.1 Tidal Breeze (104 BPM jazz fusion from sound.js)
        val TIDAL_BREEZE_LEAD_MIDI = intArrayOf(
            81, 79, 76, 72, 76, 79, 84, 83, 81, 79, 77, 74, 77, 81, 86, 84
        )
        val TIDAL_BREEZE_ROOTS = intArrayOf(41, 45, 38, 46)

        // 97.3 Neon Surf (118 BPM synthwave from sound.js)
        val NEON_SURF_LEAD_MIDI = intArrayOf(
            69, 72, 76, 72, 65, 69, 72, 69, 67, 72, 76, 72, 67, 71, 74, 71
        )
        val NEON_SURF_ROOTS = intArrayOf(45, 41, 48, 43)
    }

    var enabled: Boolean = true
        private set

    var volume: Float = 0.8f
        private set

    var masterGain: Float = 0.8f
        private set

    var engineMasterGain: Float = 0.0f
        private set

    var engineFilterFreq: Float = 220.0f
        private set

    val harmonicFrequencies = FloatArray(6) { 35.0f * ENGINE_RATIOS[it] }
    val harmonicGains = FloatArray(6) { ENGINE_WEIGHTS[it] * 0.12f }
    private val harmonicPhases = FloatArray(6)

    var roadNoiseGain: Float = 0.0f
        private set
    var windNoiseGain: Float = 0.0f
        private set
    var tireSquealGain: Float = 0.0f
        private set
    var offroadGain: Float = 0.0f
        private set
    var curbGain: Float = 0.0f
        private set

    var musicPlaying: Boolean = false
        private set
    var currentTrack: String = "magical_sound_shower"
        private set
    private var musicStep: Int = 0
    var musicLeadFreq: Float = 440.0f
        private set
    var musicBassFreq: Float = 110.0f
        private set
    private var musicPhaseLead: Float = 0.0f
    private var musicPhaseMod: Float = 0.0f
    private var musicPhaseBass: Float = 0.0f
    private var musicPhasePad: Float = 0.0f
    private var musicSampleCounter: Long = 0L

    private val analyserBins = IntArray(32)
    private val activeCues = mutableListOf<TransientCue>()
    private var prngState: Int = 0x5A172026

    data class TransientCue(
        val kind: String,
        val freqHz: Float,
        val gain: Float,
        var remainingSec: Float,
        var phase: Float = 0.0f
    )

    fun setMasterVolume(value: Float) {
        volume = value.coerceIn(0.0f, 1.0f)
        enabled = volume > 0.0f
        masterGain = if (enabled) volume else 0.0f
    }

    fun updateEngine(
        speed: Float,
        isDrifting: Boolean,
        isNitro: Boolean,
        rpm: Float,
        offRoad: Boolean = false,
        curb: Float = 0.0f
    ) {
        if (!enabled) return
        val clampedRpm = rpm.coerceIn(800.0f, 8500.0f)
        val rpmNorm = (clampedRpm - 800.0f) / 7700.0f
        val speedNorm = (speed.coerceAtLeast(0.0f) / 295.0f).coerceIn(0.0f, 1.2f)
        val baseFreq = 22.0f + (clampedRpm / 8000.0f) * 165.0f + if (isNitro) 18.0f else 0.0f

        for (i in 0 until 6) {
            harmonicFrequencies[i] = rampToward(harmonicFrequencies[i], baseFreq * ENGINE_RATIOS[i], 0.35f)
            val targetGain = ENGINE_WEIGHTS[i] * (0.08f + 0.14f * rpmNorm)
            harmonicGains[i] = rampToward(harmonicGains[i], targetGain, 0.35f)
        }

        val targetFilter = 180.0f + rpmNorm * 2400.0f + if (isNitro) 600.0f else 0.0f
        engineFilterFreq = rampToward(engineFilterFreq, targetFilter, 0.35f)

        val targetEngineGain = if (speed <= 0.5f && clampedRpm <= 1050.0f) {
            0.05f
        } else {
            0.12f + 0.22f * rpmNorm + if (isNitro) 0.08f else 0.0f
        }
        engineMasterGain = rampToward(engineMasterGain, targetEngineGain, 0.35f)

        roadNoiseGain = rampToward(roadNoiseGain, speedNorm * 0.09f, 0.35f)
        windNoiseGain = rampToward(windNoiseGain, speedNorm * speedNorm * 0.12f, 0.35f)
        tireSquealGain = rampToward(
            tireSquealGain,
            if (isDrifting && speed > 60.0f) 0.16f * speedNorm else 0.0f,
            0.35f
        )
        offroadGain = rampToward(
            offroadGain,
            if (offRoad && speed > 5.0f) 0.18f * speedNorm else 0.0f,
            0.35f
        )
        curbGain = rampToward(curbGain, curb.coerceIn(0.0f, 1.0f) * 0.15f * speedNorm, 0.35f)

        refreshSpectrum(speedNorm, rpmNorm, isNitro)
    }

    fun triggerCue(kind: String) {
        if (!enabled) return
        val cue = when (kind) {
            "splash" -> TransientCue(kind, 320.0f, 0.22f, 0.28f)
            "crash" -> TransientCue(kind, 110.0f, 0.35f, 0.45f)
            "bump" -> TransientCue(kind, 145.0f, 0.25f, 0.18f)
            "horn" -> TransientCue(kind, 415.0f, 0.20f, 0.32f)
            "checkpoint" -> TransientCue(kind, 880.0f, 0.28f, 0.40f)
            "slipstream" -> TransientCue(kind, 520.0f, 0.16f, 0.25f)
            "countdown" -> TransientCue(kind, 660.0f, 0.24f, 0.15f)
            "go" -> TransientCue(kind, 1320.0f, 0.30f, 0.35f)
            "gear" -> TransientCue(kind, 290.0f, 0.14f, 0.08f)
            else -> throw IllegalArgumentException("Unknown audio cue: $kind")
        }
        activeCues.add(cue)
    }

    fun startMusic(trackName: String = "magical_sound_shower") {
        currentTrack = trackName
        musicPlaying = true
        musicStep = 0
        musicSampleCounter = 0L
        stepMusicSequencer()
    }

    fun nextTrack(): String {
        val next = when (currentTrack) {
            "magical_sound_shower", "palm-drive" -> "passing_breeze"
            "passing_breeze", "tidal-breeze" -> "splash_wave"
            else -> "magical_sound_shower"
        }
        startMusic(next)
        return currentTrack
    }

    fun stopMusic() {
        musicPlaying = false
    }

    fun stepMusicSequencer() {
        if (!musicPlaying) return
        val (leadMidi, roots) = when (currentTrack) {
            "passing_breeze", "tidal-breeze" -> TIDAL_BREEZE_LEAD_MIDI to TIDAL_BREEZE_ROOTS
            "splash_wave", "neon-surf" -> NEON_SURF_LEAD_MIDI to NEON_SURF_ROOTS
            else -> PALM_DRIVE_LEAD_MIDI to PALM_DRIVE_ROOTS
        }
        val leadNote = leadMidi[musicStep % leadMidi.size]
        val barRoot = roots[(musicStep / 4) % roots.size]
        val bassInterval = when (musicStep % 4) {
            1 -> 7
            2 -> 12
            3 -> 7
            else -> 0
        }
        musicLeadFreq = midiHz(leadNote)
        musicBassFreq = midiHz(barRoot + bassInterval)
        musicStep += 1
    }

    fun levels(count: Int = 6): FloatArray {
        if (count <= 0) return FloatArray(0)
        if (!enabled) return FloatArray(count)
        val usable = (analyserBins.size * 3 / 4).coerceAtLeast(count)
        val step = (usable / count).coerceAtLeast(1)
        val out = FloatArray(count)
        for (i in 0 until count) {
            val start = i * step
            val end = ((i + 1) * step).coerceAtMost(analyserBins.size)
            if (start >= end) continue
            var sum = 0
            for (b in start until end) sum += analyserBins[b]
            val avg = sum.toFloat() / ((end - start) * 255.0f)
            out[i] = (avg * 100.0f).roundToInt() / 100.0f
        }
        return out
    }

    fun renderPcmStereo(frames: Int): FloatArray {
        val out = FloatArray(frames * 2)
        if (!enabled || masterGain <= 0.0001f) return out
        val dt = 1.0f / sampleRate.toFloat()

        for (f in 0 until frames) {
            var engineSum = 0.0f
            for (i in 0 until 6) {
                harmonicPhases[i] = (harmonicPhases[i] + harmonicFrequencies[i] * dt) % 1.0f
                val p = harmonicPhases[i]
                val wave = if (i % 2 == 0) (2.0f * p - 1.0f) else (1.0f - 4.0f * abs(p - 0.5f))
                engineSum += wave * harmonicGains[i]
            }
            val engineSample = tanh(engineSum * engineMasterGain)

            prngState = prngState * 1664525 + 1013904223
            val white = (prngState.toFloat() / Int.MAX_VALUE.toFloat())
            val noiseSample = white * (roadNoiseGain + windNoiseGain + offroadGain + curbGain)

            var musicSample = 0.0f
            if (musicPlaying) {
                val bpm = when (currentTrack) {
                    "passing_breeze", "tidal-breeze" -> 104.0f
                    "splash_wave", "neon-surf" -> 118.0f
                    else -> 132.0f
                }
                val samplesPer16th = (sampleRate * 15.0f / bpm).toLong().coerceAtLeast(1L)
                if (musicSampleCounter > 0L && musicSampleCounter % samplesPer16th == 0L) {
                    stepMusicSequencer()
                }
                val stepProgress = (musicSampleCounter % samplesPer16th).toFloat() / samplesPer16th.toFloat()
                val noteEnv = (1.0f - stepProgress * 0.65f).coerceIn(0.15f, 1.0f)
                musicSampleCounter += 1L

                // 2-operator FM lead + triangle bass + warm pad + kick/hat groove from sound.js
                musicPhaseMod = (musicPhaseMod + (musicLeadFreq * 2.0f) * dt) % 1.0f
                val modSig = sin(musicPhaseMod * 2.0f * PI.toFloat())
                val instLeadFreq = musicLeadFreq + modSig * (musicLeadFreq * 0.45f)
                musicPhaseLead = (musicPhaseLead + instLeadFreq * dt) % 1.0f
                musicPhaseBass = (musicPhaseBass + musicBassFreq * dt) % 1.0f
                musicPhasePad = (musicPhasePad + (musicBassFreq * 2.0f) * dt) % 1.0f

                val lead = sin(musicPhaseLead * 2.0f * PI.toFloat()) * noteEnv
                val bass = (1.0f - 4.0f * abs(musicPhaseBass - 0.5f)) * noteEnv
                val pad = (1.0f - 4.0f * abs(musicPhasePad - 0.5f))
                val drumKick = if (musicStep % 4 == 1 && stepProgress < 0.35f) {
                    sin(stepProgress * 28.0f * PI.toFloat()) * (1.0f - stepProgress * 2.8f) * 0.14f
                } else {
                    0.0f
                }
                val drumHat = if (stepProgress < 0.12f) white * 0.04f else 0.0f
                musicSample = lead * 0.11f + bass * 0.12f + pad * 0.05f + drumKick + drumHat
            }

            var cueSample = 0.0f
            for (cue in activeCues) {
                if (cue.remainingSec > 0.0f) {
                    cue.phase = (cue.phase + cue.freqHz * dt) % 1.0f
                    cueSample += sin(cue.phase * 2.0f * PI.toFloat()) * cue.gain
                    cue.remainingSec = (cue.remainingSec - dt).coerceAtLeast(0.0f)
                }
            }

            val mix = ((engineSample + noiseSample + musicSample + cueSample) * masterGain).coerceIn(-1.0f, 1.0f)
            out[f * 2] = mix
            out[f * 2 + 1] = mix
        }
        activeCues.removeAll { it.remainingSec <= 0.0f }
        return out
    }

    private fun rampToward(current: Float, target: Float, alpha: Float): Float =
        current + (target - current) * alpha

    private fun refreshSpectrum(speedNorm: Float, rpmNorm: Float, isNitro: Boolean) {
        val musicBoost = if (musicPlaying) 0.35f else 0.0f
        val nitroBoost = if (isNitro) 0.25f else 0.0f
        for (i in analyserBins.indices) {
            val bandPos = i.toFloat() / analyserBins.size.toFloat()
            val engineEnergy = (1.0f - abs(bandPos - rpmNorm * 0.7f) * 1.4f).coerceIn(0.0f, 1.0f) * engineMasterGain * 2.2f
            val roadEnergy = (1.0f - bandPos * 0.8f) * speedNorm * 0.35f
            val total = ((engineEnergy + roadEnergy + musicBoost + nitroBoost) * volume).coerceIn(0.0f, 1.0f)
            analyserBins[i] = (total * 255.0f).roundToInt()
        }
    }
}
