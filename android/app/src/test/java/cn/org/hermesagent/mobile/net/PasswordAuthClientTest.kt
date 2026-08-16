package cn.org.hermesagent.mobile.net

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class PasswordAuthClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: PasswordAuthClient

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        client = PasswordAuthClient(
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
    fun loginUsesPasswordEndpointAndVerifiesCookieWithAuthMe() {
        server.enqueue(
            jsonResponse("{\"ok\":true}")
                .addHeader("Set-Cookie", "hermes_session_at=test-session-cookie; Path=/; HttpOnly; Secure"),
        )
        server.enqueue(
            jsonResponse(
                """
                {
                  "user_id": "user-1",
                  "email": "person@example.test",
                  "display_name": "Test User",
                  "org_id": "org-1",
                  "provider": "password",
                  "expires_at": "2026-08-14T12:00:00Z"
                }
                """.trimIndent(),
            ),
        )

        val result = client.login(
            remoteUrl = server.url("/").toString(),
            provider = "password-provider",
            username = "test-user",
            password = "test-password",
        )

        assertTrue(result.ok)
        assertEquals("hermes_session_at=test-session-cookie", result.cookieHeader)
        assertNotNull(result.identity)
        val identity = result.identity!!
        assertEquals("user-1", identity.getString("userId"))
        assertEquals("person@example.test", identity.getString("email"))
        assertEquals("Test User", identity.getString("displayName"))
        assertEquals("org-1", identity.getString("orgId"))
        assertEquals("password", identity.getString("provider"))
        assertEquals("2026-08-14T12:00:00Z", identity.getString("expiresAt"))
        assertFalse(identity.has("user_id"))

        val loginRequest = takeRequest()
        assertEquals("POST", loginRequest.method)
        assertEquals("/auth/password-login", loginRequest.path)
        assertEquals("application/json", loginRequest.getHeader("Content-Type"))
        val loginBody = JSONObject(loginRequest.body.readUtf8())
        assertEquals(
            setOf("provider", "username", "password"),
            loginBody.keys().asSequence().toSet(),
        )
        assertEquals("password-provider", loginBody.getString("provider"))
        assertEquals("test-user", loginBody.getString("username"))
        assertEquals("test-password", loginBody.getString("password"))

        val authMeRequest = takeRequest()
        assertEquals("GET", authMeRequest.method)
        assertEquals("/api/auth/me", authMeRequest.path)
        assertEquals("hermes_session_at=test-session-cookie", authMeRequest.getHeader("Cookie"))
    }

    @Test
    fun unauthorizedPasswordLoginMapsToCredentialsErrorAndDoesNotCallAuthMe() {
        server.enqueue(jsonResponse("{\"detail\":\"invalid\"}", 401))

        val result = client.login(server.url("/").toString(), "password-provider", "test-user", "test-password")

        assertFalse(result.ok)
        assertEquals("用户名或密码错误", result.error)
        assertEquals(1, server.requestCount)
        assertEquals("/auth/password-login", takeRequest().path)
    }

    @Test
    fun passwordLoginMapsKnownGatewayErrors() {
        val expected = mapOf(
            404 to "该网关不支持密码登录（provider 未启用）",
            429 to "尝试过于频繁，请稍后再试",
            503 to "网关未注册任何登录方式",
        )

        expected.forEach { (status, message) ->
            server.enqueue(jsonResponse("{\"error\":\"unavailable\"}", status))

            val result = client.login(server.url("/").toString(), "password-provider", "test-user", "test-password")

            assertFalse(result.ok)
            assertEquals(message, result.error)
            assertEquals("/auth/password-login", takeRequest().path)
        }
        assertEquals(expected.size, server.requestCount)
    }

    @Test
    fun unexpectedPasswordLoginStatusRetainsHttpStatus() {
        server.enqueue(jsonResponse("{\"error\":\"server\"}", 500))

        val result = client.login(server.url("/").toString(), "password-provider", "test-user", "test-password")

        assertFalse(result.ok)
        assertEquals("登录失败（HTTP 500）", result.error)
        assertEquals(1, server.requestCount)
        assertEquals("/auth/password-login", takeRequest().path)
    }

    @Test
    fun successfulLoginWithoutSessionCookieIsNotReportedAsSuccess() {
        server.enqueue(jsonResponse("{\"ok\":true}"))

        val result = client.login(server.url("/").toString(), "password-provider", "test-user", "test-password")

        assertFalse(result.ok)
        assertEquals("登录未生效，请重试", result.error)
        assertEquals(1, server.requestCount)
        assertEquals("/auth/password-login", takeRequest().path)
    }

    @Test
    fun authMeUnauthorizedCookieIsMappedAndDoesNotReportIdentity() {
        server.enqueue(jsonResponse("{\"detail\":\"expired\"}", 401))

        val result = client.authMe(
            remoteUrl = server.url("/").toString(),
            cookieHeader = "hermes_session_at=test-session-cookie",
        )

        assertFalse(result.ok)
        assertEquals("登录未生效，请重试", result.error)
        assertEquals(1, server.requestCount)
        val request = takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/auth/me", request.path)
        assertEquals("hermes_session_at=test-session-cookie", request.getHeader("Cookie"))
    }

    private fun jsonResponse(body: String, status: Int = 200): MockResponse =
        MockResponse()
            .setResponseCode(status)
            .setHeader("Content-Type", "application/json")
            .setBody(body)

    private fun takeRequest() = server.takeRequest(1, TimeUnit.SECONDS).also {
        assertNotNull("expected a request", it)
    }!!
}
