import Foundation

public protocol OmnishellEngine: AnyObject {
    var uiAst: String { get }
    var onAstChanged: ((String) -> Void)? { get set }
    func start() throws
    func close()
    func dispatchAction(_ action: String)
}
