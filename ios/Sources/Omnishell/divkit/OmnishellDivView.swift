#if canImport(SwiftUI) && canImport(UIKit)
import Foundation
import SwiftUI
import UIKit
#if canImport(DivKit)
import DivKit
#endif

#if canImport(DivKit)
@available(iOS 16.0, *)
public final class OmnishellDivContainerView: UIView {
    public let divView: DivKit.DivView
    fileprivate var appliedAstCount: Int = 0
    fileprivate var appliedCardId: String = ""
    fileprivate var pendingSourceTask: Task<Void, Never>?

    public init(divKitComponents: DivKit.DivKitComponents) {
        self.divView = DivKit.DivView(divKitComponents: divKitComponents)
        super.init(frame: .zero)
        backgroundColor = .clear
        addSubview(divView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        if divView.frame != bounds {
            divView.frame = bounds
        }
        if bounds.width > 0 && bounds.height > 0 {
            divView.onVisibleBoundsChanged(to: bounds)
        }
    }
}

@available(iOS 16.0, *)
public struct OmnishellDivView: UIViewRepresentable {
    public let host: OmnishellDivKitHost
    public let revision: Int

    public init(host: OmnishellDivKitHost, revision: Int = 0) {
        self.host = host
        self.revision = revision
    }

    public func makeUIView(context: Context) -> OmnishellDivContainerView {
        OmnishellDivContainerView(divKitComponents: host.divKitComponents)
    }

    public func updateUIView(_ container: OmnishellDivContainerView, context: Context) {
        _ = revision
        let targetAstCount = host.astParseCount
        let astJson = host.lastRenderedAst
        let cardIdStr = host.currentCardId

        if targetAstCount != container.appliedAstCount,
           !astJson.isEmpty,
           let jsonData = astJson.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] {
            let cardChanged = !container.appliedCardId.isEmpty && container.appliedCardId != cardIdStr
            container.appliedAstCount = targetAstCount
            container.appliedCardId = cardIdStr

            let cardId = DivCardID(rawValue: cardIdStr.isEmpty ? "omnishell_card" : cardIdStr)
            let source = DivViewSource(kind: .json(dict), cardId: cardId)
            let previousTask = container.pendingSourceTask
            container.pendingSourceTask = Task { @MainActor in
                _ = await previousTask?.value
                await container.divView.setSource(
                    source,
                    shouldResetPreviousCardData: cardChanged
                )
                host.syncCurrentVariablesToDivKit()
                if container.bounds.width > 0 && container.bounds.height > 0 {
                    container.divView.onVisibleBoundsChanged(to: container.bounds)
                }
            }
        }

        let patches = host.drainPendingPatches()
        if !patches.isEmpty, !cardIdStr.isEmpty {
            let cardId = DivCardID(rawValue: cardIdStr)
            for patchStr in patches {
                if let patchData = patchStr.data(using: .utf8),
                   let patch = try? parseDivPatch(patchData) {
                    container.divView.applyPatch(patch, cardId: cardId)
                }
            }
        }
    }
}
#endif

@available(iOS 16.0, *)
@MainActor
public final class OmnishellStoreViewModel: ObservableObject {
    public let storageBridge: StorageBridge
    public let networkBridge: NetworkBridge
    public let authBridge: AuthBridge
    public let printBridge: PrintBridge
    public let divKitHost: OmnishellDivKitHost
    public let flipFactory: FlipCardDivCustomBlockFactory
    public let realmFactory: PrintRealmDivCustomBlockFactory
    public let engine: JavaScriptCoreOmnishellEngine
    public let resourcesUrl: URL
    public let origin: String

    @Published public private(set) var renderRevision: Int = 0
    private var lastReportedWidthDp: Int = 0
    private var lastReportedDark: Bool?

    public init(
        storageBridge: StorageBridge,
        networkBridge: NetworkBridge,
        authBridge: AuthBridge,
        printBridge: PrintBridge,
        divKitHost: OmnishellDivKitHost,
        resourcesUrl: URL,
        origin: String = "https://snapcards.fun",
        engine: JavaScriptCoreOmnishellEngine? = nil
    ) {
        self.storageBridge = storageBridge
        self.networkBridge = networkBridge
        self.authBridge = authBridge
        self.printBridge = printBridge
        self.divKitHost = divKitHost
        self.resourcesUrl = resourcesUrl
        self.origin = origin

        OmnishellImageLoader.shared.resourcesUrl = resourcesUrl
        OmnishellImageLoader.shared.origin = origin

        divKitHost.resourcesUrl = resourcesUrl
        divKitHost.origin = origin
        divKitHost.printBridge = printBridge

        let flip = FlipCardDivCustomBlockFactory()
        let realm = PrintRealmDivCustomBlockFactory(printBridge: printBridge)
        self.flipFactory = flip
        self.realmFactory = realm
        if !divKitHost.hasCustomFactory(supporting: "flip-card") {
            divKitHost.registerCustomFactory(flip)
        }
        if !divKitHost.hasCustomFactory(supporting: "print-realm") {
            divKitHost.registerCustomFactory(realm)
        }

        let resolvedEngine: JavaScriptCoreOmnishellEngine
        let needsStart: Bool
        if let providedEngine = engine {
            resolvedEngine = providedEngine
            resolvedEngine.resourcesUrl = resourcesUrl
            needsStart = false
        } else {
            let runtimeUrl = resourcesUrl.appendingPathComponent("omnishell-runtime.js")
            let runtimeScript: String
            do {
                runtimeScript = try String(contentsOf: runtimeUrl, encoding: .utf8)
            } catch {
                fatalError("Missing Omnishell host runtime bundle at \(runtimeUrl.path): \(error)")
            }
            resolvedEngine = JavaScriptCoreOmnishellEngine(
                networkBridge: networkBridge,
                storageBridge: storageBridge,
                initialScript: runtimeScript,
                authBridge: authBridge,
                origin: origin,
                printBridge: printBridge,
                resourcesUrl: resourcesUrl
            )
            needsStart = true
        }
        self.engine = resolvedEngine

        divKitHost.onHostUpdated = { [weak self] in
            if Thread.isMainThread {
                MainActor.assumeIsolated {
                    self?.renderRevision &+= 1
                }
            } else {
                DispatchQueue.main.async {
                    self?.renderRevision &+= 1
                }
            }
        }

        resolvedEngine.onAstChanged = { [weak resolvedEngine] ast in
            if Thread.isMainThread {
                _ = divKitHost.render(astJson: ast) { actionUri in
                    resolvedEngine?.dispatchAction(actionUri)
                }
            } else {
                DispatchQueue.main.async {
                    _ = divKitHost.render(astJson: ast) { actionUri in
                        resolvedEngine?.dispatchAction(actionUri)
                    }
                }
            }
        }
        resolvedEngine.onPatchChanged = { patchJson in
            if Thread.isMainThread {
                _ = divKitHost.applyPatch(patchJson: patchJson)
            } else {
                DispatchQueue.main.async {
                    _ = divKitHost.applyPatch(patchJson: patchJson)
                }
            }
        }
        resolvedEngine.onVariableChanged = { name, value in
            if Thread.isMainThread {
                divKitHost.updateVariable(name: name, value: value)
            } else {
                DispatchQueue.main.async {
                    divKitHost.updateVariable(name: name, value: value)
                }
            }
        }

        if needsStart {
            do {
                try resolvedEngine.start()
            } catch {
                fatalError("Failed to start JavaScriptCoreOmnishellEngine: \(error)")
            }
        } else if !resolvedEngine.uiAst.isEmpty && divKitHost.astParseCount == 0 {
            _ = divKitHost.render(astJson: resolvedEngine.uiAst) { [weak resolvedEngine] actionUri in
                resolvedEngine?.dispatchAction(actionUri)
            }
        }
        self.renderRevision = divKitHost.renderRevision
    }

    public func updateDisplay(viewportWidthDp: Int, isDark: Bool, isRtl: Bool) {
        let clampedWidth = max(viewportWidthDp, 320)
        guard clampedWidth != lastReportedWidthDp || isDark != lastReportedDark else {
            return
        }
        lastReportedWidthDp = clampedWidth
        lastReportedDark = isDark
        divKitHost.configureDisplay(
            viewportWidthDp: clampedWidth,
            themeMode: divKitHost.themeMode,
            layoutDirection: isRtl ? "rtl" : "ltr"
        )
        let scheme = isDark ? "dark" : "light"
        engine.dispatchAction("pronto://event/DISPLAY?viewport=\(clampedWidth)&scheme=\(scheme)")
    }
}

@available(iOS 16.0, *)
public struct OmnishellNativeAppView: View {
    @StateObject private var viewModel: OmnishellStoreViewModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.layoutDirection) private var layoutDirection

    public init(viewModel: @autoclosure @escaping () -> OmnishellStoreViewModel) {
        self._viewModel = StateObject(wrappedValue: viewModel())
    }

    public var body: some View {
        GeometryReader { proxy in
            #if canImport(DivKit)
            OmnishellDivView(
                host: viewModel.divKitHost,
                revision: viewModel.renderRevision
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear {
                let widthDp = Int(proxy.size.width.rounded())
                if widthDp > 0 {
                    viewModel.updateDisplay(
                        viewportWidthDp: widthDp,
                        isDark: colorScheme == .dark,
                        isRtl: layoutDirection == .rightToLeft
                    )
                }
            }
            .onChange(of: proxy.size.width) { newWidth in
                let widthDp = Int(newWidth.rounded())
                if widthDp > 0 {
                    viewModel.updateDisplay(
                        viewportWidthDp: widthDp,
                        isDark: colorScheme == .dark,
                        isRtl: layoutDirection == .rightToLeft
                    )
                }
            }
            .onChange(of: colorScheme) { newScheme in
                let widthDp = Int(proxy.size.width.rounded())
                if widthDp > 0 {
                    viewModel.updateDisplay(
                        viewportWidthDp: widthDp,
                        isDark: newScheme == .dark,
                        isRtl: layoutDirection == .rightToLeft
                    )
                }
            }
            #else
            EmptyView()
            #endif
        }
    }
}
#endif
