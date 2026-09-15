import Foundation

public final class SqliteKeyValueStore: KeyValueStore, @unchecked Sendable {
    private let db: SqlDatabase

    public init(db: SqlDatabase) throws {
        self.db = db
        _ = try db.exec("CREATE TABLE IF NOT EXISTS __omnishell_kv (key TEXT PRIMARY KEY, value TEXT);", params: [])
    }

    public func get(_ key: String) -> String? {
        do {
            let rows = try db.query("SELECT value FROM __omnishell_kv WHERE key = ?;", params: [key])
            if let first = rows.first, let val = first["value"] {
                return val as? String ?? String(describing: val)
            }
            return nil
        } catch {
            fatalError("Failed to get KV key '\(key)': \(error)")
        }
    }

    public func set(_ key: String, value: String) {
        do {
            _ = try db.exec(
                "INSERT INTO __omnishell_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
                params: [key, value]
            )
        } catch {
            fatalError("Failed to set KV key '\(key)': \(error)")
        }
    }

    public func delete(_ key: String) -> Bool {
        do {
            let result = try db.exec("DELETE FROM __omnishell_kv WHERE key = ?;", params: [key])
            return result.rowsAffected > 0
        } catch {
            fatalError("Failed to delete KV key '\(key)': \(error)")
        }
    }

    public func clear() {
        do {
            _ = try db.exec("DELETE FROM __omnishell_kv;", params: [])
        } catch {
            fatalError("Failed to clear KV store: \(error)")
        }
    }

    public func keys() -> [String] {
        do {
            let rows = try db.query("SELECT key FROM __omnishell_kv ORDER BY key ASC;", params: [])
            return rows.compactMap { row in
                guard let k = row["key"] else { return nil }
                return k as? String ?? String(describing: k)
            }
        } catch {
            fatalError("Failed to get KV keys: \(error)")
        }
    }
}
