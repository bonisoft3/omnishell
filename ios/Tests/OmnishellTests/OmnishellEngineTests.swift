import Testing
import Foundation
@testable import Omnishell

@Suite("OmnishellEngine Tests")
struct OmnishellEngineTests {
    @Test func engineExecutesStorageCapabilitiesFromJs() throws {
        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let storageBridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        let networkBridge = NetworkBridge(client: URLSessionFetchClient())

        let script = """
            __omnishellStorage.kv.set('auth_token', 'jwt_secret_123');
            __omnishellStorage.sql.exec('CREATE TABLE test_js (id TEXT PRIMARY KEY, title TEXT);');
            __omnishellStorage.sql.exec('INSERT INTO test_js (id, title) VALUES (?, ?);', ['1', 'First Post']);
            const rows = __omnishellStorage.sql.query('SELECT title FROM test_js WHERE id = ?;', ['1']);
            emitUiAst(JSON.stringify({ card: { title: rows[0].title, token: __omnishellStorage.kv.get('auth_token') } }));
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

        #expect(engine.uiAst.contains("First Post"))
        #expect(engine.uiAst.contains("jwt_secret_123"))
    }

    @Test func engineActionDispatchUpdatesUiAst() async throws {
        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let storageBridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        let networkBridge = NetworkBridge(client: URLSessionFetchClient())

        let script = """
            let count = 0;
            onAction(function(actionUri) {
                if (actionUri === 'pronto://event/INCREMENT') {
                    count += 1;
                    emitUiAst(JSON.stringify({ count: count }));
                }
            });
            emitUiAst(JSON.stringify({ count: count }));
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
        #expect(engine.uiAst.contains("\"count\":0"))

        engine.dispatchAction("pronto://event/INCREMENT")

        // Wait a brief moment for async dispatch queue
        var updated = false
        for _ in 0..<20 {
            if engine.uiAst.contains("\"count\":1") {
                updated = true
                break
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        #expect(updated == true)
        #expect(engine.uiAst.contains("\"count\":1"))
    }
}
