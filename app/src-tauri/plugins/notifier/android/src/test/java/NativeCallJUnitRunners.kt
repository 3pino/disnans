package dev.disnans.notifier

import org.junit.Test

/**
 * 通話の純粋部分の試験（`object` の `run()` の検査）を、JUnit の @Test として走らせる。
 * `:notifier:testDebugUnitTest` が、これらを他の JUnit と同じように実行する。
 * 検査そのものは各 `*Test.kt` にある。ここでは件数を標準出力に出す（前後の比較に使う）。
 */
class NativeCallPcmJUnit {
  @Test fun pureChecks() = runHarness("NativeCallPcmTest") { NativeCallPcmTest.run() }
}

class NativeCallFramingJUnit {
  @Test fun pureChecks() = runHarness("NativeCallFramingTest") { NativeCallFramingTest.run() }
}

class NativeCallMixerJUnit {
  @Test fun pureChecks() = runHarness("NativeCallMixerTest") { NativeCallMixerTest.run() }
}

class NativeCallCoreJUnit {
  @Test fun pureChecks() = runHarness("NativeCallCoreTest") { NativeCallCoreTest.run() }
}

class NativeCallProtocolJUnit {
  @Test fun protocolCases() = runHarness("NativeCallProtocolTests") {
    val cases = NativeCallProtocolTests.run()
    check(cases > 0) { "protocol cases did not run" }
    println("NativeCallProtocolTests: $cases protocol cases passed")
  }
}

class NativeCallTwoPeerJUnit {
  @Test fun twoPeers() = runHarness("NativeCallTwoPeerTest") { NativeCallTwoPeerTest.run() }
}

class NativeCallRuntimeJUnit {
  @Test fun runtimeChecks() = runHarness("NativeCallRuntimeTest") { NativeCallRuntimeTest.run() }
}

class NativeCallPumpJUnit {
  @Test fun pumpChecks() = runHarness("NativeCallPumpTest") { NativeCallPumpTest.run() }
}

class NativeCallAudioAdapterJUnit {
  @Test fun adapterChecks() = runHarness("NativeCallAudioAdapterTest") { NativeCallAudioAdapterTest.run() }
}
