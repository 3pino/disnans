import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Properties

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.disnans.screen"
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
    // startActivityForResult の結果（ActivityResult）の型
    implementation("androidx.activity:activity:${versions.getProperty("androidx.activity")}")
    implementation("com.fasterxml.jackson.core:jackson-databind:${versions.getProperty("jackson")}")
    implementation(project(":tauri-android"))
    // Tauri の生成名と単独ビルドの名前に依存せず、同梱の通話ライブラリを参照する。
    val notifierDir = file("../../notifier/android").canonicalFile
    val notifier = rootProject.allprojects.single { it.projectDir.canonicalFile == notifierDir }
    implementation(project(notifier.path))
    testImplementation("junit:junit:${versions.getProperty("junit")}")
}
