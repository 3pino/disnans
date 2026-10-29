package dev.disnans.notifier

import android.app.Activity
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.NotificationManager
import android.app.usage.UsageStatsManager
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.os.Build
import android.os.PowerManager
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 診断ログに添える、デバイスの状態（通知が来ない・通話が切れるの原因になりやすい設定）と、ログの共有。
 * 共有は、アプリの FileProvider（gen/android の manifest の `${applicationId}.fileprovider`。cache-path を公開している）を使う。
 */
object DiagReport {
  private const val EXPORT_DIR = "diag-export"
  private const val MAX_EXITS = 10

  fun appVersion(context: Context): String = try {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    @Suppress("DEPRECATION")
    val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
    "${info.versionName} ($code)"
  } catch (ex: Exception) {
    "?"
  }

  /** 人が読む形の、デバイスの状態（1 行 1 項目） */
  fun device(activity: Activity): String {
    val lines = ArrayList<String>()
    fun add(name: String, value: () -> Any?) {
      lines.add("$name: ${try { value() } catch (ex: Exception) { "?（${ex.javaClass.simpleName}）" }}")
    }
    val prefs = Prefs(activity)
    val nm = activity.getSystemService(NotificationManager::class.java)
    val pm = activity.getSystemService(PowerManager::class.java)
    val am = activity.getSystemService(ActivityManager::class.java)

    add("アプリ") { appVersion(activity) }
    add("機種") { "${Build.MANUFACTURER} ${Build.MODEL}（${Build.DEVICE}）" }
    add("Android") { "${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）" }
    add("WebView") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } else "?"
    }
    add("通知の許可") { nm.areNotificationsEnabled() }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      for (id in listOf("messages", "connection", "call")) {
        add("通知チャンネル $id の重要度") { nm.getNotificationChannel(id)?.importance ?: "（未作成）" }
      }
    }
    add("常駐の設定") { "有効=${prefs.enabled} サーバー=${prefs.serverUrl ?: "（なし）"}" }
    add("常駐サービス") { "動作中=${NotifyService.running} 接続中=${NotifyService.connected}" }
    add("通話のサービス") { "動作中=${CallService.running}" }
    add("ネイティブ通話のサービス") { "動作中=${NativeCallService.running}" }
    add("ネイティブ通話の保存状態") {
      val call = NativeCallPrefs(activity).read()
      "再開希望=${call.wanted} ミュート=${call.status?.muted} スピーカーミュート=${call.status?.deafened}"
    }
    add("電池の最適化の対象外") { pm.isIgnoringBatteryOptimizations(activity.packageName) }
    add("省電力モード") { pm.isPowerSaveMode }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      add("バックグラウンドの制限") { am.isBackgroundRestricted }
      add("アプリの待機バケット") {
        bucketName(activity.getSystemService(UsageStatsManager::class.java).appStandbyBucket)
      }
    }
    add("データセーバー") {
      when (activity.getSystemService(ConnectivityManager::class.java).restrictBackgroundStatus) {
        ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED -> "有効（裏での通信が制限される）"
        ConnectivityManager.RESTRICT_BACKGROUND_STATUS_WHITELISTED -> "有効（このアプリは対象外）"
        else -> "無効"
      }
    }
    add("メモリ") {
      val info = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
      "空き ${info.availMem / 1024 / 1024} MB / 全体 ${info.totalMem / 1024 / 1024} MB 少ない=${info.lowMemory}"
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      lines.add("")
      lines.add("最近プロセスが終わった理由（新しい順）:")
      try {
        val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.US)
        val exits = am.getHistoricalProcessExitReasons(activity.packageName, 0, MAX_EXITS)
        if (exits.isEmpty()) lines.add("  （なし）")
        for (e in exits) {
          lines.add(
            "  ${fmt.format(Date(e.timestamp))} ${exitReasonName(e.reason)} 重要度=${e.importance} " +
              "pss=${e.pss / 1024}MB ${e.processName} ${e.description.orEmpty()}"
          )
        }
      } catch (ex: Exception) {
        lines.add("  （読めませんでした: ${ex.message}）")
      }
    }
    return lines.joinToString("\n")
  }

  private fun bucketName(bucket: Int): String = when (bucket) {
    UsageStatsManager.STANDBY_BUCKET_ACTIVE -> "ACTIVE"
    UsageStatsManager.STANDBY_BUCKET_WORKING_SET -> "WORKING_SET"
    UsageStatsManager.STANDBY_BUCKET_FREQUENT -> "FREQUENT"
    UsageStatsManager.STANDBY_BUCKET_RARE -> "RARE"
    UsageStatsManager.STANDBY_BUCKET_RESTRICTED -> "RESTRICTED"
    else -> bucket.toString()
  }

  @RequiresApi(Build.VERSION_CODES.R)
  private fun exitReasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_ANR -> "ANR"
    ApplicationExitInfo.REASON_CRASH -> "CRASH"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "CRASH_NATIVE"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "DEPENDENCY_DIED"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "EXCESSIVE_RESOURCE_USAGE"
    ApplicationExitInfo.REASON_EXIT_SELF -> "EXIT_SELF"
    ApplicationExitInfo.REASON_FREEZER -> "FREEZER"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "INITIALIZATION_FAILURE"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "LOW_MEMORY"
    ApplicationExitInfo.REASON_OTHER -> "OTHER"
    ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE -> "PACKAGE_STATE_CHANGE"
    ApplicationExitInfo.REASON_PACKAGE_UPDATED -> "PACKAGE_UPDATED"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "PERMISSION_CHANGE"
    ApplicationExitInfo.REASON_SIGNALED -> "SIGNALED"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "USER_REQUESTED"
    ApplicationExitInfo.REASON_USER_STOPPED -> "USER_STOPPED"
    else -> "UNKNOWN($reason)"
  }

  /** テキストをキャッシュに書き、共有のシートを開く（前に書き出したファイルは消す） */
  fun share(activity: Activity, text: String, name: String) {
    val dir = File(activity.cacheDir, EXPORT_DIR)
    dir.deleteRecursively()
    dir.mkdirs()
    val safe = name.substringAfterLast('/').replace('\\', '_').ifEmpty { "disnans-log.txt" }
    val file = File(dir, safe)
    file.writeText(text)
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = "text/plain"
      putExtra(Intent.EXTRA_STREAM, uri)
      putExtra(Intent.EXTRA_SUBJECT, "disnans の診断ログ")
      // 共有のシートのプレビューと、受け取り側への読み取りの許可
      clipData = ClipData.newRawUri(safe, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(Intent.createChooser(send, "診断ログを送る"))
  }
}
