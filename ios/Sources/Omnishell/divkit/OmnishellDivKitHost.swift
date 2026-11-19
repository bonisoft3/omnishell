import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
@preconcurrency import DivKit
@preconcurrency import DivKitSVG
@preconcurrency import LayoutKit
@preconcurrency import VGSL
#endif

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

public struct DivCustomMountSpec: Sendable {
    public let id: String
    public let customType: String
    public let customPropsJson: String
    public let itemsCount: Int
    public let itemsJson: String

    public init(
        id: String,
        customType: String,
        customPropsJson: String,
        itemsCount: Int = 0,
        itemsJson: String = "[]"
    ) {
        self.id = id
        self.customType = customType
        self.customPropsJson = customPropsJson
        self.itemsCount = itemsCount
        self.itemsJson = itemsJson
    }
}

public struct DivStateBlockSpec: Sendable {
    public let id: String
    public let defaultStateId: String
    public let stateIdVariable: String?
    public let stateIds: [String]
}

public protocol DivCustomBlockFactory: AnyObject {
    func isCustomTypeSupported(_ type: String) -> Bool
    func onBindCustomBlock(_ spec: DivCustomMountSpec, variableStorage: DivVariableStorage)
    func onReleaseCustomBlock(_ spec: DivCustomMountSpec)
}

public final class OmnishellDivKitHost: @unchecked Sendable {
    private let stateLock = NSLock()
    public private(set) var currentCardId: String = ""
    public private(set) var lastRenderedAst: String = ""
    public private(set) var hasError: Bool = false
    public private(set) var astParseCount: Int = 0
    public private(set) var renderRevision: Int = 0
    public private(set) var viewportWidthDp: Int = 390
    public private(set) var themeMode: String = "auto"
    public private(set) var layoutDirection: String = "ltr"

    public var isRtl: Bool {
        return layoutDirection == "rtl"
    }

    public var formFactor: String {
        return viewportWidthDp >= 768 ? "tablet" : "phone"
    }

    public var printBridge: PrintBridge?
    public var resourcesUrl: URL? {
        didSet {
            #if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
            resourceRequester?.updateContext(resourcesUrl: resourcesUrl, origin: origin)
            #endif
        }
    }
    public var origin: String = "https://snapcards.fun" {
        didSet {
            #if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
            resourceRequester?.updateContext(resourcesUrl: resourcesUrl, origin: origin)
            #endif
        }
    }

    public let variableStorage = DivVariableStorage()
    private var customFactories: [DivCustomBlockFactory] = []
    private var activeCustomMounts: [DivCustomMountSpec] = []
    private var activeStateBlocks: [String: DivStateBlockSpec] = [:]
    private var explicitStateSelection: [String: String] = [:]
    private var activePalette: [String: (light: String, dark: String)] = [:]
    private var onActionCallback: ((String) -> Void)?
    private var _divKitErrors: [String] = []
    private var _pendingPatchJsons: [String] = []
    public var onHostUpdated: (() -> Void)?

    #if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
    private var _divKitComponents: DivKit.DivKitComponents?
    private var resourceRequester: OmnishellDivImageHolderFactory?
    private var divVarObserverDisposable: Disposable?
    private var isSyncingToDivKit = false
    #endif

    public init() {}

    public var divKitErrors: [String] {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _divKitErrors
    }

    public func recordDivKitError(_ message: String) {
        stateLock.lock()
        _divKitErrors.append(message)
        stateLock.unlock()
    }

    public func clearDivKitErrors() {
        stateLock.lock()
        _divKitErrors.removeAll()
        stateLock.unlock()
    }

    public func drainPendingPatches() -> [String] {
        stateLock.lock()
        let out = _pendingPatchJsons
        _pendingPatchJsons.removeAll()
        stateLock.unlock()
        return out
    }

    public func hasCustomFactory(supporting customType: String) -> Bool {
        customFactories.contains { $0.isCustomTypeSupported(customType) }
    }

    #if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
    public var divKitComponents: DivKit.DivKitComponents {
        if let existing = _divKitComponents {
            return existing
        }
        let created = buildDivKitComponents()
        _divKitComponents = created
        return created
    }

    private func buildDivKitComponents() -> DivKit.DivKitComponents {
        if Thread.isMainThread {
            DivKitLogger.isEnabled = true
            DivKitLogger.setLogger { [weak self] level, msg in
                if level == .error {
                    self?.recordDivKitError(msg)
                }
            }
        }
        let imageFactory = OmnishellDivImageHolderFactory(resourcesUrl: resourcesUrl, origin: origin)
        self.resourceRequester = imageFactory
        let customFactory = OmnishellCompositeDivCustomBlockFactory(host: self)
        let reporter = OmnishellDivReporter(host: self)
        let urlHandler = DivUrlHandlerDelegate { [weak self] url, _ in
            self?.dispatchActionUri(url.absoluteString)
        }
        let components = DivKit.DivKitComponents(
            divCustomBlockFactory: customFactory,
            imageHolderFactory: imageFactory,
            layoutDirection: isRtl ? .rightToLeft : .leftToRight,
            reporter: reporter,
            urlHandler: urlHandler
        )
        divVarObserverDisposable = components.variablesStorage.addObserver { [weak self, weak components] event in
            guard let self = self, let components = components, !self.isSyncingToDivKit else { return }
            let cardId: DivCardID
            switch event.kind {
            case let .local(cid, _):
                cardId = cid
            case .global:
                guard !self.currentCardId.isEmpty else { return }
                cardId = DivCardID(rawValue: self.currentCardId)
            }
            for varName in event.changedVariables {
                guard let val = components.variablesStorage.getVariableValue(cardId: cardId, name: varName) else {
                    continue
                }
                let rawKey = varName.rawValue
                let swiftVal: Any
                switch val {
                case let .string(s): swiftVal = s
                case let .integer(i): swiftVal = i
                case let .number(d): swiftVal = d
                case let .bool(b): swiftVal = b
                case let .url(u): swiftVal = u.absoluteString
                case .color, .dict, .array: continue
                }
                self.variableStorage.setVariable(name: rawKey, value: swiftVal)
                if rawKey.hasPrefix("input_") {
                    let field = String(rawKey.dropFirst("input_".count))
                    let encodedField = field.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? field
                    let strVal = "\(swiftVal)"
                    let encodedVal = strVal.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? strVal
                    self.onActionCallback?("pronto://event/INPUT?field=\(encodedField)&value=\(encodedVal)")
                } else if rawKey == "flipped" {
                    let strVal = "\(swiftVal)"
                    let encodedVal = strVal.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? strVal
                    self.onActionCallback?("div-action://set_variable?name=flipped&value=\(encodedVal)")
                }
            }
        }
        return components
    }

    fileprivate func makeCustomBlock(data: DivCustomData, context: DivBlockModelingContext) -> Block {
        for factory in customFactories where factory.isCustomTypeSupported(data.name) {
            if let flip = factory as? FlipCardDivCustomBlockFactory {
                return flip.makeDivBlock(data: data, context: context)
            }
            #if canImport(WebKit)
            if let realm = factory as? PrintRealmDivCustomBlockFactory {
                return realm.makeDivBlock(data: data, context: context, resourcesUrl: resourcesUrl)
            }
            #endif
        }
        context.addError(message: "Unsupported DivCustom block type: \(data.name)")
        return EmptyBlock.zeroSized
    }

    public func syncCurrentVariablesToDivKit() {
        guard !currentCardId.isEmpty else { return }
        let components = self.divKitComponents
        let cid = DivCardID(rawValue: currentCardId)
        let snap = variableStorage.snapshot()
        if Thread.isMainThread {
            isSyncingToDivKit = true
            for (k, v) in snap {
                let strVal = (v as? Bool).map { $0 ? "true" : "false" } ?? "\(v)"
                components.variablesStorage.update(cardId: cid, name: DivVariableName(rawValue: k), value: strVal)
            }
            isSyncingToDivKit = false
        }
    }

    private func syncVariableToDivKit(name: String, value: Any) {
        guard !currentCardId.isEmpty else { return }
        let components = self.divKitComponents
        let cardId = DivCardID(rawValue: currentCardId)
        let varName = DivVariableName(rawValue: name)
        let strValue: String
        if let b = value as? Bool {
            strValue = b ? "true" : "false"
        } else {
            strValue = "\(value)"
        }
        if Thread.isMainThread {
            isSyncingToDivKit = true
            components.variablesStorage.update(cardId: cardId, name: varName, value: strValue)
            isSyncingToDivKit = false
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.isSyncingToDivKit = true
                components.variablesStorage.update(cardId: cardId, name: varName, value: strValue)
                self.isSyncingToDivKit = false
            }
        }
    }

    private func syncCardVariablesToDivKit(cardId: String, vars: [[String: Any]]) {
        guard let components = _divKitComponents, !cardId.isEmpty else { return }
        var divVars = DivVariables()
        for v in vars {
            guard let name = v["name"] as? String else { continue }
            let typeStr = v["type"] as? String ?? "string"
            let rawVal = v["value"]
            let vName = DivVariableName(rawValue: name)
            switch typeStr {
            case "boolean":
                let b = (rawVal as? Bool) ?? ("\(rawVal ?? "false")".lowercased() == "true")
                divVars[vName] = .bool(b)
            case "integer":
                let i = (rawVal as? NSNumber)?.intValue ?? Int("\(rawVal ?? "0")") ?? 0
                divVars[vName] = .integer(i)
            case "number":
                let d = (rawVal as? NSNumber)?.doubleValue ?? Double("\(rawVal ?? "0")") ?? 0.0
                divVars[vName] = .number(d)
            default:
                divVars[vName] = .string("\(rawVal ?? "")")
            }
        }
        let cid = DivCardID(rawValue: cardId)
        let snapshotVars = divVars
        if Thread.isMainThread {
            isSyncingToDivKit = true
            components.variablesStorage.append(variables: snapshotVars, for: cid, replaceExisting: true)
            isSyncingToDivKit = false
        } else {
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.isSyncingToDivKit = true
                components.variablesStorage.append(variables: snapshotVars, for: cid, replaceExisting: true)
                self.isSyncingToDivKit = false
            }
        }
    }
    #endif

    public func configureDisplay(
        viewportWidthDp: Int? = nil,
        themeMode: String? = nil,
        layoutDirection: String? = nil
    ) {
        if let w = viewportWidthDp { self.viewportWidthDp = w }
        if let t = themeMode { self.themeMode = t }
        if let d = layoutDirection { self.layoutDirection = d }
        updateVariable(name: "form_factor", value: formFactor)
        updateVariable(name: "theme_mode", value: self.themeMode)
        if self.themeMode == "light" || self.themeMode == "dark" {
            updateVariable(name: "resolved_theme", value: self.themeMode)
        }
        updateVariable(name: "layout_direction", value: self.layoutDirection)
        for factory in customFactories {
            if let flipFactory = factory as? FlipCardDivCustomBlockFactory {
                flipFactory.isRtl = isRtl
            }
        }
    }

    public func getPaletteColors() -> [String: (light: String, dark: String)] {
        return activePalette
    }

    public func registerCustomFactory(_ factory: DivCustomBlockFactory) {
        customFactories.append(factory)
    }

    public func getActiveCustomMounts() -> [DivCustomMountSpec] {
        return activeCustomMounts
    }

    public func getStateBlocks() -> [DivStateBlockSpec] {
        return Array(activeStateBlocks.values)
    }

    public func currentStateId(for blockId: String) -> String? {
        if let explicit = explicitStateSelection[blockId] {
            return explicit
        }
        guard let spec = activeStateBlocks[blockId] else { return nil }
        if let varName = spec.stateIdVariable {
            return variableStorage.getString(name: varName, default: spec.defaultStateId)
        }
        return spec.defaultStateId
    }

    public func dispatchActionUri(_ actionUri: String) {
        if actionUri.hasPrefix("div-action://set_variable?"),
           let comps = URLComponents(string: actionUri),
           let items = comps.queryItems {
            let name = items.first(where: { $0.name == "name" })?.value
            let val = items.first(where: { $0.name == "value" })?.value
            if let name = name, let val = val {
                updateVariable(name: name, value: val)
                onActionCallback?(actionUri)
            }
            return
        }
        if actionUri.hasPrefix("div-action://set_state?"),
           let comps = URLComponents(string: actionUri),
           let statePath = comps.queryItems?.first(where: { $0.name == "state_id" })?.value {
            let parts = statePath.split(separator: "/").map(String.init)
            if parts.count >= 2 {
                let targetBlock = parts[parts.count - 2]
                let nextState = parts[parts.count - 1]
                explicitStateSelection[targetBlock] = nextState
                if let spec = activeStateBlocks[targetBlock], let varName = spec.stateIdVariable {
                    updateVariable(name: varName, value: nextState)
                }
            }
            return
        }
        if actionUri.hasPrefix("omnishell://print") || actionUri.hasPrefix("omnishell://checkout") {
            _ = printBridge?.handleActionUri(actionUri)
            onActionCallback?(actionUri)
            return
        }
        #if canImport(UIKit)
        if actionUri.hasPrefix("https://") || actionUri.hasPrefix("http://"),
           let extUrl = URL(string: actionUri) {
            DispatchQueue.main.async {
                UIApplication.shared.open(extUrl)
            }
            return
        }
        #endif
        onActionCallback?(actionUri)
    }

    @discardableResult
    public func applyPatch(patchJson: String) -> Bool {
        guard let data = patchJson.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              obj["patch"] is [String: Any] || obj["changes"] is [[String: Any]] else {
            return false
        }
        let normalizedPatch: String
        if obj["patch"] != nil {
            normalizedPatch = patchJson
        } else if let wrappedData = try? JSONSerialization.data(withJSONObject: ["patch": obj]),
                  let wrappedStr = String(data: wrappedData, encoding: .utf8) {
            normalizedPatch = wrappedStr
        } else {
            return false
        }
        stateLock.lock()
        _pendingPatchJsons.append(normalizedPatch)
        renderRevision += 1
        let notify = onHostUpdated
        stateLock.unlock()
        notify?()
        return true
    }

    @discardableResult
    public func render(astJson: String, onAction: @escaping (String) -> Void) -> Bool {
        self.onActionCallback = onAction
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

        let vars = card["variables"] as? [[String: Any]] ?? []
        for v in vars {
            guard let name = v["name"] as? String else { continue }
            let val = v["value"] ?? ""
            variableStorage.setVariable(name: name, value: val)
            if name == "layout_direction", let dirStr = val as? String {
                layoutDirection = dirStr
                for factory in customFactories {
                    if let flipFactory = factory as? FlipCardDivCustomBlockFactory {
                        flipFactory.isRtl = (dirStr == "rtl")
                    }
                }
            }
        }

        activePalette.removeAll()
        if let paletteArr = card["palette"] as? [[String: Any]] {
            for p in paletteArr {
                guard let pName = p["name"] as? String,
                      let pLight = p["light"] as? String else { continue }
                let pDark = p["dark"] as? String ?? pLight
                activePalette[pName] = (light: pLight, dark: pDark)
            }
        }

        var mounts: [DivCustomMountSpec] = []
        var stateBlocks: [String: DivStateBlockSpec] = [:]
        for st in states {
            if let div = st["div"] as? [String: Any] {
                collectDescriptors(div: div, mounts: &mounts, stateBlocks: &stateBlocks)
            }
        }
        for prevMount in activeCustomMounts {
            for factory in customFactories where factory.isCustomTypeSupported(prevMount.customType) {
                factory.onReleaseCustomBlock(prevMount)
            }
        }
        activeCustomMounts = mounts
        activeStateBlocks = stateBlocks
        for mount in mounts {
            for factory in customFactories where factory.isCustomTypeSupported(mount.customType) {
                factory.onBindCustomBlock(mount, variableStorage: variableStorage)
            }
        }

        stateLock.lock()
        currentCardId = logId
        lastRenderedAst = astJson
        hasError = false
        astParseCount += 1
        renderRevision += 1
        let notify = onHostUpdated
        stateLock.unlock()

        #if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
        syncCardVariablesToDivKit(cardId: logId, vars: vars)
        #endif

        notify?()
        return true
    }

    public func updateVariable(name: String, value: Any) {
        variableStorage.setVariable(name: name, value: value)
        #if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
        syncVariableToDivKit(name: name, value: value)
        #endif
    }

    private func collectDescriptors(
        div: [String: Any],
        mounts: inout [DivCustomMountSpec],
        stateBlocks: inout [String: DivStateBlockSpec]
    ) {
        if let type = div["type"] as? String {
            if type == "custom" {
                let id = div["id"] as? String ?? "custom"
                let customType = div["custom_type"] as? String ?? ""
                var propsJson = "{}"
                if let props = div["custom_props"],
                   let data = try? JSONSerialization.data(withJSONObject: props),
                   let str = String(data: data, encoding: .utf8) {
                    propsJson = str
                }
                let childItems = div["items"] as? [[String: Any]] ?? []
                var itemsStr = "[]"
                if !childItems.isEmpty,
                   let iData = try? JSONSerialization.data(withJSONObject: childItems),
                   let str = String(data: iData, encoding: .utf8) {
                    itemsStr = str
                }
                mounts.append(
                    DivCustomMountSpec(
                        id: id,
                        customType: customType,
                        customPropsJson: propsJson,
                        itemsCount: childItems.count,
                        itemsJson: itemsStr
                    )
                )
            } else if type == "state" {
                let id = (div["div_id"] as? String) ?? (div["id"] as? String) ?? "state"
                let defaultStateId = div["default_state_id"] as? String ?? "closed"
                let stateIdVar = div["state_id_variable"] as? String
                let stList = (div["states"] as? [[String: Any]] ?? []).compactMap { $0["state_id"] as? String }
                stateBlocks[id] = DivStateBlockSpec(
                    id: id,
                    defaultStateId: defaultStateId,
                    stateIdVariable: stateIdVar,
                    stateIds: stList
                )
            }
        }
        for key in ["items", "states"] {
            if let children = div[key] as? [[String: Any]] {
                for child in children {
                    collectDescriptors(div: child, mounts: &mounts, stateBlocks: &stateBlocks)
                }
            }
        }
        if let nested = div["div"] as? [String: Any] {
            collectDescriptors(div: nested, mounts: &mounts, stateBlocks: &stateBlocks)
        }
    }

    private func renderErrorFallback(errorMessage: String) {
        stateLock.lock()
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
        renderRevision += 1
        let notify = onHostUpdated
        stateLock.unlock()
        notify?()
    }
}

#if canImport(DivKit) && canImport(DivKitSVG) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
private final class OmnishellCompositeDivCustomBlockFactory: DivKit.DivCustomBlockFactory {
    private weak var host: OmnishellDivKitHost?

    init(host: OmnishellDivKitHost) {
        self.host = host
    }

    func makeBlock(data: DivCustomData, context: DivBlockModelingContext) -> Block {
        guard let host = host else {
            return EmptyBlock.zeroSized
        }
        return host.makeCustomBlock(data: data, context: context)
    }
}

private final class OmnishellDivReporter: DivKit.DivReporter {
    private weak var host: OmnishellDivKitHost?

    init(host: OmnishellDivKitHost) {
        self.host = host
    }

    func reportError(cardId: DivCardID, error: DivError) {
        if error.level == .error {
            host?.recordDivKitError("[\(cardId.rawValue)] \(error.message)")
        }
    }
}
#endif
