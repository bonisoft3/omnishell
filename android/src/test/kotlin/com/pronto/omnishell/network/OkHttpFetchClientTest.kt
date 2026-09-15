package com.pronto.omnishell.network

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class OkHttpFetchClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: OkHttpFetchClient

    @BeforeEach
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = OkHttpFetchClient()
    }

    @AfterEach
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun testGetRequest() {
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setHeader("Content-Type", "application/json")
                .setBody("""{"status": "ok"}""")
        )

        val url = server.url("/api/status").toString()
        val response = client.fetch(url, NativeFetchRequest(method = "GET"))

        assertEquals(200, response.status)
        assertEquals("""{"status": "ok"}""", response.body)
        assertEquals("application/json", response.headers["Content-Type"])

        val recorded = server.takeRequest()
        assertEquals("GET", recorded.method)
        assertEquals("/api/status", recorded.path)
    }

    @Test
    fun testPostRequestWithBodyAndHeaders() {
        server.enqueue(
            MockResponse()
                .setResponseCode(201)
                .setBody("""{"id": 42}""")
        )

        val url = server.url("/api/items").toString()
        val response = client.fetch(
            url,
            NativeFetchRequest(
                method = "POST",
                headers = mapOf("X-Custom-Header" to "ProntoTest", "Content-Type" to "application/json"),
                body = """{"name": "Widget"}"""
            )
        )

        assertEquals(201, response.status)
        assertEquals("""{"id": 42}""", response.body)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("ProntoTest", recorded.getHeader("X-Custom-Header"))
        assertEquals("""{"name": "Widget"}""", recorded.body.readUtf8())
    }

    @Test
    fun testSecurityForbiddenSchemes() {
        assertThrows<SecurityException> {
            client.fetch("file:///etc/passwd", NativeFetchRequest())
        }
        assertThrows<SecurityException> {
            client.fetch("javascript:alert(1)", NativeFetchRequest())
        }
        assertThrows<SecurityException> {
            client.fetch("content://contacts", NativeFetchRequest())
        }
    }

    @Test
    fun testSseStreaming() {
        val ssePayload = "event: patch\ndata: {\"row\": 1}\n\n"
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(ssePayload)
        )

        val latch = CountDownLatch(1)
        var receivedType = ""
        var receivedData = ""

        val closeable = client.connectSse(
            url = server.url("/shapes").toString(),
            headers = emptyMap(),
            listener = object : SseEventListener {
                override fun onOpen() {}

                override fun onEvent(id: String?, type: String, data: String) {
                    receivedType = type
                    receivedData = data
                    latch.countDown()
                }

                override fun onError(throwable: Throwable) {}
                override fun onClosed() {}
            }
        )

        val ok = latch.await(5, TimeUnit.SECONDS)
        closeable.close()

        assertTrue(ok, "SSE event timed out")
        assertEquals("patch", receivedType)
        assertEquals("{\"row\": 1}", receivedData)
    }
}
