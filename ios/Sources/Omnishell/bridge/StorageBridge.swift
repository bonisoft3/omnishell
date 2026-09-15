import Foundation

public final class StorageBridge: @unchecked Sendable {
    private let sqlDatabase: SqlDatabase
    private let keyValueStore: KeyValueStore
    private let jsonEncoder = JSONEncoder()

    public init(sqlDatabase: SqlDatabase, keyValueStore: KeyValueStore) {
        self.sqlDatabase = sqlDatabase
        self.keyValueStore = keyValueStore
    }

    public func sqlExec(sql: String, paramsJson: String?) -> String {
        let params = parseParams(paramsJson)
        do {
            let result = try sqlDatabase.exec(sql, params: params)
            let data = try jsonEncoder.encode(result)
            return String(data: data, encoding: .utf8) ?? "{}"
        } catch {
            fatalError("SQL execution error: \(error) for SQL: \(sql)")
        }
    }

    public func sqlQuery(sql: String, paramsJson: String?) -> String {
        let params = parseParams(paramsJson)
        do {
            let rows = try sqlDatabase.query(sql, params: params)
            let sanitized = sanitizeForJson(rows)
            let data = try JSONSerialization.data(withJSONObject: sanitized, options: [])
            return String(data: data, encoding: .utf8) ?? "[]"
        } catch {
            fatalError("SQL query error: \(error) for SQL: \(sql)")
        }
    }

    public func kvGet(key: String) -> String? {
        keyValueStore.get(key)
    }

    public func kvSet(key: String, value: String) {
        keyValueStore.set(key, value: value)
    }

    public func kvDelete(key: String) -> Bool {
        keyValueStore.delete(key)
    }

    public func kvClear() {
        keyValueStore.clear()
    }

    public func kvKeys() -> String {
        let keys = keyValueStore.keys()
        let data = (try? JSONSerialization.data(withJSONObject: keys, options: [])) ?? Data("[]".utf8)
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    public func close() {
        sqlDatabase.close()
    }

    private func parseParams(_ paramsJson: String?) -> [Any?] {
        guard let json = paramsJson, let data = json.data(using: .utf8) else {
            return []
        }
        guard let array = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [Any?] else {
            return []
        }
        return array
    }

    private func sanitizeForJson(_ rows: [[String: Any?]]) -> [[String: Any]] {
        return rows.map { row in
            var cleanRow: [String: Any] = [:]
            for (k, v) in row {
                if let val = v {
                    if let data = val as? Data {
                        cleanRow[k] = data.base64EncodedString()
                    } else {
                        cleanRow[k] = val
                    }
                } else {
                    cleanRow[k] = NSNull()
                }
            }
            return cleanRow
        }
    }
}
