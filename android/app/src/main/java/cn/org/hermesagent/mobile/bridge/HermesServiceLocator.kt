package cn.org.hermesagent.mobile.bridge

import java.util.concurrent.ConcurrentHashMap

/**
 * Registry of native services implementing Hermes commands, keyed by command
 * name. Keeps the WebView bridge agnostic of service implementations.
 */
class HermesServiceLocator {
    private val services = ConcurrentHashMap<String, BridgeService>()
    private val commandIndex = ConcurrentHashMap<String, BridgeService>()

    fun register(name: String, service: BridgeService) {
        services[name] = service
        for (cmd in service.commands()) {
            commandIndex[cmd] = service
        }
    }

    fun handlerFor(command: String): BridgeService? = commandIndex[command]

    fun service(name: String): BridgeService? = services[name]

    fun shutdown() {
        services.values.forEach { (it as? AutoCloseable)?.close() }
        services.clear()
        commandIndex.clear()
    }
}
