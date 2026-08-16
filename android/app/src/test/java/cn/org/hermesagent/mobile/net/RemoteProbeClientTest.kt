package cn.org.hermesagent.mobile.net

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

class RemoteProbeClientTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun publicStatusIsReachableAndDoesNotRequestProviders() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.PUBLIC_STATUS))

        val result = probe()

        assertTrue(result.reachable)
        assertFalse(result.authRequired)
        assertEquals("0.7.0", result.version)
        assertTrue(result.authProviders.isEmpty())
        val request = takeRequest()
        assertEquals("GET", request.method)
        assertEquals("/api/status", request.path)
        assertNull(request.getHeader("Cookie"))
        assertEquals(1, server.requestCount)
    }

    @Test
    fun oauthProbeAddsCookieToStatusAndProvidersRequests() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS, 401))
        server.enqueue(jsonResponse(RemoteProbeFixtures.EMPTY_PROVIDERS))

        val result = probe(cookieHeader = "hermes_session_at=session-value")

        assertTrue(result.reachable)
        assertTrue(result.authRequired)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(
            "hermes_session_at=session-value",
            takeRequest().getHeader("Cookie"),
        )
        assertEquals(
            "hermes_session_at=session-value",
            takeRequest().getHeader("Cookie"),
        )
    }

    @Test
    fun legacyProvidersEmbeddedInStatusAreIgnoredWhenAuthIsNotRequired() {
        server.enqueue(
            jsonResponse(
                """{"auth_required":false,"version":"legacy-field","auth_providers":[{"name":"stale"}]}""",
            ),
        )

        val result = probe()

        assertTrue(result.reachable)
        assertFalse(result.authRequired)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(1, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
    }

    @Test
    fun gatedStatusRequestsProvidersAfterStatusAndNormalizesMixedEntries() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS, 401))
        server.enqueue(jsonResponse(RemoteProbeFixtures.MIXED_PROVIDERS))

        val result = probe()

        assertTrue(result.reachable)
        assertTrue(result.authRequired)
        assertEquals("0.7.0-gated", result.version)
        assertEquals(
            listOf(
                AuthProviderInfo("password", "Password", true),
                AuthProviderInfo("oauth", "OAuth", false),
                AuthProviderInfo("fallback-name", "fallback-name", false),
                AuthProviderInfo("null-display", "null-display", false),
                AuthProviderInfo("invalid-supports", "invalid-supports", false),
            ),
            result.authProviders,
        )
        val bridgeResult = result.toJson()
        val firstProvider = bridgeResult.getJSONArray("authProviders").getJSONObject(0)
        assertEquals("password", firstProvider.getString("name"))
        assertEquals("Password", firstProvider.getString("displayName"))
        assertTrue(firstProvider.getBoolean("supportsPassword"))
        for (index in 0 until bridgeResult.getJSONArray("authProviders").length()) {
            assertFalse(bridgeResult.getJSONArray("authProviders").isNull(index))
        }
        assertEquals(2, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
        assertEquals("/api/auth/providers", takeRequestPathFromFirstRequest())
    }

    @Test
    fun stringAuthRequiredIsNotTreatedAsBooleanAndDoesNotRequestProviders() {
        server.enqueue(jsonResponse("""{"auth_required":"true","version":"string-flag"}"""))

        val result = probe()

        assertTrue(result.reachable)
        assertFalse(result.authRequired)
        assertEquals("string-flag", result.version)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(1, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
    }

    @Test
    fun emptyProvidersResponseProducesAnEmptyList() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS))
        server.enqueue(jsonResponse(RemoteProbeFixtures.EMPTY_PROVIDERS))

        val result = probe()

        assertTrue(result.reachable)
        assertTrue(result.authRequired)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(2, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
        assertEquals("/api/auth/providers", takeRequestPathFromFirstRequest())
    }

    @Test
    fun provider503ReturnsEmptyListWithoutThrowing() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS))
        server.enqueue(jsonResponse("{" + "\"error\":\"providers unavailable\"}", 503))

        val result = probe()

        assertTrue(result.reachable)
        assertTrue(result.authRequired)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(2, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
        assertEquals("/api/auth/providers", takeRequestPathFromFirstRequest())
    }

    @Test
    fun nullMissingAndWrongProviderFieldsReturnEmptyListWithoutThrowing() {
        val malformedBodies = listOf(
            "null",
            "{}",
            """{"providers":null}""",
            """{"providers":"not-an-array"}""",
            """{"providers":[null,{"display_name":"no-name"},{"name":false}]}""",
        )

        malformedBodies.forEach { body ->
            server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS))
            server.enqueue(jsonResponse(body))

            val result = probe()

            assertTrue(result.reachable)
            assertTrue(result.authRequired)
            assertTrue(result.authProviders.isEmpty())
        }

        assertEquals(malformedBodies.size * 2, server.requestCount)
        repeat(malformedBodies.size) {
            assertEquals("/api/status", takeRequestPathFromFirstRequest())
            assertEquals("/api/auth/providers", takeRequestPathFromFirstRequest())
        }
    }

    @Test
    fun invalidProviderJsonReturnsEmptyListWithoutThrowing() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS))
        server.enqueue(MockResponse().setResponseCode(200).setBody("not-json"))

        val result = probe()

        assertTrue(result.reachable)
        assertTrue(result.authRequired)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(2, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
        assertEquals("/api/auth/providers", takeRequestPathFromFirstRequest())
    }

    @Test
    fun providerTimeoutReturnsEmptyListWithoutChangingStatusReachability() {
        server.enqueue(jsonResponse(RemoteProbeFixtures.GATED_STATUS))
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(RemoteProbeFixtures.MIXED_PROVIDERS)
                .setBodyDelay(250, TimeUnit.MILLISECONDS),
        )

        val result = probe(readTimeoutMillis = 50)

        assertTrue(result.reachable)
        assertTrue(result.authRequired)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(2, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
        assertEquals("/api/auth/providers", takeRequestPathFromFirstRequest())
    }

    @Test
    fun invalidStatusJsonIsStillAReachableResponseWithNoAuthGate() {
        server.enqueue(MockResponse().setResponseCode(200).setBody("not-json"))

        val result = probe()

        assertTrue(result.reachable)
        assertFalse(result.authRequired)
        assertEquals("", result.version)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(1, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
    }

    @Test
    fun nonSuccessStatusOtherThan401IsNotReachable() {
        server.enqueue(jsonResponse("""{"auth_required":false,"version":"server-error"}""", 500))

        val result = probe()

        assertFalse(result.reachable)
        assertFalse(result.authRequired)
        assertEquals("server-error", result.version)
        assertTrue(result.authProviders.isEmpty())
        assertEquals(1, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
    }

    @Test
    fun existingVersionFallbackFieldsRemainReadable() {
        server.enqueue(jsonResponse("""{"auth_required":false,"hermes_version":"legacy-version"}"""))

        val result = probe()

        assertTrue(result.reachable)
        assertEquals("legacy-version", result.version)
        assertEquals(1, server.requestCount)
        assertEquals("/api/status", takeRequestPathFromFirstRequest())
    }

    private fun probe(
        readTimeoutMillis: Long = 1_000,
        cookieHeader: String? = null,
    ): RemoteProbeResult {
        val client = OkHttpClient.Builder()
            .connectTimeout(1, TimeUnit.SECONDS)
            .readTimeout(readTimeoutMillis, TimeUnit.MILLISECONDS)
            .build()
        return RemoteProbeClient(client).probe(server.url("/").toString(), cookieHeader)
    }

    private fun jsonResponse(body: String, code: Int = 200): MockResponse =
        MockResponse()
            .setResponseCode(code)
            .setHeader("Content-Type", "application/json")
            .setBody(body)

    private fun takeRequestPathFromFirstRequest(): String {
        val request = server.takeRequest(1, TimeUnit.SECONDS)
        assertNotNull("expected a request", request)
        return request!!.path.orEmpty()
    }

    private fun takeRequest(): okhttp3.mockwebserver.RecordedRequest {
        val request = server.takeRequest(1, TimeUnit.SECONDS)
        assertNotNull("expected a request", request)
        return request!!
    }
}
