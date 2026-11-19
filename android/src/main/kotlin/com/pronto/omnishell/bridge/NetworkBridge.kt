package com.pronto.omnishell.bridge

import com.pronto.omnishell.network.NativeFetchRequest
import com.pronto.omnishell.network.OkHttpFetchClient
import com.pronto.omnishell.network.SseEventListener
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class NetworkBridge(
    private val client: OkHttpFetchClient = OkHttpFetchClient(),
    private val json: Json = Json { ignoreUnknownKeys = true }
) : AutoCloseable {
    private val activeStreams = ConcurrentHashMap<String, AutoCloseable>()

    fun nativeFetchAsync(
        url: String,
        optionsJson: String?,
        onResolve: (String) -> Unit,
        onReject: (String) -> Unit
    ) {
        val request = try {
            if (!optionsJson.isNullOrBlank()) {
                json.decodeFromString<NativeFetchRequest>(optionsJson)
            } else {
                NativeFetchRequest()
            }
        } catch (t: Throwable) {
            onReject("Invalid fetch options JSON: ${t.message}")
            return
        }

        client.fetchAsync(
            url = url,
            request = request,
            onSuccess = { response ->
                try {
                    onResolve(json.encodeToString(response))
                } catch (t: Throwable) {
                    onReject("Failed to serialize response: ${t.message}")
                }
            },
            onFailure = { err ->
                onReject(err.message ?: err.javaClass.simpleName)
            }
        )
    }

    fun nativeFetch(url: String, optionsJson: String?): String {
        val request = if (!optionsJson.isNullOrBlank()) {
            json.decodeFromString<NativeFetchRequest>(optionsJson)
        } else {
            NativeFetchRequest()
        }
        val response = client.fetch(url, request)
        return json.encodeToString(response)
    }

    fun nativeSseConnect(
        url: String,
        headersJson: String?,
        onEvent: (id: String?, type: String, data: String) -> Unit,
        onError: (String) -> Unit
    ): String {
        val headers = if (!headersJson.isNullOrBlank()) {
            json.decodeFromString<Map<String, String>>(headersJson)
        } else {
            emptyMap()
        }

        val streamId = UUID.randomUUID().toString()
        val closeable = client.connectSse(
            url = url,
            headers = headers,
            listener = object : SseEventListener {
                override fun onOpen() {}

                override fun onEvent(id: String?, type: String, data: String) {
                    onEvent(id, type, data)
                }

                override fun onError(throwable: Throwable) {
                    onError(throwable.message ?: throwable.javaClass.simpleName)
                }

                override fun onClosed() {
                    activeStreams.remove(streamId)
                }
            }
        )

        activeStreams[streamId] = closeable
        return streamId
    }

    fun nativeSseClose(streamId: String) {
        activeStreams.remove(streamId)?.close()
    }

    override fun close() {
        client.close()
        activeStreams.values.forEach { it.close() }
        activeStreams.clear()
    }
}
