import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(SwiftUI) && canImport(UIKit)
import SwiftUI
#endif
#if canImport(DivKit) && canImport(DivKitSVG) && canImport(VGSL) && canImport(UIKit)
@preconcurrency import DivKit
@preconcurrency import DivKitSVG
@preconcurrency import VGSL
#endif

public enum DivImageSupport {
    public static let blankSvgDataUri =
        "data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%221%22%20height%3D%221%22%2F%3E"

    public static func resolveImageUrl(_ rawSrc: String, origin: String = "https://snapcards.fun") -> String {
        let trimmed = rawSrc.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return blankSvgDataUri }
        if trimmed.hasPrefix("data:") || trimmed.hasPrefix("https://") || trimmed.hasPrefix("http://") || trimmed.hasPrefix("file://") {
            return trimmed
        }
        let cleanOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.hasPrefix("/") {
            return "\(cleanOrigin)\(trimmed)"
        }
        return "\(cleanOrigin)/\(trimmed)"
    }

    public static func decodeSvgDataUri(_ uri: String) -> Data? {
        if uri.hasPrefix("data:image/svg+xml;base64,") {
            let b64 = String(uri.dropFirst("data:image/svg+xml;base64,".count))
            return Data(base64Encoded: b64)
        }
        if uri.hasPrefix("data:image/svg+xml;utf8,") {
            let encoded = String(uri.dropFirst("data:image/svg+xml;utf8,".count))
            let decoded = encoded.removingPercentEncoding ?? encoded
            return Data(decoded.utf8)
        }
        if uri.hasPrefix("data:image/svg+xml,") {
            let encoded = String(uri.dropFirst("data:image/svg+xml,".count))
            let decoded = encoded.removingPercentEncoding ?? encoded
            return Data(decoded.utf8)
        }
        return nil
    }

    public static func decodeDataUri(_ uri: String) -> Data? {
        if let svg = decodeSvgDataUri(uri) {
            return svg
        }
        guard uri.hasPrefix("data:"), let commaIdx = uri.firstIndex(of: ",") else {
            return nil
        }
        let header = uri[..<commaIdx]
        let payload = String(uri[uri.index(after: commaIdx)...])
        if header.contains(";base64") {
            return Data(base64Encoded: payload, options: .ignoreUnknownCharacters)
        }
        let decoded = payload.removingPercentEncoding ?? payload
        return Data(decoded.utf8)
    }

    public static func resolveBundledFile(url: URL, resourcesUrl: URL?, origin: String) -> URL? {
        if url.isFileURL, FileManager.default.fileExists(atPath: url.path) {
            return url
        }
        let cleanOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let urlStr = url.absoluteString
        let relPath: String
        if urlStr.hasPrefix(cleanOrigin + "/") {
            relPath = String(urlStr.dropFirst((cleanOrigin + "/").count))
        } else if url.scheme == nil {
            relPath = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        } else {
            return nil
        }
        let cleanRel = (relPath.removingPercentEncoding ?? relPath)
            .components(separatedBy: "?").first ?? relPath
        if cleanRel.isEmpty { return nil }

        if let res = resourcesUrl {
            for candidate in [
                res.appendingPathComponent(cleanRel),
                res.appendingPathComponent("web").appendingPathComponent(cleanRel)
            ] where FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
        }
        if let bundlePath = Bundle.main.resourceURL?.appendingPathComponent(cleanRel),
           FileManager.default.fileExists(atPath: bundlePath.path) {
            return bundlePath
        }
        return nil
    }
}

#if canImport(DivKit) && canImport(DivKitSVG) && canImport(VGSL) && canImport(UIKit)
public final class OmnishellDivImageHolderFactory: DivImageHolderFactory, @unchecked Sendable {
    private let lock = NSLock()
    private var _resourcesUrl: URL?
    private var _origin: String
    private let svgFactory: SVGImageHolderFactory
    private let svgDecoder = SVGDecoder()
    private let localCache = NSCache<NSString, UIImage>()

    public init(resourcesUrl: URL? = nil, origin: String = "https://snapcards.fun") {
        self._resourcesUrl = resourcesUrl
        self._origin = origin
        self.svgFactory = SVGImageHolderFactory(requestPerformer: URLRequestPerformer(urlTransform: nil))
        self.localCache.countLimit = 180
    }

    public func updateContext(resourcesUrl: URL?, origin: String) {
        lock.lock()
        self._resourcesUrl = resourcesUrl
        self._origin = origin
        lock.unlock()
    }

    private func decodeImageData(_ data: Data) -> UIImage? {
        svgDecoder.decode(data: data) ?? UIImage(data: data)
    }

    public func make(_ url: URL?, _ placeholder: ImagePlaceholder?) -> ImageHolder {
        guard let url = url else {
            return svgFactory.make(nil, placeholder)
        }
        let raw = url.absoluteString
        if let cached = localCache.object(forKey: raw as NSString) {
            return cached
        }
        if raw.hasPrefix("data:") {
            if let data = DivImageSupport.decodeDataUri(raw),
               let img = decodeImageData(data) {
                localCache.setObject(img, forKey: raw as NSString)
                return img
            }
            return NilImageHolder()
        }
        lock.lock()
        let resUrl = _resourcesUrl
        let orig = _origin
        lock.unlock()

        if let localUrl = DivImageSupport.resolveBundledFile(url: url, resourcesUrl: resUrl, origin: orig),
           let localData = try? Data(contentsOf: localUrl),
           let img = decodeImageData(localData) {
            localCache.setObject(img, forKey: raw as NSString)
            return img
        }
        return svgFactory.make(url, placeholder)
    }
}
#endif

#if canImport(SwiftUI) && canImport(UIKit)
@available(iOS 16.0, *)
@MainActor
public final class OmnishellImageLoader: ObservableObject {
    public static let shared = OmnishellImageLoader()
    private let cache = NSCache<NSString, UIImage>()
    public var resourcesUrl: URL?
    public var origin: String = "https://snapcards.fun"

    private init() {
        cache.countLimit = 180
    }

    public func cachedImage(for urlString: String) -> UIImage? {
        cache.object(forKey: urlString as NSString)
    }

    public func load(urlString: String) async -> UIImage? {
        let resolved = DivImageSupport.resolveImageUrl(urlString, origin: origin)
        if let hit = cache.object(forKey: resolved as NSString) {
            return hit
        }
        if resolved.hasPrefix("data:") {
            guard let data = DivImageSupport.decodeDataUri(resolved) else { return nil }
            #if canImport(DivKitSVG)
            if let svgImg = SVGDecoder().decode(data: data) {
                cache.setObject(svgImg, forKey: resolved as NSString)
                return svgImg
            }
            #endif
            if let img = UIImage(data: data) {
                cache.setObject(img, forKey: resolved as NSString)
                return img
            }
            return nil
        }
        guard let url = URL(string: resolved) else { return nil }
        if let localFile = DivImageSupport.resolveBundledFile(url: url, resourcesUrl: resourcesUrl, origin: origin),
           let data = try? Data(contentsOf: localFile),
           let img = UIImage(data: data) {
            cache.setObject(img, forKey: resolved as NSString)
            return img
        }
        do {
            var req = URLRequest(url: url)
            req.cachePolicy = .returnCacheDataElseLoad
            req.timeoutInterval = 15
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200...299).contains(http.statusCode),
                  let image = UIImage(data: data) else {
                return nil
            }
            cache.setObject(image, forKey: resolved as NSString)
            return image
        } catch {
            return nil
        }
    }
}

@available(iOS 16.0, *)
public struct OmnishellRemoteImage: View {
    public let urlString: String
    public var contentMode: ContentMode = .fit

    @State private var uiImage: UIImage?

    public init(urlString: String, contentMode: ContentMode = .fit) {
        self.urlString = urlString
        self.contentMode = contentMode
        self._uiImage = State(initialValue: OmnishellImageLoader.shared.cachedImage(for: urlString))
    }

    public var body: some View {
        ZStack {
            if let img = uiImage {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Color.clear
            }
        }
        .task(id: urlString) {
            uiImage = OmnishellImageLoader.shared.cachedImage(for: urlString)
            if uiImage == nil {
                uiImage = await OmnishellImageLoader.shared.load(urlString: urlString)
            }
        }
    }
}
#endif
