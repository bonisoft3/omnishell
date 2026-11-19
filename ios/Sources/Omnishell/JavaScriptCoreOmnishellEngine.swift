import Foundation
import JavaScriptCore

public final class JavaScriptCoreOmnishellEngine: OmnishellEngine, @unchecked Sendable {
    private let networkBridge: NetworkBridge
    private let storageBridge: StorageBridge
    public let authBridge: AuthBridge
    public let printBridge: PrintBridge
    public let origin: String
    public var resourcesUrl: URL?
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
    public var onPatchChanged: ((String) -> Void)?
    public var onVariableChanged: ((String, Any) -> Void)?

    private var context: JSContext?

    public init(
        networkBridge: NetworkBridge,
        storageBridge: StorageBridge,
        initialScript: String = "",
        authBridge: AuthBridge? = nil,
        origin: String = "https://snapcards.fun",
        printBridge: PrintBridge? = nil,
        resourcesUrl: URL? = nil
    ) {
        self.networkBridge = networkBridge
        self.storageBridge = storageBridge
        self.authBridge = authBridge ?? AuthBridge(sessionStore: KeyValueSessionStore(storageBridge: storageBridge))
        self.origin = origin
        self.printBridge = printBridge ?? PrintBridge(networkBridge: networkBridge, origin: origin)
        self.initialScript = initialScript
        self.resourcesUrl = resourcesUrl
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
        ctx.setObject(origin as NSString, forKeyedSubscript: "__omnishellOrigin" as NSString)

        let emitUiAstBlock: @convention(block) (String) -> Void = { [weak self] ast in
            guard let self = self else { return }
            self.lock.lock()
            self._uiAst = ast
            let callback = self.onAstChanged
            self.lock.unlock()
            callback?(ast)
        }
        ctx.setObject(emitUiAstBlock, forKeyedSubscript: "__emitUiAst" as NSString)

        let emitDivPatchBlock: @convention(block) (String) -> Void = { [weak self] patchJson in
            guard let self = self else { return }
            self.lock.lock()
            let callback = self.onPatchChanged
            self.lock.unlock()
            callback?(patchJson)
        }
        ctx.setObject(emitDivPatchBlock, forKeyedSubscript: "__emitDivPatch" as NSString)

        let emitDivVarUpdateBlock: @convention(block) (String, JSValue) -> Void = { [weak self] name, val in
            guard let self = self else { return }
            let swiftVal: Any
            if val.isBoolean {
                swiftVal = val.toBool()
            } else if val.isNumber, let num = val.toNumber() {
                swiftVal = num
            } else {
                swiftVal = val.toString() ?? ""
            }
            self.lock.lock()
            let callback = self.onVariableChanged
            self.lock.unlock()
            callback?(name, swiftVal)
        }
        ctx.setObject(emitDivVarUpdateBlock, forKeyedSubscript: "__emitDivVariableUpdate" as NSString)

        let readBundledScreenBlock: @convention(block) (String) -> JSValue? = { [weak self] screenName in
            guard let self = self, let ctx = self.context else { return nil }
            let cleanName = (screenName as NSString).lastPathComponent
            guard let base = self.resourcesUrl else {
                ctx.exception = JSValue(newErrorFromMessage: "Missing resourcesUrl on JavaScriptCoreOmnishellEngine", in: ctx)
                return nil
            }
            let fileUrl = base.appendingPathComponent("screens").appendingPathComponent("\(cleanName).divkit.json")
            do {
                let text = try String(contentsOf: fileUrl, encoding: .utf8)
                return JSValue(object: text, in: ctx)
            } catch {
                ctx.exception = JSValue(newErrorFromMessage: "Failed to read \(fileUrl.path): \(error.localizedDescription)", in: ctx)
                return nil
            }
        }
        ctx.setObject(readBundledScreenBlock, forKeyedSubscript: "__readBundledScreenDivKit" as NSString)

        // Asynchronous non-blocking fetch resolving on the serial JSContext queue.
        let nativeFetchAsyncBlock: @convention(block) (String, String, JSValue?) -> Void = { [weak self] reqId, url, optionsVal in
            guard let self = self else { return }
            let optStr = (optionsVal?.isUndefined == false && optionsVal?.isNull == false) ? optionsVal?.toString() : nil
            self.networkBridge.nativeFetchAsync(
                url: url,
                optionsJson: optStr,
                onResolve: { [weak self] rawJson in
                    guard let self = self else { return }
                    self.queue.async {
                        guard let ctx = self.context else { return }
                        ctx.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, rawJson])
                    }
                },
                onReject: { [weak self] errMsg in
                    guard let self = self else { return }
                    self.queue.async {
                        guard let ctx = self.context else { return }
                        ctx.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, errMsg])
                    }
                }
            )
        }
        ctx.setObject(nativeFetchAsyncBlock, forKeyedSubscript: "__nativeFetchAsync" as NSString)

        let nativeSleepBlock: @convention(block) (String, Int) -> Void = { [weak self] reqId, ms in
            guard let self = self else { return }
            let clamped = max(1, ms)
            self.queue.asyncAfter(deadline: .now() + .milliseconds(clamped)) { [weak self] in
                guard let self = self, let ctx = self.context else { return }
                ctx.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, "{}"])
            }
        }
        ctx.setObject(nativeSleepBlock, forKeyedSubscript: "__nativeSleep" as NSString)

        let nativeSseConnectBlock: @convention(block) (String, JSValue?) -> String = { [weak self] url, headersVal in
            guard let self = self else { return "" }
            let headStr = (headersVal?.isUndefined == false && headersVal?.isNull == false) ? headersVal?.toString() : nil
            return self.networkBridge.nativeSseConnect(
                url: url,
                headersJson: headStr,
                onEvent: { [weak self] id, type, data in
                    guard let self = self else { return }
                    self.queue.async {
                        guard let ctx = self.context else { return }
                        let argId: Any = id != nil ? (id! as NSString) : NSNull()
                        ctx.globalObject.invokeMethod("__onSseEvent", withArguments: [type, data, argId])
                    }
                },
                onError: { [weak self] errorMsg in
                    guard let self = self else { return }
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

        // AuthBridge bindings
        let authPasskeySignInBlock: @convention(block) (String, String) -> Void = { [weak self] reqId, optsJson in
            guard let self = self else { return }
            self.authBridge.passkeySignIn(
                optionsJson: optsJson,
                onResolve: { [weak self] json in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, json])
                    }
                },
                onReject: { [weak self] err in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, err])
                    }
                }
            )
        }
        ctx.setObject(authPasskeySignInBlock, forKeyedSubscript: "__nativeAuthPasskeySignIn" as NSString)

        let authPasskeyRegisterBlock: @convention(block) (String, String) -> Void = { [weak self] reqId, optsJson in
            guard let self = self else { return }
            self.authBridge.passkeyRegister(
                optionsJson: optsJson,
                onResolve: { [weak self] json in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, json])
                    }
                },
                onReject: { [weak self] err in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, err])
                    }
                }
            )
        }
        ctx.setObject(authPasskeyRegisterBlock, forKeyedSubscript: "__nativeAuthPasskeyRegister" as NSString)

        let authOidcStartBlock: @convention(block) (String, String, JSValue?) -> Void = { [weak self] reqId, provider, optsVal in
            guard let self = self else { return }
            let optStr = (optsVal?.isUndefined == false && optsVal?.isNull == false) ? optsVal?.toString() : nil
            self.authBridge.oidcStart(
                provider: provider,
                optionsJson: optStr,
                onResolve: { [weak self] json in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, json])
                    }
                },
                onReject: { [weak self] err in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, err])
                    }
                }
            )
        }
        ctx.setObject(authOidcStartBlock, forKeyedSubscript: "__nativeAuthOidcStart" as NSString)

        let authLoadSessionBlock: @convention(block) () -> JSValue? = { [weak self] in
            guard let self = self, let json = self.authBridge.loadSessionJson() else {
                return nil
            }
            return JSValue(object: json, in: self.context)
        }
        ctx.setObject(authLoadSessionBlock, forKeyedSubscript: "__nativeAuthLoadSession" as NSString)

        let authSaveSessionBlock: @convention(block) (String) -> Void = { [weak self] sessionJson in
            guard let self = self else { return }
            do {
                try self.authBridge.saveSessionJson(sessionJson)
            } catch {
                if let ctx = self.context {
                    ctx.exception = JSValue(newErrorFromMessage: error.localizedDescription, in: ctx)
                }
            }
        }
        ctx.setObject(authSaveSessionBlock, forKeyedSubscript: "__nativeAuthSaveSession" as NSString)

        let authClearSessionBlock: @convention(block) () -> Void = { [weak self] in
            self?.authBridge.clearSession()
        }
        ctx.setObject(authClearSessionBlock, forKeyedSubscript: "__nativeAuthClearSession" as NSString)

        let authAppleSignInBlock: @convention(block) (String, String) -> Void = { [weak self] reqId, optsJson in
            guard let self = self else { return }
            self.authBridge.signInWithApple(
                optionsJson: optsJson,
                onResolve: { [weak self] resJson in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, resJson])
                    }
                },
                onReject: { [weak self] errMsg in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, errMsg])
                    }
                }
            )
        }
        ctx.setObject(authAppleSignInBlock, forKeyedSubscript: "__nativeAuthAppleSignIn" as NSString)

        let authDeleteAccountBlock: @convention(block) (String, String) -> Void = { [weak self] reqId, optsJson in
            guard let self = self else { return }
            self.authBridge.deleteAccount(
                optionsJson: optsJson,
                networkBridge: self.networkBridge,
                storageBridge: self.storageBridge,
                onResolve: { [weak self] resJson in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, resJson])
                    }
                },
                onReject: { [weak self] errMsg in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, errMsg])
                    }
                }
            )
        }
        ctx.setObject(authDeleteAccountBlock, forKeyedSubscript: "__nativeAuthDeleteAccount" as NSString)

        let printSheetBlock: @convention(block) (String, String) -> Void = { [weak self] reqId, optsJson in
            guard let self = self else { return }
            self.printBridge.printSheet(
                optionsJson: optsJson,
                onResolve: { [weak self] resJson in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, resJson])
                    }
                },
                onReject: { [weak self] errMsg in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, errMsg])
                    }
                }
            )
        }
        ctx.setObject(printSheetBlock, forKeyedSubscript: "__nativePrintSheet" as NSString)

        let openCheckoutBlock: @convention(block) (String, String) -> Void = { [weak self] reqId, optsJson in
            guard let self = self else { return }
            self.printBridge.openCheckout(
                optionsJson: optsJson,
                onResolve: { [weak self] resJson in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncResolve", withArguments: [reqId, resJson])
                    }
                },
                onReject: { [weak self] errMsg in
                    guard let self = self else { return }
                    self.queue.async {
                        self.context?.globalObject.invokeMethod("__onAsyncReject", withArguments: [reqId, errMsg])
                    }
                }
            )
        }
        ctx.setObject(openCheckoutBlock, forKeyedSubscript: "__nativeOpenCheckout" as NSString)

        let verifyEd25519Block: @convention(block) (String, String, String) -> Bool = { pubKeyB64, message, sigB64 in
            return ManifestVerifier.verifyEd25519Base64(
                publicKeyBase64: pubKeyB64,
                messageUtf8: message,
                signatureBase64: sigB64
            )
        }
        ctx.setObject(verifyEd25519Block, forKeyedSubscript: "__nativeVerifyEd25519" as NSString)

        let verifyEntryHtmlBlock: @convention(block) (String, String) -> JSValue? = { [weak self] html, pubKeyB64 in
            guard let self = self, let ctx = self.context else { return nil }
            do {
                let manifestJson = try ManifestVerifier.verifyEntryHtml(entryHtml: html, publicKeyBase64: pubKeyB64)
                return JSValue(object: manifestJson, in: ctx)
            } catch {
                ctx.exception = JSValue(newErrorFromMessage: error.localizedDescription, in: ctx)
                return nil
            }
        }
        ctx.setObject(verifyEntryHtmlBlock, forKeyedSubscript: "__nativeVerifyEntryManifest" as NSString)
    }

    private func injectPrelude(_ ctx: JSContext) {
        let prelude = #"""
            globalThis.__sseListeners = [];
            globalThis.__actionHandlers = [];
            globalThis.__pendingAsync = new Map();
            globalThis.__nextAsyncId = 0;

            globalThis.__makeAsyncPromise = function(starter) {
                const reqId = "req_" + (++globalThis.__nextAsyncId);
                return new Promise(function(resolve, reject) {
                    globalThis.__pendingAsync.set(reqId, { resolve: resolve, reject: reject });
                    starter(reqId);
                });
            };

            globalThis.__onAsyncResolve = function(reqId, rawJson) {
                const entry = globalThis.__pendingAsync.get(reqId);
                if (!entry) return;
                globalThis.__pendingAsync.delete(reqId);
                entry.resolve(rawJson);
            };

            globalThis.__onAsyncReject = function(reqId, errMsg) {
                const entry = globalThis.__pendingAsync.get(reqId);
                if (!entry) return;
                globalThis.__pendingAsync.delete(reqId);
                entry.reject(new TypeError(errMsg || "Native async error"));
            };

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

            if (typeof globalThis.setTimeout === "undefined" && typeof __nativeSleep === "function") {
                globalThis.__timers = new Set();
                globalThis.__nextTimerId = 0;
                globalThis.setTimeout = function(fn, delayMs) {
                    const id = ++globalThis.__nextTimerId;
                    globalThis.__timers.add(id);
                    const ms = Math.max(1, Number(delayMs) || 1);
                    globalThis.__makeAsyncPromise((reqId) => __nativeSleep(reqId, ms)).then(() => {
                        if (!globalThis.__timers.has(id)) return;
                        globalThis.__timers.delete(id);
                        if (typeof fn === "function") fn();
                    });
                    return id;
                };
                globalThis.clearTimeout = function(id) {
                    globalThis.__timers.delete(id);
                };
            }

            if (typeof globalThis.URL === "undefined") {
                globalThis.URL = class URL {
                    constructor(input, base) {
                        const raw = String(input);
                        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
                            const m = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
                            if (!m) throw new TypeError("Invalid URL: " + raw);
                            this.protocol = m[1].toLowerCase();
                            this.host = m[2];
                            this.origin = this.protocol + "//" + this.host;
                            this.pathname = m[3] || "/";
                            this.search = m[4] || "";
                            this.hash = m[5] || "";
                            this.href = this.origin + this.pathname + this.search + this.hash;
                        } else if (base) {
                            const b = base instanceof URL ? base : new URL(base);
                            const qIdx = raw.indexOf("?");
                            const hIdx = raw.indexOf("#");
                            const pathEnd = qIdx !== -1 ? qIdx : (hIdx !== -1 ? hIdx : raw.length);
                            const relPath = raw.slice(0, pathEnd);
                            this.protocol = b.protocol;
                            this.host = b.host;
                            this.origin = b.origin;
                            if (relPath.startsWith("/")) {
                                this.pathname = relPath;
                            } else if (relPath === "") {
                                this.pathname = b.pathname;
                            } else {
                                const baseDir = b.pathname.slice(0, b.pathname.lastIndexOf("/") + 1);
                                this.pathname = baseDir + relPath;
                            }
                            this.search = qIdx !== -1 ? raw.slice(qIdx, hIdx !== -1 ? hIdx : raw.length) : "";
                            this.hash = hIdx !== -1 ? raw.slice(hIdx) : "";
                            this.href = this.origin + this.pathname + this.search + this.hash;
                        } else {
                            throw new TypeError("Invalid URL: " + raw);
                        }
                    }
                    toString() { return this.href; }
                };
            }

            if (typeof globalThis.Headers === "undefined") {
                globalThis.Headers = class Headers {
                    constructor(init) {
                        this._map = new Map();
                        if (init instanceof Headers) {
                            init.forEach((v, k) => this.set(k, v));
                        } else if (init && typeof init === "object") {
                            for (const [k, v] of Object.entries(init)) {
                                this.set(k, v);
                            }
                        }
                    }
                    get(name) {
                        const v = this._map.get(String(name).toLowerCase());
                        return v === undefined ? null : v;
                    }
                    set(name, value) {
                        this._map.set(String(name).toLowerCase(), String(value));
                    }
                    has(name) {
                        return this._map.has(String(name).toLowerCase());
                    }
                    delete(name) {
                        this._map.delete(String(name).toLowerCase());
                    }
                    forEach(cb) {
                        for (const [k, v] of this._map.entries()) cb(v, k, this);
                    }
                    toObject() {
                        const out = {};
                        for (const [k, v] of this._map.entries()) out[k] = v;
                        return out;
                    }
                };
            }

            if (typeof globalThis.Request === "undefined") {
                globalThis.Request = class Request {
                    constructor(input, init) {
                        if (input && typeof input === "object" && typeof input.url === "string") {
                            this.url = input.url;
                            this.method = (init && init.method) || input.method || "GET";
                            this.mode = (init && init.mode) || input.mode || "cors";
                            this.cache = (init && init.cache) || input.cache || "default";
                            this.headers = new Headers((init && init.headers) || input.headers);
                            this.body = (init && init.body !== undefined) ? init.body : (input.body || null);
                        } else {
                            this.url = String(input);
                            this.method = (init && init.method ? String(init.method) : "GET").toUpperCase();
                            this.mode = (init && init.mode) || "cors";
                            this.cache = (init && init.cache) || "default";
                            this.headers = new Headers(init && init.headers);
                            this.body = (init && init.body !== undefined) ? String(init.body) : null;
                        }
                    }
                    clone() { return new Request(this); }
                };
            }

            if (typeof globalThis.Response === "undefined") {
                globalThis.Response = class Response {
                    constructor(body, init) {
                        this._body = body === undefined || body === null ? "" : String(body);
                        this.status = (init && init.status !== undefined) ? Number(init.status) : 200;
                        this.statusText = (init && init.statusText !== undefined) ? String(init.statusText) : "OK";
                        this.ok = this.status >= 200 && this.status < 300;
                        this.headers = new Headers(init && init.headers);
                    }
                    async text() { return this._body; }
                    async json() { return JSON.parse(this._body); }
                    clone() {
                        return new Response(this._body, {
                            status: this.status,
                            statusText: this.statusText,
                            headers: this.headers
                        });
                    }
                };
            }

            globalThis.fetch = async function(input, options) {
                const req = input instanceof Request ? input : new Request(input, options);
                const hdrObj = {};
                if (req.headers && req.headers.forEach) {
                    req.headers.forEach((v, k) => { hdrObj[k] = v; });
                } else if (options && options.headers) {
                    Object.assign(hdrObj, options.headers);
                }
                const payload = {
                    method: (options && options.method) || req.method || "GET",
                    headers: hdrObj,
                    body: (options && options.body !== undefined) ? options.body : (req.body || undefined)
                };
                const raw = await globalThis.__makeAsyncPromise((reqId) => {
                    __nativeFetchAsync(reqId, req.url, JSON.stringify(payload));
                });
                const res = JSON.parse(raw);
                return new Response(res.body, {
                    status: res.status,
                    statusText: res.statusText,
                    headers: res.headers || {}
                });
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

            globalThis.__omnishellAuth = {
                passkeySignIn: async (options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthPasskeySignIn(reqId, JSON.stringify(options || {}));
                    });
                    return JSON.parse(raw);
                },
                passkeyRegister: async (options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthPasskeyRegister(reqId, JSON.stringify(options || {}));
                    });
                    return JSON.parse(raw);
                },
                oidcStart: async (provider, options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthOidcStart(reqId, String(provider || ""), options ? JSON.stringify(options) : null);
                    });
                    return JSON.parse(raw);
                },
                loadSession: () => {
                    const raw = __nativeAuthLoadSession();
                    return raw ? JSON.parse(raw) : null;
                },
                saveSession: (session) => {
                    __nativeAuthSaveSession(typeof session === "string" ? session : JSON.stringify(session));
                },
                clearSession: () => {
                    __nativeAuthClearSession();
                },
                appleSignIn: async (options) => {
                    const payload = Object.assign({ origin: globalThis.__omnishellOrigin }, options || {});
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthAppleSignIn(reqId, JSON.stringify(payload));
                    });
                    return JSON.parse(raw);
                },
                deleteAccount: async (options) => {
                    const payload = Object.assign({ origin: globalThis.__omnishellOrigin }, options || {});
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthDeleteAccount(reqId, JSON.stringify(payload));
                    });
                    return JSON.parse(raw);
                }
            };
            globalThis.AuthBridge = globalThis.__omnishellAuth;

            globalThis.__omnishellPrint = {
                printSheet: async (options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativePrintSheet(reqId, JSON.stringify(options || {}));
                    });
                    return JSON.parse(raw);
                },
                openCheckout: async (options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeOpenCheckout(reqId, JSON.stringify(options || {}));
                    });
                    return JSON.parse(raw);
                }
            };
            globalThis.PrintBridge = globalThis.__omnishellPrint;

            globalThis.__verifyManifestEd25519 = function(publicKeyBase64, messageUtf8, signatureBase64) {
                return Boolean(__nativeVerifyEd25519(String(publicKeyBase64), String(messageUtf8), String(signatureBase64)));
            };
            globalThis.__verifyEntryManifestEd25519 = function(entryHtml, publicKeyBase64) {
                return JSON.parse(__nativeVerifyEntryManifest(String(entryHtml), String(publicKeyBase64)));
            };

            (function initDiskCacheStorage() {
                const sql = globalThis.__omnishellStorage.sql;
                sql.exec("CREATE TABLE IF NOT EXISTS omnishell_cache_names (cache_name TEXT PRIMARY KEY);");
                sql.exec("CREATE TABLE IF NOT EXISTS omnishell_http_cache (cache_name TEXT NOT NULL, url TEXT NOT NULL, pathname TEXT NOT NULL, status INTEGER NOT NULL, status_text TEXT NOT NULL, headers_json TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (cache_name, url));");

                function normUrl(reqOrStr) {
                    const raw = typeof reqOrStr === "string" ? reqOrStr : reqOrStr.url;
                    return new URL(raw, globalThis.__omnishellOrigin || "https://snapcards.fun");
                }

                function openCacheSync(cacheName) {
                    sql.exec("INSERT OR IGNORE INTO omnishell_cache_names (cache_name) VALUES (?);", [cacheName]);
                    return {
                        async match(req, opts) {
                            const u = normUrl(req);
                            const rows = (opts && opts.ignoreSearch)
                                ? sql.query("SELECT status, status_text, headers_json, body FROM omnishell_http_cache WHERE cache_name = ? AND pathname = ? LIMIT 1;", [cacheName, u.pathname])
                                : sql.query("SELECT status, status_text, headers_json, body FROM omnishell_http_cache WHERE cache_name = ? AND url = ? LIMIT 1;", [cacheName, u.href]);
                            if (!rows || rows.length === 0) return undefined;
                            const r = rows[0];
                            return new Response(r.body, {
                                status: Number(r.status),
                                statusText: String(r.status_text || ""),
                                headers: JSON.parse(r.headers_json || "{}")
                            });
                        },
                        async put(req, response) {
                            const u = normUrl(req);
                            const body = await response.clone().text();
                            const hdrs = {};
                            if (response.headers && response.headers.forEach) {
                                response.headers.forEach((v, k) => { hdrs[k] = v; });
                            }
                            sql.exec("INSERT OR IGNORE INTO omnishell_cache_names (cache_name) VALUES (?);", [cacheName]);
                            sql.exec("INSERT OR REPLACE INTO omnishell_http_cache (cache_name, url, pathname, status, status_text, headers_json, body) VALUES (?, ?, ?, ?, ?, ?, ?);", [
                                cacheName, u.href, u.pathname, response.status, response.statusText || "", JSON.stringify(hdrs), body
                            ]);
                        },
                        async delete(req, opts) {
                            const u = normUrl(req);
                            const existing = (opts && opts.ignoreSearch)
                                ? sql.query("SELECT url FROM omnishell_http_cache WHERE cache_name = ? AND pathname = ? LIMIT 1;", [cacheName, u.pathname])
                                : sql.query("SELECT url FROM omnishell_http_cache WHERE cache_name = ? AND url = ? LIMIT 1;", [cacheName, u.href]);
                            if (!existing || existing.length === 0) return false;
                            if (opts && opts.ignoreSearch) {
                                sql.exec("DELETE FROM omnishell_http_cache WHERE cache_name = ? AND pathname = ?;", [cacheName, u.pathname]);
                            } else {
                                sql.exec("DELETE FROM omnishell_http_cache WHERE cache_name = ? AND url = ?;", [cacheName, u.href]);
                            }
                            return true;
                        },
                        async keys() {
                            const rows = sql.query("SELECT url FROM omnishell_http_cache WHERE cache_name = ? ORDER BY url ASC;", [cacheName]);
                            return (rows || []).map(r => new Request(r.url));
                        }
                    };
                }

                globalThis.caches = {
                    async open(name) { return openCacheSync(String(name)); },
                    async keys() {
                        const rows = sql.query("SELECT cache_name FROM omnishell_cache_names UNION SELECT DISTINCT cache_name FROM omnishell_http_cache ORDER BY cache_name ASC;");
                        return (rows || []).map(r => String(r.cache_name));
                    },
                    async delete(name) {
                        const cname = String(name);
                        const existing = sql.query("SELECT cache_name FROM omnishell_cache_names WHERE cache_name = ? UNION SELECT cache_name FROM omnishell_http_cache WHERE cache_name = ? LIMIT 1;", [cname, cname]);
                        sql.exec("DELETE FROM omnishell_http_cache WHERE cache_name = ?;", [cname]);
                        sql.exec("DELETE FROM omnishell_cache_names WHERE cache_name = ?;", [cname]);
                        return Boolean(existing && existing.length > 0);
                    },
                    async match(req, opts) {
                        const names = await this.keys();
                        for (const n of names) {
                            const hit = await openCacheSync(n).match(req, opts);
                            if (hit) return hit;
                        }
                        return undefined;
                    }
                };
            })();
        """#
        ctx.evaluateScript(prelude)
    }

    public func close() {
        queue.sync {
            self.networkBridge.close()
            self.storageBridge.close()
            self.context = nil
        }
    }

    public func evaluateJs(_ script: String) -> JSValue? {
        var result: JSValue?
        queue.sync {
            result = self.context?.evaluateScript(script)
        }
        return result
    }
}
