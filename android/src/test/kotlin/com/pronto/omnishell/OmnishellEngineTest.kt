package com.pronto.omnishell

import com.pronto.omnishell.bridge.NetworkBridge
import com.pronto.omnishell.bridge.StorageBridge
import com.pronto.omnishell.network.OkHttpFetchClient
import com.pronto.omnishell.storage.JdbcSqliteDatabase
import com.pronto.omnishell.storage.SqliteKeyValueStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OmnishellEngineTest {
    private lateinit var server: MockWebServer
    private lateinit var db: JdbcSqliteDatabase
    private lateinit var engine: QuickJsOmnishellEngine

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        db = JdbcSqliteDatabase("jdbc:sqlite::memory:")
        val kv = SqliteKeyValueStore(db)
        val networkBridge = NetworkBridge(OkHttpFetchClient())
        val storageBridge = StorageBridge(kv, db)

        val testScript = """
            let state = { count: 0 };

            function render(s) {
                return JSON.stringify({
                    card: {
                        log_id: "counter_card",
                        states: [{
                            state_id: 0,
                            div: {
                                type: "container",
                                orientation: "vertical",
                                items: [
                                    {
                                        type: "text",
                                        text: "Count: " + s.count
                                    },
                                    {
                                        type: "separator"
                                    }
                                ]
                            }
                        }]
                    }
                });
            }

            emitUiAst(render(state));

            onAction((action) => {
                if (action === "pronto://event/INCREMENT") {
                    state.count += 1;
                    emitUiAst(render(state));
                }
            });
        """.trimIndent()

        engine = QuickJsOmnishellEngine(networkBridge, storageBridge, testScript)
    }

    @AfterEach
    fun tearDown() {
        engine.close()
        server.shutdown()
    }

    @Test
    fun testStartEmitsInitialUiAst() {
        engine.start()
        val ast = engine.uiAst.value
        assertTrue(ast.contains("counter_card"))
        assertTrue(ast.contains("Count: 0"))
    }

    @Test
    fun testDispatchActionUpdatesUiAst() = runBlocking {
        engine.start()
        assertEquals(true, engine.uiAst.value.contains("Count: 0"))

        engine.dispatchAction("pronto://event/INCREMENT")

        var retries = 0
        while (!engine.uiAst.value.contains("Count: 1") && retries < 20) {
            delay(50)
            retries++
        }

        assertTrue(engine.uiAst.value.contains("Count: 1"))
    }

    @Test
    fun testNativeFetchInjectionInsideQuickJs() = runBlocking {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"electric_shape_id": "shape_123"}""")
        )

        val serverUrl = server.url("/v1/shapes").toString()
        val script = """
            (async () => {
                const res = await fetch('$serverUrl');
                const data = await res.json();
                emitUiAst(JSON.stringify({ shape: data.electric_shape_id }));
            })();
        """.trimIndent()

        val netBridge = NetworkBridge(OkHttpFetchClient())
        val storBridge = StorageBridge(SqliteKeyValueStore(db), db)
        val fetchEngine = QuickJsOmnishellEngine(netBridge, storBridge, script)

        fetchEngine.start()

        var retries = 0
        while (!fetchEngine.uiAst.value.contains("shape_123") && retries < 20) {
            delay(50)
            retries++
        }

        assertTrue(fetchEngine.uiAst.value.contains("shape_123"))
        fetchEngine.close()
    }

    @Test
    fun testNativeStorageInjectionInsideQuickJs() = runBlocking {
        val script = """
            (() => {
                __omnishellStorage.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);");
                __omnishellStorage.sql.exec("INSERT INTO notes (title) VALUES (?);", ["Local First Note"]);
                const rows = __omnishellStorage.sql.query("SELECT * FROM notes;");
                emitUiAst(JSON.stringify({ notesCount: rows.length, firstTitle: rows[0].title }));
            })();
        """.trimIndent()

        val netBridge = NetworkBridge(OkHttpFetchClient())
        val storBridge = StorageBridge(SqliteKeyValueStore(db), db)
        val storageEngine = QuickJsOmnishellEngine(netBridge, storBridge, script)

        storageEngine.start()

        var retries = 0
        while (!storageEngine.uiAst.value.contains("Local First Note") && retries < 20) {
            delay(50)
            retries++
        }

        assertTrue(storageEngine.uiAst.value.contains("Local First Note"))
        assertTrue(storageEngine.uiAst.value.contains("\"notesCount\":1"))
        storageEngine.close()
    }

    @Test
    fun testEventSourceInsideQuickJs() = runBlocking {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody("event: shape_change\ndata: {\"version\": 99}\n\n")
        )

        val serverUrl = server.url("/stream").toString()
        val script = """
            const es = new EventSource('$serverUrl');
            es.addEventListener('shape_change', (e) => {
                const payload = JSON.parse(e.data);
                emitUiAst(JSON.stringify({ sseVersion: payload.version }));
                es.close();
            });
        """.trimIndent()

        val netBridge = NetworkBridge(OkHttpFetchClient())
        val storBridge = StorageBridge(SqliteKeyValueStore(db), db)
        val sseEngine = QuickJsOmnishellEngine(netBridge, storBridge, script)

        sseEngine.start()

        var retries = 0
        while (!sseEngine.uiAst.value.contains("\"sseVersion\":99") && retries < 25) {
            delay(50)
            retries++
        }

        assertTrue(sseEngine.uiAst.value.contains("\"sseVersion\":99"))
        sseEngine.close()
    }
}
