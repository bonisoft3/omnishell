package com.pronto.omnishell.network

import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

open class OkHttpFetchClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // 0 for streaming SSE & Electric long-polls
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
) : AutoCloseable {
    private val activeCalls = ConcurrentHashMap<String, Call>()

    private fun buildHttpRequest(url: String, request: NativeFetchRequest): Request {
        validateUrl(url)

        val builder = Request.Builder().url(url)
        request.headers.forEach { (name, value) ->
            builder.addHeader(name, value)
        }

        val method = request.method.uppercase()
        val body = when {
            request.body != null -> {
                val mediaType = request.headers["Content-Type"]?.toMediaTypeOrNull()
                    ?: "application/json; charset=utf-8".toMediaTypeOrNull()
                request.body.toRequestBody(mediaType)
            }
            method in listOf("POST", "PUT", "PATCH") -> {
                ByteArray(0).toRequestBody(null)
            }
            else -> null
        }

        builder.method(method, body)
        return builder.build()
    }

    private fun toNativeResponse(response: Response): NativeFetchResponse {
        val headersMap = mutableMapOf<String, String>()
        response.headers.forEach { pair ->
            headersMap[pair.first] = pair.second
        }
        return NativeFetchResponse(
            status = response.code,
            statusText = response.message.ifEmpty { "OK" },
            headers = headersMap,
            body = response.body?.string().orEmpty()
        )
    }

    fun fetchAsync(
        url: String,
        request: NativeFetchRequest,
        onSuccess: (NativeFetchResponse) -> Unit,
        onFailure: (Throwable) -> Unit
    ) {
        val httpRequest = try {
            buildHttpRequest(url, request)
        } catch (t: Throwable) {
            onFailure(t)
            return
        }

        val callId = UUID.randomUUID().toString()
        val call = client.newCall(httpRequest)
        activeCalls[callId] = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                activeCalls.remove(callId)
                onFailure(e)
            }

            override fun onResponse(call: Call, response: Response) {
                activeCalls.remove(callId)
                try {
                    response.use { res ->
                        onSuccess(toNativeResponse(res))
                    }
                } catch (t: Throwable) {
                    onFailure(t)
                }
            }
        })
    }

    fun fetch(url: String, request: NativeFetchRequest): NativeFetchResponse {
        val httpRequest = buildHttpRequest(url, request)
        client.newCall(httpRequest).execute().use { response ->
            return toNativeResponse(response)
        }
    }

    fun connectSse(
        url: String,
        headers: Map<String, String> = emptyMap(),
        listener: SseEventListener
    ): AutoCloseable {
        validateUrl(url)

        val builder = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .header("Cache-Control", "no-cache")

        headers.forEach { (name, value) ->
            builder.addHeader(name, value)
        }

        val request = builder.build()
        val sseFactory = EventSources.createFactory(client)

        val eventSource = sseFactory.newEventSource(
            request,
            object : EventSourceListener() {
                override fun onOpen(eventSource: EventSource, response: Response) {
                    listener.onOpen()
                }

                override fun onEvent(
                    eventSource: EventSource,
                    id: String?,
                    type: String?,
                    data: String
                ) {
                    listener.onEvent(id, type ?: "message", data)
                }

                override fun onClosed(eventSource: EventSource) {
                    listener.onClosed()
                }

                override fun onFailure(
                    eventSource: EventSource,
                    t: Throwable?,
                    response: Response?
                ) {
                    listener.onError(t ?: RuntimeException("SSE request failed: ${response?.code}"))
                }
            }
        )

        return AutoCloseable {
            eventSource.cancel()
        }
    }

    override fun close() {
        activeCalls.values.forEach { it.cancel() }
        activeCalls.clear()
    }

    private fun validateUrl(url: String) {
        val scheme = url.substringBefore("://", missingDelimiterValue = "").lowercase()
        if (scheme != "http" && scheme != "https") {
            throw SecurityException("Forbidden URL scheme: '$scheme'. Only HTTP/HTTPS is permitted.")
        }
        if (url.toHttpUrlOrNull() == null) {
            throw IllegalArgumentException("Malformed URL: $url")
        }
    }
}
