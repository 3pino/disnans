import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    kotlin("jvm") version "2.2.10"
}

repositories {
    mavenCentral()
}

java {
    sourceCompatibility = JavaVersion.VERSION_1_8
    targetCompatibility = JavaVersion.VERSION_1_8
}
kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
    sourceSets.main {
        kotlin.srcDir("../android/src/main/java")
        kotlin.srcDir("../android/src/test/java")
        kotlin.srcDir("../../screen/android/src/main/java")
        kotlin.srcDir("../../screen/android/src/test/java")
        kotlin.include(
            "NativeCallTypes.kt",
            "NativeCallProtocol.kt",
            "NativeCallWire.kt",
            "NativeCallPcm.kt",
            "NativeCallCore.kt",
            "NativeCallRuntime.kt",
            "NativeCallPump.kt",
            "NativeCallAudioLifecycle.kt",
            "ShareRelayConfig.kt",
            "ShareRelayCore.kt",
            "ShareRelayInbox.kt",
            "CaptureGate.kt",
            "**/NativeCall*Test*.kt",
            "**/ShareRelay*Test*.kt",
            "**/RelayInboxTest.kt",
            "**/CaptureGateTest.kt",
        )
    }
}
sourceSets.main {
    resources.srcDir("../android/src/test/resources")
    resources.srcDir("../../screen/android/src/test/resources")
}

// 版は plugins/gradle-versions.properties（ここでは notifier/native-tests から 2 つ上）
val versions = Properties().apply { file("../../gradle-versions.properties").inputStream().use { load(it) } }

dependencies {
    implementation("com.fasterxml.jackson.core:jackson-databind:${versions.getProperty("jackson")}")
    implementation("com.squareup.okhttp3:okhttp:${versions.getProperty("okhttp")}")
    // このプロジェクトは試験専用。本体の Android の依存には追加しない。
    implementation("junit:junit:${versions.getProperty("junit")}")
    implementation("com.squareup.okhttp3:mockwebserver:${versions.getProperty("okhttp")}")
}

tasks.register<JavaExec>("nativeCallTest") {
    group = "verification"
    description = "Run native call protocol, PCM and lifecycle tests without Android or a microphone"
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("dev.disnans.notifier.NativeCallTestsKt")
    enableAssertions = true
}
tasks.named("check") {
    dependsOn("nativeCallTest")
}
