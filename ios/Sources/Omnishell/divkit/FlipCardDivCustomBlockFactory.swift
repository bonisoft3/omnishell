import Foundation
import QuartzCore
#if canImport(DivKit) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
@preconcurrency import DivKit
@preconcurrency import LayoutKit
import UIKit
@preconcurrency import VGSL
#endif

public final class FlipCardDivCustomBlockFactory: DivCustomBlockFactory, @unchecked Sendable {

    public struct BoundFlipCard: Sendable {
        public let id: String
        public let flippedVariable: String
        public let perspectivePx: Double
        public let durationMs: Int
        public let itemsCount: Int
        public var isFlipped: Bool
        public var rotationRadians: Double
        public var frontTransform: CATransform3D
        public var backTransform: CATransform3D
        public var frontHidden: Bool
        public var backHidden: Bool
    }

    private let lock = NSLock()
    private var cards: [String: BoundFlipCard] = [:]
    private var unsubscribes: [String: () -> Void] = [:]
    public var isRtl: Bool = false

    public init(isRtl: Bool = false) {
        self.isRtl = isRtl
    }

    public var boundCardsCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return cards.count
    }

    public func getFlipCard(_ id: String) -> BoundFlipCard? {
        lock.lock()
        defer { lock.unlock() }
        return cards[id]
    }

    public func isCustomTypeSupported(_ type: String) -> Bool {
        return type == "flip-card" || type == "flip_card_3d"
    }

    public static func isTruthyFlip(_ raw: String) -> Bool {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lower == "yes" || lower == "true" || lower == "1"
    }

    public static func makePerspectiveRotation(angleRadians: CGFloat, perspectivePx: Double) -> CATransform3D {
        var perspective = CATransform3DIdentity
        perspective.m34 = -1.0 / CGFloat(max(perspectivePx, 100.0))
        let rotation = CATransform3DMakeRotation(angleRadians, 0.0, 1.0, 0.0)
        return CATransform3DConcat(rotation, perspective)
    }

    private func computeState(
        id: String,
        flippedVariable: String,
        perspectivePx: Double,
        durationMs: Int,
        itemsCount: Int,
        rawValue: String
    ) -> BoundFlipCard {
        let flipped = Self.isTruthyFlip(rawValue)
        let dir: Double = isRtl ? -1.0 : 1.0
        let frontAngle = flipped ? (dir * Double.pi) : 0.0
        let backAngle = flipped ? 0.0 : (-dir * Double.pi)
        return BoundFlipCard(
            id: id,
            flippedVariable: flippedVariable,
            perspectivePx: perspectivePx,
            durationMs: durationMs,
            itemsCount: itemsCount,
            isFlipped: flipped,
            rotationRadians: frontAngle,
            frontTransform: Self.makePerspectiveRotation(
                angleRadians: CGFloat(frontAngle),
                perspectivePx: perspectivePx
            ),
            backTransform: Self.makePerspectiveRotation(
                angleRadians: CGFloat(backAngle),
                perspectivePx: perspectivePx
            ),
            frontHidden: flipped,
            backHidden: !flipped
        )
    }

    public func onBindCustomBlock(_ spec: DivCustomMountSpec, variableStorage: DivVariableStorage) {
        guard isCustomTypeSupported(spec.customType) else { return }

        lock.lock()
        let prevUnsub = unsubscribes.removeValue(forKey: spec.id)
        lock.unlock()
        prevUnsub?()

        var flippedVar = "flipped"
        var perspectivePx = 1200.0
        var durationMs = 600

        if let data = spec.customPropsJson.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let explicitVar = obj["flipped_variable"] as? String, !explicitVar.isEmpty {
                flippedVar = explicitVar
            } else if let expr = obj["flipped"] as? String {
                flippedVar = expr
                    .replacingOccurrences(of: "@{", with: "")
                    .replacingOccurrences(of: "}", with: "")
            }
            if let p = obj["perspective_px"] as? NSNumber {
                perspectivePx = p.doubleValue
            }
            if let d = obj["duration_ms"] as? NSNumber {
                durationMs = d.intValue
            }
        }

        let initialVal = variableStorage.getString(name: flippedVar, default: "no")
        let initialState = computeState(
            id: spec.id,
            flippedVariable: flippedVar,
            perspectivePx: perspectivePx,
            durationMs: durationMs,
            itemsCount: spec.itemsCount,
            rawValue: initialVal
        )

        lock.lock()
        cards[spec.id] = initialState
        lock.unlock()

        let cardId = spec.id
        let itemCnt = spec.itemsCount
        let unsub = variableStorage.addListener { [weak self] changedVar, newValue in
            guard let self = self, changedVar == flippedVar else { return }
            let updated = self.computeState(
                id: cardId,
                flippedVariable: flippedVar,
                perspectivePx: perspectivePx,
                durationMs: durationMs,
                itemsCount: itemCnt,
                rawValue: "\(newValue)"
            )
            self.lock.lock()
            self.cards[cardId] = updated
            self.lock.unlock()
        }

        lock.lock()
        unsubscribes[spec.id] = unsub
        lock.unlock()
    }

    public func onReleaseCustomBlock(_ spec: DivCustomMountSpec) {
        guard isCustomTypeSupported(spec.customType) else { return }
        lock.lock()
        let unsub = unsubscribes.removeValue(forKey: spec.id)
        cards.removeValue(forKey: spec.id)
        lock.unlock()
        unsub?()
    }

    #if canImport(DivKit) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
    public func makeDivBlock(data: DivCustomData, context: DivBlockModelingContext) -> Block {
        let props = data.data
        let flippedVar: String
        if let explicitVar = props["flipped_variable"] as? String, !explicitVar.isEmpty {
            flippedVar = explicitVar
        } else if let expr = props["flipped"] as? String, expr.hasPrefix("@{"), expr.hasSuffix("}") {
            flippedVar = String(expr.dropFirst(2).dropLast())
        } else {
            flippedVar = "flipped"
        }

        // Resolving via expressionResolver registers flippedVar in context.variableTracker
        // so DivView re-models this block in place whenever flipped mutates.
        let resolvedFlipStr = context.expressionResolver.resolveString("@{\(flippedVar)}") ?? "no"
        let flipped = Self.isTruthyFlip(resolvedFlipStr)
        let perspectivePx = (props["perspective_px"] as? NSNumber)?.doubleValue ?? 1200.0
        let durationMs = (props["duration_ms"] as? NSNumber)?.intValue ?? 600
        let blockRtl = (props["direction"] as? String) == "rtl" || isRtl

        let front = data.children.count > 0 ? data.children[0] : EmptyBlock.zeroSized
        let back = data.children.count > 1 ? data.children[1] : EmptyBlock.zeroSized

        return FlipCard3DBlock(
            frontBlock: front,
            backBlock: back,
            widthTrait: data.widthTrait,
            heightTrait: data.heightTrait,
            isFlipped: flipped,
            isRtl: blockRtl,
            perspectivePx: perspectivePx,
            durationMs: durationMs,
            path: context.parentPath
        )
    }
    #endif
}

#if canImport(DivKit) && canImport(LayoutKit) && canImport(VGSL) && canImport(UIKit)
private final class FlipCard3DBlock: BlockWithTraits {
    let frontBlock: Block
    let backBlock: Block
    let widthTrait: LayoutTrait
    let heightTrait: LayoutTrait
    let isFlipped: Bool
    let isRtl: Bool
    let perspectivePx: Double
    let durationMs: Int
    let path: UIElementPath?

    init(
        frontBlock: Block,
        backBlock: Block,
        widthTrait: LayoutTrait,
        heightTrait: LayoutTrait,
        isFlipped: Bool,
        isRtl: Bool,
        perspectivePx: Double,
        durationMs: Int,
        path: UIElementPath?
    ) {
        self.frontBlock = frontBlock
        self.backBlock = backBlock
        self.widthTrait = widthTrait
        self.heightTrait = heightTrait
        self.isFlipped = isFlipped
        self.isRtl = isRtl
        self.perspectivePx = perspectivePx
        self.durationMs = durationMs
        self.path = path
    }

    var debugDescription: String {
        "FlipCard3DBlock(flipped: \(isFlipped), perspective: \(perspectivePx))"
    }

    var intrinsicContentWidth: CGFloat {
        switch widthTrait {
        case let .fixed(w): return w
        default: return max(frontBlock.intrinsicContentWidth, backBlock.intrinsicContentWidth)
        }
    }

    func intrinsicContentHeight(forWidth width: CGFloat) -> CGFloat {
        switch heightTrait {
        case let .fixed(h): return h
        default:
            return max(
                frontBlock.intrinsicContentHeight(forWidth: width),
                backBlock.intrinsicContentHeight(forWidth: width)
            )
        }
    }

    func equals(_ other: Block) -> Bool {
        guard let other = other as? FlipCard3DBlock else { return false }
        return isFlipped == other.isFlipped
            && isRtl == other.isRtl
            && perspectivePx == other.perspectivePx
            && durationMs == other.durationMs
            && widthTrait == other.widthTrait
            && heightTrait == other.heightTrait
            && frontBlock.equals(other.frontBlock)
            && backBlock.equals(other.backBlock)
    }

    func getImageHolders() -> [ImageHolder] {
        frontBlock.getImageHolders() + backBlock.getImageHolders()
    }

    func getRemoteURLs() -> [URL] {
        frontBlock.getRemoteURLs() + backBlock.getRemoteURLs()
    }

    var accessibilityChildren: [AccessibilityContaining] {
        isFlipped ? [backBlock] : [frontBlock]
    }

    func laidOut(for width: CGFloat) -> Block {
        let h = intrinsicContentHeight(forWidth: width)
        return laidOut(for: CGSize(width: width, height: h))
    }

    func laidOut(for size: CGSize) -> Block {
        FlipCard3DBlock(
            frontBlock: frontBlock.laidOut(for: size),
            backBlock: backBlock.laidOut(for: size),
            widthTrait: widthTrait,
            heightTrait: heightTrait,
            isFlipped: isFlipped,
            isRtl: isRtl,
            perspectivePx: perspectivePx,
            durationMs: durationMs,
            path: path
        )
    }

    func updated(withStates states: BlocksState) throws -> FlipCard3DBlock {
        let nextFront = try frontBlock.updated(withStates: states)
        let nextBack = try backBlock.updated(withStates: states)
        if nextFront === frontBlock && nextBack === backBlock {
            return self
        }
        return FlipCard3DBlock(
            frontBlock: nextFront,
            backBlock: nextBack,
            widthTrait: widthTrait,
            heightTrait: heightTrait,
            isFlipped: isFlipped,
            isRtl: isRtl,
            perspectivePx: perspectivePx,
            durationMs: durationMs,
            path: path
        )
    }

    func updated(path: UIElementPath, isFocused: Bool) throws -> FlipCard3DBlock {
        let nextFront = try frontBlock.updated(path: path, isFocused: isFocused)
        let nextBack = try backBlock.updated(path: path, isFocused: isFocused)
        if nextFront === frontBlock && nextBack === backBlock {
            return self
        }
        return FlipCard3DBlock(
            frontBlock: nextFront,
            backBlock: nextBack,
            widthTrait: widthTrait,
            heightTrait: heightTrait,
            isFlipped: isFlipped,
            isRtl: isRtl,
            perspectivePx: perspectivePx,
            durationMs: durationMs,
            path: path
        )
    }

    static func makeBlockView() -> BlockView {
        MainActor.assumeIsolated {
            FlipCard3DView()
        }
    }

    func canConfigureBlockView(_ view: BlockView) -> Bool {
        view is FlipCard3DView
    }

    func configureBlockView(
        _ view: BlockView,
        observer: ElementStateObserver?,
        overscrollDelegate: ScrollDelegate?,
        renderingDelegate: RenderingDelegate?
    ) {
        guard let flipView = view as? FlipCard3DView else { return }
        MainActor.assumeIsolated {
            flipView.configure(
                block: self,
                observer: observer,
                overscrollDelegate: overscrollDelegate,
                renderingDelegate: renderingDelegate
            )
        }
    }
}

private final class FlipCard3DView: UIView, BlockViewProtocol {
    private let frontContainer = UIView()
    private let backContainer = UIView()
    private var frontBlockView: BlockView?
    private var backBlockView: BlockView?
    private var currentFlipped: Bool?
    private var currentBlock: FlipCard3DBlock?

    nonisolated var effectiveBackgroundColor: UIColor? { nil }

    nonisolated func onVisibleBoundsChanged(from: CGRect, to: CGRect) {
        MainActor.assumeIsolated {
            frontBlockView?.onVisibleBoundsChanged(
                from: convert(from, to: frontBlockView),
                to: convert(to, to: frontBlockView)
            )
            backBlockView?.onVisibleBoundsChanged(
                from: convert(from, to: backBlockView),
                to: convert(to, to: backBlockView)
            )
        }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = false
        frontContainer.layer.isDoubleSided = false
        backContainer.layer.isDoubleSided = false
        addSubview(backContainer)
        addSubview(frontContainer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func layoutSubviews() {
        super.layoutSubviews()

        let savedFront = frontContainer.layer.transform
        let savedBack = backContainer.layer.transform
        frontContainer.layer.transform = CATransform3DIdentity
        backContainer.layer.transform = CATransform3DIdentity

        frontContainer.frame = bounds
        backContainer.frame = bounds
        frontBlockView?.frame = frontContainer.bounds
        backBlockView?.frame = backContainer.bounds
        frontBlockView?.layoutIfNeeded()
        backBlockView?.layoutIfNeeded()

        frontContainer.layer.transform = savedFront
        backContainer.layer.transform = savedBack
    }

    func configure(
        block: FlipCard3DBlock,
        observer: ElementStateObserver?,
        overscrollDelegate: ScrollDelegate?,
        renderingDelegate: RenderingDelegate?
    ) {
        currentBlock = block

        frontBlockView = block.frontBlock.reuse(
            frontBlockView,
            observer: observer,
            overscrollDelegate: overscrollDelegate,
            renderingDelegate: renderingDelegate,
            superview: frontContainer
        )
        backBlockView = block.backBlock.reuse(
            backBlockView,
            observer: observer,
            overscrollDelegate: overscrollDelegate,
            renderingDelegate: renderingDelegate,
            superview: backContainer
        )

        let dir: CGFloat = block.isRtl ? -1.0 : 1.0
        let frontAngle: CGFloat = block.isFlipped ? (dir * .pi) : 0.0
        let backAngle: CGFloat = block.isFlipped ? 0.0 : (-dir * .pi)
        let nextFrontTransform = FlipCardDivCustomBlockFactory.makePerspectiveRotation(
            angleRadians: frontAngle,
            perspectivePx: block.perspectivePx
        )
        let nextBackTransform = FlipCardDivCustomBlockFactory.makePerspectiveRotation(
            angleRadians: backAngle,
            perspectivePx: block.perspectivePx
        )

        frontContainer.isUserInteractionEnabled = !block.isFlipped
        backContainer.isUserInteractionEnabled = block.isFlipped
        frontBlockView?.layer.isDoubleSided = false
        backBlockView?.layer.isDoubleSided = false

        let targetFrontAlpha: CGFloat = block.isFlipped ? 0.0 : 1.0
        let targetBackAlpha: CGFloat = block.isFlipped ? 1.0 : 0.0
        let shouldAnimate = currentFlipped != nil && currentFlipped != block.isFlipped && window != nil
        currentFlipped = block.isFlipped

        if shouldAnimate {
            let duration = max(Double(block.durationMs) / 1000.0, 0.15)
            UIView.animateKeyframes(
                withDuration: duration,
                delay: 0,
                options: [.allowUserInteraction, .beginFromCurrentState]
            ) { [frontContainer, backContainer] in
                UIView.addKeyframe(withRelativeStartTime: 0.0, relativeDuration: 1.0) {
                    frontContainer.layer.transform = nextFrontTransform
                    backContainer.layer.transform = nextBackTransform
                }
                UIView.addKeyframe(withRelativeStartTime: 0.49, relativeDuration: 0.02) {
                    frontContainer.alpha = targetFrontAlpha
                    backContainer.alpha = targetBackAlpha
                }
            }
        } else {
            frontContainer.layer.transform = nextFrontTransform
            backContainer.layer.transform = nextBackTransform
            frontContainer.alpha = targetFrontAlpha
            backContainer.alpha = targetBackAlpha
        }

        setNeedsLayout()
    }
}
#endif
