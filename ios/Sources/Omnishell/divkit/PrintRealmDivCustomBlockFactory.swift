import Foundation
#if canImport(WebKit)
import WebKit
#endif
#if canImport(DivKit) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
@preconcurrency import DivKit
@preconcurrency import LayoutKit
import UIKit
@preconcurrency import VGSL
#endif

public final class PrintRealmDivCustomBlockFactory: DivCustomBlockFactory, @unchecked Sendable {

    public struct BoundRealmBlock: Sendable {
        public let id: String
        public let customType: String
        public let unit: String
        public let isolation: String
        public let grants: [String]
        public let src: String?
        public let subdomain: String?
        public var deckId: String
        public var orderId: String
        public let locale: String
        public var direction: String
        public var theme: String
        public let origin: String
        public let dpi: Int
        public let allowsGeolocation: Bool
        public let allows300DpiCanvas: Bool
        public let allowsMediaPrint: Bool
        public let props: [String: String]
        public let events: [String: String]
        public let printActionUrl: String?
        public let checkoutActionUrl: String?
    }

    private let lock = NSLock()
    private var realms: [String: BoundRealmBlock] = [:]
    private var unsubscribes: [String: () -> Void] = [:]
    private let printBridge: PrintBridge?

    public init(printBridge: PrintBridge? = nil) {
        self.printBridge = printBridge
    }

    public var boundRealmsCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return realms.count
    }

    public func getRealmBlock(_ id: String) -> BoundRealmBlock? {
        lock.lock()
        defer { lock.unlock() }
        return realms[id]
    }

    public func isCustomTypeSupported(_ type: String) -> Bool {
        return type == "web-realm" || type == "print-realm" || type == "print_realm"
    }

    private static func resolveMaybeVar(_ raw: String?, storage: DivVariableStorage) -> String {
        guard let raw = raw, !raw.isEmpty else { return "" }
        if raw.hasPrefix("@{") && raw.hasSuffix("}") {
            let name = String(raw.dropFirst(2).dropLast())
            return storage.getString(name: name, default: "")
        }
        return raw
    }

    private func computeRealmBlock(
        spec: DivCustomMountSpec,
        storage: DivVariableStorage
    ) -> BoundRealmBlock {
        var obj: [String: Any] = [:]
        if let data = spec.customPropsJson.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            obj = parsed
        }

        let unit = obj["unit"] as? String ?? spec.id
        let isolation = obj["isolation"] as? String ?? "realm"
        let grants = (obj["grants"] as? [Any])?.compactMap { $0 as? String } ?? []
        let src = obj["src"] as? String
        let subdomain = obj["subdomain"] as? String

        let deckId = Self.resolveMaybeVar(obj["deck_id"] as? String, storage: storage)
        let orderId = Self.resolveMaybeVar(obj["order_id"] as? String, storage: storage)
        let locale = obj["locale"] as? String ?? "pt"
        let direction = storage.getString(
            name: "layout_direction",
            default: obj["direction"] as? String ?? "ltr"
        )
        let theme = storage.getString(
            name: "resolved_theme",
            default: obj["theme"] as? String ?? "light"
        )
        let origin = obj["origin"] as? String ?? "https://snapcards.fun"

        var props: [String: String] = [:]
        if let rawProps = obj["props"] as? [String: Any] {
            for (k, v) in rawProps {
                props[k] = "\(v)"
            }
        }
        var events: [String: String] = [:]
        if let rawEvents = obj["events"] as? [String: Any] {
            for (k, v) in rawEvents {
                events[k] = "\(v)"
            }
        }

        let dpi = props["dpi"].flatMap(Int.init)
            ?? (obj["dpi"] as? NSNumber)?.intValue
            ?? 300
        let isPrintSheet = spec.customType == "print-realm" || spec.customType == "print_realm"

        return BoundRealmBlock(
            id: spec.id,
            customType: spec.customType,
            unit: unit,
            isolation: isolation,
            grants: grants,
            src: src,
            subdomain: subdomain,
            deckId: deckId,
            orderId: orderId,
            locale: locale,
            direction: direction,
            theme: theme,
            origin: origin,
            dpi: dpi,
            allowsGeolocation: grants.contains("geolocation"),
            allows300DpiCanvas: isPrintSheet || grants.contains("canvas-300dpi"),
            allowsMediaPrint: isPrintSheet || grants.contains("print"),
            props: props,
            events: events,
            printActionUrl: obj["print_action_url"] as? String,
            checkoutActionUrl: obj["checkout_action_url"] as? String
        )
    }

    public func onBindCustomBlock(_ spec: DivCustomMountSpec, variableStorage: DivVariableStorage) {
        guard isCustomTypeSupported(spec.customType) else { return }

        lock.lock()
        let prev = unsubscribes.removeValue(forKey: spec.id)
        lock.unlock()
        prev?()

        let initial = computeRealmBlock(spec: spec, storage: variableStorage)
        lock.lock()
        realms[spec.id] = initial
        lock.unlock()

        let unsub = variableStorage.addListener { [weak self, weak variableStorage] changedVar, _ in
            guard let self = self, let storage = variableStorage else { return }
            if changedVar == "active_deck_id" ||
               changedVar == "active_order_id" ||
               changedVar == "resolved_theme" ||
               changedVar == "layout_direction" {
                let updated = self.computeRealmBlock(spec: spec, storage: storage)
                self.lock.lock()
                self.realms[spec.id] = updated
                self.lock.unlock()
            }
        }

        lock.lock()
        unsubscribes[spec.id] = unsub
        lock.unlock()
    }

    public func onReleaseCustomBlock(_ spec: DivCustomMountSpec) {
        guard isCustomTypeSupported(spec.customType) else { return }
        lock.lock()
        let unsub = unsubscribes.removeValue(forKey: spec.id)
        realms.removeValue(forKey: spec.id)
        lock.unlock()
        unsub?()
    }

    public func requestGeolocationForRealm(
        realmId: String,
        originUrl: String,
        completion: @escaping @Sendable (Bool) -> Void
    ) {
        guard let block = getRealmBlock(realmId), block.allowsGeolocation else {
            completion(false)
            return
        }
        guard let bridge = printBridge else {
            completion(true)
            return
        }
        bridge.delegateGeolocationPermission(
            originUrl: originUrl,
            unit: block.unit,
            grants: block.grants,
            completion: completion
        )
    }

    public func triggerRealmPrint(realmId: String, onComplete: (@Sendable (String) -> Void)? = nil) {
        guard let block = getRealmBlock(realmId) else { return }
        let url = block.printActionUrl?
            .replacingOccurrences(of: "@{active_deck_id}", with: block.deckId)
            ?? "omnishell://print?job=Snapcards&unit=\(block.unit)&deck=\(block.deckId)&dpi=\(block.dpi)"
        _ = printBridge?.handleActionUri(url, onComplete: onComplete)
    }

    #if canImport(DivKit) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit) && canImport(WebKit)
    public func makeDivBlock(
        data: DivCustomData,
        context: DivBlockModelingContext,
        resourcesUrl: URL?
    ) -> Block {
        let props = data.data
        let rawDeck = props["deck_id"] as? String ?? ""
        let resolvedDeck = rawDeck.hasPrefix("@{")
            ? (context.expressionResolver.resolveString(rawDeck) ?? "")
            : rawDeck
        let src = props["src"] as? String
        let origin = props["origin"] as? String ?? "https://snapcards.fun"
        let unit = props["unit"] as? String ?? data.name

        let fixedHeight: CGFloat
        switch data.heightTrait {
        case let .fixed(h): fixedHeight = h
        default: fixedHeight = (data.name == "print-realm" || data.name == "print_realm") ? 360 : 240
        }

        let lazyView = Lazy<GenericViewBlock.Content>(onMainThreadGetter: {
            MainActor.assumeIsolated {
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                let webView = WKWebView(frame: .zero, configuration: config)
                webView.isOpaque = false
                webView.backgroundColor = .clear
                webView.layer.cornerRadius = 12
                webView.clipsToBounds = true
                if let src = src, !src.isEmpty {
                    let cleanRel = src.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    if let res = resourcesUrl {
                        let localCandidate = res.appendingPathComponent("web").appendingPathComponent(cleanRel)
                        if FileManager.default.fileExists(atPath: localCandidate.path) {
                            webView.loadFileURL(localCandidate, allowingReadAccessTo: res)
                            return .view(webView)
                        }
                    }
                    if let remoteUrl = URL(string: DivImageSupport.resolveImageUrl(src, origin: origin)) {
                        webView.load(URLRequest(url: remoteUrl))
                        return .view(webView)
                    }
                }
                let html = """
                <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
                <style>body{margin:0;padding:16px;font:14px -apple-system,sans-serif;color:#334155;background:#FAF8F5;border-radius:12px}</style>
                </head><body><strong>\(unit)</strong><div style="margin-top:6px;opacity:0.75">Deck: \(resolvedDeck)</div></body></html>
                """
                webView.loadHTMLString(html, baseURL: URL(string: origin))
                return .view(webView)
            }
        })

        return GenericViewBlock(
            lazyContent: lazyView,
            width: .resizable,
            height: .fixed(fixedHeight)
        )
    }
    #endif
}
