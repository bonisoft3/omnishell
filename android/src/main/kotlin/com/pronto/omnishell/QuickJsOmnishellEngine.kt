package com.pronto.omnishell

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import com.pronto.omnishell.bridge.AuthBridge
import com.pronto.omnishell.bridge.KeyValueSessionStore
import com.pronto.omnishell.bridge.NetworkBridge
import com.pronto.omnishell.bridge.PrintBridge
import com.pronto.omnishell.bridge.StorageBridge
import com.pronto.omnishell.security.ManifestVerifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.concurrent.Executors

class QuickJsOmnishellEngine(
    private val networkBridge: NetworkBridge,
    private val storageBridge: StorageBridge,
    private val initialScript: String = "",
    val authBridge: AuthBridge = AuthBridge(KeyValueSessionStore(storageBridge)),
    // The app's own origin, which every relative address the runtime asks for
    // resolves against; there is no app to default to.
    val origin: String,
    val printBridge: PrintBridge = PrintBridge(networkBridge = networkBridge, origin = origin)
) : OmnishellEngine {
    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "omnishell-quickjs").apply { isDaemon = true }
    }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val _uiAst = MutableStateFlow("")
    override val uiAst: StateFlow<String> = _uiAst.asStateFlow()

    private var quickJs: QuickJs? = null

    override fun start() {
        runBlocking(dispatcher) {
            val qjs = QuickJs.create(dispatcher)
            quickJs = qjs
            bindCapabilities(qjs)
            injectPrelude(qjs)
            if (initialScript.isNotBlank()) {
                qjs.evaluate<Any?>(initialScript)
            }
        }
    }

    override fun dispatchAction(action: String) {
        scope.launch {
            val qjs = quickJs ?: throw IllegalStateException("OmnishellEngine not started")
            val escapedAction = Json.encodeToString(action)
            qjs.evaluate<Any?>("__dispatchAction($escapedAction)")
        }
    }

    private fun resolveAsyncInJs(reqId: String, rawJson: String) {
        scope.launch {
            val escId = Json.encodeToString(reqId)
            val escJson = Json.encodeToString(rawJson)
            quickJs?.evaluate<Any?>("__onAsyncResolve($escId, $escJson)")
        }
    }

    private fun rejectAsyncInJs(reqId: String, errorMsg: String) {
        scope.launch {
            val escId = Json.encodeToString(reqId)
            val escErr = Json.encodeToString(errorMsg)
            quickJs?.evaluate<Any?>("__onAsyncReject($escId, $escErr)")
        }
    }

    private fun bindCapabilities(qjs: QuickJs) {
        qjs.function("__getOmnishellOrigin") {
            origin
        }

        qjs.function("__emitUiAst") { args ->
            val astJson = args.firstOrNull() as? String ?: ""
            _uiAst.value = astJson
        }

        qjs.function("__nativeFetch") { args ->
            val url = args[0] as String
            val optionsJson = args.getOrNull(1) as? String
            networkBridge.nativeFetch(url, optionsJson)
        }

        qjs.function("__nativeFetchAsync") { args ->
            val reqId = args[0] as String
            val url = args[1] as String
            val optionsJson = args.getOrNull(2) as? String
            networkBridge.nativeFetchAsync(
                url = url,
                optionsJson = optionsJson,
                onResolve = { rawJson -> resolveAsyncInJs(reqId, rawJson) },
                onReject = { errMsg -> rejectAsyncInJs(reqId, errMsg) }
            )
        }

        qjs.function("__nativeSleep") { args ->
            val reqId = args[0] as String
            val ms = ((args.getOrNull(1) as? Number)?.toLong() ?: 1L).coerceAtLeast(1L)
            scope.launch {
                delay(ms)
                resolveAsyncInJs(reqId, "{}")
            }
        }

        qjs.function("__nativeSseConnect") { args ->
            val url = args[0] as String
            val headersJson = args.getOrNull(1) as? String
            networkBridge.nativeSseConnect(
                url = url,
                headersJson = headersJson,
                onEvent = { id, type, data ->
                    scope.launch {
                        val escapedId = if (id != null) Json.encodeToString(id) else "null"
                        val escapedType = Json.encodeToString(type)
                        val escapedData = Json.encodeToString(data)
                        quickJs?.evaluate<Any?>("__onSseEvent($escapedType, $escapedData, $escapedId)")
                    }
                },
                onError = { errorMsg ->
                    scope.launch {
                        val escapedErr = Json.encodeToString(errorMsg)
                        quickJs?.evaluate<Any?>("__onSseError($escapedErr)")
                    }
                }
            )
        }

        qjs.function("__nativeSseClose") { args ->
            val streamId = args[0] as String
            networkBridge.nativeSseClose(streamId)
        }

        qjs.function("__nativeKvGet") { args ->
            val key = args[0] as String
            storageBridge.kvGet(key)
        }

        qjs.function("__nativeKvSet") { args ->
            val key = args[0] as String
            val value = args[1] as String
            storageBridge.kvSet(key, value)
        }

        qjs.function("__nativeKvDelete") { args ->
            val key = args[0] as String
            storageBridge.kvDelete(key)
        }

        qjs.function("__nativeKvClear") {
            storageBridge.kvClear()
        }

        qjs.function("__nativeKvKeys") {
            storageBridge.kvKeys()
        }

        qjs.function("__nativeSqlExec") { args ->
            val sql = args[0] as String
            val paramsJson = args.getOrNull(1) as? String
            storageBridge.sqlExec(sql, paramsJson)
        }

        qjs.function("__nativeSqlQuery") { args ->
            val sql = args[0] as String
            val paramsJson = args.getOrNull(1) as? String
            storageBridge.sqlQuery(sql, paramsJson)
        }

        qjs.function("__nativeAuthPasskeySignIn") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            authBridge.passkeySignIn(
                optionsJson = optsJson,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeAuthPasskeyRegister") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            authBridge.passkeyRegister(
                optionsJson = optsJson,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeAuthOidcStart") { args ->
            val reqId = args[0] as String
            val provider = args[1] as String
            val optsJson = args.getOrNull(2) as? String
            authBridge.oidcStart(
                provider = provider,
                optionsJson = optsJson,
                networkBridge = networkBridge,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeAuthRedeemTicket") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            authBridge.redeemTicket(
                optionsJson = optsJson,
                networkBridge = networkBridge,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeAuthPasskeyLogin") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            authBridge.passkeyLogin(
                optionsJson = optsJson,
                networkBridge = networkBridge,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeAuthLoadSession") {
            authBridge.loadSessionJson()
        }

        qjs.function("__nativeAuthSaveSession") { args ->
            val sessionJson = args[0] as String
            authBridge.saveSessionJson(sessionJson)
        }

        qjs.function("__nativeAuthClearSession") {
            authBridge.clearSession()
        }

        qjs.function("__nativeAuthDeleteAccount") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            authBridge.deleteAccount(
                optionsJson = optsJson,
                networkBridge = networkBridge,
                storageBridge = storageBridge,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativePrintSheet") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            printBridge.printSheet(
                optionsJson = optsJson,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeOpenCheckout") { args ->
            val reqId = args[0] as String
            val optsJson = args[1] as String
            printBridge.openCheckout(
                optionsJson = optsJson,
                onResolve = { res -> resolveAsyncInJs(reqId, res) },
                onReject = { err -> rejectAsyncInJs(reqId, err) }
            )
        }

        qjs.function("__nativeVerifyEd25519") { args ->
            val pubKeyB64 = args[0] as String
            val msg = args[1] as String
            val sigB64 = args[2] as String
            ManifestVerifier.verifyEd25519Base64(pubKeyB64, msg, sigB64)
        }

        qjs.function("__nativeVerifyEntryManifest") { args ->
            val html = args[0] as String
            val pubKeyB64 = args[1] as String
            ManifestVerifier.verifyEntryHtml(html, pubKeyB64)
        }
    }

    private suspend fun injectPrelude(qjs: QuickJs) {
        val prelude = """
            globalThis.__omnishellOrigin = __getOmnishellOrigin();
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
                appleSignIn: (options) => globalThis.__omnishellAuth.oidcStart("apple", {
                    origin: options.origin,
                    guestBearerToken: options.guestBearerToken
                }),
                redeemTicket: async (options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthRedeemTicket(reqId, JSON.stringify(options || {}));
                    });
                    return JSON.parse(raw);
                },
                passkeyLogin: async (options) => {
                    const raw = await globalThis.__makeAsyncPromise((reqId) => {
                        __nativeAuthPasskeyLogin(reqId, JSON.stringify(options || {}));
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
                    return new URL(raw, globalThis.__omnishellOrigin);
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
        """.trimIndent()
        qjs.evaluate<Any?>(prelude)
    }

    override fun close() {
        runBlocking(dispatcher) {
            networkBridge.close()
            storageBridge.close()
            quickJs?.close()
            quickJs = null
        }
        executor.shutdown()
    }
}
