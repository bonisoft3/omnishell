import Foundation

public final class NetworkBridge: @unchecked Sendable {
    private let client: URLSessionFetchClient
    private let jsonDecoder = JSONDecoder()
    private let jsonEncoder = JSONEncoder()

    public init(client: URLSessionFetchClient = URLSessionFetchClient()) {
        self.client = client
    }

    public func nativeFetchAsync(
        url: String,
        optionsJson: String?,
        onResolve: @escaping @Sendable (String) -> Void,
        onReject: @escaping @Sendable (String) -> Void
    ) {
        var request = NativeFetchRequest()
        if let jsonStr = optionsJson, !jsonStr.isEmpty {
            guard let data = jsonStr.data(using: .utf8) else {
                onReject("Invalid UTF-8 fetch options")
                return
            }
            do {
                request = try jsonDecoder.decode(NativeFetchRequest.self, from: data)
            } catch {
                onReject("Invalid fetch options JSON: \(error.localizedDescription)")
                return
            }
        }

        client.fetchAsync(url: url, request: request) { [jsonEncoder] result in
            switch result {
            case .success(let response):
                do {
                    let resData = try jsonEncoder.encode(response)
                    guard let resStr = String(data: resData, encoding: .utf8) else {
                        onReject("Failed to encode fetch response as UTF-8")
                        return
                    }
                    onResolve(resStr)
                } catch {
                    onReject("Failed to encode fetch response: \(error.localizedDescription)")
                }
            case .failure(let error):
                onReject(error.localizedDescription)
            }
        }
    }

    public func nativeFetch(url: String, optionsJson: String?) -> String {
        var request = NativeFetchRequest()
        if let jsonStr = optionsJson, let data = jsonStr.data(using: .utf8) {
            if let decoded = try? jsonDecoder.decode(NativeFetchRequest.self, from: data) {
                request = decoded
            }
        }
        do {
            let response = try client.fetch(url: url, request: request)
            let resData = try jsonEncoder.encode(response)
            return String(data: resData, encoding: .utf8) ?? "{}"
        } catch {
            let errResponse = NativeFetchResponse(
                status: 500,
                statusText: "Network Error: \(error.localizedDescription)",
                headers: [:],
                body: error.localizedDescription
            )
            let errData = (try? jsonEncoder.encode(errResponse)) ?? Data()
            return String(data: errData, encoding: .utf8) ?? "{}"
        }
    }

    public func nativeSseConnect(
        url: String,
        headersJson: String?,
        onEvent: @escaping (String?, String, String) -> Void,
        onError: @escaping (String) -> Void
    ) -> String {
        var headers: [String: String] = [:]
        if let jsonStr = headersJson, let data = jsonStr.data(using: .utf8) {
            headers = (try? JSONSerialization.jsonObject(with: data) as? [String: String]) ?? [:]
        }

        let listener = ClosureSseEventListener(
            onOpen: {},
            onEvent: onEvent,
            onClosed: {},
            onError: { err in onError(err.localizedDescription) }
        )

        do {
            return try client.connectSse(url: url, headers: headers, listener: listener)
        } catch {
            onError(error.localizedDescription)
            return ""
        }
    }

    public func nativeSseClose(streamId: String) {
        client.closeSse(streamId: streamId)
    }

    public func close() {
        client.close()
    }
}

private class ClosureSseEventListener: SseEventListener {
    private let _onOpen: () -> Void
    private let _onEvent: (String?, String, String) -> Void
    private let _onClosed: () -> Void
    private let _onError: (Error) -> Void

    init(
        onOpen: @escaping () -> Void,
        onEvent: @escaping (String?, String, String) -> Void,
        onClosed: @escaping () -> Void,
        onError: @escaping (Error) -> Void
    ) {
        self._onOpen = onOpen
        self._onEvent = onEvent
        self._onClosed = onClosed
        self._onError = onError
    }

    func onOpen() { _onOpen() }
    func onEvent(id: String?, type: String, data: String) { _onEvent(id, type, data) }
    func onClosed() { _onClosed() }
    func onError(_ error: Error) { _onError(error) }
}
