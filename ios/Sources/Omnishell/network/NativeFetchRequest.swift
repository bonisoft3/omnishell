import Foundation

public struct NativeFetchRequest: Codable {
    public let method: String
    public let headers: [String: String]
    public let body: String?

    public init(method: String = "GET", headers: [String: String] = [:], body: String? = nil) {
        self.method = method
        self.headers = headers
        self.body = body
    }
}
