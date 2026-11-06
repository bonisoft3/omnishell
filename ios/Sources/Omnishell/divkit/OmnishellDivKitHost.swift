import Foundation

/// Upstream DivKit (`divkit-ios`) variable storage bridge allowing 60–120 Hz scalar updates
/// (such as kinetic HUD telemetry and form input bindings) to mutate bound `@{variable}`
/// values in-place without re-parsing the card JSON AST.
public final class DivVariableStorage: @unchecked Sendable {
    private let lock = NSLock()
    private var variables: [String: Any] = [:]
    private var nextListenerId: Int = 1
    private var listeners: [Int: (String, Any) -> Void] = [:]

    public init() {}

    public var listenerCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return listeners.count
    }

    public func declare(name: String, initialValue: Any) {
        lock.lock()
        if variables[name] == nil {
            variables[name] = initialValue
        }
        lock.unlock()
    }

    public func setVariable(name: String, value: Any) {
        lock.lock()
        let prev = variables[name].map { "\($0)" }
        let next = "\(value)"
        variables[name] = value
        let callbacks = prev != next ? Array(listeners.values) : []
        lock.unlock()

        for cb in callbacks {
            cb(name, value)
        }
    }

    public func setVariables(_ batch: [String: Any]) {
        for (k, v) in batch {
            setVariable(name: k, value: v)
        }
    }

    public func getVariable(name: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return variables[name]
    }

    public func getString(name: String, default defaultValue: String = "") -> String {
        lock.lock()
        defer { lock.unlock() }
        if let v = variables[name] {
            return "\(v)"
        }
        return defaultValue
    }

    public func snapshot() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return variables
    }

    @discardableResult
    public func addListener(_ listener: @escaping (String, Any) -> Void) -> () -> Void {
        lock.lock()
        let id = nextListenerId
        nextListenerId += 1
        listeners[id] = listener
        lock.unlock()
        return { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            self.listeners.removeValue(forKey: id)
            self.lock.unlock()
        }
    }
}

/// Descriptor for a `div-custom` mount (`custom_type: "kinetic:<actor>"` or `"kinetic-layer:<layer>"`).
public struct DivCustomMountSpec: Sendable {
    public let id: String
    public let customType: String
    public let customPropsJson: String

    public init(id: String, customType: String, customPropsJson: String) {
        self.id = id
        self.customType = customType
        self.customPropsJson = customPropsJson
    }
}

/// Protocol matching upstream `divkit-ios` `DivCustomBlockFactory` for mounting native views
/// (`FilamentKineticPresenter` `CAMetalLayer` and HUD layers) inside a DivKit card layout.
public protocol DivCustomBlockFactory: AnyObject {
    func isCustomTypeSupported(_ type: String) -> Bool
    func onBindCustomBlock(_ spec: DivCustomMountSpec, variableStorage: DivVariableStorage)
    func onReleaseCustomBlock(_ spec: DivCustomMountSpec)
}

/// Shared Omnishell DivKit Host (`divkit-ios` card lifecycle, `DivVariableStorage`,
/// `DivCustomBlockFactory` registry, and error boundary fallback).
public final class OmnishellDivKitHost: @unchecked Sendable {
    public private(set) var currentCardId: String = ""
    public private(set) var lastRenderedAst: String = ""
    public private(set) var hasError: Bool = false
    /// Monotonically incremented only when the full card JSON AST is parsed.
    public private(set) var astParseCount: Int = 0

    public let variableStorage = DivVariableStorage()
    private var customFactories: [DivCustomBlockFactory] = []
    private var activeCustomMounts: [DivCustomMountSpec] = []

    public init() {}

    public func registerCustomFactory(_ factory: DivCustomBlockFactory) {
        customFactories.append(factory)
    }

    public func getActiveCustomMounts() -> [DivCustomMountSpec] {
        return activeCustomMounts
    }

    @discardableResult
    public func render(astJson: String, onAction: @escaping (String) -> Void) -> Bool {
        guard let data = astJson.data(using: .utf8),
              let jsonObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let card = jsonObj["card"] as? [String: Any] else {
            renderErrorFallback(errorMessage: "Missing or invalid 'card' root in DivKit JSON AST")
            return false
        }

        let logId = card["log_id"] as? String ?? "unknown_card"
        guard let states = card["states"] as? [[String: Any]], !states.isEmpty else {
            renderErrorFallback(errorMessage: "DivKit 'card' contains no 'states'")
            return false
        }

        if let vars = card["variables"] as? [[String: Any]] {
            for v in vars {
                guard let name = v["name"] as? String else { continue }
                let val = v["value"] ?? ""
                variableStorage.declare(name: name, initialValue: val)
            }
        }

        var mounts: [DivCustomMountSpec] = []
        for st in states {
            if let div = st["div"] as? [String: Any] {
                collectCustomMounts(div: div, out: &mounts)
            }
        }
        for prevMount in activeCustomMounts {
            for factory in customFactories where factory.isCustomTypeSupported(prevMount.customType) {
                factory.onReleaseCustomBlock(prevMount)
            }
        }
        activeCustomMounts = mounts
        for mount in mounts {
            for factory in customFactories where factory.isCustomTypeSupported(mount.customType) {
                factory.onBindCustomBlock(mount, variableStorage: variableStorage)
            }
        }

        currentCardId = logId
        lastRenderedAst = astJson
        hasError = false
        astParseCount += 1
        return true
    }

    /// Update a DivKit variable in-place without re-parsing the card JSON AST.
    public func updateVariable(name: String, value: Any) {
        variableStorage.setVariable(name: name, value: value)
    }

    private func collectCustomMounts(div: [String: Any], out: inout [DivCustomMountSpec]) {
        if let type = div["type"] as? String, type == "custom" {
            let id = div["id"] as? String ?? "custom"
            let customType = div["custom_type"] as? String ?? ""
            var propsJson = "{}"
            if let props = div["custom_props"],
               let data = try? JSONSerialization.data(withJSONObject: props),
               let str = String(data: data, encoding: .utf8) {
                propsJson = str
            }
            out.append(DivCustomMountSpec(id: id, customType: customType, customPropsJson: propsJson))
        }
        for key in ["items", "states"] {
            if let children = div[key] as? [[String: Any]] {
                for child in children {
                    collectCustomMounts(div: child, out: &out)
                }
            }
        }
        if let nested = div["div"] as? [String: Any] {
            collectCustomMounts(div: nested, out: &out)
        }
    }

    private func renderErrorFallback(errorMessage: String) {
        hasError = true
        currentCardId = "error_boundary_fallback"
        let escaped = errorMessage
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t")
        lastRenderedAst = """
        {
          "card": {
            "log_id": "error_boundary_fallback",
            "states": [
              {
                "state_id": 0,
                "div": {
                  "type": "text",
                  "text": "Native Render Error: \(escaped)",
                  "text_color": "#A93226"
                }
              }
            ]
          }
        }
        """
    }
}
