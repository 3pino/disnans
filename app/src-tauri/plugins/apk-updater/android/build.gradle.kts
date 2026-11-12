import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.disnans.apkupdater"
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

// 版は plugins/gradle-versions.properties
val versions = Properties().apply { file("../../gradle-versions.properties").inputStream().use { load(it) } }

dependencies {
    implementation("androidx.core:core-ktx:${versions.getProperty("androidx.core")}")
    implementation("com.fasterxml.jackson.core:jackson-databind:${versions.getProperty("jackson")}")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:${versions.getProperty("junit")}")
}
