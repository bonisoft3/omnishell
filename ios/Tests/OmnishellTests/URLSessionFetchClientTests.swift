import Testing
import Foundation
@testable import Omnishell

@Suite("URLSessionFetchClient Tests")
struct URLSessionFetchClientTests {
    private let client = URLSessionFetchClient()

    @Test func forbiddenSchemesThrowSecurityError() {
        let forbidden = [
            "file:///etc/passwd",
            "ftp://ftp.example.com",
            "javascript:alert(1)",
            "content://contacts"
        ]

        for badUrl in forbidden {
            #expect(throws: URLSessionFetchClient.SecurityError.self) {
                _ = try client.fetch(url: badUrl, request: NativeFetchRequest())
            }
        }
    }

    @Test func nativeFetchRequestSerialization() throws {
        let req = NativeFetchRequest(
            method: "POST",
            headers: ["Authorization": "Token secret", "Content-Type": "application/json"],
            body: "{\"article\":{\"title\":\"Testing\"}}"
        )

        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(NativeFetchRequest.self, from: data)

        #expect(decoded.method == "POST")
        #expect(decoded.headers["Authorization"] == "Token secret")
        #expect(decoded.body == "{\"article\":{\"title\":\"Testing\"}}")
    }
}
