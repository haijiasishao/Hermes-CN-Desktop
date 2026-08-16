package cn.org.hermesagent.mobile.notify

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CompletionDetectorTest {

    private fun assistantUi(
        id: String,
        createdAt: Double,
        status: String,
        text: String? = "最终回答",
        toolState: String? = null,
    ): JSONObject = JSONObject().apply {
        put("id", id)
        put("sessionId", "s1")
        put("role", "assistant")
        put("createdAt", createdAt)
        put("status", status)
        val parts = JSONArray()
        if (toolState != null) {
            parts.put(JSONObject()
                .put("type", "tool")
                .put("toolCallId", "call-1")
                .put("name", "terminal")
                .put("state", toolState)
                .put("input", JSONObject()))
        }
        if (text != null) {
            parts.put(JSONObject().put("type", "text").put("text", text))
        }
        put("parts", parts)
    }

    private fun userUi(id: String, createdAt: Double): JSONObject = JSONObject().apply {
        put("id", id)
        put("sessionId", "s1")
        put("role", "user")
        put("createdAt", createdAt)
        put("status", "complete")
        put("parts", JSONArray().put(JSONObject().put("type", "text").put("text", "提问")))
    }

    private fun legacyAssistant(
        id: String,
        timestamp: Double,
        finishReason: String?,
        text: String? = "最终回答",
        toolCalls: Boolean = false,
    ): JSONObject = JSONObject().apply {
        put("id", id)
        put("session_id", "s1")
        put("role", "assistant")
        put("timestamp", timestamp)
        if (finishReason != null) put("finish_reason", finishReason)
        if (text != null) put("content", text)
        if (toolCalls) put("tool_calls", JSONArray().put(JSONObject().put("id", "call-1").put("type", "function")))
    }

    @Test
    fun terminalAnswerUiMessageConvergesToCompleted() {
        val msgs = JSONArray()
            .put(userUi("u1", 100.0))
            .put(assistantUi("a1", 200.0, "complete", text = "好的，这是答案"))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertTrue(result.isTerminal)
        assertEquals("completed", result.state)
    }

    @Test
    fun erroredMessageConvergesToFailed() {
        val msgs = JSONArray().put(assistantUi("a1", 200.0, "error", text = null))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertTrue(result.isTerminal)
        assertEquals("failed", result.state)
    }

    @Test
    fun midTurnRunningToolRoundIsNotTerminal() {
        // Hermes persists tool-call rounds as complete assistants; a running
        // tool part proves the agent is still working (hermes-debug-1786772272797).
        val msgs = JSONArray().put(
            assistantUi("mid1", 200.0, "complete", text = "正在执行工具", toolState = "running"),
        )
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertFalse(result.isTerminal)
    }

    @Test
    fun doneToolRoundWithFinalTextIsTerminal() {
        val msgs = JSONArray().put(
            assistantUi("a1", 200.0, "complete", text = "结果如下", toolState = "done"),
        )
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertTrue(result.isTerminal)
        assertEquals("completed", result.state)
    }

    @Test
    fun emptyOrNoMessagesIsNotTerminal() {
        assertFalse(CompletionDetector.detectTerminal(JSONArray(), 100L).isTerminal)
        assertFalse(CompletionDetector.detectTerminal(JSONArray().put(userUi("u1", 100.0)), 100L).isTerminal)
    }

    @Test
    fun staleAnswerBeforeTurnStartIsIgnored() {
        // Previous turn's completion must not converge the current turn.
        // createdAt is far earlier than turnStart - clockSkew, so it cannot
        // be this turn's answer (180s before a turn that started at 100s).
        val msgs = JSONArray().put(assistantUi("old", 50.0, "complete", text = "上一轮完成"))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100_000L)
        assertFalse(result.isTerminal)
    }

    @Test
    fun closeWithinClockSkewStillConverges() {
        // createdAt a few seconds before the local turn-start timestamp is
        // tolerated (device clock vs backend clock skew).
        val msgs = JSONArray().put(assistantUi("a1", 900.0, "complete", text = "答案"))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 1_000L)
        assertTrue(result.isTerminal)
    }

    @Test
    fun legacyMessageWithToolCallsIsNotTerminal() {
        val msgs = JSONArray().put(legacyAssistant("mid1", 200.0, "tool_calls", text = "调用工具", toolCalls = true))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertFalse(result.isTerminal)
    }

    @Test
    fun legacyFinishedWithStopConverges() {
        val msgs = JSONArray().put(legacyAssistant("a1", 200.0, "stop", text = "完成啦"))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertTrue(result.isTerminal)
        assertEquals("completed", result.state)
    }

    @Test
    fun legacyErroredFinishConvergesToFailed() {
        val msgs = JSONArray().put(legacyAssistant("a1", 200.0, "error", text = "失败"))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertTrue(result.isTerminal)
        assertEquals("failed", result.state)
    }

    @Test
    fun scansPastTrailingUserMessageForTerminalAssistant() {
        // After a completed turn the user may have sent another message; the
        // last ASSISTANT remains the terminal evidence and the turn is over.
        val msgs = JSONArray()
            .put(assistantUi("a1", 200.0, "complete", text = "第一轮答案"))
            .put(userUi("u2", 300.0))
        val result = CompletionDetector.detectTerminal(msgs, turnStartedAtMs = 100L)
        assertTrue(result.isTerminal)
        assertEquals("completed", result.state)
    }
}
