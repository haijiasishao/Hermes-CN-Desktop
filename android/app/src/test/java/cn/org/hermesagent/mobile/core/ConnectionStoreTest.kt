package cn.org.hermesagent.mobile.core

import org.junit.Assert.assertEquals
import org.junit.Test

class ConnectionStoreTest {
    @Test
    fun newRemoteConfigurationHasNoHardcodedAddress() {
        assertEquals("", ConnectionStore.DEFAULT_REMOTE_URL)
        assertEquals("http://127.0.0.1:9119", ConnectionStore.DEFAULT_LOCAL_URL)
    }
}
