import Foundation

public protocol SqlDatabase: AnyObject {
    func exec(_ sql: String, params: [Any?]) throws -> SqlExecResult
    func query(_ sql: String, params: [Any?]) throws -> [[String: Any?]]
    func close()
}

public extension SqlDatabase {
    func exec(_ sql: String) throws -> SqlExecResult {
        try exec(sql, params: [])
    }
    func query(_ sql: String) throws -> [[String: Any?]] {
        try query(sql, params: [])
    }
}
