import Foundation

public protocol SseEventListener: AnyObject {
    func onOpen()
    func onEvent(id: String?, type: String, data: String)
    func onClosed()
    func onError(_ error: Error)
}
