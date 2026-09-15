package com.pronto.omnishell

import com.dokar.quickjs.QuickJs
import com.dokar.quickjs.binding.function
import com.pronto.omnishell.bridge.NetworkBridge
import com.pronto.omnishell.bridge.StorageBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
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
    private val initialScript: String = ""
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

    private fun bindCapabilities(qjs: QuickJs) {
        qjs.function("__emitUiAst") { args ->
            val astJson = args.firstOrNull() as? String ?: ""
            _uiAst.value = astJson
        }

        qjs.function("__nativeFetch") { args ->
            val url = args[0] as String
            val optionsJson = args.getOrNull(1) as? String
            networkBridge.nativeFetch(url, optionsJson)
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
    }

    private suspend fun injectPrelude(qjs: QuickJs) {
        val prelude = """
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
