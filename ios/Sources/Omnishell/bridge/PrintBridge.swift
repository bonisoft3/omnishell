import Foundation
#if canImport(UIKit)
import UIKit
#endif
#if canImport(AuthenticationServices)
import AuthenticationServices
#endif
#if canImport(SafariServices)
import SafariServices
#endif

public struct PrintJobRequest: Codable, Equatable, Sendable {
    public let jobName: String
    public let source: String
    public let format: String
    public let deckId: String
    public let vendor: String
    public let paper: String
    public let orientation: String
    public let cardSize: String
    public let layout: String
    public let cutLines: String
    public let dpi: Int
    public let htmlContent: String?
    public let pdfBase64: String?

    public init(
        jobName: String = "Snapcards",
        source: String = "window-print",
        format: String = "sheet",
        deckId: String = "",
        vendor: String = "print_at_home",
        paper: String = "a4",
        orientation: String = "portrait",
        cardSize: String = "standard",
        layout: String = "fold",
        cutLines: String = "yes",
        dpi: Int = 300,
        htmlContent: String? = nil,
        pdfBase64: String? = nil
    ) {
        self.jobName = jobName
        self.source = source
        self.format = format
        self.deckId = deckId
        self.vendor = vendor
        self.paper = paper
        self.orientation = orientation
        self.cardSize = cardSize
        self.layout = layout
        self.cutLines = cutLines
        self.dpi = dpi
        self.htmlContent = htmlContent
        self.pdfBase64 = pdfBase64
    }
}

public struct PrintJobResult: Codable, Equatable, Sendable {
    public let jobId: String
    public let jobName: String
    public let formatterType: String
    public let dpi: Int
    public let accepted: Bool

    public init(
        jobId: String,
        jobName: String,
        formatterType: String,
        dpi: Int,
        accepted: Bool
    ) {
        self.jobId = jobId
        self.jobName = jobName
        self.formatterType = formatterType
        self.dpi = dpi
        self.accepted = accepted
    }
}

public struct CheckoutSessionRequest: Codable, Equatable, Sendable {
    public let orderId: String
    public let deckId: String
    public let checkoutUrl: String
    public let returnUrl: String

    public init(
        orderId: String,
        deckId: String = "",
        checkoutUrl: String,
        returnUrl: String? = nil
    ) {
        self.orderId = orderId
        self.deckId = deckId
        self.checkoutUrl = checkoutUrl
        self.returnUrl = returnUrl ?? PrintBridge.buildPrintReturnUri(orderId: orderId)
    }
}

public struct CheckoutReturnResult: Codable, Equatable, Sendable {
    public let orderId: String
    public let outcome: String
    public let callbackUrl: String

    public init(orderId: String, outcome: String, callbackUrl: String) {
        self.orderId = orderId
        self.outcome = outcome
        self.callbackUrl = callbackUrl
    }
}

public struct PrintReturnDeepLink: Codable, Equatable, Sendable {
    public let orderId: String
    public let outcome: String?

    public init(orderId: String, outcome: String? = nil) {
        self.orderId = orderId
        self.outcome = outcome
    }
}

public protocol NativePrintHandler: Sendable {
    /// Delegates to `UIPrintInteractionController.shared` (`viewPrintFormatter()` or PDF `printingItem`).
    func printDocument(
        request: PrintJobRequest,
        completion: @escaping @Sendable (Result<PrintJobResult, Error>) -> Void
    )

    /// Routes Stripe Checkout via `ASWebAuthenticationSession` / `SFSafariViewController`
    /// returning to `snapcards://print/return?order=<id>` or Universal Link `https://snapcards.fun/print?order=<id>`.
    func openCheckoutSession(
        request: CheckoutSessionRequest,
        completion: @escaping @Sendable (Result<CheckoutReturnResult, Error>) -> Void
    )

    /// Delegates OS geolocation permission for `WKWebView` realms that declare `"geolocation"` in `grants`.
    func requestGeolocationPermission(
        origin: String,
        unit: String,
        completion: @escaping @Sendable (Bool) -> Void
    )
}

public extension NativePrintHandler {
    func requestGeolocationPermission(
        origin: String,
        unit: String,
        completion: @escaping @Sendable (Bool) -> Void
    ) {
        completion(true)
    }
}

#if canImport(UIKit)
@MainActor
public enum UIKitPrintInteractionCoordinator {
    public static func makePrintInfo(for request: PrintJobRequest) -> UIPrintInfo {
        let info = UIPrintInfo.printInfo()
        info.jobName = request.jobName
        info.outputType = .general
        info.orientation = request.orientation == "landscape" ? .landscape : .portrait
        info.duplex = request.layout.hasPrefix("duplex") ? .longEdge : .none
        return info
    }

    public static func presentPdfPrint(
        pdfData: Data,
        request: PrintJobRequest,
        completion: @escaping @Sendable (Result<PrintJobResult, Error>) -> Void
    ) {
        let controller = UIPrintInteractionController.shared
        controller.printInfo = makePrintInfo(for: request)
        controller.printingItem = pdfData
        controller.present(animated: true) { _, completed, error in
            if let error = error {
                completion(.failure(error))
            } else {
                completion(.success(PrintJobResult(
                    jobId: UUID().uuidString,
                    jobName: request.jobName,
                    formatterType: "UIPrintInteractionController.printingItem",
                    dpi: request.dpi,
                    accepted: completed
                )))
            }
        }
    }
}
#endif

public enum PrintBridgeError: Error, LocalizedError {
    case missingPrintHandler(String)
    case invalidPayload(String)
    case httpFailure(Int)

    public var errorDescription: String? {
        switch self {
        case .missingPrintHandler(let op):
            return "PrintBridge.\(op) requires a configured NativePrintHandler"
        case .invalidPayload(let detail):
            return "Invalid PrintBridge payload: \(detail)"
        case .httpFailure(let status):
            return "Print order recheck failed with HTTP \(status)"
        }
    }
}

public final class PrintBridge: @unchecked Sendable {
    private let handler: NativePrintHandler?
    private let networkBridge: NetworkBridge?
    public let origin: String
    private let jsonDecoder = JSONDecoder()
    private let jsonEncoder = JSONEncoder()

    public init(
        handler: NativePrintHandler? = nil,
        networkBridge: NetworkBridge? = nil,
        origin: String = "https://snapcards.fun"
    ) {
        self.handler = handler
        self.networkBridge = networkBridge
        self.origin = origin
    }

    public static func buildPrintReturnUri(orderId: String) -> String {
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))
        let enc = orderId.addingPercentEncoding(withAllowedCharacters: allowed) ?? orderId
        return "snapcards://print/return?order=\(enc)"
    }

    public static func parsePrintReturnDeepLink(_ rawUrl: String) -> PrintReturnDeepLink? {
        guard let comps = URLComponents(string: rawUrl),
              let scheme = comps.scheme?.lowercased(),
              let items = comps.queryItems,
              let orderId = items.first(where: { $0.name == "order" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !orderId.isEmpty else {
            return nil
        }
        let outcome = items.first(where: { $0.name == "checkout" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanOutcome = (outcome?.isEmpty == false) ? outcome : nil

        if scheme == "snapcards" {
            let route = "\(comps.host ?? "")\(comps.path)".trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if route == "print/return" || route == "print" {
                return PrintReturnDeepLink(orderId: orderId, outcome: cleanOutcome)
            }
            return nil
        }

        if scheme == "https" || scheme == "http" {
            let segments = comps.path.split(separator: "/").map(String.init)
            if segments.last == "print" {
                return PrintReturnDeepLink(orderId: orderId, outcome: cleanOutcome)
            }
        }
        return nil
    }

    public func delegateGeolocationPermission(
        originUrl: String,
        unit: String,
        grants: [String],
        completion: @escaping @Sendable (Bool) -> Void
    ) {
        guard grants.contains("geolocation") else {
            completion(false)
            return
        }
        guard let handler = handler else {
            completion(true)
            return
        }
        handler.requestGeolocationPermission(origin: originUrl, unit: unit, completion: completion)
    }

    public func printSheet(
        optionsJson: String,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let handler = handler else {
            onReject(PrintBridgeError.missingPrintHandler("printSheet").localizedDescription)
            return
        }
        let req: PrintJobRequest
        if let data = optionsJson.data(using: .utf8),
           let decoded = try? jsonDecoder.decode(PrintJobRequest.self, from: data) {
            req = decoded
        } else if let data = optionsJson.data(using: .utf8),
                  let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            req = PrintJobRequest(
                jobName: dict["jobName"] as? String ?? "Snapcards",
                source: dict["source"] as? String ?? "window-print",
                format: dict["format"] as? String ?? "sheet",
                deckId: dict["deckId"] as? String ?? "",
                vendor: dict["vendor"] as? String ?? "print_at_home",
                paper: dict["paper"] as? String ?? "a4",
                orientation: dict["orientation"] as? String ?? "portrait",
                cardSize: dict["cardSize"] as? String ?? "standard",
                layout: dict["layout"] as? String ?? "fold",
                cutLines: dict["cutLines"] as? String ?? "yes",
                dpi: (dict["dpi"] as? NSNumber)?.intValue ?? 300,
                htmlContent: dict["htmlContent"] as? String,
                pdfBase64: dict["pdfBase64"] as? String
            )
        } else {
            onReject(PrintBridgeError.invalidPayload("Malformed PrintJobRequest JSON").localizedDescription)
            return
        }

        handler.printDocument(request: req) { [jsonEncoder] result in
            switch result {
            case .success(let jobResult):
                if let encoded = try? jsonEncoder.encode(jobResult),
                   let str = String(data: encoded, encoding: .utf8) {
                    onResolve(str)
                } else {
                    onReject("Failed to encode PrintJobResult")
                }
            case .failure(let err):
                onReject(err.localizedDescription)
            }
        }
    }

    public func openCheckout(
        optionsJson: String,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        guard let handler = handler else {
            onReject(PrintBridgeError.missingPrintHandler("openCheckout").localizedDescription)
            return
        }
        guard let data = optionsJson.data(using: .utf8),
              let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let orderId = dict["orderId"] as? String, !orderId.isEmpty,
              let checkoutUrl = dict["checkoutUrl"] as? String, !checkoutUrl.isEmpty else {
            onReject(PrintBridgeError.invalidPayload("openCheckout requires orderId and checkoutUrl").localizedDescription)
            return
        }
        let req = CheckoutSessionRequest(
            orderId: orderId,
            deckId: dict["deckId"] as? String ?? "",
            checkoutUrl: checkoutUrl,
            returnUrl: dict["returnUrl"] as? String
        )
        handler.openCheckoutSession(request: req) { [jsonEncoder] result in
            switch result {
            case .success(let out):
                if let encoded = try? jsonEncoder.encode(out),
                   let str = String(data: encoded, encoding: .utf8) {
                    onResolve(str)
                } else {
                    onReject("Failed to encode CheckoutReturnResult")
                }
            case .failure(let err):
                onReject(err.localizedDescription)
            }
        }
    }

    @discardableResult
    public func handleActionUri(
        _ actionUri: String,
        onComplete: (@Sendable (String) -> Void)? = nil,
        onError: (@Sendable (String) -> Void)? = nil
    ) -> Bool {
        if actionUri.hasPrefix("omnishell://print"),
           let comps = URLComponents(string: actionUri) {
            let items = comps.queryItems ?? []
            let q = Dictionary(uniqueKeysWithValues: items.compactMap { item -> (String, String)? in
                guard let v = item.value else { return nil }
                return (item.name, v)
            })
            let req = PrintJobRequest(
                jobName: q["job"].flatMap { $0.isEmpty ? nil : $0 } ?? "Snapcards",
                source: q["source"] ?? "window-print",
                format: q["format"] ?? "sheet",
                deckId: q["deck"] ?? "",
                vendor: q["vendor"] ?? "print_at_home",
                paper: q["paper"] ?? "a4",
                orientation: q["orientation"] ?? "portrait",
                cardSize: q["card_size"] ?? "standard",
                layout: q["layout"] ?? "fold",
                cutLines: q["cut_lines"] ?? "yes",
                dpi: q["dpi"].flatMap(Int.init) ?? 300
            )
            guard let handler = handler else { return true }
            handler.printDocument(request: req) { [jsonEncoder] res in
                switch res {
                case .success(let job):
                    if let data = try? jsonEncoder.encode(job),
                       let str = String(data: data, encoding: .utf8) {
                        onComplete?(str)
                    }
                case .failure(let err):
                    onError?(err.localizedDescription)
                }
            }
            return true
        }

        if actionUri.hasPrefix("omnishell://checkout"),
           let comps = URLComponents(string: actionUri) {
            let items = comps.queryItems ?? []
            let q = Dictionary(uniqueKeysWithValues: items.compactMap { item -> (String, String)? in
                guard let v = item.value else { return nil }
                return (item.name, v)
            })
            let orderId = q["order"] ?? ""
            let checkoutUrl = q["checkout_url"] ?? ""
            let deckId = q["deck"] ?? ""
            let returnUrl = q["return_url"].flatMap { $0.isEmpty ? nil : $0 }
            guard let handler = handler else { return true }
            if !orderId.isEmpty && !checkoutUrl.isEmpty {
                let req = CheckoutSessionRequest(
                    orderId: orderId,
                    deckId: deckId,
                    checkoutUrl: checkoutUrl,
                    returnUrl: returnUrl
                )
                handler.openCheckoutSession(request: req) { [jsonEncoder] res in
                    switch res {
                    case .success(let out):
                        if let data = try? jsonEncoder.encode(out),
                           let str = String(data: data, encoding: .utf8) {
                            onComplete?(str)
                        }
                    case .failure(let err):
                        onError?(err.localizedDescription)
                    }
                }
            }
            return true
        }
        return false
    }

    public func handlePrintReturnDeepLink(
        _ deepLinkUrl: String,
        bearerToken: String? = nil,
        completion: @escaping @Sendable (Result<(PrintReturnDeepLink, String?), Error>) -> Void
    ) {
        guard let parsed = Self.parsePrintReturnDeepLink(deepLinkUrl) else {
            completion(.failure(PrintBridgeError.invalidPayload("Unrecognized print return deep link: \(deepLinkUrl)")))
            return
        }
        guard let net = networkBridge else {
            completion(.success((parsed, nil)))
            return
        }
        let cleanOrigin = origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&=+"))
        let encId = parsed.orderId.addingPercentEncoding(withAllowedCharacters: allowed) ?? parsed.orderId

        var hdrs: [String: String] = [
            "content-type": "application/json",
            "Prefer": "return=representation"
        ]
        if let bearer = bearerToken, !bearer.isEmpty {
            hdrs["Authorization"] = "Bearer \(bearer)"
        }
        let requestHeaders = hdrs
        let getOptsData = try? JSONSerialization.data(withJSONObject: ["method": "GET", "headers": requestHeaders])
        let getOptsStr = getOptsData.flatMap { String(data: $0, encoding: .utf8) }

        net.nativeFetchAsync(
            url: "\(cleanOrigin)/crud/print_order?id=eq.\(encId)",
            optionsJson: getOptsStr,
            onResolve: { rawGet in
                guard let envData = rawGet.data(using: .utf8),
                      let env = try? JSONSerialization.jsonObject(with: envData) as? [String: Any],
                      let status = (env["status"] as? NSNumber)?.intValue else {
                    completion(.failure(PrintBridgeError.invalidPayload("Invalid response envelope")))
                    return
                }
                guard (200...299).contains(status) else {
                    completion(.failure(PrintBridgeError.httpFailure(status)))
                    return
                }
                let bodyStr = env["body"] as? String ?? "[]"
                guard let bodyData = bodyStr.data(using: .utf8),
                      let rows = try? JSONSerialization.jsonObject(with: bodyData) as? [[String: Any]],
                      let firstRow = rows.first else {
                    completion(.success((parsed, nil)))
                    return
                }
                let firstRowJson: String? = (try? JSONSerialization.data(withJSONObject: firstRow))
                    .flatMap { String(data: $0, encoding: .utf8) }

                if (firstRow["status"] as? String) == "awaiting_payment" {
                    let nextChecks = ((firstRow["checks"] as? NSNumber)?.intValue ?? 0) + 1
                    let patchBodyData = try? JSONSerialization.data(withJSONObject: [
                        "status": "checking",
                        "checks": nextChecks
                    ])
                    let patchBodyStr = patchBodyData.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
                    let patchOptsData = try? JSONSerialization.data(withJSONObject: [
                        "method": "PATCH",
                        "headers": requestHeaders,
                        "body": patchBodyStr
                    ])
                    let patchOptsStr = patchOptsData.flatMap { String(data: $0, encoding: .utf8) }
                    net.nativeFetchAsync(
                        url: "\(cleanOrigin)/crud/print_order?id=eq.\(encId)",
                        optionsJson: patchOptsStr,
                        onResolve: { rawPatch in
                            if let pData = rawPatch.data(using: .utf8),
                               let pEnv = try? JSONSerialization.jsonObject(with: pData) as? [String: Any],
                               let pBody = pEnv["body"] as? String,
                               let pRowsData = pBody.data(using: .utf8),
                               let pRows = try? JSONSerialization.jsonObject(with: pRowsData) as? [[String: Any]],
                               let updated = pRows.first,
                               let updatedData = try? JSONSerialization.data(withJSONObject: updated),
                               let updatedStr = String(data: updatedData, encoding: .utf8) {
                                completion(.success((parsed, updatedStr)))
                            } else {
                                completion(.success((parsed, firstRowJson)))
                            }
                        },
                        onReject: { errMsg in
                            completion(.failure(PrintBridgeError.invalidPayload(errMsg)))
                        }
                    )
                } else {
                    completion(.success((parsed, firstRowJson)))
                }
            },
            onReject: { errMsg in
                completion(.failure(PrintBridgeError.invalidPayload(errMsg)))
            }
        )
    }
}
