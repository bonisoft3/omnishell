import Foundation
import JavaScriptCore

public final class JavaScriptCoreOmnishellEngine: OmnishellEngine, @unchecked Sendable {
    private let networkBridge: NetworkBridge
    private let storageBridge: StorageBridge
    private let initialScript: String
    private let queue = DispatchQueue(label: "com.pronto.omnishell.jsc", qos: .userInitiated)
    private let lock = NSLock()

    private var _uiAst: String = ""
    public var uiAst: String {
        lock.lock()
        defer { lock.unlock() }
        return _uiAst
    }

    public var onAstChanged: ((String) -> Void)?

    private var context: JSContext?

    public init(
        networkBridge: NetworkBridge,
        storageBridge: StorageBridge,
        initialScript: String = ""
    ) {
        self.networkBridge = networkBridge
        self.storageBridge = storageBridge
        self.initialScript = initialScript
    }

    public func start() throws {
        queue.sync {
            let ctx = JSContext() ?? JSContext(virtualMachine: JSVirtualMachine())!
            ctx.exceptionHandler = { _, exception in
                let desc = exception?.toString() ?? "unknown"
                fatalError("Unhandled JavaScriptCore exception: \(desc)")
            }
            self.context = ctx

            bindCapabilities(ctx)
            injectPrelude(ctx)

            if !initialScript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ctx.evaluateScript(initialScript)
            }
        }
    }

    public func dispatchAction(_ action: String) {
        queue.async { [weak self] in
            guard let self = self, let ctx = self.context else { return }
            ctx.globalObject.invokeMethod("__dispatchAction", withArguments: [action])
        }
    }

    private func bindCapabilities(_ ctx: JSContext) {
        let emitUiAstBlock: @convention(block) (String) -> Void = { [weak self] ast in
            guard let self = self else { return }
            self.lock.lock()
            self._uiAst = ast
            let callback = self.onAstChanged
            self.lock.unlock()
            callback?(ast)
        }
        ctx.setObject(emitUiAstBlock, forKeyedSubscript: "__emitUiAst" as NSString)

        let nativeFetchBlock: @convention(block) (String, JSValue?) -> String = { [weak self] url, optionsVal in
            guard let self = self else { return "{}" }
            let optStr = (optionsVal?.isUndefined == false && optionsVal?.isNull == false) ? optionsVal?.toString() : nil
            return self.networkBridge.nativeFetch(url: url, optionsJson: optStr)
        }
        ctx.setObject(nativeFetchBlock, forKeyedSubscript: "__nativeFetch" as NSString)

        let nativeSseConnectBlock: @convention(block) (String, JSValue?) -> String = { [weak self] url, headersVal in
            guard let self = self else { return "" }
            let headStr = (headersVal?.isUndefined == false && headersVal?.isNull == false) ? headersVal?.toString() : nil
            return self.networkBridge.nativeSseConnect(
                url: url,
                headersJson: headStr,
                onEvent: { id, type, data in
                    self.queue.async {
                        guard let ctx = self.context else { return }
                        let argId: Any = id != nil ? (id! as NSString) : NSNull()
                        ctx.globalObject.invokeMethod("__onSseEvent", withArguments: [type, data, argId])
                    }
                },
                onError: { errorMsg in
                    self.queue.async {
                        guard let ctx = self.context else { return }
                        ctx.globalObject.invokeMethod("__onSseError", withArguments: [errorMsg])
                    }
                }
            )
        }
        ctx.setObject(nativeSseConnectBlock, forKeyedSubscript: "__nativeSseConnect" as NSString)

        let nativeSseCloseBlock: @convention(block) (String) -> Void = { [weak self] streamId in
            self?.networkBridge.nativeSseClose(streamId: streamId)
        }
        ctx.setObject(nativeSseCloseBlock, forKeyedSubscript: "__nativeSseClose" as NSString)

        let nativeKvGetBlock: @convention(block) (String) -> JSValue? = { [weak self] key in
            guard let self = self, let val = self.storageBridge.kvGet(key: key) else {
                return nil
            }
            return JSValue(object: val, in: self.context)
        }
        ctx.setObject(nativeKvGetBlock, forKeyedSubscript: "__nativeKvGet" as NSString)

        let nativeKvSetBlock: @convention(block) (String, String) -> Void = { [weak self] key, val in
            self?.storageBridge.kvSet(key: key, value: val)
        }
        ctx.setObject(nativeKvSetBlock, forKeyedSubscript: "__nativeKvSet" as NSString)

        let nativeKvDeleteBlock: @convention(block) (String) -> Bool = { [weak self] key in
            self?.storageBridge.kvDelete(key: key) ?? false
        }
        ctx.setObject(nativeKvDeleteBlock, forKeyedSubscript: "__nativeKvDelete" as NSString)

        let nativeKvClearBlock: @convention(block) () -> Void = { [weak self] in
            self?.storageBridge.kvClear()
        }
        ctx.setObject(nativeKvClearBlock, forKeyedSubscript: "__nativeKvClear" as NSString)

        let nativeKvKeysBlock: @convention(block) () -> String = { [weak self] in
            self?.storageBridge.kvKeys() ?? "[]"
        }
        ctx.setObject(nativeKvKeysBlock, forKeyedSubscript: "__nativeKvKeys" as NSString)

        let nativeSqlExecBlock: @convention(block) (String, JSValue?) -> String = { [weak self] sql, paramsVal in
            guard let self = self else { return "{}" }
            let paramsStr = (paramsVal?.isUndefined == false && paramsVal?.isNull == false) ? paramsVal?.toString() : nil
            return self.storageBridge.sqlExec(sql: sql, paramsJson: paramsStr)
        }
        ctx.setObject(nativeSqlExecBlock, forKeyedSubscript: "__nativeSqlExec" as NSString)

        let nativeSqlQueryBlock: @convention(block) (String, JSValue?) -> String = { [weak self] sql, paramsVal in
            guard let self = self else { return "[]" }
            let paramsStr = (paramsVal?.isUndefined == false && paramsVal?.isNull == false) ? paramsVal?.toString() : nil
            return self.storageBridge.sqlQuery(sql: sql, paramsJson: paramsStr)
        }
        ctx.setObject(nativeSqlQueryBlock, forKeyedSubscript: "__nativeSqlQuery" as NSString)
    }

    private func injectPrelude(_ ctx: JSContext) {
        let prelude = """
            globalThis.__sseListeners = [];
            globalThis.__actionHandlers = [];

            globalThis.__onSseEvent = function(type, data, id) {
                for (const listener of globalThis.__sseListeners) {
                    if (listener.onEvent) listener.onEvent({ type, data, lastEventId: id });
                }
            };

            globalThis.__onSseError = function(errorMsg) {
                for (const listener of globalThis.__sseListeners) {
                    if (listener.onError) listener.onError(new Error(errorMsg));
                }
            };

            globalThis.__dispatchAction = function(action) {
                for (const handler of globalThis.__actionHandlers) {
                    handler(action);
                }
            };

            globalThis.onAction = function(handler) {
                globalThis.__actionHandlers.push(handler);
            };

            globalThis.emitUiAst = function(ast) {
                const json = typeof ast === 'string' ? ast : JSON.stringify(ast);
                __emitUiAst(json);
            };

            globalThis.fetch = async function(url, options) {
                const optionsJson = options ? JSON.stringify(options) : null;
                const raw = __nativeFetch(url, optionsJson);
                const res = JSON.parse(raw);
                return {
                    status: res.status,
                    statusText: res.statusText,
                    ok: res.status >= 200 && res.status < 300,
                    headers: {
                        get: (name) => {
                            const lower = name.toLowerCase();
                            for (const [k, v] of Object.entries(res.headers)) {
                                if (k.toLowerCase() === lower) return v;
                            }
                            return null;
                        }
                    },
                    text: async () => res.body,
                    json: async () => JSON.parse(res.body)
                };
            };

            globalThis.EventSource = class EventSource {
                constructor(url, dict) {
                    this.url = url;
                    this.readyState = 0;
                    this._listeners = new Map();
                    const streamId = __nativeSseConnect(url, dict ? JSON.stringify(dict) : null);
                    this._streamId = streamId;
                    this._listenerObj = {
                        onEvent: (e) => {
                            this.readyState = 1;
                            const handler = this['on' + e.type] || (e.type === 'message' ? this.onmessage : null);
                            if (handler) handler(e);
                            const list = this._listeners.get(e.type) || [];
                            for (const fn of list) fn(e);
                        },
                        onError: (err) => {
                            this.readyState = 2;
                            if (this.onerror) this.onerror(err);
                        }
                    };
                    globalThis.__sseListeners.push(this._listenerObj);
                }
                addEventListener(type, fn) {
                    if (!this._listeners.has(type)) this._listeners.set(type, []);
                    this._listeners.get(type).push(fn);
                }
                removeEventListener(type, fn) {
                    const list = this._listeners.get(type);
                    if (list) this._listeners.set(type, list.filter(cb => cb !== fn));
                }
                close() {
                    this.readyState = 2;
                    if (this._streamId) {
                        __nativeSseClose(this._streamId);
                        this._streamId = null;
                    }
                    const idx = globalThis.__sseListeners.indexOf(this._listenerObj);
                    if (idx !== -1) globalThis.__sseListeners.splice(idx, 1);
                }
            };

            globalThis.__omnishellStorage = {
                kv: {
                    get: (key) => __nativeKvGet(key),
                    set: (key, val) => __nativeKvSet(key, String(val)),
                    delete: (key) => Boolean(__nativeKvDelete(key)),
                    clear: () => __nativeKvClear(),
                    keys: () => JSON.parse(__nativeKvKeys())
                },
                sql: {
                    exec: (sql, params) => JSON.parse(__nativeSqlExec(sql, params ? JSON.stringify(params) : null)),
                    query: (sql, params) => JSON.parse(__nativeSqlQuery(sql, params ? JSON.stringify(params) : null))
                }
            };
        """
        ctx.evaluateScript(prelude)
    }

    public func close() {
        queue.sync {
            self.networkBridge.close()
            self.storageBridge.close()
            self.context = nil
        }
    }

    // Helper for testing JavaScript evaluation directly
    public func evaluateJs(_ script: String) -> JSValue? {
        var result: JSValue?
        queue.sync {
            result = self.context?.evaluateScript(script)
        }
        return result
    }
}
