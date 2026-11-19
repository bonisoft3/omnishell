package com.pronto.omnishell

import com.pronto.omnishell.bridge.AuthBridge
import com.pronto.omnishell.bridge.AuthSession
import com.pronto.omnishell.bridge.KeyValueSessionStore
import com.pronto.omnishell.bridge.NativeCredentialHandler
import com.pronto.omnishell.bridge.NetworkBridge
import com.pronto.omnishell.bridge.OidcCeremonyResult
import com.pronto.omnishell.bridge.OidcStartOptions
import com.pronto.omnishell.bridge.PasskeyRegisterOptions
import com.pronto.omnishell.bridge.PasskeySignInOptions
import com.pronto.omnishell.bridge.CheckoutReturnResult
import com.pronto.omnishell.bridge.CheckoutTabRequest
import com.pronto.omnishell.bridge.NativePrintHandler
import com.pronto.omnishell.bridge.PrintBridge
import com.pronto.omnishell.bridge.PrintJobRequest
import com.pronto.omnishell.bridge.PrintJobResult
import com.pronto.omnishell.bridge.StorageBridge
import com.pronto.omnishell.divkit.DivImageSupport
import com.pronto.omnishell.divkit.FlipCardDivCustomAdapter
import com.pronto.omnishell.divkit.OmnishellDivKitHost
import com.pronto.omnishell.divkit.PrintRealmDivCustomAdapter
import com.pronto.omnishell.network.OkHttpFetchClient
import com.pronto.omnishell.storage.JdbcSqliteDatabase
import com.pronto.omnishell.storage.SqliteKeyValueStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.File
import java.nio.charset.StandardCharsets
import java.security.KeyPairGenerator
import java.security.Signature
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SnapcardsNativeHostTest {
    private lateinit var server: MockWebServer
    private lateinit var db: JdbcSqliteDatabase

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        db = JdbcSqliteDatabase("jdbc:sqlite::memory:")
    }

    @AfterEach
    fun tearDown() {
        db.close()
        server.shutdown()
    }

    @Test
    fun `async QuickJS fetch resolves concurrently without blocking slow Electric long-polls`() = runBlocking {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                return if (request.path?.contains("/long-poll") == true) {
                    MockResponse()
                        .setBodyDelay(350, TimeUnit.MILLISECONDS)
                        .setResponseCode(200)
                        .setBody("""{"stream":"settled"}""")
                } else {
                    MockResponse()
                        .setResponseCode(200)
                        .setBody("""{"fast":"ok"}""")
                }
            }
        }

        val slowUrl = server.url("/electric/long-poll").toString()
        val fastUrl = server.url("/api/fast").toString()
        val script = """
            let state = { order: [] };
            onAction((act) => {
                if (act === "pronto://event/PING") {
                    state.order.push("action");
                    emitUiAst(JSON.stringify(state));
                }
            });
            (async () => {
                const slow = fetch('$slowUrl').then(r => r.json()).then(() => {
                    state.order.push("slow");
                    emitUiAst(JSON.stringify(state));
                });
                const fast = fetch('$fastUrl').then(r => r.json()).then(() => {
                    state.order.push("fast");
                    emitUiAst(JSON.stringify(state));
                });
                await Promise.all([slow, fast]);
            })();
        """.trimIndent()

        val kv = SqliteKeyValueStore(db)
        val engine = QuickJsOmnishellEngine(
            networkBridge = NetworkBridge(OkHttpFetchClient()),
            storageBridge = StorageBridge(kv, db),
            initialScript = script
        )

        engine.start()
        engine.dispatchAction("pronto://event/PING")

        var retries = 0
        while (!engine.uiAst.value.contains("\"slow\"") && retries < 40) {
            delay(25)
            retries++
        }

        val ast = engine.uiAst.value
        assertTrue(ast.contains("\"fast\""))
        assertTrue(ast.contains("\"action\""))
        assertTrue(ast.contains("\"slow\""))
        assertTrue(ast.indexOf("fast") < ast.indexOf("slow"))
        assertTrue(ast.indexOf("action") < ast.indexOf("slow"))
        engine.close()
    }

    @Test
    fun `AuthBridge, SQLite CacheStorage offline-first-sw, and Ed25519 ManifestVerifier run inside QuickJS`() = runBlocking {
        val swSource = File("../offline-first-sw.js").readText(Charsets.UTF_8)

        val kpg = KeyPairGenerator.getInstance("Ed25519")
        val kp = kpg.generateKeyPair()
        // Extract 32-byte raw public key from 44-byte X.509 SubjectPublicKeyInfo
        val x509Pub = kp.public.encoded
        val rawPub32 = x509Pub.copyOfRange(x509Pub.size - 32, x509Pub.size)
        val pubB64 = Base64.getEncoder().encodeToString(rawPub32)

        val bridgeHash = "1".repeat(64)
        val manifestJson = """{"imports":{"/@native/bridge":"/_immutable-$bridgeHash-bridge"},"screens":{}}"""
        val signer = Signature.getInstance("Ed25519")
        signer.initSign(kp.private)
        signer.update(manifestJson.toByteArray(StandardCharsets.UTF_8))
        val sigB64 = Base64.getEncoder().encodeToString(signer.sign())

        val signedEntryHtml = """<!doctype html><html><head><script type="importmap" id="pronto-assets" data-signature="$sigB64">$manifestJson</script></head><body>v2</body></html>"""
        repeat(2) {
            server.enqueue(
                MockResponse()
                    .setResponseCode(200)
                    .setHeader("Cache-Control", "public, no-cache")
                    .setBody(signedEntryHtml)
            )
        }

        val origin = server.url("/").toString().trimEnd('/')
        val kv = SqliteKeyValueStore(db)
        val storageBridge = StorageBridge(kv, db)
        val authBridge = AuthBridge(
            sessionStore = KeyValueSessionStore(storageBridge),
            credentialHandler = object : NativeCredentialHandler {
                override fun passkeySignIn(
                    options: PasskeySignInOptions,
                    onSuccess: (String) -> Unit,
                    onFailure: (Throwable) -> Unit
                ) {
                    onSuccess("""{"id":"android-passkey-1","rpId":"${options.rpId}"}""")
                }

                override fun passkeyRegister(
                    options: PasskeyRegisterOptions,
                    onSuccess: (String) -> Unit,
                    onFailure: (Throwable) -> Unit
                ) {
                    onSuccess("""{"id":"android-passkey-reg","promoted":${options.promote ?: false}}""")
                }

                override fun oidcStart(
                    provider: String,
                    startUrl: String,
                    codeVerifier: String,
                    options: OidcStartOptions,
                    onSuccess: (OidcCeremonyResult) -> Unit,
                    onFailure: (Throwable) -> Unit
                ) {
                    onSuccess(
                        OidcCeremonyResult(
                            ticket = "ticket_android_99",
                            codeVerifier = codeVerifier,
                            callbackUrl = startUrl,
                            session = AuthSession(
                                token = "jwt_android_oidc",
                                refreshToken = "rt_android_001",
                                userId = "user_adopted_android",
                                handle = "android@snapcards.fun",
                                isGuest = false
                            )
                        )
                    )
                }
            }
        )

        val escapedSw = Json.encodeToString(swSource)
        val script = """
            (async () => {
                const swCode = $escapedSw;
                const handlers = {};
                const bg = [];
                const self = {
                    location: { origin: '$origin' },
                    skipWaiting: () => {},
                    clients: { claim: () => {} },
                    registration: { navigationPreload: { disable: () => Promise.resolve() } },
                    addEventListener: (t, fn) => { handlers[t] = fn; }
                };
                new Function('self', 'caches', 'fetch', 'Response', 'Headers', 'URL', swCode)(
                    self, globalThis.caches, globalThis.fetch, globalThis.Response, globalThis.Headers, globalThis.URL
                );

                const stale = await caches.open('workbox-old');
                await stale.put('$origin/stale', new Response('old'));
                const entries = await caches.open('pronto-entries-v1');
                await entries.put('$origin/', new Response('<head><meta name="pronto-kept"></head><body>v1</body>'));

                handlers.activate({ waitUntil: p => bg.push(p) });
                await Promise.all(bg.splice(0));
                const cacheKeys = await caches.keys();

                let navPromise;
                handlers.fetch({
                    request: { method: 'GET', url: '$origin/', mode: 'navigate', cache: 'default' },
                    respondWith: p => { navPromise = p; },
                    waitUntil: p => bg.push(p)
                });
                const firstPaint = await (await navPromise).text();
                await Promise.all(bg.splice(0));

                handlers.fetch({
                    request: { method: 'GET', url: '$origin/', mode: 'navigate', cache: 'default' },
                    respondWith: p => { navPromise = p; },
                    waitUntil: p => bg.push(p)
                });
                const secondPaint = await (await navPromise).text();
                const verified = __verifyEntryManifestEd25519(secondPaint, '$pubB64');

                const reg = await AuthBridge.passkeyRegister({
                    rpId: 'snapcards.fun',
                    rpName: 'Snapcards',
                    challenge: 'c1',
                    userId: 'guest-1',
                    userName: 'guest',
                    promote: true
                });
                const oidc = await AuthBridge.oidcStart('google', { origin: '$origin' });
                const saved = AuthBridge.loadSession();

                emitUiAst(JSON.stringify({
                    cacheKeys,
                    firstV1: firstPaint.includes('v1'),
                    secondKept: secondPaint.includes('pronto-kept') && secondPaint.includes('v2'),
                    bridgeRef: verified.imports['/@native/bridge'],
                    promoted: reg.promoted,
                    ticket: oidc.ticket,
                    token: saved.token
                }));
            })();
        """.trimIndent()

        val engine = QuickJsOmnishellEngine(
            networkBridge = NetworkBridge(OkHttpFetchClient()),
            storageBridge = storageBridge,
            initialScript = script,
            authBridge = authBridge,
            origin = origin
        )
        engine.start()

        var retries = 0
        while (!engine.uiAst.value.contains("jwt_android_oidc") && retries < 40) {
            delay(25)
            retries++
        }

        val ast = engine.uiAst.value
        assertTrue(ast.contains("\"firstV1\":true"))
        assertTrue(ast.contains("\"secondKept\":true"))
        assertFalse(ast.contains("workbox-old"))
        assertTrue(ast.contains("\"promoted\":true"))
        assertTrue(ast.contains("\"ticket\":\"ticket_android_99\""))
        assertTrue(ast.contains("\"token\":\"jwt_android_oidc\""))
        engine.close()
    }

    @Test
    fun `FlipCardDivCustomAdapter computes 3D rotationY + camera distance and switches div-state in place`() {
        val cardJson = """
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
        """.trimIndent()

        val host = OmnishellDivKitHost()
        val flipAdapter = FlipCardDivCustomAdapter(density = 3.0f)
        host.registerCustomAdapter(flipAdapter)

        assertTrue(host.render(cardJson) {})
        assertEquals(1, host.astParseCount)

        val initial = flipAdapter.boundFlipCards["card-flip"]!!
        assertEquals(2, initial.itemsCount)
        assertFalse(initial.isFlipped)
        assertEquals(0f, initial.frontRotationYDeg)
        assertEquals(-180f, initial.backRotationYDeg)
        assertEquals(1200f * 3f * 8f, initial.cameraDistancePx)
        assertTrue(initial.frontVisible && initial.frontClickable)
        assertFalse(initial.backVisible || initial.backClickable)

        // Flip in-place via DivKit set_variable URI without re-parsing AST
        host.dispatchActionUri("div-action://set_variable?name=flipped&value=yes")
        assertEquals(1, host.astParseCount)

        val flipped = flipAdapter.boundFlipCards["card-flip"]!!
        assertTrue(flipped.isFlipped)
        assertEquals(180f, flipped.frontRotationYDeg)
        assertEquals(0f, flipped.backRotationYDeg)
        assertFalse(flipped.frontVisible || flipped.frontClickable)
        assertTrue(flipped.backVisible && flipped.backClickable)

        // Open popover div-state in place
        assertEquals("closed", host.currentStateId("state_card-edit-sheet"))
        host.dispatchActionUri("div-action://set_variable?name=sheet_card_edit_sheet_state&value=open")
        assertEquals("open", host.currentStateId("state_card-edit-sheet"))

        // SVG data-URI decoding + `/img/*` resolution
        assertEquals(
            "https://snapcards.fun/img/card.webp",
            DivImageSupport.resolveImageUrl("/img/card.webp", "https://snapcards.fun")
        )
        val svgBytes = DivImageSupport.decodeSvgDataUri("data:image/svg+xml;utf8,%3Csvg%3E%3C%2Fsvg%3E")!!
        assertEquals("<svg></svg>", String(svgBytes, StandardCharsets.UTF_8))

        // Re-render releases previous listener without leaking
        assertEquals(1, host.variableController.listenerCount)
        assertTrue(host.render(cardJson) {})
        assertEquals(1, host.variableController.listenerCount)
    }

    @Test
    fun `PrintRealmDivCustomAdapter, PrintBridge, DeleteAccount wipe, and responsive RTL dark display work end to end`() = runBlocking {
        val patchedRequests = mutableListOf<String>()
        var accountDeleted = false
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val reqPath = request.path ?: ""
                if (reqPath.startsWith("/crud/print_order") && request.method == "GET") {
                    return MockResponse()
                        .setResponseCode(200)
                        .setBody("""[{"id":"ord_android_1","status":"awaiting_payment","checks":1}]""")
                }
                if (reqPath.startsWith("/crud/print_order") && request.method == "PATCH") {
                    patchedRequests.add(request.body.readUtf8())
                    return MockResponse()
                        .setResponseCode(200)
                        .setBody("""[{"id":"ord_android_1","status":"checking","checks":2}]""")
                }
                if (reqPath == "/auth/account" && request.method == "DELETE") {
                    accountDeleted = request.getHeader("Authorization") == "Bearer jwt_del_1"
                    return MockResponse().setResponseCode(200).setBody("""{"deleted":true}""")
                }
                return MockResponse().setResponseCode(404)
            }
        }

        val origin = server.url("/").toString().trimEnd('/')
        val kv = SqliteKeyValueStore(db)
        val storageBridge = StorageBridge(kv, db)
        val networkBridge = NetworkBridge(OkHttpFetchClient())
        val authBridge = AuthBridge(
            sessionStore = KeyValueSessionStore(storageBridge)
        )
        authBridge.saveSession(
            AuthSession(
                token = "jwt_del_1",
                refreshToken = "rt_del_1",
                userId = "user_del_android",
                handle = "davi",
                isGuest = false
            )
        )

        val printedJobs = mutableListOf<PrintJobRequest>()
        val launchedCheckouts = mutableListOf<CheckoutTabRequest>()
        val printBridge = PrintBridge(
            handler = object : NativePrintHandler {
                override fun printDocument(
                    request: PrintJobRequest,
                    onSuccess: (PrintJobResult) -> Unit,
                    onFailure: (Throwable) -> Unit
                ) {
                    printedJobs.add(request)
                    onSuccess(
                        PrintJobResult(
                            jobId = "job_1",
                            jobName = request.jobName,
                            adapterType = "WebViewPrintDocumentAdapter",
                            dpi = request.dpi,
                            accepted = true
                        )
                    )
                }

                override fun openCheckoutCustomTab(
                    request: CheckoutTabRequest,
                    onSuccess: (CheckoutReturnResult) -> Unit,
                    onFailure: (Throwable) -> Unit
                ) {
                    launchedCheckouts.add(request)
                    onSuccess(
                        CheckoutReturnResult(
                            orderId = request.orderId,
                            outcome = "launched",
                            callbackUrl = request.returnUrl
                        )
                    )
                }
            },
            networkBridge = networkBridge,
            origin = origin
        )

        val host = OmnishellDivKitHost()
        host.printBridge = printBridge
        val flipAdapter = FlipCardDivCustomAdapter(density = 3.0f)
        val realmAdapter = PrintRealmDivCustomAdapter(printBridge = printBridge)
        host.registerCustomAdapter(flipAdapter)
        host.registerCustomAdapter(realmAdapter)

        // Configure Tablet (820dp) + Dark + RTL
        host.configureDisplay(viewportWidthDp = 820, themeMode = "dark", layoutDirection = "rtl")
        assertEquals("tablet", host.formFactor)
        assertEquals("dark", host.themeMode)
        assertEquals("rtl", host.layoutDirection)
        assertTrue(flipAdapter.isRtl)

        val printCardJson = """
            {
              "card": {
                "log_id": "omnishell_print",
                "variables": [
                  { "name": "active_deck_id", "type": "string", "value": "deck_solar" },
                  { "name": "order_id", "type": "string", "value": "ord_android_1" },
                  { "name": "order_checkout_url", "type": "string", "value": "https://checkout.stripe.com/c/pay/cs_android" }
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
                            "origin": "$origin",
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
                            "origin": "$origin",
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
        """.trimIndent()

        val hostActions = mutableListOf<String>()
        assertTrue(host.render(printCardJson) { act -> hostActions.add(act) })

        val mapRealm = realmAdapter.boundRealms["realm_delivery_map"]!!
        assertTrue(mapRealm.allowsGeolocation)
        var allowedGeo = false
        var deniedGeo = true
        printBridge.delegateGeolocationPrompt(origin, "delivery-map", mapRealm.grants) { _, allow, _ -> allowedGeo = allow }
        printBridge.delegateGeolocationPrompt(origin, "print-sheet", listOf("print")) { _, allow, _ -> deniedGeo = allow }
        assertTrue(allowedGeo)
        assertFalse(deniedGeo)

        val sheetRealm = realmAdapter.boundRealms["print_sheet_realm"]!!
        assertTrue(sheetRealm.allowsMediaPrint)
        assertTrue(sheetRealm.allows300DpiCanvas)
        assertEquals("deck_solar", sheetRealm.deckId)

        // Dispatch omnishell://print and omnishell://checkout action URIs through OmnishellDivKitHost
        host.dispatchActionUri("omnishell://print?deck=deck_solar&paper=a4&dpi=300&job=Snapcards")
        assertEquals(1, printedJobs.size)
        assertEquals("deck_solar", printedJobs[0].deckId)
        assertEquals(300, printedJobs[0].dpi)

        host.dispatchActionUri("omnishell://checkout?order=ord_android_1&checkout_url=https%3A%2F%2Fcheckout.stripe.com%2Fc%2Fpay%2Fcs_android&return_url=snapcards%3A%2F%2Fprint%2Freturn%3Forder%3Dord_android_1")
        assertEquals(1, launchedCheckouts.size)
        assertEquals("ord_android_1", launchedCheckouts[0].orderId)
        assertEquals("https://checkout.stripe.com/c/pay/cs_android", launchedCheckouts[0].checkoutUrl)

        // Deep-link return triggers order recheck PATCH
        assertEquals("ord_android_1", PrintBridge.parsePrintReturnDeepLink("https://snapcards.fun/print?order=ord_android_1")?.orderId)
        val rechecked = printBridge.handlePrintReturnDeepLink(
            deepLinkUrl = "snapcards://print/return?order=ord_android_1",
            bearerToken = "jwt_del_1"
        )
        assertTrue(rechecked != null)
        assertEquals("ord_android_1", rechecked.first.orderId)
        assertEquals(1, patchedRequests.size)
        assertTrue(patchedRequests[0].contains("\"status\":\"checking\""))
        assertTrue(patchedRequests[0].contains("\"checks\":2"))

        // Account deletion wipes SQLite outbox + user shapes while keeping public shapes
        storageBridge.sqlExec("CREATE TABLE mecha_outbox (id TEXT PRIMARY KEY);", null)
        storageBridge.sqlExec("CREATE TABLE mecha_shape_row (shape_id TEXT, subject TEXT, row_key TEXT, row_json TEXT);", null)
        storageBridge.sqlExec("INSERT INTO mecha_outbox VALUES ('tx_1');", null)
        storageBridge.sqlExec("INSERT INTO mecha_shape_row VALUES ('favorite', 'user_del_android', 'f1', '{}');", null)
        storageBridge.sqlExec("INSERT INTO mecha_shape_row VALUES ('card_set', '', 'd1', '{}');", null)

        var deleteOutcome = ""
        authBridge.deleteAccount(
            optionsJson = """{"origin":"$origin"}""",
            networkBridge = networkBridge,
            storageBridge = storageBridge,
            onResolve = { deleteOutcome = it },
            onReject = { err -> throw IllegalStateException(err) }
        )
        var tries = 0
        while (deleteOutcome.isEmpty() && tries < 40) {
            delay(25)
            tries++
        }
        assertTrue(accountDeleted)
        assertTrue(deleteOutcome.contains("\"deleted\":true"))
        assertEquals(null, authBridge.loadSession())
        assertEquals("[]", storageBridge.sqlQuery("SELECT * FROM mecha_outbox;", null))
        assertEquals("[]", storageBridge.sqlQuery("SELECT * FROM mecha_shape_row WHERE subject = 'user_del_android';", null))
        assertTrue(storageBridge.sqlQuery("SELECT * FROM mecha_shape_row WHERE subject = '';", null).contains("d1"))
    }
}
