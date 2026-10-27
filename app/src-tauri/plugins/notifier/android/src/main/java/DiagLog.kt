package dev.disnans.notifier

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 診断ログ。logcat（タグ disnans）に出すのと同時に、アプリの内部の領域のファイルにも残す。
 * リリース版では logcat をユーザーから集められないため、設定の「診断ログ」から書き出して開発者に送ってもらう。
 * 常駐サービスはアプリ（WebView）が止まっていても動くので、通知・通話の記録はここに集める。
 *
 * ファイルは [MAX_BYTES] を超えたら 1 世代だけ残して作り直す（合計でおよそ 2 倍まで）。
 * メッセージの本文は書かない（ID や状態だけにする）。
 */
object DiagLog {
  private const val TAG = "disnans"
  private const val DIR = "diag"
  private const val CURRENT = "diag.log"
  private const val PREVIOUS = "diag.1.log"
  private const val MAX_BYTES = 512L * 1024
  private const val MAX_LINE_CHARS = 2000

  private val lock = Any()
  @Volatile private var dir: File? = null
  private val time = object : ThreadLocal<SimpleDateFormat>() {
    override fun initialValue() = SimpleDateFormat("MM-dd HH:mm:ss.SSS", Locale.US)
  }

  /** 書き込み先を決める。アプリ・サービス・受信のどれが先に動いても良いよう、それぞれの入口で呼ぶ */
  fun init(context: Context) {
    if (dir != null) return
    dir = File(context.applicationContext.filesDir, DIR).apply { mkdirs() }
  }

  fun i(message: String) = write('I', message, null)

  fun w(message: String, error: Throwable? = null) = write('W', message, error)

  fun e(message: String, error: Throwable? = null) = write('E', message, error)

  /** JS から届いた行（レベルは info / warn / error / log） */
  fun js(level: String, message: String) {
    val l = when (level) {
      "error" -> 'E'
      "warn" -> 'W'
      else -> 'I'
    }
    write(l, "[js] $message", null)
  }

  private fun write(level: Char, message: String, error: Throwable?) {
    val text = if (error != null) "$message: ${error.javaClass.simpleName}: ${error.message}" else message
    when (level) {
      'E' -> Log.e(TAG, text, error)
      'W' -> Log.w(TAG, text, error)
      else -> Log.i(TAG, text)
    }
    val d = dir ?: return
    val line = "${time.get()!!.format(Date())} $level ${text.take(MAX_LINE_CHARS).replace('\n', ' ')}\n"
    synchronized(lock) {
      try {
        val file = File(d, CURRENT)
        if (file.length() > MAX_BYTES) {
          val old = File(d, PREVIOUS)
          old.delete()
          file.renameTo(old)
        }
        File(d, CURRENT).appendText(line)
      } catch (ex: Exception) {
        // 書けなくても本体の動作は続ける（logcat には出ている）
      }
    }
  }

  /** 古い順の全文（前の世代 → いまの世代） */
  fun read(): String {
    val d = dir ?: return ""
    synchronized(lock) {
      return try {
        listOf(File(d, PREVIOUS), File(d, CURRENT)).filter { it.exists() }.joinToString("") { it.readText() }
      } catch (ex: Exception) {
        "（ログを読めませんでした: ${ex.message}）\n"
      }
    }
  }

  fun clear() {
    val d = dir ?: return
    synchronized(lock) {
      File(d, PREVIOUS).delete()
      File(d, CURRENT).delete()
    }
  }
}
