package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper

/**
 * 試験の小さな道具。JUnit を使わず（キャッシュに無いため）、失敗は例外にする。
 * 実行: 各 *Test.kt の `main` を java で呼ぶ（tools/ の手順を参照）。
 */
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
