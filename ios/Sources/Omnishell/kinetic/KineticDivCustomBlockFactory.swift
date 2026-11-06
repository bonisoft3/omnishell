import Foundation

/// Upstream `divkit-ios` `DivCustomBlockFactory` mounting:
///   - `custom_type: "kinetic:<actor>"` -> `FilamentKineticPresenter` 3D `CAMetalLayer` block
///   - `custom_type: "kinetic-layer:<layer>"` -> Fast HUD layer bound to `@{hud_<layer>}`
public final class KineticDivCustomBlockFactory: DivCustomBlockFactory, @unchecked Sendable {

    public struct BoundHudLayer: Sendable {
        public let id: String
        public let layer: String
        public let variableName: String
        public let fill: Bool
        public var currentValue: String
    }

    public let presenter: FilamentKineticPresenter
    public private(set) var mountedKineticActor: String?
    private let lock = NSLock()
    private var hudLayers: [String: BoundHudLayer] = [:]
    private var layerUnsubscribes: [String: () -> Void] = [:]

    public init(presenter: FilamentKineticPresenter = FilamentKineticPresenter()) {
        self.presenter = presenter
    }

    public var boundHudLayersCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return hudLayers.count
    }

    public func getHudLayer(_ layer: String) -> BoundHudLayer? {
        lock.lock()
        defer { lock.unlock() }
        return hudLayers[layer]
    }

    public func isCustomTypeSupported(_ type: String) -> Bool {
        return type.hasPrefix("kinetic:") || type.hasPrefix("kinetic-layer:")
    }

    public func onBindCustomBlock(_ spec: DivCustomMountSpec, variableStorage: DivVariableStorage) {
        if spec.customType.hasPrefix("kinetic:") {
            mountedKineticActor = String(spec.customType.dropFirst("kinetic:".count))
            return
        }
        if spec.customType.hasPrefix("kinetic-layer:") {
            let layer = String(spec.customType.dropFirst("kinetic-layer:".count))
            lock.lock()
            let oldUnsub = layerUnsubscribes.removeValue(forKey: layer)
            lock.unlock()
            oldUnsub?()

            var rawVar = "@{hud_\(layer)}"
            var fill = false
            if let data = spec.customPropsJson.data(using: .utf8),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let v = obj["variable"] as? String { rawVar = v }
                if let f = obj["fill"] as? Bool { fill = f }
            }
            let varName = rawVar
                .replacingOccurrences(of: "@{", with: "")
                .replacingOccurrences(of: "}", with: "")
            let initial = variableStorage.getString(name: varName, default: "")

            lock.lock()
            hudLayers[layer] = BoundHudLayer(
                id: spec.id,
                layer: layer,
                variableName: varName,
                fill: fill,
                currentValue: initial
            )
            lock.unlock()

            let unsub = variableStorage.addListener { [weak self] changedVar, newValue in
                guard let self = self, changedVar == varName else { return }
                self.lock.lock()
                if var entry = self.hudLayers[layer] {
                    entry.currentValue = "\(newValue)"
                    self.hudLayers[layer] = entry
                }
                self.lock.unlock()
            }
            lock.lock()
            layerUnsubscribes[layer] = unsub
            lock.unlock()
        }
    }

    public func onReleaseCustomBlock(_ spec: DivCustomMountSpec) {
        if spec.customType.hasPrefix("kinetic:") {
            mountedKineticActor = nil
        } else if spec.customType.hasPrefix("kinetic-layer:") {
            let layer = String(spec.customType.dropFirst("kinetic-layer:".count))
            lock.lock()
            let unsub = layerUnsubscribes.removeValue(forKey: layer)
            hudLayers.removeValue(forKey: layer)
            lock.unlock()
            unsub?()
        }
    }
}
