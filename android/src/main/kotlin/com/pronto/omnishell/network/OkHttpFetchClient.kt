package com.pronto.omnishell.network

import okhttp3.Call
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.sse.EventSource
import okhttp3.sse.EventSourceListener
import okhttp3.sse.EventSources
import java.util.concurrent.TimeUnit

open class OkHttpFetchClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS) // 0 for streaming SSE
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()
) {
    fun fetch(url: String, request: NativeFetchRequest): NativeFetchResponse {
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
        val httpRequest = builder.build()

        client.newCall(httpRequest).execute().use { response ->
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
