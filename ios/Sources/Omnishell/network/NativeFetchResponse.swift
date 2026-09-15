import Foundation

public struct NativeFetchResponse: Codable {
    public let status: Int
    public let statusText: String
    public let headers: [String: String]
    public let body: String

    public init(status: Int, statusText: String, headers: [String: String] = [:], body: String = "") {
        self.status = status
        self.statusText = statusText
        self.headers = headers
        self.body = body
    }
}
