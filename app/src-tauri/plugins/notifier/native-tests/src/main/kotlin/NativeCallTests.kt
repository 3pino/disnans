package dev.disnans.notifier

import org.junit.runner.JUnitCore
import dev.disnans.screen.ShareRelayCoreTest
import dev.disnans.screen.ShareRelayWireGoldenTest
import dev.disnans.screen.CaptureGateTest
import dev.disnans.screen.RelayInboxTest

/** Android・マイクを使わず、実際の通話処理に使う純粋部分を確認する。 */
fun main() {
    val protocol = NativeCallProtocolTests.run()
    val transport = mutableListOf<Class<*>>(NativeCallWireTest::class.java, NativeCallTransportSmokeTest::class.java)
    if (!System.getenv("DISNANS_NATIVE_TEST_SERVER_BIN").isNullOrBlank()) transport.add(NativeCallServerInteropTest::class.java)
    val junit = JUnitCore.runClasses(*transport.toTypedArray())
    for (failure in junit.failures) System.err.println(failure)
    check(junit.wasSuccessful()) { "Native call JUnit tests failed: ${junit.failureCount}/${junit.runCount}" }
    NativeCallPcmTest.run()
    NativeCallFramingTest.run()
    NativeCallMixerTest.run()
    NativeCallCoreTest.run()
    NativeCallTwoPeerTest.run()
    NativeCallRuntimeTest.run()
    NativeCallPumpTest.run()
    NativeCallAudioAdapterTest.run()
    val screen = JUnitCore.runClasses(ShareRelayCoreTest::class.java, ShareRelayWireGoldenTest::class.java, CaptureGateTest::class.java, RelayInboxTest::class.java)
    for (failure in screen.failures) System.err.println(failure)
    check(screen.wasSuccessful()) { "Native screen relay tests failed: ${screen.failureCount}/${screen.runCount}" }
    println("Native call: $protocol protocol cases, ${junit.runCount} transport cases and ${Check.count} pure assertions passed; screen relay: ${screen.runCount} cases")
}
