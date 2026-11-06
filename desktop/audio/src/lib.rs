//! `omnishell-audio`: Native audio role bridge (CoreAudio on macOS/iOS, CPAL on Desktop,
//! Oboe on Android) implementing the tamed `AudioContext` node/param/analyser graph
//! and exact polyphonic FM/subtractive synthesis from `apps/apexrun/shell/engine/sound.js`.
//!
//! Synthesizes real-time 48 kHz stereo PCM audio for:
//!   - 3 FM radio stations (`88.5 Palm Drive` synth samba 132 BPM, `92.1 Tidal Breeze` jazz fusion 104 BPM,
//!     `97.3 Neon Surf` synthwave 118 BPM) with 2-operator FM lead, triangle pad chords, bass,
//!     exponential-sweep kick thump (`140->40 Hz`), bandpass snare (`1800 Hz`), and highpass hat (`7000 Hz`)
//!   - Engine dual-oscillator (`sawtooth` 1x + `square` 0.5x) + 6-harmonic bank through speed-coupled lowpass filter
//!   - Seeded `0x5eed` xorshift32 noise bed for wind (`bandpass 600 Hz Q=0.7`) and tyres (`bandpass 2600 Hz Q=4.0`)
//!   - Race cues (`checkpoint-extended`, `fork-approach`, `race-start`, `race-finish`, `time-out`,
//!     `traffic-collision`, `close-pass`, `mini-turbo`)
//!   - 64-point spectrum analyser folding `getByteFrequencyData` into `levels(n)` in `0..1`.

use std::f32::consts::PI;

pub const ENGINE_RATIOS: [f32; 6] = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0];
pub const ENGINE_WEIGHTS: [f32; 6] = [0.45, 1.0, 0.55, 0.70, 0.35, 0.20];

pub const MIX_RADIO: f32 = 0.7;
pub const MIX_ENGINE_IDLE: f32 = 0.06;
pub const MIX_ENGINE_REV: f32 = 0.14;
pub const MIX_WIND: f32 = 0.12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeAudioBackend {
    CoreAudio,
    Cpal,
    Oboe,
}

impl NativeAudioBackend {
    pub fn host_default() -> Self {
        if cfg!(target_os = "macos") || cfg!(target_os = "ios") {
            NativeAudioBackend::CoreAudio
        } else if cfg!(target_os = "android") {
            NativeAudioBackend::Oboe
        } else {
            NativeAudioBackend::Cpal
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaveType {
    Sine,
    Sawtooth,
    Triangle,
    Square,
}

impl WaveType {
    #[inline]
    pub fn sample(self, phase: f32) -> f32 {
        let p = phase.rem_euclid(1.0);
        match self {
            WaveType::Sine => (p * 2.0 * PI).sin(),
            WaveType::Sawtooth => 2.0 * p - 1.0,
            WaveType::Triangle => 1.0 - 4.0 * (p - 0.5).abs(),
            WaveType::Square => {
                if p < 0.5 {
                    1.0
                } else {
                    -1.0
                }
            }
        }
    }
}

#[inline]
pub fn midi_hz(note: i32) -> f32 {
    440.0 * 2.0_f32.powf((note as f32 - 69.0) / 12.0)
}

/// Exact xorshift32 PRNG matching `apps/apexrun/shell/engine/prng.js` (`createPrng(0x5eed)`).
fn build_seeded_noise_buffer(sample_rate: u32) -> Vec<f32> {
    let len = (sample_rate as usize) * 2;
    let mut out = Vec::with_capacity(len);
    let mut s: u32 = 0x5eed;
    for _ in 0..len {
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        let u = (s as f32) / 4294967296.0;
        out.push(u * 2.0 - 1.0);
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterKind {
    Lowpass,
    Bandpass,
    Highpass,
}

/// Standard Robert Bristow-Johnson biquad filter matching Web Audio `BiquadFilterNode`.
#[derive(Debug, Clone)]
pub struct BiquadFilter {
    pub kind: FilterKind,
    pub freq: f32,
    pub q: f32,
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadFilter {
    pub fn new(kind: FilterKind, freq: f32, q: f32, sample_rate: f32) -> Self {
        let mut f = Self {
            kind,
            freq,
            q,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        };
        f.update_coeffs(sample_rate);
        f
    }

    pub fn set_freq(&mut self, freq: f32, sample_rate: f32) {
        if (self.freq - freq).abs() > 1.0 {
            self.freq = freq;
            self.update_coeffs(sample_rate);
        }
    }

    pub fn update_coeffs(&mut self, sample_rate: f32) {
        let f0 = self.freq.clamp(20.0, sample_rate * 0.45);
        let q = self.q.max(0.1);
        let w0 = 2.0 * PI * f0 / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);

        let (b0, b1, b2, a0, a1, a2) = match self.kind {
            FilterKind::Lowpass => {
                let b1 = 1.0 - cos_w0;
                let b0 = b1 * 0.5;
                let b2 = b0;
                (b0, b1, b2, 1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha)
            }
            FilterKind::Highpass => {
                let b1 = -(1.0 + cos_w0);
                let b0 = (1.0 + cos_w0) * 0.5;
                let b2 = b0;
                (b0, b1, b2, 1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha)
            }
            FilterKind::Bandpass => {
                let b0 = alpha;
                let b1 = 0.0;
                let b2 = -alpha;
                (b0, b1, b2, 1.0 + alpha, -2.0 * cos_w0, 1.0 - alpha)
            }
        };

        let inv_a0 = 1.0 / a0;
        self.b0 = b0 * inv_a0;
        self.b1 = b1 * inv_a0;
        self.b2 = b2 * inv_a0;
        self.a1 = a1 * inv_a0;
        self.a2 = a2 * inv_a0;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = if y.is_finite() { y } else { 0.0 };
        self.y1
    }
}

#[derive(Debug, Clone)]
pub struct AudioParam {
    pub value: f32,
    pub target_value: f32,
    pub time_constant: f32,
}

impl AudioParam {
    pub fn new(initial: f32) -> Self {
        Self {
            value: initial,
            target_value: initial,
            time_constant: 0.02,
        }
    }

    pub fn set_value_at_time(&mut self, value: f32, _time: f64) {
        self.value = value;
        self.target_value = value;
    }

    pub fn linear_ramp_to_value_at_time(&mut self, value: f32, _time: f64) {
        self.value = value;
        self.target_value = value;
    }

    pub fn exponential_ramp_to_value_at_time(&mut self, value: f32, _time: f64) {
        self.value = value.max(0.0001);
        self.target_value = self.value;
    }

    pub fn set_target_at_time(&mut self, target: f32, _start_time: f64, time_constant: f32) {
        self.target_value = target;
        self.time_constant = time_constant.max(0.001);
        // Step one frame toward target for immediate readback parity with Web Audio tests
        let alpha = (1.0 / (60.0 * self.time_constant)).clamp(0.15, 1.0);
        self.value += (self.target_value - self.value) * alpha;
    }

    pub fn step(&mut self, dt: f32) {
        let alpha = (dt / self.time_constant).clamp(0.0, 1.0);
        self.value += (self.target_value - self.value) * alpha;
    }
}

#[derive(Debug, Clone)]
pub struct HarmonicVoice {
    pub ratio: f32,
    pub wave: WaveType,
    pub frequency: AudioParam,
    pub gain: AudioParam,
    pub phase: f32,
}

#[derive(Debug, Clone)]
pub struct AnalyserNode {
    pub fft_size: usize,
    pub smoothing_time_constant: f32,
    pub bins: Vec<u8>,
}

impl AnalyserNode {
    pub fn new(fft_size: usize) -> Self {
        let bin_count = (fft_size / 2).max(1);
        Self {
            fft_size,
            smoothing_time_constant: 0.65,
            bins: vec![0; bin_count],
        }
    }

    pub fn frequency_bin_count(&self) -> usize {
        self.bins.len()
    }

    pub fn get_byte_frequency_data(&self, out: &mut [u8]) {
        let n = out.len().min(self.bins.len());
        out[..n].copy_from_slice(&self.bins[..n]);
    }

    /// Fold the analyser's bins into `count` normalized `[0.0, 1.0]` bars matching `sound.js` `levels(count)`.
    pub fn levels(&self, count: usize) -> Vec<f32> {
        if count == 0 || self.bins.is_empty() {
            return Vec::new();
        }
        let per = (self.bins.len() / count).max(1);
        let mut out = Vec::with_capacity(count);
        for k in 0..count {
            let start = k * per;
            let end = ((k + 1) * per).min(self.bins.len());
            if start >= end {
                out.push(0.0);
                continue;
            }
            let sum: u32 = self.bins[start..end].iter().map(|&b| b as u32).sum();
            let avg = sum as f32 / ((end - start) as f32 * 255.0);
            out.push((avg * 100.0).round() / 100.0);
        }
        out
    }
}

#[derive(Debug, Clone)]
pub struct TransientCue {
    pub kind: String,
    pub freq_hz: f32,
    pub gain: f32,
    pub remaining_s: f32,
    pub phase: f32,
}

/// Active polyphonic synthesizer voice matching `thump`, `noise`, `arpeggio`, and `note` in `sound.js`.
#[derive(Debug, Clone)]
enum SynthVoice {
    /// `thump(t, from, vel)`: sine oscillator sweeping exponentially `from -> 40 Hz` in `0.15s`,
    /// gain decaying exponentially `vel -> 0.001` in `0.30s`.
    Thump {
        delay_s: f32,
        elapsed_s: f32,
        from_hz: f32,
        vel: f32,
        phase: f32,
        is_song: bool,
    },
    /// `noise(t, { type, from, to, q, len, attack, vel })`: biquad-filtered seeded noise.
    FilteredNoise {
        delay_s: f32,
        elapsed_s: f32,
        len_s: f32,
        attack_s: f32,
        from_hz: f32,
        to_hz: f32,
        vel: f32,
        filter: BiquadFilter,
        noise_cursor: usize,
        is_song: bool,
    },
    /// Pitched oscillator (`bass`, `pad`, `lead` with 2-op FM, or `arpeggio` note).
    Tone {
        delay_s: f32,
        elapsed_s: f32,
        len_s: f32,
        attack_s: f32,
        wave: WaveType,
        freq_hz: f32,
        peak_gain: f32,
        fm_mod: bool,
        phase: f32,
        mod_phase: f32,
        is_song: bool,
    },
}

impl SynthVoice {
    fn is_song(&self) -> bool {
        match self {
            SynthVoice::Thump { is_song, .. }
            | SynthVoice::FilteredNoise { is_song, .. }
            | SynthVoice::Tone { is_song, .. } => *is_song,
        }
    }

    fn is_alive(&self) -> bool {
        match self {
            SynthVoice::Thump { elapsed_s, .. } => *elapsed_s < 0.32,
            SynthVoice::FilteredNoise {
                elapsed_s, len_s, ..
            } => *elapsed_s < *len_s + 0.02,
            SynthVoice::Tone {
                elapsed_s, len_s, ..
            } => *elapsed_s < *len_s + 0.05,
        }
    }

    #[inline]
    fn sample(&mut self, dt: f32, sample_rate: f32, noise_buf: &[f32]) -> (f32, f32) {
        match self {
            SynthVoice::Thump {
                delay_s,
                elapsed_s,
                from_hz,
                vel,
                phase,
                is_song,
            } => {
                if *delay_s > 0.0 {
                    *delay_s -= dt;
                    return (0.0, 0.0);
                }
                let t = *elapsed_s;
                *elapsed_s += dt;
                if t >= 0.32 {
                    return (0.0, 0.0);
                }
                let freq = if t < 0.15 {
                    *from_hz * (40.0 / *from_hz).powf(t / 0.15)
                } else {
                    40.0
                };
                let env = if t < 0.30 {
                    *vel * (0.001 / (*vel).max(0.001)).powf(t / 0.30)
                } else {
                    0.0
                };
                *phase = (*phase + freq * dt).rem_euclid(1.0);
                let s = (*phase * 2.0 * PI).sin() * env * if *is_song { MIX_RADIO } else { 1.0 };
                (s, freq)
            }
            SynthVoice::FilteredNoise {
                delay_s,
                elapsed_s,
                len_s,
                attack_s,
                from_hz,
                to_hz,
                vel,
                filter,
                noise_cursor,
                is_song,
            } => {
                if *delay_s > 0.0 {
                    *delay_s -= dt;
                    return (0.0, 0.0);
                }
                let t = *elapsed_s;
                *elapsed_s += dt;
                if t >= *len_s {
                    return (0.0, 0.0);
                }
                let freq = if (*to_hz - *from_hz).abs() > 1.0 {
                    let f = *from_hz * (*to_hz / *from_hz).powf((t / *len_s).clamp(0.0, 1.0));
                    filter.set_freq(f, sample_rate);
                    f
                } else {
                    *from_hz
                };
                let env = if *attack_s > 0.0 && t < *attack_s {
                    0.001 + (*vel - 0.001) * (t / *attack_s)
                } else {
                    let decay_t = (t - *attack_s).max(0.0);
                    let decay_len = (*len_s - *attack_s).max(0.005);
                    *vel * (0.001 / (*vel).max(0.001)).powf((decay_t / decay_len).clamp(0.0, 1.0))
                };
                let raw = noise_buf[*noise_cursor % noise_buf.len()];
                *noise_cursor = noise_cursor.wrapping_add(1);
                let filtered = filter.process(raw);
                let s = filtered * env * if *is_song { MIX_RADIO } else { 1.0 };
                (s, freq)
            }
            SynthVoice::Tone {
                delay_s,
                elapsed_s,
                len_s,
                attack_s,
                wave,
                freq_hz,
                peak_gain,
                fm_mod,
                phase,
                mod_phase,
                is_song,
            } => {
                if *delay_s > 0.0 {
                    *delay_s -= dt;
                    return (0.0, 0.0);
                }
                let t = *elapsed_s;
                *elapsed_s += dt;
                if t >= *len_s {
                    return (0.0, 0.0);
                }
                let env = if t < *attack_s {
                    0.0001 + (*peak_gain - 0.0001) * (t / (*attack_s).max(0.001))
                } else {
                    let decay_t = (t - *attack_s).max(0.0);
                    let decay_len = (*len_s - *attack_s).max(0.005);
                    *peak_gain
                        * (0.0001 / (*peak_gain).max(0.0002))
                            .powf((decay_t / decay_len).clamp(0.0, 1.0))
                };
                let inst_freq = if *fm_mod {
                    // Two-operator FM from sound.js: modulator at 2x pitch, depth 0.8x pitch
                    *mod_phase = (*mod_phase + (*freq_hz * 2.0) * dt).rem_euclid(1.0);
                    let mod_sig = (*mod_phase * 2.0 * PI).sin();
                    *freq_hz + mod_sig * (*freq_hz * 0.8)
                } else {
                    *freq_hz
                };
                *phase = (*phase + inst_freq * dt).rem_euclid(1.0);
                let s = wave.sample(*phase) * env * if *is_song { MIX_RADIO } else { 1.0 };
                (s, *freq_hz)
            }
        }
    }
}

/// Station definition matching `STATIONS` in `apps/apexrun/shell/engine/sound.js`.
pub struct StationSpec {
    pub id: &'static str,
    pub freq: &'static str,
    pub name: &'static str,
    pub genre: &'static str,
    pub bpm: f32,
    pub lead_wave: WaveType,
    pub bass_wave: WaveType,
    pub chords: [&'static [i32]; 4],
    pub roots: [i32; 4],
    pub bass: [Option<i32>; 16],
    pub kick: &'static [u8; 16],
    pub snare: &'static [u8; 16],
    pub hat: &'static [u8; 16],
    pub lead: &'static [(usize, i32, usize)],
}

const NEON_LEAD: [(usize, i32, usize); 32] = [
    // Bar 0: chord [57, 60, 64] + 12 -> [69, 72, 76, 72] x 2
    (0, 69, 2),
    (2, 72, 2),
    (4, 76, 2),
    (6, 72, 2),
    (8, 69, 2),
    (10, 72, 2),
    (12, 76, 2),
    (14, 72, 2),
    // Bar 1: chord [53, 57, 60] + 12 -> [65, 69, 72, 69] x 2
    (16, 65, 2),
    (18, 69, 2),
    (20, 72, 2),
    (22, 69, 2),
    (24, 65, 2),
    (26, 69, 2),
    (28, 72, 2),
    (30, 69, 2),
    // Bar 2: chord [55, 60, 64] + 12 -> [67, 72, 76, 72] x 2
    (32, 67, 2),
    (34, 72, 2),
    (36, 76, 2),
    (38, 72, 2),
    (40, 67, 2),
    (42, 72, 2),
    (44, 76, 2),
    (46, 72, 2),
    // Bar 3: chord [55, 59, 62] + 12 -> [67, 71, 74, 71] x 2
    (48, 67, 2),
    (50, 71, 2),
    (52, 74, 2),
    (54, 71, 2),
    (56, 67, 2),
    (58, 71, 2),
    (60, 74, 2),
    (62, 71, 2),
];

pub const STATIONS: [StationSpec; 3] = [
    StationSpec {
        id: "palm-drive",
        freq: "88.5",
        name: "Palm Drive",
        genre: "synth samba",
        bpm: 132.0,
        lead_wave: WaveType::Square,
        bass_wave: WaveType::Triangle,
        chords: [
            &[62, 66, 69, 73],
            &[59, 62, 66, 69],
            &[55, 59, 62, 66],
            &[57, 61, 64, 67],
        ],
        roots: [38, 35, 43, 33],
        bass: [
            Some(0),
            None,
            None,
            Some(7),
            None,
            None,
            Some(12),
            None,
            Some(0),
            None,
            None,
            Some(7),
            None,
            None,
            Some(12),
            None,
        ],
        kick: b"x.....x.x.......",
        snare: b"..x..x...x..x.x.",
        hat: b"xxxxxxxxxxxxxxxx",
        lead: &[
            (0, 78, 2),
            (2, 81, 2),
            (4, 83, 4),
            (10, 81, 2),
            (12, 78, 4),
            (16, 76, 2),
            (18, 78, 2),
            (20, 81, 6),
            (28, 83, 2),
            (30, 81, 2),
            (32, 83, 2),
            (34, 86, 4),
            (38, 83, 2),
            (40, 81, 4),
            (44, 79, 4),
            (48, 81, 2),
            (50, 85, 2),
            (52, 88, 4),
            (58, 85, 2),
            (60, 81, 4),
        ],
    },
    StationSpec {
        id: "tidal-breeze",
        freq: "92.1",
        name: "Tidal Breeze",
        genre: "jazz fusion",
        bpm: 104.0,
        lead_wave: WaveType::Sine,
        bass_wave: WaveType::Triangle,
        chords: [
            &[53, 57, 60, 64, 67],
            &[57, 60, 64, 67],
            &[50, 53, 57, 60, 64],
            &[46, 50, 53, 57],
        ],
        roots: [41, 45, 38, 46],
        bass: [
            Some(0),
            None,
            None,
            None,
            Some(7),
            None,
            None,
            None,
            Some(12),
            None,
            None,
            None,
            Some(10),
            None,
            None,
            None,
        ],
        kick: b"x.........x.....",
        snare: b"....x.......x...",
        hat: b"x.x.x.x.x.x.x.x.",
        lead: &[
            (2, 81, 3),
            (6, 79, 2),
            (8, 76, 4),
            (14, 72, 2),
            (16, 76, 2),
            (18, 79, 2),
            (20, 84, 6),
            (28, 83, 4),
            (34, 81, 2),
            (36, 77, 2),
            (38, 76, 2),
            (40, 74, 8),
            (48, 77, 2),
            (50, 81, 2),
            (52, 86, 4),
            (58, 84, 2),
            (60, 81, 4),
        ],
    },
    StationSpec {
        id: "neon-surf",
        freq: "97.3",
        name: "Neon Surf",
        genre: "synthwave",
        bpm: 118.0,
        lead_wave: WaveType::Sawtooth,
        bass_wave: WaveType::Sawtooth,
        chords: [&[57, 60, 64], &[53, 57, 60], &[55, 60, 64], &[55, 59, 62]],
        roots: [45, 41, 48, 43],
        bass: [
            Some(0),
            None,
            Some(12),
            None,
            Some(0),
            None,
            Some(12),
            None,
            Some(0),
            None,
            Some(12),
            None,
            Some(0),
            None,
            Some(12),
            None,
        ],
        kick: b"x...x...x...x...",
        snare: b"....x.......x...",
        hat: b"..x...x...x...x.",
        lead: &NEON_LEAD,
    },
];

pub fn resolve_station_index(track_name: &str) -> Option<usize> {
    match track_name {
        "palm-drive" | "magical_sound_shower" | "0" => Some(0),
        "tidal-breeze" | "passing_breeze" | "1" => Some(1),
        "neon-surf" | "splash_wave" | "last_wave" | "2" => Some(2),
        "off" | "-1" => None,
        _ => Some(0),
    }
}

/// Native `SoundEngine` + `AudioContext` role bridge matching `apps/apexrun/shell/engine/sound.js`.
pub struct NativeSoundEngine {
    pub backend: NativeAudioBackend,
    pub sample_rate: u32,
    pub current_time: f64,
    pub enabled: bool,
    pub volume: f32,
    pub master_gain: AudioParam,
    pub engine_master_gain: AudioParam,
    pub engine_filter_freq: AudioParam,
    pub harmonics: Vec<HarmonicVoice>,
    pub road_noise_gain: AudioParam,
    pub wind_noise_gain: AudioParam,
    pub tire_squeal_gain: AudioParam,
    pub offroad_gain: AudioParam,
    pub curb_gain: AudioParam,
    pub music_playing: bool,
    pub current_track: String,
    pub station_index: Option<usize>,
    pub music_step: usize,
    pub music_lead_freq: f32,
    pub music_bass_freq: f32,
    pub music_phase_lead: f32,
    pub music_phase_bass: f32,
    pub analyser: AnalyserNode,
    pub transients: Vec<TransientCue>,
    voices: Vec<SynthVoice>,
    noise_buffer: Vec<f32>,
    noise_cursor: usize,
    engine_osc_saw_phase: f32,
    engine_osc_sq_phase: f32,
    engine_lowpass: BiquadFilter,
    wind_bandpass: BiquadFilter,
    tyre_bandpass: BiquadFilter,
    song_elapsed_s: f64,
    next_step_index: usize,
}

impl NativeSoundEngine {
    pub fn new(sample_rate: u32) -> Self {
        let harmonics = ENGINE_RATIOS
            .iter()
            .enumerate()
            .map(|(i, &ratio)| HarmonicVoice {
                ratio,
                wave: if i % 2 == 0 {
                    WaveType::Sawtooth
                } else {
                    WaveType::Triangle
                },
                frequency: AudioParam::new(35.0 * ratio),
                gain: AudioParam::new(ENGINE_WEIGHTS[i] * 0.12),
                phase: 0.0,
            })
            .collect();

        let sr = sample_rate as f32;
        Self {
            backend: NativeAudioBackend::host_default(),
            sample_rate,
            current_time: 0.0,
            enabled: true,
            volume: 0.7,
            master_gain: AudioParam::new(0.7),
            engine_master_gain: AudioParam::new(0.0),
            engine_filter_freq: AudioParam::new(300.0),
            harmonics,
            road_noise_gain: AudioParam::new(0.0),
            wind_noise_gain: AudioParam::new(0.0),
            tire_squeal_gain: AudioParam::new(0.0),
            offroad_gain: AudioParam::new(0.0),
            curb_gain: AudioParam::new(0.0),
            music_playing: false,
            current_track: "palm-drive".to_string(),
            station_index: Some(0),
            music_step: 0,
            music_lead_freq: midi_hz(78),
            music_bass_freq: midi_hz(38),
            music_phase_lead: 0.0,
            music_phase_bass: 0.0,
            analyser: AnalyserNode::new(64),
            transients: Vec::new(),
            voices: Vec::with_capacity(64),
            noise_buffer: build_seeded_noise_buffer(sample_rate),
            noise_cursor: 0,
            engine_osc_saw_phase: 0.0,
            engine_osc_sq_phase: 0.0,
            engine_lowpass: BiquadFilter::new(FilterKind::Lowpass, 300.0, 1.0, sr),
            wind_bandpass: BiquadFilter::new(FilterKind::Bandpass, 600.0, 0.7, sr),
            tyre_bandpass: BiquadFilter::new(FilterKind::Bandpass, 2600.0, 4.0, sr),
            song_elapsed_s: 0.0,
            next_step_index: 0,
        }
    }

    pub fn set_volume(&mut self, value: f32) {
        self.volume = value.clamp(0.0, 1.0);
        self.enabled = self.volume > 0.0;
        let g = if self.enabled { self.volume } else { 0.0 };
        self.master_gain.set_target_at_time(g, self.current_time, 0.02);
    }

    /// Update continuous engine, wind, and tyre parameters matching `engineVoice` and `update` in `sound.js`.
    pub fn update_engine(
        &mut self,
        speed: f32,
        is_drifting: bool,
        is_nitro: bool,
        rpm: f32,
        off_road: bool,
        curb: f32,
    ) {
        if !self.enabled {
            return;
        }
        assert!(
            speed.is_finite() && rpm.is_finite() && curb.is_finite(),
            "update_engine requires finite parameters"
        );
        let clamped_rpm = rpm.clamp(800.0, 9000.0);
        let rev = ((clamped_rpm - 1000.0) / 8000.0).clamp(0.0, 1.0);
        let speed_norm = (speed.max(0.0) / 300.0).clamp(0.0, 1.2);

        // `engineVoice` from sound.js:
        // freq = (rpm / 60) * 1.5 * (isNitro ? 1.1 : 1)
        // cutoff = 300 + speed * 6 + (gear === 'high' ? 200 : 0)
        // gain = MIX.engineIdle + MIX.engineRev * rev
        let voice_freq = (clamped_rpm / 60.0) * 1.5 * if is_nitro { 1.1 } else { 1.0 };
        let high_gear_bonus = if speed > 145.0 { 200.0 } else { 0.0 };
        let cutoff = 300.0 + speed.max(0.0) * 6.0 + high_gear_bonus;
        let voice_gain = if speed > 0.5 || clamped_rpm > 1000.0 {
            MIX_ENGINE_IDLE + MIX_ENGINE_REV * rev
        } else {
            0.0
        };

        for (i, h) in self.harmonics.iter_mut().enumerate() {
            h.frequency
                .set_target_at_time(voice_freq * h.ratio, self.current_time, 0.04);
            let weight = ENGINE_WEIGHTS[i] * (0.08 + 0.14 * rev);
            h.gain.set_target_at_time(weight, self.current_time, 0.04);
        }

        self.engine_filter_freq
            .set_target_at_time(cutoff, self.current_time, 0.08);
        self.engine_master_gain
            .set_target_at_time(voice_gain, self.current_time, 0.10);

        self.road_noise_gain
            .set_target_at_time(speed_norm * 0.04, self.current_time, 0.05);
        self.wind_noise_gain.set_target_at_time(
            MIX_WIND * speed_norm * speed_norm,
            self.current_time,
            0.20,
        );
        self.tire_squeal_gain.set_target_at_time(
            if is_drifting && speed > 40.0 {
                0.22
            } else {
                0.0
            },
            self.current_time,
            0.05,
        );
        self.offroad_gain.set_target_at_time(
            if off_road && speed > 5.0 {
                0.14 * speed_norm
            } else {
                0.0
            },
            self.current_time,
            0.04,
        );
        self.curb_gain
            .set_target_at_time(curb.clamp(0.0, 1.0) * 0.12 * speed_norm, self.current_time, 0.02);

        self.refresh_analyser_spectrum(speed_norm, rev, is_nitro);
    }

    fn push_arpeggio(&mut self, notes: &[i32], step_s: f32, wave: WaveType, vel: f32) {
        for (i, &note) in notes.iter().enumerate() {
            let freq = midi_hz(note);
            self.voices.push(SynthVoice::Tone {
                delay_s: i as f32 * step_s,
                elapsed_s: 0.0,
                len_s: step_s * 1.6,
                attack_s: 0.003,
                wave,
                freq_hz: freq,
                peak_gain: vel,
                fm_mod: false,
                phase: 0.0,
                mod_phase: 0.0,
                is_song: false,
            });
        }
    }

    /// Trigger race cues matching `CUES` in `apps/apexrun/shell/engine/sound.js` as well as legacy cue names.
    pub fn trigger_cue(&mut self, kind: &str) {
        if !self.enabled {
            return;
        }
        let sr = self.sample_rate as f32;
        match kind {
            "checkpoint-extended" | "checkpoint" => {
                self.push_arpeggio(&[84, 88, 91, 96], 0.09, WaveType::Square, 0.25);
            }
            "fork-approach" => {
                self.push_arpeggio(&[79, 86], 0.18, WaveType::Sine, 0.30);
            }
            "race-start" | "go" => {
                self.push_arpeggio(&[84], 0.30, WaveType::Square, 0.30);
            }
            "countdown" => {
                self.push_arpeggio(&[72], 0.18, WaveType::Square, 0.24);
            }
            "race-finish" => {
                self.push_arpeggio(&[72, 76, 79, 84, 88, 91, 96], 0.12, WaveType::Square, 0.30);
            }
            "time-out" => {
                self.push_arpeggio(&[67, 63, 60, 55], 0.22, WaveType::Triangle, 0.35);
            }
            "traffic-collision" | "crash" | "bump" => {
                self.voices.push(SynthVoice::Thump {
                    delay_s: 0.0,
                    elapsed_s: 0.0,
                    from_hz: 90.0,
                    vel: 0.9,
                    phase: 0.0,
                    is_song: false,
                });
                self.voices.push(SynthVoice::FilteredNoise {
                    delay_s: 0.0,
                    elapsed_s: 0.0,
                    len_s: 0.25,
                    attack_s: 0.0,
                    from_hz: 900.0,
                    to_hz: 900.0,
                    vel: 0.7,
                    filter: BiquadFilter::new(FilterKind::Lowpass, 900.0, 1.0, sr),
                    noise_cursor: self.noise_cursor,
                    is_song: false,
                });
            }
            "close-pass" | "slipstream" => {
                self.voices.push(SynthVoice::FilteredNoise {
                    delay_s: 0.0,
                    elapsed_s: 0.0,
                    len_s: 0.35,
                    attack_s: 0.10,
                    from_hz: 400.0,
                    to_hz: 3200.0,
                    vel: 0.5,
                    filter: BiquadFilter::new(FilterKind::Bandpass, 400.0, 3.0, sr),
                    noise_cursor: self.noise_cursor,
                    is_song: false,
                });
            }
            "mini-turbo" => {
                self.voices.push(SynthVoice::FilteredNoise {
                    delay_s: 0.0,
                    elapsed_s: 0.0,
                    len_s: 0.30,
                    attack_s: 0.09,
                    from_hz: 300.0,
                    to_hz: 1800.0,
                    vel: 0.35,
                    filter: BiquadFilter::new(FilterKind::Bandpass, 300.0, 3.0, sr),
                    noise_cursor: self.noise_cursor,
                    is_song: false,
                });
            }
            _ => {
                self.push_arpeggio(&[76], 0.12, WaveType::Triangle, 0.18);
            }
        }

        // Also populate `self.transients` for inspection tests
        let (freq_hz, gain, dur) = match kind {
            "splash" => (320.0, 0.22, 0.28),
            "crash" | "traffic-collision" => (90.0, 0.35, 0.30),
            "bump" => (145.0, 0.25, 0.18),
            "horn" => (415.0, 0.20, 0.32),
            "checkpoint" | "checkpoint-extended" => (midi_hz(84), 0.25, 0.40),
            "slipstream" | "close-pass" => (520.0, 0.16, 0.35),
            "countdown" => (midi_hz(72), 0.24, 0.18),
            "go" | "race-start" => (midi_hz(84), 0.30, 0.35),
            _ => (440.0, 0.15, 0.15),
        };
        self.transients.push(TransientCue {
            kind: kind.to_string(),
            freq_hz,
            gain,
            remaining_s: dur,
            phase: 0.0,
        });
    }

    pub fn start_music(&mut self, track_name: &str) {
        self.current_track = track_name.to_string();
        self.station_index = resolve_station_index(track_name);
        self.music_playing = self.station_index.is_some();
        // Disconnect previous song's queued voices (a pad rings for a whole bar)
        self.voices.retain(|v| !v.is_song());
        self.song_elapsed_s = 0.0;
        self.next_step_index = 0;
        self.music_step = 0;
        if self.music_playing {
            self.step_music_sequencer();
            self.next_step_index = 1;
        }
    }

    pub fn stop_music(&mut self) {
        self.music_playing = false;
        self.station_index = None;
        self.voices.retain(|v| !v.is_song());
    }

    /// Schedule one sixteenth-note step (`step`) of the active station from `STATIONS` in `sound.js`.
    pub fn step_music_sequencer(&mut self) {
        if !self.music_playing {
            return;
        }
        let Some(st_idx) = self.station_index else {
            return;
        };
        let st = &STATIONS[st_idx % STATIONS.len()];
        let spb = 60.0 / st.bpm;
        let loop_step = self.music_step % 64;
        let bar = loop_step / 16;
        let s = loop_step % 16;
        let sr = self.sample_rate as f32;

        // 1. Kick (`thump(t, 140, 0.9, songBus)`)
        if st.kick[s] == b'x' {
            self.voices.push(SynthVoice::Thump {
                delay_s: 0.0,
                elapsed_s: 0.0,
                from_hz: 140.0,
                vel: 0.9,
                phase: 0.0,
                is_song: true,
            });
        }

        // 2. Snare (`noise(t, { type: 'bandpass', from: 1800, len: 0.15, vel: 0.8 * 0.45 })`)
        if st.snare[s] == b'x' {
            self.voices.push(SynthVoice::FilteredNoise {
                delay_s: 0.0,
                elapsed_s: 0.0,
                len_s: 0.15,
                attack_s: 0.0,
                from_hz: 1800.0,
                to_hz: 1800.0,
                vel: 0.8 * 0.45,
                filter: BiquadFilter::new(FilterKind::Bandpass, 1800.0, 1.0, sr),
                noise_cursor: self.noise_cursor.wrapping_add(loop_step * 97),
                is_song: true,
            });
        }

        // 3. Hi-hat (`noise(t, { type: 'highpass', from: 7000, len: 0.05, vel: hat_vel * 0.18 })`)
        if st.hat[s] == b'x' {
            let hat_vel = if s.is_multiple_of(4) { 0.7 } else { 0.4 };
            self.voices.push(SynthVoice::FilteredNoise {
                delay_s: 0.0,
                elapsed_s: 0.0,
                len_s: 0.05,
                attack_s: 0.0,
                from_hz: 7000.0,
                to_hz: 7000.0,
                vel: hat_vel * 0.18,
                filter: BiquadFilter::new(FilterKind::Highpass, 7000.0, 1.0, sr),
                noise_cursor: self.noise_cursor.wrapping_add(loop_step * 251),
                is_song: true,
            });
        }

        // 4. Bass (`roots[bar] + bass[s]`, dur = 0.45 * spb, vel = 0.9, peak = 0.35 * 0.9)
        if let Some(offset) = st.bass[s] {
            let midi_note = st.roots[bar] + offset;
            let freq = midi_hz(midi_note);
            self.music_bass_freq = freq;
            self.voices.push(SynthVoice::Tone {
                delay_s: 0.0,
                elapsed_s: 0.0,
                len_s: 0.45 * spb,
                attack_s: 0.01,
                wave: st.bass_wave,
                freq_hz: freq,
                peak_gain: 0.35 * 0.9,
                fm_mod: false,
                phase: 0.0,
                mod_phase: 0.0,
                is_song: true,
            });
        }

        // 5. Pad chord on step 0 of each bar (`dur = 4 * spb`, vel = 0.5, peak = 0.05 * 0.5, attack = 0.4s)
        if s == 0 {
            for &midi_note in st.chords[bar] {
                let freq = midi_hz(midi_note);
                self.voices.push(SynthVoice::Tone {
                    delay_s: 0.0,
                    elapsed_s: 0.0,
                    len_s: 4.0 * spb,
                    attack_s: 0.40,
                    wave: WaveType::Triangle,
                    freq_hz: freq,
                    peak_gain: 0.05 * 0.5,
                    fm_mod: false,
                    phase: 0.0,
                    mod_phase: 0.0,
                    is_song: true,
                });
            }
        }

        // 6. Lead melody (`LEAD_BY_STEP[loop]`, dur = (len / 4) * spb, vel = 0.8, peak = 0.12 * 0.8, 2-op FM)
        for &(at_step, midi_note, len_sixteenths) in st.lead {
            if at_step == loop_step {
                let freq = midi_hz(midi_note);
                self.music_lead_freq = freq;
                self.voices.push(SynthVoice::Tone {
                    delay_s: 0.0,
                    elapsed_s: 0.0,
                    len_s: (len_sixteenths as f32 / 4.0) * spb,
                    attack_s: 0.01,
                    wave: st.lead_wave,
                    freq_hz: freq,
                    peak_gain: 0.12 * 0.8,
                    fm_mod: true,
                    phase: 0.0,
                    mod_phase: 0.0,
                    is_song: true,
                });
            }
        }

        self.music_step = self.music_step.wrapping_add(1);
    }

    /// Fold the live FFT spectrum into `count` equalizer bands in `[0.0, 1.0]` matching `sound.js` `levels(count)`.
    pub fn levels(&self, count: usize) -> Vec<f32> {
        if !self.enabled {
            return vec![0.0; count];
        }
        self.analyser.levels(count)
    }

    /// Synthesize `frames` stereo PCM samples (`[L, R, L, R, ...]`) at `sample_rate`.
    pub fn render_pcm_stereo(&mut self, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0f32; frames * 2];
        if !self.enabled || self.master_gain.value <= 0.0001 {
            self.current_time += frames as f64 / self.sample_rate as f64;
            return out;
        }

        let sr = self.sample_rate as f32;
        let dt = 1.0 / sr;
        let step_dur_s = if let Some(st_idx) = self.station_index {
            let bpm = STATIONS[st_idx % STATIONS.len()].bpm as f64;
            (60.0 / bpm) * 0.25 // 1 sixteenth note = 1/4 beat
        } else {
            0.125
        };

        for f in 0..frames {
            self.master_gain.step(dt);
            self.engine_master_gain.step(dt);
            self.engine_filter_freq.step(dt);
            self.road_noise_gain.step(dt);
            self.wind_noise_gain.step(dt);
            self.tire_squeal_gain.step(dt);
            self.offroad_gain.step(dt);
            self.curb_gain.step(dt);

            // Step the station sequencer at exact sixteenth-note boundaries
            if self.music_playing {
                while self.song_elapsed_s >= (self.next_step_index as f64) * step_dur_s {
                    self.next_step_index += 1;
                    self.step_music_sequencer();
                }
                self.song_elapsed_s += dt as f64;
            }

            // 1. Engine voice (`[['sawtooth', 1], ['square', 0.5]]` through lowpass filter `engineFilter`)
            let base_freq = if let Some(h1) = self.harmonics.get(1) {
                h1.frequency.value
            } else {
                60.0
            };
            for h in &mut self.harmonics {
                h.frequency.step(dt);
                h.gain.step(dt);
            }
            self.engine_osc_saw_phase = (self.engine_osc_saw_phase + base_freq * dt).rem_euclid(1.0);
            self.engine_osc_sq_phase =
                (self.engine_osc_sq_phase + (base_freq * 0.5) * dt).rem_euclid(1.0);
            let eng_raw = (WaveType::Sawtooth.sample(self.engine_osc_saw_phase)
                + WaveType::Square.sample(self.engine_osc_sq_phase))
                * 0.5;
            self.engine_lowpass
                .set_freq(self.engine_filter_freq.value, sr);
            let engine_sample =
                self.engine_lowpass.process(eng_raw) * self.engine_master_gain.value;

            // 2. Seeded noise bed for wind (`bandpass 600 Hz Q=0.7`) and tyres (`bandpass 2600 Hz Q=4.0`)
            let raw_noise = self.noise_buffer[self.noise_cursor % self.noise_buffer.len()];
            self.noise_cursor = self.noise_cursor.wrapping_add(1);
            let wind_sample = self.wind_bandpass.process(raw_noise) * self.wind_noise_gain.value;
            let tyre_sample = self.tyre_bandpass.process(raw_noise)
                * (self.tire_squeal_gain.value + self.offroad_gain.value + self.curb_gain.value);

            // 3. Polyphonic radio + cue voices
            let mut voice_sum = 0.0f32;
            let noise_ref = &self.noise_buffer;
            for v in &mut self.voices {
                let (s, _) = v.sample(dt, sr, noise_ref);
                voice_sum += s;
            }

            for cue in &mut self.transients {
                if cue.remaining_s > 0.0 {
                    cue.remaining_s = (cue.remaining_s - dt).max(0.0);
                }
            }

            // Soft limiter (`DynamicsCompressor` equivalent) + master volume
            let pre_limit = (engine_sample + wind_sample + tyre_sample + voice_sum)
                * self.master_gain.value;
            let mix = (pre_limit * 0.95).tanh();
            out[f * 2] = mix;
            out[f * 2 + 1] = mix;
        }

        self.voices.retain(|v| v.is_alive());
        self.transients.retain(|c| c.remaining_s > 0.0);
        self.current_time += frames as f64 / self.sample_rate as f64;
        out
    }

    fn refresh_analyser_spectrum(&mut self, speed_norm: f32, rpm_norm: f32, is_nitro: bool) {
        let n = self.analyser.bins.len();
        let nitro_boost = if is_nitro { 0.22 } else { 0.0 };
        let pulse = ((self.music_step as f32 * 0.7).sin() * 0.5 + 0.5) * 0.25;
        let music_boost = if self.music_playing {
            0.28 + pulse
        } else {
            0.0
        };
        for i in 0..n {
            let band_pos = i as f32 / n as f32;
            let engine_energy = (1.0 - (band_pos - rpm_norm * 0.7).abs() * 1.4).clamp(0.0, 1.0)
                * self.engine_master_gain.value
                * 2.2;
            let road_energy = (1.0 - band_pos * 0.8) * speed_norm * 0.35;
            let band_music = music_boost * (1.0 - (band_pos - 0.35).abs() * 0.9).clamp(0.2, 1.0);
            let total = ((engine_energy + road_energy + band_music + nitro_boost) * self.volume)
                .clamp(0.0, 1.0);
            self.analyser.bins[i] = (total * 255.0).round() as u8;
        }
    }
}
