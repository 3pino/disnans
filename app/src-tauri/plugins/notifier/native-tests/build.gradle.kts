import org.jetbrains.kotlin.gradle.dsl.JvmTarget

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
        kotlin.include(
            "NativeCallTypes.kt",
            "NativeCallProtocol.kt",
            "NativeCallWire.kt",
            "NativeCallPcm.kt",
            "NativeCallCore.kt",
            "NativeCallRuntime.kt",
            "NativeCallPump.kt",
            "NativeCallAudioLifecycle.kt",
            "**/NativeCall*Test*.kt",
        )
    }
}
sourceSets.main {
    resources.srcDir("../android/src/test/resources")
}

dependencies {
    implementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // このプロジェクトは試験専用。本体の Android の依存には追加しない。
    implementation("junit:junit:4.13.2")
    implementation("com.squareup.okhttp3:mockwebserver:4.12.0")
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
