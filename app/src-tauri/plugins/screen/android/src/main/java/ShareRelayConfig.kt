package dev.disnans.screen

/** 中継のイベント名（受け手の JS と合わせる）。frame と state は必ず要る。query は任意 */
class RelayNames(val frame: String, val state: String, val query: String?)

/** 検査を通った中継の設定。on の状態の JSON は、ここで一度だけ作る */
class RelayConfig private constructor(val names: RelayNames, val onStateJson: String) {
  companion object {
    const val OFF_STATE_JSON = "{\"on\":false}"

    /**
     * 要求の検査。失敗は固定の code で返す（画面の取得を始める前に、呼び出し側で止める）。
     * extra は on の状態に足す項目（値は文字列・真偽・有限の数だけ。null は不可）。
     * 上限は、追加項目の JSON 全体（{} を含む）の UTF-8 のバイト数で決める（SDK と同じ）。
     */
    fun parse(frame: String?, state: String?, query: String?, extra: Map<String, Any?>): RelayParse {
      if (frame == null || state == null) return RelayParse.Err("bad_name")
      if (!validName(frame) || !validName(state) || (query != null && !validName(query))) {
        return RelayParse.Err("bad_name")
      }
      val names = listOfNotNull(frame, state, query)
      if (names.toSet().size != names.size) return RelayParse.Err("duplicate_name")

      val parts = StringBuilder()
      for ((k, v) in extra) {
        if (k == "on") return RelayParse.Err("reserved_state_key")
        val enc = encodeValue(v) ?: return RelayParse.Err("bad_state")
        parts.append(',').append(jsonString(k)).append(':').append(enc)
      }
      val extraJson = if (parts.isEmpty()) "{}" else "{${parts.substring(1)}}"
      val on = "{\"on\":true$parts}"
      if (extraJson.toByteArray(Charsets.UTF_8).size > RelayLimits.STATE_EXTRA_MAX_BYTES) {
        return RelayParse.Err("state_too_large")
      }
      return RelayParse.Ok(RelayConfig(RelayNames(frame, state, query), on))
    }

    private val KNOWN_KEYS = setOf("frameEvent", "stateEvent", "queryEvent", "state")

    /**
     * JS から来た callRelay（JSON を Kotlin の値に直したもの）を厳しく検査する。
     * 無い（present=false）は Absent（旧い開始）。在るのに、オブジェクトでない・知らない項目がある・型が違う は、すべて拒否する。
     * 名前は文字列だけ。state はオブジェクトだけ（配列・null・数などは拒否）。
     */
    fun fromRaw(present: Boolean, value: Any?): RelayParse {
      if (!present) return RelayParse.Absent
      val m = value as? Map<*, *> ?: return RelayParse.Err("bad_relay")
      if (m.keys.any { it !in KNOWN_KEYS }) return RelayParse.Err("bad_relay")
      val frame = m["frameEvent"] as? String ?: return RelayParse.Err("bad_name")
      val stateName = m["stateEvent"] as? String ?: return RelayParse.Err("bad_name")
      val query: String? = if (m.containsKey("queryEvent")) {
        m["queryEvent"] as? String ?: return RelayParse.Err("bad_name")
      } else {
        null
      }
      val extra = LinkedHashMap<String, Any?>()
      if (m.containsKey("state")) {
        val st = m["state"] as? Map<*, *> ?: return RelayParse.Err("bad_state")
        for ((k, v) in st) {
          val key = k as? String ?: return RelayParse.Err("bad_state")
          extra[key] = v
        }
      }
      return parse(frame, stateName, query, extra)
    }

    private fun validName(s: String): Boolean =
      s.isNotEmpty() && s.length <= RelayLimits.NAME_MAX_CHARS && s != "audio"

    private fun encodeValue(v: Any?): String? = when (v) {
      is String -> jsonString(v)
      is Boolean -> v.toString()
      is Int -> v.toString()
      is Long -> v.toString()
      is Double -> if (v.isFinite()) v.toString() else null
      is Float -> if (v.isFinite()) v.toString() else null
      is Number -> if (v.toDouble().isFinite()) v.toString() else null
      else -> null
    }

    /** JSON の文字列（引用符と制御文字だけを逃がす） */
    internal fun jsonString(s: String): String {
      val sb = StringBuilder("\"")
      for ((i, ch) in s.withIndex()) {
        when {
          ch == '"' -> sb.append("\\\"")
          ch == '\\' -> sb.append("\\\\")
          ch == '\b' -> sb.append("\\b")
          ch == '\t' -> sb.append("\\t")
          ch == '\n' -> sb.append("\\n")
          ch == '\u000c' -> sb.append("\\f")
          ch == '\r' -> sb.append("\\r")
          ch < ' ' || (ch in '\uD800'..'\uDBFF' && (i + 1 == s.length || s[i + 1] !in '\uDC00'..'\uDFFF')) ||
            (ch in '\uDC00'..'\uDFFF' && (i == 0 || s[i - 1] !in '\uD800'..'\uDBFF')) -> sb.append(String.format("\\u%04x", ch.code))
          else -> sb.append(ch)
        }
      }
      return sb.append('"').toString()
    }
  }
}

sealed class RelayParse {
  class Ok(val config: RelayConfig) : RelayParse()
  class Err(val code: String) : RelayParse()
  /** callRelay が無い（旧い開始）。中継は使わない */
  object Absent : RelayParse()
}
