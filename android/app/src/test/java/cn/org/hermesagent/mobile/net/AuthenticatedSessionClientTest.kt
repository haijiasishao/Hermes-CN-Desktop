package cn.org.hermesagent.mobile.net

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class AuthenticatedSessionClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: AuthenticatedSessionClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = AuthenticatedSessionClient(
            OkHttpClient.Builder()
                .connectTimeout(1, TimeUnit.SECONDS)
                .readTimeout(1, TimeUnit.SECONDS)
                .build(),
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun mintWsTicketUsesPostEndpointAndCookieWithoutAuthorization() {
        server.enqueue(jsonResponse("{\"ticket\":\"ticket-value\"}"))

        val result = client.mintWsTicket(
            remoteUrl = server.url("/dashboard/").toString(),
            cookieHeader = "hermes_session_at=session-value",
        )

        assertTrue(result.ok)
        assertEquals("ticket-value", result.ticket)
        assertEquals(200, result.status)

        val request = server.takeRequest(1, TimeUnit.SECONDS)
            ?: error("expected ws-ticket request")
        assertEquals("POST", request.method)
        assertEquals("/dashboard/api/auth/ws-ticket", request.path)
        assertEquals("hermes_session_at=session-value", request.getHeader("Cookie"))
        assertNull(request.getHeader("Authorization"))
        assertEquals("", request.body.readUtf8())
    }

    @Test
    fun unauthorizedTicketMapsToExpiredLoginMessage() {
        server.enqueue(jsonResponse("{\"detail\":\"expired\"}", 401))

        val result = client.mintWsTicket(server.url("/").toString(), "hermes_session_at=expired")

        assertFalse(result.ok)
        assertNull(result.ticket)
        assertEquals(401, result.status)
        assertEquals("登录已过期，请重新登录", result.error)
    }

    @Test
    fun ticketResponseWithoutTicketIsNotSuccess() {
        server.enqueue(jsonResponse("{\"ok\":true}"))

        val result = client.mintWsTicket(server.url("/").toString(), "hermes_session_at=session-value")

        assertFalse(result.ok)
        assertNull(result.ticket)
        assertEquals(200, result.status)
        assertEquals("ws-ticket 响应缺少 ticket", result.error)
    }

    @Test
    fun nonUnauthorizedHttpErrorRetainsStatus() {
        server.enqueue(jsonResponse("{\"error\":\"unavailable\"}", 503))

        val result = client.mintWsTicket(server.url("/").toString(), "hermes_session_at=session-value")

        assertFalse(result.ok)
        assertEquals(503, result.status)
        assertEquals("HTTP 503", result.error)
    }

    private fun jsonResponse(body: String, status: Int = 200): MockResponse =
        MockResponse()
            .setResponseCode(status)
            .setHeader("Content-Type", "application/json")
            .setBody(body)
}
