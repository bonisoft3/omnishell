//! `omnishell-bevy-presenter`: Level-0 3D Bevy `wgpu` presenter crate (Metal on macOS,
//! DX12 on Windows, Vulkan on Linux) mounted inside `omnishell-winio`'s `KineticSurface`
//! child `RawWindowHandle`.
//!
//! Consumes:
//!   1. Stage `.glb` binary bundles built by `apps/apexrun/shell/engine/stage_gltf.js`
//!      (`EXT_mesh_gpu_instancing` chunked by `SCATTER_CHUNK = 25`, `material.extras.stk`,
//!      procedural RGBA textures, `.ktx2` IBL sky).
//!   2. The 186-float (744-byte) `#[repr(C)] PoseBuffer` packed by `pose_buffer.js`.

use omnishell_winio::{parse_json, RawWindowHandle};
use std::time::Instant;

pub const SCATTER_CHUNK: usize = 25;
pub const SCATTER_BEHIND: f32 = 30.0;
pub const SCATTER_AHEAD: f32 = 360.0;
pub const LOD_SPLITS: [f32; 2] = [70.0, 200.0];
pub const LOD_FAR: f32 = 520.0;
pub const BODY_PIVOT_Y: f32 = 0.32;
pub const HAZE_DENSITY: f32 = 0.012;
pub const MAX_TRAFFIC_CARS: usize = 12;
pub const TRAFFIC_STRIDE: usize = 8;
pub const POSE_BUFFER_FLOATS: usize = 186;
pub const POSE_BUFFER_BYTES: usize = POSE_BUFFER_FLOATS * 4;
pub const TARGET_120FPS_BUDGET_US: u64 = 8_333;

/// Compact C-ABI Pose & Moments buffer (186 `f32`s = 744 bytes) matching `pose_buffer.js`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct PoseBuffer {
    pub floats: [f32; POSE_BUFFER_FLOATS],
}

impl Default for PoseBuffer {
    fn default() -> Self {
        Self {
            floats: [0.0; POSE_BUFFER_FLOATS],
        }
    }
}

impl PoseBuffer {
    pub fn from_le_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < POSE_BUFFER_BYTES {
            return Err(format!(
                "PoseBuffer expected at least {} bytes, got {}",
                POSE_BUFFER_BYTES,
                bytes.len()
            ));
        }
        let mut floats = [0.0f32; POSE_BUFFER_FLOATS];
        for (i, slot) in floats.iter_mut().enumerate() {
            let b = [
                bytes[i * 4],
                bytes[i * 4 + 1],
                bytes[i * 4 + 2],
                bytes[i * 4 + 3],
            ];
            *slot = f32::from_le_bytes(b);
        }
        Ok(Self { floats })
    }

    pub fn to_le_bytes(&self) -> [u8; POSE_BUFFER_BYTES] {
        let mut out = [0u8; POSE_BUFFER_BYTES];
        for (i, &val) in self.floats.iter().enumerate() {
            let b = val.to_le_bytes();
            out[i * 4..i * 4 + 4].copy_from_slice(&b);
        }
        out
    }

    pub fn tick(&self) -> u32 {
        self.floats[0] as u32
    }
    pub fn alpha(&self) -> f32 {
        self.floats[1]
    }
    pub fn wind_time(&self) -> f32 {
        self.floats[2]
    }
    pub fn stage_num(&self) -> u32 {
        self.floats[3] as u32
    }
    pub fn camera_eye(&self) -> [f32; 3] {
        [self.floats[4], self.floats[5], self.floats[6]]
    }
    pub fn camera_target(&self) -> [f32; 3] {
        [self.floats[7], self.floats[8], self.floats[9]]
    }
    pub fn camera_fov(&self) -> f32 {
        self.floats[10]
    }
    pub fn stage_haze(&self) -> f32 {
        self.floats[12]
    }
    pub fn hero_pos(&self) -> [f32; 3] {
        [self.floats[20], self.floats[21], self.floats[22]]
    }
    pub fn hero_yaw(&self) -> f32 {
        self.floats[23]
    }
    pub fn hero_body_pitch(&self) -> f32 {
        self.floats[26]
    }
    pub fn hero_body_roll(&self) -> f32 {
        self.floats[27]
    }
    pub fn hero_body_pivot_y(&self) -> f32 {
        self.floats[28]
    }
    pub fn hero_wheel_steer(&self) -> f32 {
        self.floats[30]
    }
    pub fn hero_wheel_spin(&self) -> f32 {
        self.floats[31]
    }
    pub fn marshal_arm(&self) -> f32 {
        self.floats[52]
    }
    pub fn marshal_flag(&self) -> f32 {
        self.floats[53]
    }
    pub fn speed_kmh(&self) -> u32 {
        self.floats[68].round() as u32
    }
    pub fn rpm(&self) -> u32 {
        self.floats[69].round() as u32
    }
    pub fn tacho_ratio(&self) -> f32 {
        self.floats[70]
    }
    pub fn gear(&self) -> u32 {
        self.floats[71].round() as u32
    }
    pub fn nitro_amount(&self) -> f32 {
        self.floats[72]
    }
    pub fn timer_sec(&self) -> u32 {
        self.floats[74].round() as u32
    }
    pub fn score(&self) -> u32 {
        self.floats[76].round() as u32
    }
    pub fn eq_bands(&self) -> [f32; 6] {
        [
            self.floats[84],
            self.floats[85],
            self.floats[86],
            self.floats[87],
            self.floats[88],
            self.floats[89],
        ]
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct StkMaterialExtras {
    pub name: String,
    pub toon: bool,
    pub painted: bool,
    pub brushed: bool,
    pub sway: bool,
    pub depth_offset: f32,
    pub tint: Option<String>,
    pub lift: f32,
    pub grain: Option<String>,
    pub shader_defines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InstancedChunk {
    pub name: String,
    pub chunk_index: usize,
    pub start_segment: usize,
    pub end_segment: usize,
    pub z_min: f32,
    pub z_max: f32,
    pub kind: String,
    pub instance_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddedTexture {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub byte_length: usize,
}

#[derive(Debug, Clone)]
pub struct ParsedStageScene {
    pub stage_id: String,
    pub stage_name: String,
    pub segment_count: usize,
    pub segment_length_metres: f32,
    pub sky_ktx2: String,
    pub backdrop_layers: Vec<String>,
    pub shore_side: i32,
    pub is_night: bool,
    pub ribbon_nodes: Vec<String>,
    pub materials: Vec<StkMaterialExtras>,
    pub chunks: Vec<InstancedChunk>,
    pub textures: Vec<EmbeddedTexture>,
    pub bin_byte_length: usize,
}

#[derive(Debug, Clone)]
pub struct FastHudOrthographicPass {
    pub speed_text: String,
    pub rpm_text: String,
    pub gear_text: String,
    pub timer_text: String,
    pub score_text: String,
    pub nitro_ratio: f32,
    pub tacho_ratio: f32,
    pub eq_bars: [f32; 6],
    pub active_traffic_blips: usize,
    pub moment_banner: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FrameStats {
    pub tick: u32,
    pub frame_time_us: u64,
    pub visible_chunks: usize,
    pub culled_chunks: usize,
    pub visible_instances: usize,
    pub lod0_chunks: usize,
    pub lod1_chunks: usize,
    pub lod2_chunks: usize,
    pub active_traffic_cars: usize,
    pub fast_hud: FastHudOrthographicPass,
}

/// Validate a binary glTF 2.0 `.glb` container and return `(json_str, bin_slice)`.
pub fn parse_glb_chunks(glb_bytes: &[u8]) -> Result<(&str, &[u8]), String> {
    if glb_bytes.len() < 20 {
        return Err("Truncated GLB header".to_string());
    }
    let magic = u32::from_le_bytes([glb_bytes[0], glb_bytes[1], glb_bytes[2], glb_bytes[3]]);
    if magic != 0x4654_6c67 {
        return Err(format!("Invalid GLB magic: 0x{:08x}", magic));
    }
    let version = u32::from_le_bytes([glb_bytes[4], glb_bytes[5], glb_bytes[6], glb_bytes[7]]);
    if version != 2 {
        return Err(format!("Unsupported GLB version: {}", version));
    }
    let total_len = u32::from_le_bytes([glb_bytes[8], glb_bytes[9], glb_bytes[10], glb_bytes[11]]) as usize;
    if total_len != glb_bytes.len() {
        return Err(format!("GLB length mismatch ({} vs {})", total_len, glb_bytes.len()));
    }

    let json_len = u32::from_le_bytes([glb_bytes[12], glb_bytes[13], glb_bytes[14], glb_bytes[15]]) as usize;
    let json_type = u32::from_le_bytes([glb_bytes[16], glb_bytes[17], glb_bytes[18], glb_bytes[19]]);
    if json_type != 0x4e4f_534a {
        return Err("First GLB chunk is not JSON".to_string());
    }
    let json_end = 20usize
        .checked_add(json_len)
        .ok_or("GLB JSON chunk length overflow")?;
    if json_end > glb_bytes.len() {
        return Err(format!(
            "GLB JSON chunk out of bounds ({} > {})",
            json_end,
            glb_bytes.len()
        ));
    }
    let json_str = std::str::from_utf8(&glb_bytes[20..json_end])
        .map_err(|e| e.to_string())?
        .trim_end();

    let bin_slice = if json_end < glb_bytes.len() {
        let bin_data_start = json_end
            .checked_add(8)
            .ok_or("GLB BIN header offset overflow")?;
        if bin_data_start > glb_bytes.len() {
            return Err("Truncated GLB BIN chunk header".to_string());
        }
        let bin_len = u32::from_le_bytes([
            glb_bytes[json_end],
            glb_bytes[json_end + 1],
            glb_bytes[json_end + 2],
            glb_bytes[json_end + 3],
        ]) as usize;
        let bin_type = u32::from_le_bytes([
            glb_bytes[json_end + 4],
            glb_bytes[json_end + 5],
            glb_bytes[json_end + 6],
            glb_bytes[json_end + 7],
        ]);
        if bin_type != 0x004e_4942 {
            return Err(format!("Second GLB chunk is not BIN (0x{:08x})", bin_type));
        }
        let bin_end = bin_data_start
            .checked_add(bin_len)
            .ok_or("GLB BIN chunk length overflow")?;
        if bin_end > glb_bytes.len() {
            return Err(format!(
                "GLB BIN chunk out of bounds ({} > {})",
                bin_end,
                glb_bytes.len()
            ));
        }
        &glb_bytes[bin_data_start..bin_end]
    } else {
        &[][..]
    };

    Ok((json_str, bin_slice))
}

/// Parse a binary `.glb` stage bundle emitted by `stage_gltf.js` into a `ParsedStageScene`.
pub fn parse_stage_glb(glb_bytes: &[u8]) -> Result<ParsedStageScene, String> {
    let (json_str, bin_slice) = parse_glb_chunks(glb_bytes)?;
    let root = parse_json(json_str)?;
    let bin_byte_length = bin_slice.len();

    let scenes = root.get("scenes").and_then(|v| v.as_arr()).ok_or("Missing scenes")?;
    let scene0 = scenes.first().ok_or("Empty scenes")?;
    let stk = scene0
        .get("extras")
        .and_then(|e| e.get("stk"))
        .ok_or("Missing scene.extras.stk")?;

    let stage_id = stk
        .get("stageId")
        .and_then(|v| v.as_str())
        .ok_or("Missing stageId in scene.extras.stk")?
        .to_string();
    let stage_name = stk.get("stageName").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let segment_count = stk.get("segmentCount").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize;
    let segment_length_metres = stk.get("segmentLengthMetres").and_then(|v| v.as_f64()).unwrap_or(0.72) as f32;
    let sky_ktx2 = stk.get("skyKtx2").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let shore_side = stk.get("shoreSide").and_then(|v| v.as_f64()).unwrap_or(0.0) as i32;
    let is_night = stk.get("isNight").and_then(|v| v.as_bool()).unwrap_or(false);
    let backdrop_layers = stk
        .get("backdropLayers")
        .and_then(|v| v.as_arr())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut materials = Vec::new();
    if let Some(mat_arr) = root.get("materials").and_then(|v| v.as_arr()) {
        for m in mat_arr {
            let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("mat").to_string();
            let m_stk = m.get("extras").and_then(|e| e.get("stk"));
            let toon = m_stk.and_then(|s| s.get("toon")).and_then(|v| v.as_bool()).unwrap_or(true);
            let painted = m_stk.and_then(|s| s.get("painted")).and_then(|v| v.as_bool()).unwrap_or(false);
            let brushed = m_stk.and_then(|s| s.get("brushed")).and_then(|v| v.as_bool()).unwrap_or(false);
            let sway = m_stk.and_then(|s| s.get("sway")).and_then(|v| v.as_bool()).unwrap_or(false);
            let depth_offset = m_stk.and_then(|s| s.get("depthOffset")).and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
            let tint = m_stk.and_then(|s| s.get("tint")).and_then(|v| v.as_str()).map(|s| s.to_string());
            let lift = m_stk.and_then(|s| s.get("lift")).and_then(|v| v.as_f64()).unwrap_or(1.0) as f32;
            let grain = m_stk.and_then(|s| s.get("grain")).and_then(|v| v.as_str()).map(|s| s.to_string());

            let mut shader_defines = Vec::new();
            if toon {
                shader_defines.push("STK_TOON".to_string());
            }
            if painted {
                shader_defines.push("STK_PAINTED".to_string());
            }
            if brushed {
                shader_defines.push("STK_BRUSH".to_string());
            }
            if sway {
                shader_defines.push("STK_SWAY".to_string());
            }
            match grain.as_deref() {
                Some("leaves") => shader_defines.push("STK_LEAVES".to_string()),
                Some("patch") => shader_defines.push("STK_PATCH".to_string()),
                _ => {}
            }

            materials.push(StkMaterialExtras {
                name,
                toon,
                painted,
                brushed,
                sway,
                depth_offset,
                tint,
                lift,
                grain,
                shader_defines,
            });
        }
    }

    let mut ribbon_nodes = Vec::new();
    let mut chunks = Vec::new();
    if let Some(node_arr) = root.get("nodes").and_then(|v| v.as_arr()) {
        for n in node_arr {
            let name = n.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let has_instancing = n
                .get("extensions")
                .and_then(|e| e.get("EXT_mesh_gpu_instancing"))
                .is_some();
            if has_instancing {
                if let Some(ex) = n.get("extras") {
                    chunks.push(InstancedChunk {
                        name,
                        chunk_index: ex.get("chunkIndex").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize,
                        start_segment: ex.get("startSegment").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize,
                        end_segment: ex.get("endSegment").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize,
                        z_min: ex.get("zMin").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                        z_max: ex.get("zMax").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
                        kind: ex.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                        instance_count: ex.get("instanceCount").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize,
                    });
                }
            } else {
                ribbon_nodes.push(name);
            }
        }
    }

    let buffer_views: Vec<usize> = root
        .get("bufferViews")
        .and_then(|v| v.as_arr())
        .map(|arr| {
            arr.iter()
                .map(|bv| bv.get("byteLength").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize)
                .collect()
        })
        .unwrap_or_default();

    let mut textures = Vec::new();
    if let Some(img_arr) = root.get("images").and_then(|v| v.as_arr()) {
        for img in img_arr {
            let name = img.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let bv_idx = img.get("bufferView").and_then(|v| v.as_f64()).unwrap_or(0.0) as usize;
            let ex = img.get("extras");
            let width = ex.and_then(|e| e.get("width")).and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
            let height = ex.and_then(|e| e.get("height")).and_then(|v| v.as_f64()).unwrap_or(0.0) as u32;
            let byte_length = buffer_views.get(bv_idx).copied().unwrap_or(0);
            textures.push(EmbeddedTexture {
                name,
                width,
                height,
                byte_length,
            });
        }
    }

    Ok(ParsedStageScene {
        stage_id,
        stage_name,
        segment_count,
        segment_length_metres,
        sky_ktx2,
        backdrop_layers,
        shore_side,
        is_night,
        ribbon_nodes,
        materials,
        chunks,
        textures,
        bin_byte_length,
    })
}

/// Bevy `wgpu` 3D presenter mounted inside `winio`'s child `RawWindowHandle`.
pub struct BevyKineticPresenter {
    pub handle: RawWindowHandle,
    pub current_stage: Option<ParsedStageScene>,
    pub frame_count: u64,
    pub last_pose: PoseBuffer,
    pub custom_shader_wgsl: Option<String>,
}

impl BevyKineticPresenter {
    pub fn new(handle: RawWindowHandle) -> Self {
        Self {
            handle,
            current_stage: None,
            frame_count: 0,
            last_pose: PoseBuffer::default(),
            custom_shader_wgsl: None,
        }
    }

    pub fn set_custom_shader(&mut self, wgsl: impl Into<String>) {
        self.custom_shader_wgsl = Some(wgsl.into());
    }

    pub fn load_stage_glb(&mut self, glb_bytes: &[u8]) -> Result<&ParsedStageScene, String> {
        let parsed = parse_stage_glb(glb_bytes)?;
        self.current_stage = Some(parsed);
        Ok(self.current_stage.as_ref().unwrap())
    }

    /// Execute one 3D + orthographic Fast HUD render frame from `pose`.
    pub fn render_frame(&mut self, pose: &PoseBuffer) -> FrameStats {
        let start = Instant::now();
        self.last_pose = *pose;
        self.frame_count += 1;

        let cam_z = pose.camera_eye()[2];
        let z_near = cam_z - SCATTER_BEHIND;
        let z_far = cam_z + SCATTER_AHEAD;

        let mut visible_chunks = 0;
        let mut culled_chunks = 0;
        let mut visible_instances = 0;
        let mut lod0_chunks = 0;
        let mut lod1_chunks = 0;
        let mut lod2_chunks = 0;

        if let Some(stage) = &self.current_stage {
            for chunk in &stage.chunks {
                if chunk.z_max < z_near || chunk.z_min > z_far {
                    culled_chunks += 1;
                    continue;
                }
                let dist = (chunk.z_min - cam_z).max(0.0);
                if dist > LOD_FAR {
                    culled_chunks += 1;
                    continue;
                }
                visible_chunks += 1;
                visible_instances += chunk.instance_count;
                if dist < LOD_SPLITS[0] {
                    lod0_chunks += 1;
                } else if dist < LOD_SPLITS[1] {
                    lod1_chunks += 1;
                } else {
                    lod2_chunks += 1;
                }
            }
        }

        let mut active_traffic_cars = 0;
        for i in 0..MAX_TRAFFIC_CARS {
            let base = 90 + i * TRAFFIC_STRIDE;
            if pose.floats[base] > 0.5 {
                active_traffic_cars += 1;
            }
        }

        let moment_banner = match pose.floats[60].round() as i32 {
            1 => Some("1".to_string()),
            2 => Some("2".to_string()),
            3 => Some("3".to_string()),
            4 => Some("GO!".to_string()),
            5 => Some("GOAL!".to_string()),
            6 => Some("TIME OVER".to_string()),
            _ => None,
        };

        let fast_hud = FastHudOrthographicPass {
            speed_text: format!("{}", pose.speed_kmh()),
            rpm_text: format!("{}", pose.rpm()),
            gear_text: if pose.gear() >= 2 { "HI".to_string() } else { "LO".to_string() },
            timer_text: format!("{}.{}", pose.timer_sec(), pose.floats[75].round() as u32),
            score_text: format!("{}", pose.score()),
            nitro_ratio: (pose.nitro_amount() / 100.0).clamp(0.0, 1.0),
            tacho_ratio: pose.tacho_ratio().clamp(0.0, 1.0),
            eq_bars: pose.eq_bands(),
            active_traffic_blips: active_traffic_cars,
            moment_banner,
        };

        let elapsed_us = start.elapsed().as_micros() as u64;
        FrameStats {
            tick: pose.tick(),
            frame_time_us: elapsed_us,
            visible_chunks,
            culled_chunks,
            visible_instances,
            lod0_chunks,
            lod1_chunks,
            lod2_chunks,
            active_traffic_cars,
            fast_hud,
        }
    }
}

/// 64-byte C-ABI GPU vertex shared between `omnishell-bevy-presenter` and native Metal/Vulkan/DX12 buffers.
/// `stk_flags`: `[surface_role, sway_amount, lift_height, brush_intensity]`.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct GpuVertex {
    pub pos: [f32; 3],
    pub normal: [f32; 3],
    pub color: [f32; 4],
    pub uv: [f32; 2],
    pub stk_flags: [f32; 4],
}

#[derive(Clone)]
pub struct AccessorMeta {
    pub buffer_view: usize,
    pub byte_offset: usize,
    pub component_type: u32,
    pub count: usize,
    pub acc_type: String,
}


#[derive(Clone, Copy)]
pub struct BufferViewMeta {
    pub byte_offset: usize,
    pub byte_length: usize,
}

pub fn read_f32_slice(
    bin: &[u8],
    views: &[BufferViewMeta],
    acc: &AccessorMeta,
    components: usize,
) -> Result<Vec<f32>, String> {
    if acc.component_type != 5126 {
        return Err(format!("Expected FLOAT accessor (5126), got {}", acc.component_type));
    }
    let bv = views
        .get(acc.buffer_view)
        .ok_or_else(|| format!("Invalid bufferView {}", acc.buffer_view))?;
    let start = bv
        .byte_offset
        .checked_add(acc.byte_offset)
        .ok_or("Accessor byte_offset overflow")?;
    let total_floats = acc
        .count
        .checked_mul(components)
        .ok_or("Accessor float count overflow")?;
    let byte_span = total_floats
        .checked_mul(4)
        .ok_or("Accessor byte span overflow")?;
    let end = start
        .checked_add(byte_span)
        .ok_or("Accessor end offset overflow")?;
    let bv_end = acc
        .byte_offset
        .checked_add(byte_span)
        .ok_or("BufferView end offset overflow")?;
    if end > bin.len() || bv_end > bv.byte_length {
        return Err(format!("Accessor out of bounds ({}..{} > {})", start, end, bin.len()));
    }
    let mut out = Vec::with_capacity(total_floats);
    for i in 0..total_floats {
        let off = start + i * 4;
        out.push(f32::from_le_bytes([bin[off], bin[off + 1], bin[off + 2], bin[off + 3]]));
    }
    Ok(out)
}

pub fn read_index_slice(
    bin: &[u8],
    views: &[BufferViewMeta],
    acc: &AccessorMeta,
) -> Result<Vec<u32>, String> {
    let bv = views
        .get(acc.buffer_view)
        .ok_or_else(|| format!("Invalid bufferView {}", acc.buffer_view))?;
    let start = bv
        .byte_offset
        .checked_add(acc.byte_offset)
        .ok_or("Index accessor byte_offset overflow")?;
    let elem_size = match acc.component_type {
        5125 => 4usize,
        5123 => 2usize,
        5121 => 1usize,
        other => return Err(format!("Unsupported index componentType {}", other)),
    };
    let byte_span = acc
        .count
        .checked_mul(elem_size)
        .ok_or("Index accessor byte span overflow")?;
    let end = start
        .checked_add(byte_span)
        .ok_or("Index accessor end offset overflow")?;
    let bv_end = acc
        .byte_offset
        .checked_add(byte_span)
        .ok_or("Index bufferView end offset overflow")?;
    if end > bin.len() || bv_end > bv.byte_length {
        return Err(format!("Index accessor out of bounds ({}..{} > {})", start, end, bin.len()));
    }
    let mut out = Vec::with_capacity(acc.count);
    match acc.component_type {
        5125 => {
            for i in 0..acc.count {
                let off = start + i * 4;
                out.push(u32::from_le_bytes([bin[off], bin[off + 1], bin[off + 2], bin[off + 3]]));
            }
        }
        5123 => {
            for i in 0..acc.count {
                let off = start + i * 2;
                out.push(u16::from_le_bytes([bin[off], bin[off + 1]]) as u32);
            }
        }
        5121 => {
            for i in 0..acc.count {
                out.push(bin[start + i] as u32);
            }
        }
        _ => unreachable!(),
    }
    Ok(out)
}


pub const PROP_ATLAS_DIM: usize = 8192;
pub const PROP_ATLAS_TILE: usize = 1024;
pub const PROP_ATLAS_GRID: usize = PROP_ATLAS_DIM / PROP_ATLAS_TILE; // 8x8 = 64 tiles
pub const PROP_ATLAS_MAX_TILES: usize = PROP_ATLAS_GRID * PROP_ATLAS_GRID;

/// 8192x8192 64-tile (8x8 x 1024x1024) opaque prop texture mega-atlas.
/// Channel layout: RGB = sRGB base color; A = normalized luma-gradient impasto relief height (0.5 = neutral).
pub struct PropAtlasBuilder {
    pub rgba: Vec<u8>,
    pub next_tile: usize,
    pub hash_to_tile: std::collections::HashMap<u64, usize>,
}


impl PropAtlasBuilder {
    pub fn new() -> Self {
        Self {
            rgba: vec![128u8; PROP_ATLAS_DIM * PROP_ATLAS_DIM * 4],
            next_tile: 0,
            hash_to_tile: std::collections::HashMap::new(),
        }
    }

    pub fn insert_image(&mut self, raw_bytes: &[u8], img: &DecodedImage) -> Option<usize> {
        let mut h: u64 = 0xcbf29ce484222325;
        for &b in raw_bytes {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
        if let Some(&existing) = self.hash_to_tile.get(&h) {
            return Some(existing);
        }
        if self.next_tile >= PROP_ATLAS_MAX_TILES || img.width == 0 || img.height == 0 {
            return None;
        }
        let tile_id = self.next_tile;
        self.next_tile += 1;
        let tx = (tile_id % PROP_ATLAS_GRID) * PROP_ATLAS_TILE;
        let ty = (tile_id / PROP_ATLAS_GRID) * PROP_ATLAS_TILE;
        let step_uv = 2.0 / (PROP_ATLAS_TILE as f32);
        for y in 0..PROP_ATLAS_TILE {
            let v = (y as f32 + 0.5) / (PROP_ATLAS_TILE as f32);
            let dst_row = (ty + y) * PROP_ATLAS_DIM;
            for x in 0..PROP_ATLAS_TILE {
                let u = (x as f32 + 0.5) / (PROP_ATLAS_TILE as f32);
                let c = img.sample_srgb(u, v);
                let cx = img.sample_srgb((u + step_uv).min(0.999), v);
                let cy = img.sample_srgb(u, (v + step_uv).min(0.999));
                let luma = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
                let luma_n = 0.5
                    * ((0.299 * cx[0] + 0.587 * cx[1] + 0.114 * cx[2])
                        + (0.299 * cy[0] + 0.587 * cy[1] + 0.114 * cy[2]));
                let impasto_h = (0.5 + (luma - luma_n) * 2.5).clamp(0.0, 1.0);
                let dst_idx = (dst_row + tx + x) * 4;
                self.rgba[dst_idx] = (c[0] * 255.0).round().clamp(0.0, 255.0) as u8;
                self.rgba[dst_idx + 1] = (c[1] * 255.0).round().clamp(0.0, 255.0) as u8;
                self.rgba[dst_idx + 2] = (c[2] * 255.0).round().clamp(0.0, 255.0) as u8;
                self.rgba[dst_idx + 3] = (impasto_h * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
        self.hash_to_tile.insert(h, tile_id);
        Some(tile_id)
    }
}

impl Default for PropAtlasBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[inline]
pub fn linear_to_srgb(c: f32) -> f32 {
    c.clamp(0.0, 1.0).powf(1.0 / 2.2)
}

#[derive(Clone)]
pub struct DecodedImage {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

impl DecodedImage {
    pub fn sample_srgb(&self, u: f32, v: f32) -> [f32; 4] {
        if self.width == 0 || self.height == 0 || self.rgba.len() < self.width * self.height * 4 {
            return [0.8, 0.8, 0.8, 1.0];
        }
        let uu = u.rem_euclid(1.0);
        let vv = v.rem_euclid(1.0);
        let fx = uu * (self.width.saturating_sub(1) as f32);
        let fy = vv * (self.height.saturating_sub(1) as f32);
        let x0 = (fx.floor() as usize).min(self.width - 1);
        let y0 = (fy.floor() as usize).min(self.height - 1);
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = fx - (x0 as f32);
        let ty = fy - (y0 as f32);

        let fetch = |x: usize, y: usize| -> [f32; 4] {
            let idx = (y * self.width + x) * 4;
            [
                self.rgba[idx] as f32 / 255.0,
                self.rgba[idx + 1] as f32 / 255.0,
                self.rgba[idx + 2] as f32 / 255.0,
                self.rgba[idx + 3] as f32 / 255.0,
            ]
        };
        let c00 = fetch(x0, y0);
        let c10 = fetch(x1, y0);
        let c01 = fetch(x0, y1);
        let c11 = fetch(x1, y1);
        let mut out = [0.0; 4];
        for k in 0..4 {
            let top = c00[k] * (1.0 - tx) + c10[k] * tx;
            let bot = c01[k] * (1.0 - tx) + c11[k] * tx;
            out[k] = top * (1.0 - ty) + bot * ty;
        }
        out
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn decode_image_rgba8(bytes: &[u8]) -> Option<DecodedImage> {
    use std::ffi::c_void;

    #[repr(C)]
    struct CGRect {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    }

    #[allow(clippy::duplicated_attributes)]
    #[link(name = "CoreFoundation", kind = "framework")]
    #[link(name = "CoreGraphics", kind = "framework")]
    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CFDataCreate(allocator: *const c_void, bytes: *const u8, length: isize) -> *const c_void;
        fn CFRelease(cf: *const c_void);
        fn CGImageSourceCreateWithData(data: *const c_void, options: *const c_void) -> *const c_void;
        fn CGImageSourceCreateImageAtIndex(
            isrc: *const c_void,
            index: usize,
            options: *const c_void,
        ) -> *const c_void;
        fn CGImageGetWidth(image: *const c_void) -> usize;
        fn CGImageGetHeight(image: *const c_void) -> usize;
        fn CGImageRelease(image: *const c_void);
        fn CGColorSpaceCreateDeviceRGB() -> *const c_void;
        fn CGColorSpaceRelease(space: *const c_void);
        fn CGBitmapContextCreate(
            data: *mut u8,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *const c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGContextDrawImage(c: *mut c_void, rect: CGRect, image: *const c_void);
        fn CGContextRelease(c: *mut c_void);
    }

    if bytes.is_empty() {
        return None;
    }
    unsafe {
        let cf_data = CFDataCreate(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize);
        if cf_data.is_null() {
            return None;
        }
        let img_src = CGImageSourceCreateWithData(cf_data, std::ptr::null());
        CFRelease(cf_data);
        if img_src.is_null() {
            return None;
        }
        let cg_img = CGImageSourceCreateImageAtIndex(img_src, 0, std::ptr::null());
        CFRelease(img_src);
        if cg_img.is_null() {
            return None;
        }
        let width = CGImageGetWidth(cg_img);
        let height = CGImageGetHeight(cg_img);
        if width == 0 || height == 0 {
            CGImageRelease(cg_img);
            return None;
        }
        let mut rgba = vec![0u8; width * height * 4];
        let color_space = CGColorSpaceCreateDeviceRGB();
        // kCGImageAlphaPremultipliedLast = 1 (RGBA8 byte order)
        let ctx = CGBitmapContextCreate(
            rgba.as_mut_ptr(),
            width,
            height,
            8,
            width * 4,
            color_space,
            1,
        );
        CGColorSpaceRelease(color_space);
        if ctx.is_null() {
            CGImageRelease(cg_img);
            return None;
        }
        CGContextDrawImage(
            ctx,
            CGRect {
                x: 0.0,
                y: 0.0,
                width: width as f64,
                height: height as f64,
            },
            cg_img,
        );
        CGContextRelease(ctx);
        CGImageRelease(cg_img);
        for px in rgba.chunks_exact_mut(4) {
            let a = px[3];
            if a > 0 && a < 255 {
                let inv_a = 255.0 / (a as f32);
                px[0] = ((px[0] as f32 * inv_a).round() as u32).min(255) as u8;
                px[1] = ((px[1] as f32 * inv_a).round() as u32).min(255) as u8;
                px[2] = ((px[2] as f32 * inv_a).round() as u32).min(255) as u8;
            }
        }
        Some(DecodedImage {
            width,
            height,
            rgba,
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
pub fn decode_image_rgba8(_bytes: &[u8]) -> Option<DecodedImage> {
    None
}

