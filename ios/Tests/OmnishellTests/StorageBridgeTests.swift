import Testing
@testable import Omnishell

@Suite("StorageBridge Tests")
struct StorageBridgeTests {
    @Test func sqlExecAndQueryWithParameters() throws {
        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let bridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        defer { bridge.close() }

        _ = try db.exec("CREATE TABLE test_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL, active INTEGER);")

        let insertRes = try db.exec("INSERT INTO test_items (name, price, active) VALUES (?, ?, ?);", params: ["Widget", 19.99, true])
        #expect(insertRes.rowsAffected == 1)
        #expect(insertRes.lastInsertRowId == 1)

        let rows = try db.query("SELECT * FROM test_items WHERE id = ?;", params: [1])
        #expect(rows.count == 1)
        #expect(rows[0]["name"] as? String == "Widget")
        #expect(rows[0]["price"] as? Double == 19.99)
        #expect(rows[0]["active"] as? Int64 == 1)
    }

    @Test func sqlInjectionDefenseViaParamBinding() throws {
        let db = try CSystemSqliteDatabase(path: ":memory:")
        defer { db.close() }

        _ = try db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);")
        _ = try db.exec("INSERT INTO users (username) VALUES (?);", params: ["alice"])

        let attack = "' OR '1'='1"
        let rows = try db.query("SELECT * FROM users WHERE username = ?;", params: [attack])
        #expect(rows.count == 0)
    }

    @Test func keyValueStoreOperations() throws {
        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        defer { db.close() }

        #expect(kv.get("color") == nil)

        kv.set("color", value: "green")
        #expect(kv.get("color") == "green")

        kv.set("color", value: "emerald")
        #expect(kv.get("color") == "emerald")

        kv.set("size", value: "XL")
        let allKeys = kv.keys()
        #expect(allKeys == ["color", "size"])

        let deleted = kv.delete("color")
        #expect(deleted == true)
        #expect(kv.get("color") == nil)

        kv.clear()
        #expect(kv.keys().isEmpty)
    }

    @Test func storageBridgeJsonContracts() throws {
        let db = try CSystemSqliteDatabase(path: ":memory:")
        let kv = try SqliteKeyValueStore(db: db)
        let bridge = StorageBridge(sqlDatabase: db, keyValueStore: kv)
        defer { bridge.close() }

        let execJson = bridge.sqlExec(
            sql: "CREATE TABLE bridge_test (id TEXT PRIMARY KEY, val TEXT);",
            paramsJson: nil
        )
        #expect(execJson.contains("rowsAffected"))

        _ = bridge.sqlExec(
            sql: "INSERT INTO bridge_test (id, val) VALUES (?, ?);",
            paramsJson: "[\"item_1\", \"Value 1\"]"
        )

        let queryJson = bridge.sqlQuery(
            sql: "SELECT val FROM bridge_test WHERE id = ?;",
            paramsJson: "[\"item_1\"]"
        )
        #expect(queryJson.contains("Value 1"))

        bridge.kvSet(key: "pref_theme", value: "dark")
        #expect(bridge.kvGet(key: "pref_theme") == "dark")
        #expect(bridge.kvKeys().contains("pref_theme"))
        #expect(bridge.kvDelete(key: "pref_theme") == true)
        #expect(bridge.kvGet(key: "pref_theme") == nil)
    }
}
