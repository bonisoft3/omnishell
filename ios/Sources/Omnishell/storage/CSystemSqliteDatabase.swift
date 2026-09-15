import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public final class CSystemSqliteDatabase: SqlDatabase, @unchecked Sendable {
    private var db: OpaquePointer?
    private let lock = NSLock()
    public let path: String

    public init(path: String = ":memory:") throws {
        self.path = path
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(path, &db, flags, nil)
        if rc != SQLITE_OK {
            let errMsg = db != nil ? String(cString: sqlite3_errmsg(db)) : "Unknown error"
            throw SqliteError.openFailed(rc: rc, message: errMsg)
        }
    }

    deinit {
        close()
    }

    public func exec(_ sql: String, params: [Any?]) throws -> SqlExecResult {
        lock.lock()
        defer { lock.unlock() }

        guard let db = db else {
            throw SqliteError.databaseClosed
        }

        var stmt: OpaquePointer?
        let prepRc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard prepRc == SQLITE_OK, let statement = stmt else {
            let errMsg = String(cString: sqlite3_errmsg(db))
            throw SqliteError.statementError(rc: prepRc, message: errMsg, sql: sql)
        }
        defer { sqlite3_finalize(statement) }

        try bindParams(statement, params: params)

        let stepRc = sqlite3_step(statement)
        guard stepRc == SQLITE_DONE || stepRc == SQLITE_ROW else {
            let errMsg = String(cString: sqlite3_errmsg(db))
            throw SqliteError.stepError(rc: stepRc, message: errMsg, sql: sql)
        }

        let rowsAffected = Int64(sqlite3_changes(db))
        let lastId = sqlite3_last_insert_rowid(db)

        return SqlExecResult(rowsAffected: rowsAffected, lastInsertRowId: lastId)
    }

    public func query(_ sql: String, params: [Any?]) throws -> [[String: Any?]] {
        lock.lock()
        defer { lock.unlock() }

        guard let db = db else {
            throw SqliteError.databaseClosed
        }

        var stmt: OpaquePointer?
        let prepRc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard prepRc == SQLITE_OK, let statement = stmt else {
            let errMsg = String(cString: sqlite3_errmsg(db))
            throw SqliteError.statementError(rc: prepRc, message: errMsg, sql: sql)
        }
        defer { sqlite3_finalize(statement) }

        try bindParams(statement, params: params)

        var rows: [[String: Any?]] = []
        let columnCount = sqlite3_column_count(statement)

        while true {
            let stepRc = sqlite3_step(statement)
            if stepRc == SQLITE_ROW {
                var row: [String: Any?] = [:]
                for i in 0..<columnCount {
                    let colName = String(cString: sqlite3_column_name(statement, i))
                    let colType = sqlite3_column_type(statement, i)
                    switch colType {
                    case SQLITE_INTEGER:
                        row[colName] = sqlite3_column_int64(statement, i)
                    case SQLITE_FLOAT:
                        row[colName] = sqlite3_column_double(statement, i)
                    case SQLITE_TEXT:
                        if let textPtr = sqlite3_column_text(statement, i) {
                            row[colName] = String(cString: textPtr)
                        } else {
                            row[colName] = ""
                        }
                    case SQLITE_BLOB:
                        if let blobPtr = sqlite3_column_blob(statement, i) {
                            let bytes = sqlite3_column_bytes(statement, i)
                            row[colName] = Data(bytes: blobPtr, count: Int(bytes))
                        } else {
                            row[colName] = Data()
                        }
                    case SQLITE_NULL:
                        row[colName] = nil
                    default:
                        row[colName] = nil
                    }
                }
                rows.append(row)
            } else if stepRc == SQLITE_DONE {
                break
            } else {
                let errMsg = String(cString: sqlite3_errmsg(db))
                throw SqliteError.stepError(rc: stepRc, message: errMsg, sql: sql)
            }
        }

        return rows
    }

    public func close() {
        lock.lock()
        defer { lock.unlock() }

        if let db = db {
            sqlite3_close_v2(db)
            self.db = nil
        }
    }

    private func bindParams(_ stmt: OpaquePointer, params: [Any?]) throws {
        for (idx, value) in params.enumerated() {
            let colIndex = Int32(idx + 1)
            let rc: Int32
            switch value {
            case nil:
                rc = sqlite3_bind_null(stmt, colIndex)
            case let str as String:
                rc = sqlite3_bind_text(stmt, colIndex, str, -1, SQLITE_TRANSIENT)
            case let num as Int:
                rc = sqlite3_bind_int64(stmt, colIndex, Int64(num))
            case let num as Int64:
                rc = sqlite3_bind_int64(stmt, colIndex, num)
            case let d as Double:
                rc = sqlite3_bind_double(stmt, colIndex, d)
            case let f as Float:
                rc = sqlite3_bind_double(stmt, colIndex, Double(f))
            case let b as Bool:
                rc = sqlite3_bind_int(stmt, colIndex, b ? 1 : 0)
            case let data as Data:
                rc = data.withUnsafeBytes {
                    sqlite3_bind_blob(stmt, colIndex, $0.baseAddress, Int32(data.count), SQLITE_TRANSIENT)
                }
            default:
                rc = sqlite3_bind_text(stmt, colIndex, String(describing: value!), -1, SQLITE_TRANSIENT)
            }
            if rc != SQLITE_OK {
                let errMsg = String(cString: sqlite3_errmsg(self.db))
                throw SqliteError.bindError(rc: rc, message: errMsg, parameterIndex: colIndex)
            }
        }
    }

    public enum SqliteError: Error, LocalizedError {
        case openFailed(rc: Int32, message: String)
        case statementError(rc: Int32, message: String, sql: String)
        case stepError(rc: Int32, message: String, sql: String)
        case bindError(rc: Int32, message: String, parameterIndex: Int32)
        case databaseClosed

        public var errorDescription: String? {
            switch self {
            case .openFailed(let rc, let msg):
                return "SQLite open failed (rc \(rc)): \(msg)"
            case .statementError(let rc, let msg, let sql):
                return "SQLite prepare statement failed (rc \(rc)): \(msg) for SQL: \(sql)"
            case .stepError(let rc, let msg, let sql):
                return "SQLite step failed (rc \(rc)): \(msg) for SQL: \(sql)"
            case .bindError(let rc, let msg, let idx):
                return "SQLite bind param failed at index \(idx) (rc \(rc)): \(msg)"
            case .databaseClosed:
                return "SQLite database connection is closed"
            }
        }
    }
}
