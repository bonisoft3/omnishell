import Foundation

public final class URLSessionFetchClient: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let session: URLSession
    private let lock = NSLock()
    private var sseTasks: [String: URLSessionDataTask] = [:]
    private var sseListeners: [String: SseEventListener] = [:]
    private var sseBuffers: [String: (buffer: String, currentEvent: String, currentData: String, currentId: String?)] = [:]

    public init(session: URLSession = .shared) {
        self.session = session
        super.init()
    }

    public func fetch(url urlString: String, request: NativeFetchRequest) throws -> NativeFetchResponse {
        try validateUrl(urlString)

        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = request.method
        urlRequest.timeoutInterval = 15.0

        for (headerKey, headerVal) in request.headers {
            urlRequest.setValue(headerVal, forHTTPHeaderField: headerKey)
        }

        let method = request.method.uppercased()
        if let body = request.body {
            if urlRequest.value(forHTTPHeaderField: "Content-Type") == nil {
                urlRequest.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            }
            urlRequest.httpBody = body.data(using: .utf8)
        } else if ["POST", "PUT", "PATCH"].contains(method) {
            urlRequest.httpBody = Data()
        }

        final class ResponseBox: @unchecked Sendable {
            var data: Data?
            var response: HTTPURLResponse?
            var error: Error?
        }
        let box = ResponseBox()

        let semaphore = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: urlRequest) { data, response, error in
            box.data = data
            box.response = response as? HTTPURLResponse
            box.error = error
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()

        if let error = box.error {
            throw error
        }

        guard let httpResponse = box.response else {
            throw URLError(.cannotParseResponse)
        }

        var responseHeaders: [String: String] = [:]
        for (key, val) in httpResponse.allHeaderFields {
            responseHeaders[String(describing: key)] = String(describing: val)
        }

        let bodyString = box.data.flatMap { String(data: $0, encoding: .utf8) } ?? ""

        return NativeFetchResponse(
            status: httpResponse.statusCode,
            statusText: HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode),
            headers: responseHeaders,
            body: bodyString
        )
    }

    public func connectSse(
        url urlString: String,
        headers: [String: String] = [:],
        listener: SseEventListener
    ) throws -> String {
        try validateUrl(urlString)

        guard let url = URL(string: urlString) else {
            throw URLError(.badURL)
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        urlRequest.setValue("no-cache", forHTTPHeaderField: "Cache-Control")

        for (k, v) in headers {
            urlRequest.setValue(v, forHTTPHeaderField: k)
        }

        let streamId = UUID().uuidString
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1

        let sseSession = URLSession(
            configuration: .default,
            delegate: SseTaskDelegate(streamId: streamId, client: self),
            delegateQueue: delegateQueue
        )

        let task = sseSession.dataTask(with: urlRequest)

        lock.lock()
        sseTasks[streamId] = task
        sseListeners[streamId] = listener
        sseBuffers[streamId] = (buffer: "", currentEvent: "message", currentData: "", currentId: nil)
        lock.unlock()

        task.resume()
        return streamId
    }

    public func closeSse(streamId: String) {
        lock.lock()
        let task = sseTasks.removeValue(forKey: streamId)
        let listener = sseListeners.removeValue(forKey: streamId)
        sseBuffers.removeValue(forKey: streamId)
        lock.unlock()

        task?.cancel()
        listener?.onClosed()
    }

    fileprivate func handleData(streamId: String, data: Data) {
        lock.lock()
        guard let listener = sseListeners[streamId],
              var state = sseBuffers[streamId],
              let text = String(data: data, encoding: .utf8) else {
            lock.unlock()
            return
        }

        state.buffer += text
        var lines = state.buffer.components(separatedBy: "\n")
        state.buffer = lines.removeLast()

        for rawLine in lines {
            let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty {
                if !state.currentData.isEmpty {
                    listener.onEvent(id: state.currentId, type: state.currentEvent, data: state.currentData)
                }
                state.currentEvent = "message"
                state.currentData = ""
                state.currentId = nil
            } else if line.hasPrefix("event:") {
                state.currentEvent = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let chunk = String(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
                state.currentData = state.currentData.isEmpty ? chunk : "\(state.currentData)\n\(chunk)"
            } else if line.hasPrefix("id:") {
                state.currentId = String(line.dropFirst(3).trimmingCharacters(in: .whitespaces))
            }
        }

        sseBuffers[streamId] = state
        lock.unlock()
    }

    fileprivate func handleOpen(streamId: String) {
        lock.lock()
        let listener = sseListeners[streamId]
        lock.unlock()
        listener?.onOpen()
    }

    fileprivate func handleError(streamId: String, error: Error) {
        lock.lock()
        let listener = sseListeners.removeValue(forKey: streamId)
        sseTasks.removeValue(forKey: streamId)
        sseBuffers.removeValue(forKey: streamId)
        lock.unlock()
        listener?.onError(error)
    }

    private func validateUrl(_ urlString: String) throws {
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              ["http", "https"].contains(scheme) else {
            throw SecurityError.forbiddenScheme(urlString)
        }
    }

    public enum SecurityError: Error, LocalizedError {
        case forbiddenScheme(String)

        public var errorDescription: String? {
            switch self {
            case .forbiddenScheme(let url):
                return "Forbidden URL scheme: '\(url)'. Only HTTP/HTTPS is permitted."
            }
        }
    }
}

private final class SseTaskDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let streamId: String
    private weak var client: URLSessionFetchClient?

    init(streamId: String, client: URLSessionFetchClient) {
        self.streamId = streamId
        self.client = client
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        client?.handleOpen(streamId: streamId)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        client?.handleData(streamId: streamId, data: data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error, (error as NSError).code != NSURLErrorCancelled {
            client?.handleError(streamId: streamId, error: error)
        }
    }
}
