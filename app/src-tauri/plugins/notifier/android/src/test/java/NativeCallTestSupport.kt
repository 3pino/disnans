package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper

/**
 * 試験の小さな道具。失敗は例外にする（JUnit の assert と同じ扱い）。
 * 実行: `:notifier:testDebugUnitTest`（NativeCallJUnitRunners.kt が各 `run()` を @Test にする）。
 */

/** harness を一つの試験として走らせ、検査の件数を出す */
internal fun runHarness(name: String, body: () -> Unit) {
  val before = Check.count
  body()
  println("$name: ${Check.count - before} checks passed")
}
object Check {
  var count = 0
  fun that(cond: Boolean, msg: () -> String) {
    count++
    if (!cond) throw AssertionError(msg())
  }
  fun eq(expected: Any?, actual: Any?, what: String) = that(expected == actual) { "$what: expected <$expected> but was <$actual>" }
  fun near(expected: Double, actual: Double, tol: Double, what: String) =
    that(Math.abs(expected - actual) <= tol) { "$what: expected $expected but was $actual (tol $tol)" }
}

object Golden {
  private val mapper = ObjectMapper()
  val root: JsonNode by lazy {
    val s = Golden::class.java.getResourceAsStream("/native-call/golden-v1.json")
      ?: error("golden-v1.json が見つかりません")
    mapper.readTree(s)
  }
}

fun JsonNode.floats(name: String): FloatArray = get(name).map { it.asDouble().toFloat() }.toFloatArray()
fun JsonNode.shorts(name: String): ShortArray = get(name).map { it.asInt().toShort() }.toShortArray()
