import Foundation

/// Mobile Filament 3D Presenter (`Filament` + `gltfio` over `CAMetalLayer`) mounted inside
/// `divkit-ios`'s `custom_type: "kinetic:<actor>"` block via `KineticDivCustomBlockFactory`.
///
/// Consumes:
///   1. Deterministic stage `.glb` binary bundles emitted by `apps/apexrun/shell/engine/stage_gltf.js`
///      (`EXT_mesh_gpu_instancing` chunked by `SCATTER_CHUNK = 25`, `material.extras.stk` mapped to
///      precompiled `.filamat` material instances, `.ktx2` IBL sky, procedural RGBA textures).
///   2. The 186-float (744-byte) C-ABI `PoseBuffer` packed by `pose_buffer.js`.
///   3. Updates DivKit `@{hud_<layer>}` variables in-place via `DivVariableStorage` without
///      re-parsing the DivKit card JSON AST.
public enum FilamentConstants {
    public static let scatterChunk: Int = 25
    public static let scatterBehind: Float = 30.0
    public static let scatterAhead: Float = 360.0
    public static let lodSplits: (Float, Float) = (70.0, 200.0)
    public static let lodFar: Float = 520.0
    public static let maxTrafficCars: Int = 12
    public static let trafficStride: Int = 8
    public static let poseBufferFloats: Int = 186
    public static let poseBufferBytes: Int = poseBufferFloats * 4
    public static let target60FpsBudgetUs: UInt64 = 16_667
    public static let target120FpsBudgetUs: UInt64 = 8_333
}

public struct FilamatMaterialInstance: Sendable, Equatable {
    public let name: String
    public let filamatAsset: String
    public let toon: Bool
    public let painted: Bool
    public let brushed: Bool
    public let sway: Bool
    public let depthOffset: Float
    public let tint: String?
    public let lift: Float
    public let grain: String?
}

public struct FilamentInstancedChunk: Sendable, Equatable {
    public let name: String
    public let chunkIndex: Int
    public let startSegment: Int
    public let endSegment: Int
    public let zMin: Float
    public let zMax: Float
    public let kind: String
    public let instanceCount: Int
}

public struct FilamentStageScene: Sendable {
    public let stageId: String
    public let stageName: String
    public let segmentCount: Int
    public let segmentLengthMetres: Float
    public let skyKtx2: String
    public let backdropLayers: [String]
    public let shoreSide: Int
    public let isNight: Bool
    public let ribbonNodes: [String]
    public let materials: [FilamatMaterialInstance]
    public let chunks: [FilamentInstancedChunk]
    public let textureCount: Int
    public let binByteLength: Int
}

public struct PoseBuffer: Sendable {
    public var floats: [Float]

    public init(floats: [Float] = Array(repeating: 0.0, count: FilamentConstants.poseBufferFloats)) {
        precondition(floats.count >= FilamentConstants.poseBufferFloats)
        self.floats = floats
    }

    public static func fromLittleEndianData(_ data: Data) throws -> PoseBuffer {
        guard data.count >= FilamentConstants.poseBufferBytes else {
            throw NSError(domain: "PoseBuffer", code: 1, userInfo: [NSLocalizedDescriptionKey: "PoseBuffer truncated"])
        }
        var out = Array(repeating: Float(0.0), count: FilamentConstants.poseBufferFloats)
        data.withUnsafeBytes { raw in
            for i in 0..<FilamentConstants.poseBufferFloats {
                let bits = raw.load(fromByteOffset: i * 4, as: UInt32.self)
                out[i] = Float(bitPattern: UInt32(littleEndian: bits))
            }
        }
        return PoseBuffer(floats: out)
    }

    public var tick: Int { Int(floats[0]) }
    public var cameraEyeZ: Float { floats[6] }
    public var heroX: Float { floats[20] }
    public var heroZ: Float { floats[22] }
    public var speedKmh: Int { Int(floats[68].rounded()) }
    public var rpm: Int { Int(floats[69].rounded()) }
    public var tachoRatio: Float { floats[70] }
    public var gear: Int { Int(floats[71].rounded()) }
    public var nitroAmount: Float { floats[72] }
    public var timerSec: Int { Int(floats[74].rounded()) }
    public var timerDec: Int { Int(floats[75].rounded()) }
    public var score: Int { Int(floats[76].rounded()) }
}

public struct FilamentFrameStats: Sendable {
    public let tick: Int
    public let frameTimeUs: UInt64
    public let visibleChunks: Int
    public let culledChunks: Int
    public let visibleInstances: Int
    public let lod0Chunks: Int
    public let lod1Chunks: Int
    public let lod2Chunks: Int
    public let activeTrafficCars: Int
}

public final class FilamentKineticPresenter: @unchecked Sendable {
    public let graphicsBackend: String
    public private(set) var currentStage: FilamentStageScene?
    public private(set) var frameCount: UInt64 = 0

    public init(graphicsBackend: String = "Metal") {
        self.graphicsBackend = graphicsBackend
    }

    @discardableResult
    public func loadStageGlb(_ data: Data) throws -> FilamentStageScene {
        guard data.count >= 20 else {
            throw NSError(domain: "FilamentKineticPresenter", code: 1, userInfo: [NSLocalizedDescriptionKey: "Truncated GLB header"])
        }
        let header: (UInt32, UInt32, UInt32, UInt32, UInt32) = data.withUnsafeBytes { raw in
            (
                UInt32(littleEndian: raw.load(fromByteOffset: 0, as: UInt32.self)),
                UInt32(littleEndian: raw.load(fromByteOffset: 4, as: UInt32.self)),
                UInt32(littleEndian: raw.load(fromByteOffset: 8, as: UInt32.self)),
                UInt32(littleEndian: raw.load(fromByteOffset: 12, as: UInt32.self)),
                UInt32(littleEndian: raw.load(fromByteOffset: 16, as: UInt32.self))
            )
        }
        guard header.0 == 0x4654_6C67, header.1 == 2, Int(header.2) == data.count, header.4 == 0x4E4F_534A else {
            throw NSError(domain: "FilamentKineticPresenter", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid GLB header"])
        }

        let jsonLen = Int(header.3)
        let jsonSlice = data.subdata(in: 20..<(20 + jsonLen))
        guard let root = try JSONSerialization.jsonObject(with: jsonSlice) as? [String: Any],
              let scenes = root["scenes"] as? [[String: Any]],
              let scene0 = scenes.first,
              let extras = scene0["extras"] as? [String: Any],
              let stk = extras["stk"] as? [String: Any] else {
            throw NSError(domain: "FilamentKineticPresenter", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing scene.extras.stk in GLB"])
        }

        let binHeaderOffset = 20 + jsonLen
        var binByteLength = 0
        if binHeaderOffset + 8 <= data.count {
            binByteLength = data.withUnsafeBytes { raw in
                Int(UInt32(littleEndian: raw.load(fromByteOffset: binHeaderOffset, as: UInt32.self)))
            }
        }

        guard let stageId = stk["stageId"] as? String, !stageId.isEmpty else {
            throw NSError(domain: "FilamentKineticPresenter", code: 4, userInfo: [NSLocalizedDescriptionKey: "Missing stageId in scene.extras.stk"])
        }
        let stageName = stk["stageName"] as? String ?? ""
        let segmentCount = (stk["segmentCount"] as? NSNumber)?.intValue ?? 0
        let segmentLengthMetres = (stk["segmentLengthMetres"] as? NSNumber)?.floatValue ?? 0.72
        let skyKtx2 = stk["skyKtx2"] as? String ?? ""
        let shoreSide = (stk["shoreSide"] as? NSNumber)?.intValue ?? 0
        let isNight = (stk["isNight"] as? NSNumber)?.boolValue ?? false
        let backdropLayers = stk["backdropLayers"] as? [String] ?? []

        var materials: [FilamatMaterialInstance] = []
        if let matArr = root["materials"] as? [[String: Any]] {
            for m in matArr {
                let name = m["name"] as? String ?? "mat"
                let mStk = (m["extras"] as? [String: Any])?["stk"] as? [String: Any]
                let toon = (mStk?["toon"] as? NSNumber)?.boolValue ?? true
                let painted = (mStk?["painted"] as? NSNumber)?.boolValue ?? false
                let brushed = (mStk?["brushed"] as? NSNumber)?.boolValue ?? false
                let sway = (mStk?["sway"] as? NSNumber)?.boolValue ?? false
                let depthOffset = (mStk?["depthOffset"] as? NSNumber)?.floatValue ?? 0.0
                let tint = mStk?["tint"] as? String
                let lift = (mStk?["lift"] as? NSNumber)?.floatValue ?? 1.0
                let grain = mStk?["grain"] as? String

                let filamatAsset: String
                if sway && grain == "leaves" {
                    filamatAsset = "materials/stk_foliage_sway.filamat"
                } else if brushed {
                    filamatAsset = "materials/stk_toon_brushed.filamat"
                } else if painted {
                    filamatAsset = "materials/stk_toon_painted.filamat"
                } else {
                    filamatAsset = "materials/stk_toon_standard.filamat"
                }

                materials.append(
                    FilamatMaterialInstance(
                        name: name,
                        filamatAsset: filamatAsset,
                        toon: toon,
                        painted: painted,
                        brushed: brushed,
                        sway: sway,
                        depthOffset: depthOffset,
                        tint: tint,
                        lift: lift,
                        grain: grain
                    )
                )
            }
        }

        var ribbonNodes: [String] = []
        var chunks: [FilamentInstancedChunk] = []
        if let nodeArr = root["nodes"] as? [[String: Any]] {
            for n in nodeArr {
                let name = n["name"] as? String ?? ""
                let ext = n["extensions"] as? [String: Any]
                if ext?["EXT_mesh_gpu_instancing"] != nil, let ex = n["extras"] as? [String: Any] {
                    chunks.append(
                        FilamentInstancedChunk(
                            name: name,
                            chunkIndex: (ex["chunkIndex"] as? NSNumber)?.intValue ?? 0,
                            startSegment: (ex["startSegment"] as? NSNumber)?.intValue ?? 0,
                            endSegment: (ex["endSegment"] as? NSNumber)?.intValue ?? 0,
                            zMin: (ex["zMin"] as? NSNumber)?.floatValue ?? 0.0,
                            zMax: (ex["zMax"] as? NSNumber)?.floatValue ?? 0.0,
                            kind: ex["kind"] as? String ?? "",
                            instanceCount: (ex["instanceCount"] as? NSNumber)?.intValue ?? 0
                        )
                    )
                } else {
                    ribbonNodes.append(name)
                }
            }
        }

        let textureCount = (root["images"] as? [[String: Any]])?.count ?? 0
        let scene = FilamentStageScene(
            stageId: stageId,
            stageName: stageName,
            segmentCount: segmentCount,
            segmentLengthMetres: segmentLengthMetres,
            skyKtx2: skyKtx2,
            backdropLayers: backdropLayers,
            shoreSide: shoreSide,
            isNight: isNight,
            ribbonNodes: ribbonNodes,
            materials: materials,
            chunks: chunks,
            textureCount: textureCount,
            binByteLength: binByteLength
        )
        currentStage = scene
        return scene
    }

    public func renderFrame(pose: PoseBuffer, variableStorage: DivVariableStorage? = nil) -> FilamentFrameStats {
        let startNs = DispatchTime.now().uptimeNanoseconds
        frameCount += 1

        let camZ = pose.cameraEyeZ
        let zNear = camZ - FilamentConstants.scatterBehind
        let zFar = camZ + FilamentConstants.scatterAhead

        var visibleChunks = 0
        var culledChunks = 0
        var visibleInstances = 0
        var lod0 = 0
        var lod1 = 0
        var lod2 = 0

        if let stage = currentStage {
            for chunk in stage.chunks {
                if chunk.zMax < zNear || chunk.zMin > zFar {
                    culledChunks += 1
                    continue
                }
                let dist = max(0.0, chunk.zMin - camZ)
                if dist > FilamentConstants.lodFar {
                    culledChunks += 1
                    continue
                }
                visibleChunks += 1
                visibleInstances += chunk.instanceCount
                if dist < FilamentConstants.lodSplits.0 {
                    lod0 += 1
                } else if dist < FilamentConstants.lodSplits.1 {
                    lod1 += 1
                } else {
                    lod2 += 1
                }
            }
        }

        var activeTraffic = 0
        for i in 0..<FilamentConstants.maxTrafficCars {
            let base = 90 + i * FilamentConstants.trafficStride
            if pose.floats[base] > 0.5 {
                activeTraffic += 1
            }
        }

        if let storage = variableStorage {
            let gearStr = pose.gear >= 2 ? "HI" : "LO"
            let clampedNitro = min(max(pose.nitroAmount, 0.0), 100.0)
            let nitroPct = "\(Int(clampedNitro.rounded()))%"
            storage.setVariable(name: "hud_speed", value: "\(pose.speedKmh)")
            storage.setVariable(name: "hud_rpm", value: "\(pose.rpm)")
            storage.setVariable(name: "hud_gear", value: gearStr)
            storage.setVariable(name: "hud_timer", value: "\(pose.timerSec)")
            storage.setVariable(name: "hud_timer_dec", value: ".\(pose.timerDec)")
            storage.setVariable(name: "hud_score", value: "\(pose.score)")
            storage.setVariable(name: "hud_nitro_text", value: nitroPct)
            storage.setVariable(name: "hud_tacho", value: "\(pose.tachoRatio)")
        }

        let elapsedUs = (DispatchTime.now().uptimeNanoseconds - startNs) / 1_000
        return FilamentFrameStats(
            tick: pose.tick,
            frameTimeUs: elapsedUs,
            visibleChunks: visibleChunks,
            culledChunks: culledChunks,
            visibleInstances: visibleInstances,
            lod0Chunks: lod0,
            lod1Chunks: lod1,
            lod2Chunks: lod2,
            activeTrafficCars: activeTraffic
        )
    }
}
