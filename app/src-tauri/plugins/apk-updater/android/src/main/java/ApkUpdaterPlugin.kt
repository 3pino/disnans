package dev.disnans.apkupdater

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class ApkFileProvider : FileProvider()

@InvokeArg
class DownloadArgs {
  lateinit var url: String
  var onProgress: Channel? = null
}

@TauriPlugin
class ApkUpdaterPlugin(private val activity: Activity) : Plugin(activity) {
  private fun canInstallPackages(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  @Command
  fun canInstall(invoke: Invoke) {
    val ret = JSObject()
    ret.put("granted", canInstallPackages())
    invoke.resolve(ret)
  }

  /** 「不明なアプリのインストール」の設定画面を開く（Android 8 以降） */
  @Command
  fun openInstallSettings(invoke: Invoke) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        activity.startActivity(intent)
      }
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }

  /** APK をキャッシュにダウンロードし、システムのインストーラーを開く */
  @Command
  fun downloadAndInstall(invoke: Invoke) {
    val args = invoke.parseArgs(DownloadArgs::class.java)
    Thread {
      try {
        val dir = File(activity.cacheDir, "updates")
        dir.deleteRecursively()
        dir.mkdirs()
        val file = File(dir, "update.apk")
        download(args.url, file, args.onProgress)
        install(file)
        invoke.resolve()
      } catch (ex: Exception) {
        invoke.reject(ex.message ?: ex.toString())
      }
    }.start()
  }

  private fun download(url: String, file: File, progress: Channel?) {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.instanceFollowRedirects = true
    conn.connectTimeout = 15_000
    conn.readTimeout = 30_000
    try {
      if (conn.responseCode !in 200..299) throw Exception("ダウンロードに失敗しました (HTTP ${conn.responseCode})")
      val total = conn.contentLengthLong
      var downloaded = 0L
      var lastSent = 0L
      conn.inputStream.use { input ->
        file.outputStream().use { output ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            output.write(buf, 0, n)
            downloaded += n
            val now = System.currentTimeMillis()
            if (progress != null && now - lastSent > 150) {
              lastSent = now
              progress.send(progressObj(downloaded, total))
            }
          }
        }
      }
      progress?.send(progressObj(downloaded, total))
    } finally {
      conn.disconnect()
    }
  }

  private fun progressObj(downloaded: Long, total: Long): JSObject {
    val o = JSObject()
    o.put("downloaded", downloaded)
    o.put("total", if (total > 0) total else null)
    return o
  }

  private fun install(file: File) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.apkupdater", file)
    @Suppress("DEPRECATION")
    val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    try {
      activity.startActivity(intent)
    } catch (_: ActivityNotFoundException) {
      intent.action = Intent.ACTION_VIEW
      activity.startActivity(intent)
    }
  }
}
