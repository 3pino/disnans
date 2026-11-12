package dev.disnans.notifier

import org.junit.runner.JUnitCore

/**
 * 実際の Rust サーバーとの相互接続だけを走らせる（DISNANS_NATIVE_TEST_SERVER_BIN が要る）。
 * 他の通話・画面の試験は `:notifier:testDebugUnitTest` と `:screen:testDebugUnitTest`（android-check）で走る。
 */
fun main() {
    val server = System.getenv("DISNANS_NATIVE_TEST_SERVER_BIN")
    if (server.isNullOrBlank()) {
        println("Native call interop: skipped (DISNANS_NATIVE_TEST_SERVER_BIN is not set)")
        return
    }
    val junit = JUnitCore.runClasses(NativeCallServerInteropTest::class.java)
    for (failure in junit.failures) System.err.println(failure)
    check(junit.wasSuccessful()) { "Native call interop tests failed: ${junit.failureCount}/${junit.runCount}" }
    println("Native call interop: ${junit.runCount} cases passed against the given server")
}
