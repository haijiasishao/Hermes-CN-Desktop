// Kotlin-native rebuild of the Hermes Agent Android client.
// Pure Kotlin + WebView — no Tauri, no Rust. The React frontend (web/) is
// hosted in the WebView and talks to this shell through window.HermesBridge.
buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
