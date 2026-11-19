import Testing
import Foundation
import CryptoKit
import QuartzCore
#if canImport(DivKit) && canImport(UIKit)
@preconcurrency import DivKit
import UIKit
#endif
@testable import Omnishell

private final class StubLongPollUrlProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _handler: (@Sendable (URLRequest) -> (Int, [String: String], Data, TimeInterval))?

    static func setHandler(_ next: (@Sendable (URLRequest) -> (Int, [String: String], Data, TimeInterval))?) {
        lock.lock()
        _handler = next
        lock.unlock()
    }

    private static func getHandler() -> (@Sendable (URLRequest) -> (Int, [String: String], Data, TimeInterval))? {
        lock.lock()
        defer { lock.unlock() }
        return _handler
    }

    override class func canInit(with request: URLRequest) -> Bool {
        return true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }

    override func startLoading() {
        let h = Self.getHandler()

        guard let handler = h, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }

        let req = request
        DispatchQueue.global().async { [weak self] in
            guard let self = self else { return }
            let (status, headers, body, delaySec) = handler(req)
            if delaySec > 0 {
                Thread.sleep(forTimeInterval: delaySec)
            }
            let response = HTTPURLResponse(
                url: url,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: headers
            )!
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            self.client?.urlProtocol(self, didLoad: body)
            self.client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}

private final class MockCredentialHandler: NativeCredentialHandler {
    func passkeySignIn(
        options: PasskeySignInOptions,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        completion(.success("{\"id\":\"ios-passkey-1\",\"rpId\":\"\(options.rpId)\"}"))
    }

    func passkeyRegister(
        options: PasskeyRegisterOptions,
        completion: @escaping @Sendable (Result<String, Error>) -> Void
    ) {
        let promoted = options.promote ?? false
        completion(.success("{\"id\":\"ios-passkey-reg\",\"userId\":\"\(options.userId)\",\"promoted\":\(promoted)}"))
    }

    func oidcStart(
        provider: String,
        startUrl: URL,
        codeVerifier: String,
        options: OidcStartOptions,
        completion: @escaping @Sendable (Result<OidcCeremonyResult, Error>) -> Void
    ) {
        let session = AuthSession(
            token: "jwt_ios_oidc",
            refreshToken: "rt_ios_001",
            userId: "user_adopted_1",
            handle: "apple@snapcards.fun",
            isGuest: false,
            expiresAtEpochS: 1_900_000_000
        )
        completion(.success(OidcCeremonyResult(
            ticket: "ticket_ios_77",
            codeVerifier: codeVerifier,
            callbackUrl: startUrl.absoluteString,
            session: session
        )))
    }

    func appleSignIn(
        options: AppleSignInOptions,
        completion: @escaping @Sendable (Result<AppleSignInResult, Error>) -> Void
    ) {
        let session = AuthSession(
            token: "jwt_ios_apple",
            refreshToken: "rt_ios_apple_1",
            userId: "user_apple_ios",
            handle: "ada@privaterelay.appleid.com",
            isGuest: false,
            expiresAtEpochS: 1_900_000_000
        )
        completion(.success(AppleSignInResult(
            identityToken: "apple.id.jwt",
            authorizationCode: "apple_code_77",
            userIdentifier: "001999.apple",
            fullName: "Ada Lovelace",
            email: "ada@privaterelay.appleid.com",
            session: session
        )))
    }
}

private final class MockPrintHandler: NativePrintHandler, @unchecked Sendable {
    var jobs: [PrintJobRequest] = []
    var checkouts: [CheckoutSessionRequest] = []

    func printDocument(
        request: PrintJobRequest,
        completion: @escaping @Sendable (Result<PrintJobResult, Error>) -> Void
    ) {
        jobs.append(request)
        completion(.success(PrintJobResult(
            jobId: "job_ios_1",
            jobName: request.jobName,
            formatterType: "UIViewPrintFormatter",
            dpi: request.dpi,
            accepted: true
        )))
    }

    func openCheckoutSession(
        request: CheckoutSessionRequest,
        completion: @escaping @Sendable (Result<CheckoutReturnResult, Error>) -> Void
    ) {
        checkouts.append(request)
        completion(.success(CheckoutReturnResult(
            orderId: request.orderId,
            outcome: "launched",
            callbackUrl: request.returnUrl
        )))
    }
}

@Suite("Snapcards Native iOS Host Tests", .serialized)
struct SnapcardsNativeHostTests {

    private func swFilePath() -> URL {
        let testFile = URL(fileURLWithPath: #filePath)
        return testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("offline-first-sw.js")
    }

    @Test("Async JSContext fetch resolves concurrently without blocking Electric long-polls or UI actions")
    func asyncFetchDoesNotDeadlockSerialJsContextQueue() async throws {
        StubLongPollUrlProtocol.setHandler { req in
            let path = req.url?.path ?? ""
            if path.contains("/long-poll") {
                return (200, ["Content-Type": "application/json"], Data("{\"stream\":\"settled\"}".utf8), 0.35)
            }
            return (200, ["Content-Type": "application/json"], Data("{\"fast\":\"ok\"}".utf8), 0.01)
        }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubLongPollUrlProtocol.self]
        let session = URLSession(configuration: cfg)

        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let storageBridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        let networkBridge = NetworkBridge(client: URLSessionFetchClient(session: session))

        let script = """
            let state = { order: [] };
            onAction((act) => {
                if (act === 'pronto://event/PING') {
                    state.order.push('action');
                    emitUiAst(JSON.stringify(state));
                }
            });
            (async () => {
                const slowPromise = fetch('https://snapcards.fun/electric/long-poll').then(r => r.json()).then(() => {
                    state.order.push('slow');
                    emitUiAst(JSON.stringify(state));
                });
                const fastPromise = fetch('https://snapcards.fun/api/fast').then(r => r.json()).then(() => {
                    state.order.push('fast');
                    emitUiAst(JSON.stringify(state));
                });
                await Promise.all([slowPromise, fastPromise]);
            })();
        """

        let engine = JavaScriptCoreOmnishellEngine(
            networkBridge: networkBridge,
            storageBridge: storageBridge,
            initialScript: script
        )
        defer {
            engine.close()
            storageBridge.close()
        }

        try engine.start()
        engine.dispatchAction("pronto://event/PING")

        for _ in 0..<40 {
            if engine.uiAst.contains("\"slow\"") && engine.uiAst.contains("\"fast\"") && engine.uiAst.contains("\"action\"") {
                break
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        // Fast fetch and UI action MUST complete before the 350ms long-poll finishes!
        #expect(engine.uiAst.contains("\"fast\""))
        #expect(engine.uiAst.contains("\"action\""))
        #expect(engine.uiAst.contains("\"slow\""))
        let slowIdx = engine.uiAst.range(of: "slow")!.lowerBound
        let fastIdx = engine.uiAst.range(of: "fast")!.lowerBound
        let actIdx = engine.uiAst.range(of: "action")!.lowerBound
        #expect(fastIdx < slowIdx)
        #expect(actIdx < slowIdx)
    }

    @Test("AuthBridge + offline-first-sw.js over SQLite CacheStorage + Ed25519 ManifestVerifier run inside JSContext")
    func swrCacheAuthAndEd25519InsideJsContext() async throws {
        let swSource = try String(contentsOf: swFilePath(), encoding: .utf8)
        let privateKey = Curve25519.Signing.PrivateKey()
        let pubKeyB64 = privateKey.publicKey.rawRepresentation.base64EncodedString()
        let manifestPayload = #"{"imports":{"/@native/bridge":"/_immutable-\#(String(repeating: "1", count: 64))-bridge"},"screens":{}}"#
        let sigB64 = try privateKey.signature(for: Data(manifestPayload.utf8)).base64EncodedString()
        let signedHtml = "<!doctype html><html><head><script type=\"importmap\" id=\"pronto-assets\" data-signature=\"\(sigB64)\">\(manifestPayload)</script></head><body>v2</body></html>"

        StubLongPollUrlProtocol.setHandler { _ in
            return (200, ["Cache-Control": "public, no-cache", "Content-Type": "text/html"], Data(signedHtml.utf8), 0.01)
        }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubLongPollUrlProtocol.self]
        let session = URLSession(configuration: cfg)

        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let storageBridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        let networkBridge = NetworkBridge(client: URLSessionFetchClient(session: session))
        let authBridge = AuthBridge(
            sessionStore: KeyValueSessionStore(storageBridge: storageBridge),
            credentialHandler: MockCredentialHandler()
        )

        let engine = JavaScriptCoreOmnishellEngine(
            networkBridge: networkBridge,
            storageBridge: storageBridge,
            authBridge: authBridge,
            origin: "https://snapcards.fun"
        )
        defer {
            engine.close()
            storageBridge.close()
        }

        try engine.start()

        let escapedSw = try String(data: JSONEncoder().encode(swSource), encoding: .utf8)!
        let testJs = """
            (async () => {
                const swCode = \(escapedSw);
                const handlers = {};
                const bg = [];
                const self = {
                    location: { origin: 'https://snapcards.fun' },
                    skipWaiting: () => {},
                    clients: { claim: () => {} },
                    registration: { navigationPreload: { disable: () => Promise.resolve() } },
                    addEventListener: (t, fn) => { handlers[t] = fn; }
                };
                new Function('self', 'caches', 'fetch', 'Response', 'Headers', 'URL', swCode)(
                    self, globalThis.caches, globalThis.fetch, globalThis.Response, globalThis.Headers, globalThis.URL
                );

                // Seed cold pronto-kept entry + stale cache
                const oldCache = await caches.open('legacy-workbox');
                await oldCache.put('https://snapcards.fun/stale', new Response('old'));
                const entryCache = await caches.open('pronto-entries-v1');
                await entryCache.put('https://snapcards.fun/', new Response('<head><meta name="pronto-kept"></head><body>v1</body>'));

                handlers.activate({ waitUntil: p => bg.push(p) });
                await Promise.all(bg.splice(0));
                const cacheNames = await caches.keys();

                let navPromise;
                handlers.fetch({
                    request: { method: 'GET', url: 'https://snapcards.fun/', mode: 'navigate', cache: 'default' },
                    respondWith: p => { navPromise = p; },
                    waitUntil: p => bg.push(p)
                });
                const firstPaint = await (await navPromise).text();
                await Promise.all(bg.splice(0));

                // Second navigation serves revalidated v2 with <meta name="pronto-kept"> and verifies Ed25519 manifest!
                handlers.fetch({
                    request: { method: 'GET', url: 'https://snapcards.fun/', mode: 'navigate', cache: 'default' },
                    respondWith: p => { navPromise = p; },
                    waitUntil: p => bg.push(p)
                });
                const secondPaint = await (await navPromise).text();
                const verified = __verifyEntryManifestEd25519(secondPaint, '\(pubKeyB64)');

                // AuthBridge passkey + OIDC round-trip
                const passkeyRes = await AuthBridge.passkeyRegister({
                    rpId: 'snapcards.fun',
                    rpName: 'Snapcards',
                    challenge: 'c1',
                    userId: 'guest-1',
                    userName: 'guest',
                    promote: true
                });
                const oidcRes = await AuthBridge.oidcStart('google', { origin: 'https://snapcards.fun' });
                const savedSession = AuthBridge.loadSession();

                emitUiAst(JSON.stringify({
                    cacheNames,
                    firstHasV1: firstPaint.includes('v1'),
                    secondKept: secondPaint.includes('pronto-kept') && secondPaint.includes('v2'),
                    bridgeRef: verified.imports['/@native/bridge'],
                    passkeyPromoted: passkeyRes.promoted,
                    oidcTicket: oidcRes.ticket,
                    savedToken: savedSession.token
                }));
            })();
        """
        _ = engine.evaluateJs(testJs)

        for _ in 0..<40 {
            if engine.uiAst.contains("jwt_ios_oidc") { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        #expect(engine.uiAst.contains("\"firstHasV1\":true"))
        #expect(engine.uiAst.contains("\"secondKept\":true"))
        #expect(!engine.uiAst.contains("legacy-workbox"))
        #expect(engine.uiAst.contains("\"passkeyPromoted\":true"))
        #expect(engine.uiAst.contains("\"oidcTicket\":\"ticket_ios_77\""))
        #expect(engine.uiAst.contains("\"savedToken\":\"jwt_ios_oidc\""))
    }

    @Test("FlipCardDivCustomBlockFactory applies CATransform3DMakeRotation + perspective and switches div-state in place")
    func flipCardCustomFactoryAndDivStateHost() throws {
        let cardJson = """
        {
          "card": {
            "log_id": "omnishell_explore",
            "variables": [
              { "name": "flipped", "type": "string", "value": "no" },
              { "name": "sheet_card_edit_sheet_state", "type": "string", "value": "closed" }
            ],
            "states": [
              {
                "state_id": 0,
                "div": {
                  "type": "container",
                  "id": "root",
                  "items": [
                    {
                      "type": "custom",
                      "id": "card-flip",
                      "custom_type": "flip-card",
                      "items": [
                        { "type": "image", "id": "front", "image_url": "https://snapcards.fun/img/capybara.webp" },
                        { "type": "text", "id": "back", "text": "Capivara" }
                      ],
                      "custom_props": {
                        "flipped": "@{flipped}",
                        "flipped_variable": "flipped",
                        "perspective_px": 1200,
                        "duration_ms": 600
                      }
                    },
                    {
                      "type": "state",
                      "id": "state_card-edit-sheet",
                      "div_id": "state_card-edit-sheet",
                      "default_state_id": "closed",
                      "state_id_variable": "sheet_card_edit_sheet_state",
                      "states": [
                        { "state_id": "closed" },
                        { "state_id": "open", "div": { "type": "text", "text": "Edit Card" } }
                      ]
                    }
                  ]
                }
              }
            ]
          }
        }
        """

        let host = OmnishellDivKitHost()
        let flipFactory = FlipCardDivCustomBlockFactory()
        host.registerCustomFactory(flipFactory)

        #expect(host.render(astJson: cardJson, onAction: { _ in }) == true)
        #expect(host.astParseCount == 1)

        let initial = flipFactory.getFlipCard("card-flip")!
        #expect(initial.itemsCount == 2)
        #expect(initial.isFlipped == false)
        #expect(abs(initial.rotationRadians - 0.0) < 1e-6)
        #expect(initial.frontHidden == false)
        #expect(initial.backHidden == true)
        #expect(abs(Double(initial.frontTransform.m34) - (-1.0 / 1200.0)) < 1e-6)

        // Flip via DivKit set_variable action without re-parsing AST
        host.dispatchActionUri("div-action://set_variable?name=flipped&value=yes")
        #expect(host.astParseCount == 1)
        let flipped = flipFactory.getFlipCard("card-flip")!
        #expect(flipped.isFlipped == true)
        #expect(abs(flipped.rotationRadians - Double.pi) < 1e-6)
        #expect(flipped.frontHidden == true)
        #expect(flipped.backHidden == false)

        // Open popover div-state in place
        #expect(host.currentStateId(for: "state_card-edit-sheet") == "closed")
        host.dispatchActionUri("div-action://set_variable?name=sheet_card_edit_sheet_state&value=open")
        #expect(host.currentStateId(for: "state_card-edit-sheet") == "open")

        // SVG data-URI decoding + `/img/*` resolution
        let resolvedUrl = DivImageSupport.resolveImageUrl("/img/card.webp", origin: "https://snapcards.fun")
        #expect(resolvedUrl == "https://snapcards.fun/img/card.webp")
        let svgData = DivImageSupport.decodeSvgDataUri("data:image/svg+xml;utf8,%3Csvg%3E%3C%2Fsvg%3E")
        #expect(String(data: svgData!, encoding: .utf8) == "<svg></svg>")

        // Re-rendering releases previous listener without leaking
        #expect(host.variableStorage.listenerCount == 1)
        #expect(host.render(astJson: cardJson, onAction: { _ in }) == true)
        #expect(host.variableStorage.listenerCount == 1)
    }

    @Test("PrintRealmDivCustomBlockFactory, PrintBridge, Sign in with Apple + Delete Account, and iPad/RTL/Dark display work end to end")
    func printRealmBridgeAppleAuthDeleteAndResponsiveHost() async throws {
        final class RequestRecorder: @unchecked Sendable {
            let lock = NSLock()
            var patchedOrderBody: String = ""
            var deleteAuthHeader: String = ""
        }
        let recorder = RequestRecorder()

        StubLongPollUrlProtocol.setHandler { req in
            let path = req.url?.path ?? ""
            let method = req.httpMethod ?? "GET"
            if path == "/crud/print_order" && method == "GET" {
                return (200, ["Content-Type": "application/json"], Data("[{\"id\":\"ord_ios_1\",\"status\":\"awaiting_payment\",\"checks\":4}]".utf8), 0.0)
            }
            if path == "/crud/print_order" && method == "PATCH" {
                let bodyStr: String
                if let b = req.httpBody {
                    bodyStr = String(data: b, encoding: .utf8) ?? ""
                } else if let stream = req.httpBodyStream {
                    stream.open()
                    var buf = [UInt8](repeating: 0, count: 1024)
                    let readBytes = stream.read(&buf, maxLength: buf.count)
                    stream.close()
                    bodyStr = readBytes > 0 ? String(bytes: buf.prefix(readBytes), encoding: .utf8) ?? "" : ""
                } else {
                    bodyStr = ""
                }
                recorder.lock.lock()
                recorder.patchedOrderBody = bodyStr
                recorder.lock.unlock()
                return (200, ["Content-Type": "application/json"], Data("[{\"id\":\"ord_ios_1\",\"status\":\"checking\",\"checks\":5}]".utf8), 0.0)
            }
            if path == "/auth/account" && method == "DELETE" {
                recorder.lock.lock()
                recorder.deleteAuthHeader = req.value(forHTTPHeaderField: "Authorization") ?? ""
                recorder.lock.unlock()
                return (200, ["Content-Type": "application/json"], Data("{\"deleted\":true}".utf8), 0.0)
            }
            return (404, [:], Data(), 0.0)
        }

        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [StubLongPollUrlProtocol.self]
        let session = URLSession(configuration: cfg)

        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let storageBridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        defer { storageBridge.close() }

        let networkBridge = NetworkBridge(client: URLSessionFetchClient(session: session))
        let authBridge = AuthBridge(
            sessionStore: KeyValueSessionStore(storageBridge: storageBridge),
            credentialHandler: MockCredentialHandler()
        )
        let mockPrint = MockPrintHandler()
        let printBridge = PrintBridge(
            handler: mockPrint,
            networkBridge: networkBridge,
            origin: "https://snapcards.fun"
        )

        let host = OmnishellDivKitHost()
        host.printBridge = printBridge
        let flipFactory = FlipCardDivCustomBlockFactory()
        let realmFactory = PrintRealmDivCustomBlockFactory(printBridge: printBridge)
        host.registerCustomFactory(flipFactory)
        host.registerCustomFactory(realmFactory)

        // Configure iPad (820pt) + Dark + RTL
        host.configureDisplay(viewportWidthDp: 820, themeMode: "dark", layoutDirection: "rtl")
        #expect(host.formFactor == "tablet")
        #expect(host.themeMode == "dark")
        #expect(host.layoutDirection == "rtl")
        #expect(flipFactory.isRtl == true)

        let printCardJson = """
        {
          "card": {
            "log_id": "omnishell_print",
            "variables": [
              { "name": "active_deck_id", "type": "string", "value": "deck_ocean" },
              { "name": "order_id", "type": "string", "value": "ord_ios_1" },
              { "name": "order_checkout_url", "type": "string", "value": "https://checkout.stripe.com/c/pay/cs_ios" }
            ],
            "states": [
              {
                "state_id": 0,
                "div": {
                  "type": "container",
                  "id": "print_root",
                  "items": [
                    {
                      "type": "custom",
                      "id": "realm_delivery_map",
                      "custom_type": "web-realm",
                      "custom_props": {
                        "unit": "delivery-map",
                        "src": "/shell/units/delivery-map/index.html",
                        "origin": "https://snapcards.fun",
                        "grants": ["geolocation"],
                        "deck_id": "@{active_deck_id}",
                        "order_id": "@{order_id}"
                      }
                    },
                    {
                      "type": "custom",
                      "id": "print_sheet_realm",
                      "custom_type": "print-realm",
                      "custom_props": {
                        "unit": "print-sheet",
                        "origin": "https://snapcards.fun",
                        "grants": ["print", "canvas-300dpi"],
                        "deck_id": "@{active_deck_id}",
                        "order_id": "@{order_id}",
                        "dpi": 300
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
        """

        #expect(host.render(astJson: printCardJson, onAction: { _ in }) == true)
        let mapState = realmFactory.getRealmBlock("realm_delivery_map")!
        #expect(mapState.allowsGeolocation == true)
        final class BoolBox: @unchecked Sendable { var value: Bool; init(_ v: Bool) { self.value = v } }
        let geoAllowed = BoolBox(false)
        let geoDenied = BoolBox(true)
        printBridge.delegateGeolocationPermission(originUrl: "https://snapcards.fun", unit: "delivery-map", grants: mapState.grants) { geoAllowed.value = $0 }
        printBridge.delegateGeolocationPermission(originUrl: "https://snapcards.fun", unit: "print-sheet", grants: ["print"]) { geoDenied.value = $0 }
        #expect(geoAllowed.value == true)
        #expect(geoDenied.value == false)

        let sheetState = realmFactory.getRealmBlock("print_sheet_realm")!
        #expect(sheetState.allowsMediaPrint == true)
        #expect(sheetState.allows300DpiCanvas == true)
        #expect(sheetState.deckId == "deck_ocean")

        host.dispatchActionUri("omnishell://print?deck=deck_ocean&paper=letter&dpi=300&job=Snapcards")
        #expect(mockPrint.jobs.count == 1)
        #expect(mockPrint.jobs[0].deckId == "deck_ocean")
        #expect(mockPrint.jobs[0].dpi == 300)

        host.dispatchActionUri("omnishell://checkout?order=ord_ios_1&checkout_url=https%3A%2F%2Fcheckout.stripe.com%2Fc%2Fpay%2Fcs_ios&return_url=snapcards%3A%2F%2Fprint%2Freturn%3Forder%3Dord_ios_1")
        #expect(mockPrint.checkouts.count == 1)
        #expect(mockPrint.checkouts[0].orderId == "ord_ios_1")
        #expect(mockPrint.checkouts[0].checkoutUrl == "https://checkout.stripe.com/c/pay/cs_ios")

        // Universal Link & custom-scheme print return deep-link parsing + recheck PATCH
        #expect(PrintBridge.parsePrintReturnDeepLink("https://snapcards.fun/print?order=ord_ios_1")?.orderId == "ord_ios_1")
        final class Box<T>: @unchecked Sendable { var value: T; init(_ v: T) { self.value = v } }
        let recheckDone = Box(false)
        printBridge.handlePrintReturnDeepLink(
            "snapcards://print/return?order=ord_ios_1",
            bearerToken: "jwt_ios_apple"
        ) { result in
            if case .success = result {
                recheckDone.value = true
            }
        }
        for _ in 0..<40 {
            if recheckDone.value { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(recheckDone.value == true)
        #expect(recorder.patchedOrderBody.contains("\"status\":\"checking\""))
        #expect(recorder.patchedOrderBody.contains("\"checks\":5"))

        // Sign in with Apple + Account Deletion inside JSContext
        _ = storageBridge.sqlExec(sql: "CREATE TABLE mecha_outbox (id TEXT PRIMARY KEY);", paramsJson: nil)
        _ = storageBridge.sqlExec(sql: "CREATE TABLE mecha_shape_row (shape_id TEXT, subject TEXT, row_key TEXT, row_json TEXT);", paramsJson: nil)
        _ = storageBridge.sqlExec(sql: "INSERT INTO mecha_outbox VALUES ('tx_ios_1');", paramsJson: nil)
        _ = storageBridge.sqlExec(sql: "INSERT INTO mecha_shape_row VALUES ('favorite', 'user_apple_ios', 'fav1', '{}');", paramsJson: nil)
        _ = storageBridge.sqlExec(sql: "INSERT INTO mecha_shape_row VALUES ('card_set', '', 'deck1', '{}');", paramsJson: nil)

        let engine = JavaScriptCoreOmnishellEngine(
            networkBridge: networkBridge,
            storageBridge: storageBridge,
            authBridge: authBridge,
            origin: "https://snapcards.fun",
            printBridge: printBridge
        )
        defer { engine.close() }
        try engine.start()
        _ = engine.evaluateJs("""
            (async () => {
                const apple = await AuthBridge.appleSignIn({ origin: 'https://snapcards.fun' });
                const del = await AuthBridge.deleteAccount({ origin: 'https://snapcards.fun' });
                const afterSession = AuthBridge.loadSession();
                emitUiAst(JSON.stringify({
                    appleUser: apple.userIdentifier,
                    deleted: del.deleted,
                    sessionCleared: afterSession === null
                }));
            })();
        """)
        for _ in 0..<40 {
            if engine.uiAst.contains("\"sessionCleared\":true") { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(engine.uiAst.contains("\"appleUser\":\"001999.apple\""))
        #expect(engine.uiAst.contains("\"deleted\":true"))
        #expect(engine.uiAst.contains("\"sessionCleared\":true"))
        #expect(recorder.deleteAuthHeader == "Bearer jwt_ios_apple")
        #expect(storageBridge.sqlQuery(sql: "SELECT * FROM mecha_outbox;", paramsJson: nil) == "[]")
        #expect(storageBridge.sqlQuery(sql: "SELECT * FROM mecha_shape_row WHERE subject = 'user_apple_ios';", paramsJson: nil) == "[]")
        #expect(storageBridge.sqlQuery(sql: "SELECT * FROM mecha_shape_row WHERE subject = '';", paramsJson: nil).contains("deck1"))
    }

    #if canImport(DivKit) && canImport(UIKit)
    @Test("Yandex DivKit parses all Snapcards .divkit.json screens and mounts live SQLite-reconciled cards + card study with zero errors")
    @available(iOS 16.0, *)
    @MainActor
    func yandexDivKitParsesAllSnapcardsScreensWithZeroErrors() async throws {
        let testFile = URL(fileURLWithPath: #filePath)
        let repoRoot = testFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let resourcesUrl = repoRoot.appendingPathComponent("apps/snapcards/dist/ios/Sources/SnapcardsApp/Resources")
        guard FileManager.default.fileExists(atPath: resourcesUrl.path) else {
            Issue.record("Missing generated Snapcards iOS resources at \(resourcesUrl.path)")
            return
        }

        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let storageBridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        defer { storageBridge.close() }

        let cacheSql = try String(contentsOf: resourcesUrl.appendingPathComponent("seed-cache.sql"), encoding: .utf8)
        let derivedSql = try String(contentsOf: resourcesUrl.appendingPathComponent("derived.sql"), encoding: .utf8)
        _ = storageBridge.sqlExec(sql: cacheSql, paramsJson: nil)
        _ = storageBridge.sqlExec(sql: derivedSql, paramsJson: nil)

        let host = OmnishellDivKitHost()
        host.resourcesUrl = resourcesUrl
        host.origin = "https://snapcards.fun"
        let flipFactory = FlipCardDivCustomBlockFactory()
        let realmFactory = PrintRealmDivCustomBlockFactory()
        host.registerCustomFactory(flipFactory)
        host.registerCustomFactory(realmFactory)

        // 1. Parse all 7 raw bundled .divkit.json screen files through Yandex DivKitComponents
        let screenNames = ["cards", "generate", "explore", "deck", "card", "print", "about"]
        for name in screenNames {
            host.clearDivKitErrors()
            let screenUrl = resourcesUrl.appendingPathComponent("screens/\(name).divkit.json")
            let data = try Data(contentsOf: screenUrl)
            let result = try host.divKitComponents.parseDivDataWithTemplates(data, cardId: DivCardID(rawValue: "raw_\(name)"))
            #expect(result.value != nil, "DivKit failed to deserialize \(name).divkit.json")
            #expect(host.divKitErrors.isEmpty, "DivKit logged errors on \(name).divkit.json: \(host.divKitErrors)")
        }

        // 2. Boot omnishell-runtime.js in JSC, mount in real Yandex DivView, navigate to study card, flip, and click Next
        host.clearDivKitErrors()
        let stubCfg = URLSessionConfiguration.ephemeral
        stubCfg.protocolClasses = [StubLongPollUrlProtocol.self]
        StubLongPollUrlProtocol.setHandler(nil)
        let offlineSession = URLSession(configuration: stubCfg)
        defer { offlineSession.invalidateAndCancel() }

        let runtimeJs = try String(contentsOf: resourcesUrl.appendingPathComponent("omnishell-runtime.js"), encoding: .utf8)
        let engine = JavaScriptCoreOmnishellEngine(
            networkBridge: NetworkBridge(client: URLSessionFetchClient(session: offlineSession)),
            storageBridge: storageBridge,
            initialScript: runtimeJs,
            origin: "https://snapcards.fun",
            resourcesUrl: resourcesUrl
        )
        defer { engine.close() }

        engine.onAstChanged = { [weak engine] ast in
            _ = host.render(astJson: ast) { uri in
                engine?.dispatchAction(uri)
            }
        }
        engine.onVariableChanged = { k, v in
            host.updateVariable(name: k, value: v)
        }
        try engine.start()

        #expect(host.currentCardId == "omnishell_cards")
        #expect(host.lastRenderedAst.contains("Animais Brasileiros"))

        let containerView = OmnishellDivContainerView(divKitComponents: host.divKitComponents)
        containerView.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        let homeDict = try JSONSerialization.jsonObject(with: Data(host.lastRenderedAst.utf8)) as! [String: Any]
        await containerView.divView.setSource(
            DivViewSource(kind: .json(homeDict), cardId: DivCardID(rawValue: host.currentCardId)),
            shouldResetPreviousCardData: false
        )
        containerView.layoutIfNeeded()
        #expect(host.divKitErrors.isEmpty, "DivView layout errors on cards: \(host.divKitErrors)")

        // Navigate into hero deck -> card study screen
        engine.dispatchAction("pronto://event/CLICK?data_id=69618be6-9206-f9c7-59eb-b5e4b072cf3d&handler=play_select&id=btn-hero-play")
        engine.dispatchAction("pronto://event/NAVIGATE?screen=deck&deck=69618be6-9206-f9c7-59eb-b5e4b072cf3d")
        for _ in 0..<40 {
            if host.currentCardId == "omnishell_card" { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(host.currentCardId == "omnishell_card")
        let card1Ast = host.lastRenderedAst

        let studyDict1 = try JSONSerialization.jsonObject(with: Data(card1Ast.utf8)) as! [String: Any]
        await containerView.divView.setSource(
            DivViewSource(kind: .json(studyDict1), cardId: DivCardID(rawValue: host.currentCardId)),
            shouldResetPreviousCardData: true
        )
        containerView.layoutIfNeeded()
        #expect(host.divKitErrors.isEmpty, "DivView layout errors on card study: \(host.divKitErrors)")

        // Flip card to Back face in place via DivVariablesStorage
        engine.dispatchAction("pronto://event/CHART_CLICK?id=card-flip-visual")
        for _ in 0..<20 {
            if host.variableStorage.getString(name: "flipped") == "yes" { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(host.variableStorage.getString(name: "flipped") == "yes")
        containerView.layoutIfNeeded()
        #expect(host.divKitErrors.isEmpty, "DivView layout errors after flip: \(host.divKitErrors)")

        // Click Next card -> advances illustration & word with zero DivKit errors
        let parseBeforeNext = host.astParseCount
        engine.dispatchAction("pronto://event/CLICK?handler=play_next&id=btn-next")
        for _ in 0..<40 {
            if host.astParseCount > parseBeforeNext { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(host.astParseCount > parseBeforeNext)
        #expect(host.lastRenderedAst != card1Ast)
        let studyDict2 = try JSONSerialization.jsonObject(with: Data(host.lastRenderedAst.utf8)) as! [String: Any]
        await containerView.divView.setSource(
            DivViewSource(kind: .json(studyDict2), cardId: DivCardID(rawValue: host.currentCardId)),
            shouldResetPreviousCardData: false
        )
        containerView.layoutIfNeeded()
        #expect(host.divKitErrors.isEmpty, "DivView layout errors after Next card: \(host.divKitErrors)")

        // 3. Dynamic uncached UGC deck translation end-to-end:
        //    Seed a fresh English UGC deck ("Space Explorers", ugc-test-deck-0001) + idle device slot ->
        //    open it in Portuguese -> verify `ask-translation` sets `generation_draft` to `drafting` with `[TRANSLATE:pt]` ->
        //    settle `generation_draft` to `done` -> verify `#translation-settles` (`create_set`) writes `deck_translation` +
        //    `card_translation` and `DivView` renders the translated Portuguese title & card word with zero DivKit errors!
        _ = engine.evaluateJs(#"""
            (function() {
                const sql = __omnishellStorage.sql;
                const devRows = sql.query("SELECT row_json FROM mecha_shape_row WHERE shape_id = 'device' LIMIT 1;");
                const dev = JSON.parse(devRows[0].row_json);
                const slotId = dev.key + ":draft-cheap";
                sql.exec(
                    "INSERT OR REPLACE INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES ('generation_draft', '', ?, ?);",
                    [slotId, JSON.stringify({ id: slotId, topic: "", category: "", locale: "", region: "", card_count: 0, status: "idle", set_id: "", details: "", txid: "10" })]
                );
                sql.exec(
                    "INSERT OR REPLACE INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES ('card_set', '', 'ugc-test-deck-0001', ?);",
                    [JSON.stringify({ id: "ugc-test-deck-0001", name: "Space Explorers", category: "Science", locale: "en-US", region: "USA", count: 2, cover_emoji: "🚀", txid: "1" })]
                );
                sql.exec(
                    "INSERT OR REPLACE INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES ('flashcard', '', 'ugc-card-01', ?);",
                    [JSON.stringify({ id: "ugc-card-01", set_id: "ugc-test-deck-0001", front: "astronaut", back: "s3://mecha-objects/seed/1128d743b7bfcda1018b5b00c09e3c1629f380fe8b962d30fa419ae406a961d2.webp", emoji: "👨‍🚀", txid: "1" })]
                );
                sql.exec(
                    "INSERT OR REPLACE INTO mecha_shape_row (shape_id, subject, row_key, row_json) VALUES ('flashcard', '', 'ugc-card-02', ?);",
                    [JSON.stringify({ id: "ugc-card-02", set_id: "ugc-test-deck-0001", front: "rocket", back: "s3://mecha-objects/seed/1128d743b7bfcda1018b5b00c09e3c1629f380fe8b962d30fa419ae406a961d2.webp", emoji: "🚀", txid: "1" })]
                );
            })();
        """#)
        engine.dispatchAction("pronto://event/NAVIGATE?screen=card&deck=ugc-test-deck-0001&locale=pt")
        var askedTopic = ""
        for _ in 0..<40 {
            let topicVal = engine.evaluateJs(#"""
                (function() {
                    const rows = __omnishellStorage.sql.query("SELECT row_json FROM mecha_shape_row WHERE shape_id = 'generation_draft';");
                    for (const r of rows) {
                        const obj = JSON.parse(r.row_json);
                        if (obj.status === "drafting" && String(obj.topic || "").includes("[TRANSLATE:pt]")) return obj.topic;
                    }
                    return "";
                })();
            """#)?.toString() ?? ""
            if !topicVal.isEmpty {
                askedTopic = topicVal
                break
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(askedTopic.contains("ugc-test-deck-0001 :: [TRANSLATE:pt] ::"), "Expected ask-translation to patch draft-cheap into drafting, got: \(askedTopic)")

        // Simulate Airlock smollm3-draft settling both translated Portuguese words on `generation_draft`
        _ = engine.evaluateJs(#"""
            (function() {
                const sql = __omnishellStorage.sql;
                const rows = sql.query("SELECT row_key, row_json FROM mecha_shape_row WHERE shape_id = 'generation_draft';");
                for (const r of rows) {
                    const obj = JSON.parse(r.row_json);
                    if (String(obj.topic || "").includes("[TRANSLATE:pt]")) {
                        obj.status = "done";
                        obj.txid = "11";
                        obj.category = JSON.stringify({ name: "Exploradores do Espaço", category: "Ciência", cards: [{ word: "astronauta" }, { word: "foguete" }] });
                        sql.exec("UPDATE mecha_shape_row SET row_json = ? WHERE shape_id = 'generation_draft' AND row_key = ?;", [JSON.stringify(obj), r.row_key]);
                    }
                }
            })();
        """#)
        engine.dispatchAction("pronto://event/NAVIGATE?screen=card&deck=ugc-test-deck-0001&locale=pt")
        for _ in 0..<40 {
            if host.lastRenderedAst.contains("Exploradores do Espaço") { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(host.lastRenderedAst.contains("Exploradores do Espaço"), "Expected translated deck title in rendered DivKit AST")
        #expect(host.lastRenderedAst.contains("astronauta"), "Expected translated card word in rendered DivKit AST")
        let studyTranslatedDict = try JSONSerialization.jsonObject(with: Data(host.lastRenderedAst.utf8)) as! [String: Any]
        await containerView.divView.setSource(
            DivViewSource(kind: .json(studyTranslatedDict), cardId: DivCardID(rawValue: host.currentCardId)),
            shouldResetPreviousCardData: false
        )
        containerView.layoutIfNeeded()
        #expect(host.divKitErrors.isEmpty, "DivView layout errors after dynamic UGC translation: \(host.divKitErrors)")
    }
    #endif
}
