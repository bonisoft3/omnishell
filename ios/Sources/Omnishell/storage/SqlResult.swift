import Foundation

public struct SqlExecResult: Codable {
    public let rowsAffected: Int64
    public let lastInsertRowId: Int64

    public init(rowsAffected: Int64, lastInsertRowId: Int64) {
        self.rowsAffected = rowsAffected
        self.lastInsertRowId = lastInsertRowId
    }
}
