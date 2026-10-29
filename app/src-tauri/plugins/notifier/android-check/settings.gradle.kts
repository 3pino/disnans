rootProject.name = "disnans-notifier-compile"
include(":notifier", ":tauri-android")
project(":notifier").projectDir = file("../android")

val apiDir = System.getenv("TAURI_ANDROID_DIR")?.let(::file)
    ?: file("../android/.tauri/tauri-api")
require(apiDir.resolve("build.gradle.kts").isFile) {
    "Set TAURI_ANDROID_DIR to the locked tauri crate's mobile/android directory"
}
project(":tauri-android").projectDir = apiDir
