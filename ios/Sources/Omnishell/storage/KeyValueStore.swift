import Foundation

public protocol KeyValueStore: AnyObject {
    func get(_ key: String) -> String?
    func set(_ key: String, value: String)
    func delete(_ key: String) -> Bool
    func clear()
    func keys() -> [String]
}
