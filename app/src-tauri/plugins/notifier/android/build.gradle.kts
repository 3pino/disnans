import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.disnans.notifier"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

// 版は plugins/gradle-versions.properties（プラグインの全てと試験プロジェクトで共有）
val versions = Properties().apply { file("../../gradle-versions.properties").inputStream().use { load(it) } }

dependencies {
    implementation("androidx.core:core-ktx:${versions.getProperty("androidx.core")}")
    implementation("com.fasterxml.jackson.core:jackson-databind:${versions.getProperty("jackson")}")
    // WebSocket クライアント（Android の標準ライブラリにはない）
    implementation("com.squareup.okhttp3:okhttp:${versions.getProperty("okhttp")}")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:${versions.getProperty("junit")}")
    testImplementation("com.squareup.okhttp3:mockwebserver:${versions.getProperty("okhttp")}")
}
