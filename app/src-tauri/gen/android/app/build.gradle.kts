import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// リリース署名の鍵。CI では環境変数、手元では ~/.config/disnans-keys/ から読む。
// 同じ鍵で署名しないと、アップデートとしてインストールできない。
val keyDir = File(System.getProperty("user.home"), ".config/disnans-keys")
val keystoreFile = System.getenv("DISNANS_KEYSTORE")?.let { file(it) }
    ?: File(keyDir, "android.jks").takeIf { it.exists() }
val keystorePassword = System.getenv("DISNANS_KEYSTORE_PASSWORD")
    ?: File(keyDir, "android.password").takeIf { it.exists() }?.readText()?.trim()

android {
    compileSdk = 37
    signingConfigs {
        if (keystoreFile != null && keystorePassword != null) {
            create("release") {
                storeFile = keystoreFile
                storePassword = keystorePassword
                keyAlias = "disnans"
                keyPassword = keystorePassword
            }
        }
    }
    namespace = "dev.disnans.app"
    defaultConfig {
        // 自宅サーバーには Tailscale 経由の http:// で接続する（通信路は WireGuard で暗号化される）
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        applicationId = "dev.disnans.app"
        minSdk = 24
        targetSdk = 37
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            // リリース版と同じ鍵で署名し、デバッグ版とリリース版を入れ替えてもアンインストール不要にする
            signingConfigs.findByName("release")?.let { signingConfig = it }
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfigs.findByName("release")?.let { signingConfig = it }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
