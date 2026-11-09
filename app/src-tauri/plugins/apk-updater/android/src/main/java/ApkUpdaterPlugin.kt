package dev.disnans.apkupdater

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.system.ErrnoException
import android.system.OsConstants
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

class ApkFileProvider : FileProvider()

@InvokeArg
class DownloadArgs {
  lateinit var url: String
  var onProgress: Channel? = null
}

@InvokeArg
class SaveDownloadArgs {
  lateinit var path: String
  lateinit var name: String
  var mime: String? = null
}

@InvokeArg
class OpenDownloadArgs {
  lateinit var uri: String
  var mime: String? = null
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

  /**
   * キャッシュの一時ファイル（Rust が書いたもの）を、ダウンロードフォルダへ保存する（MediaStore。Android 10 以降）。
   * 結果は uri と name。失敗は code（invalid / unsupported / no_space / permission / io）だけ返す。一時ファイルは Rust が消す。
   */
  @Command
  fun saveDownload(invoke: Invoke) {
    val args = invoke.parseArgs(SaveDownloadArgs::class.java)
    Thread {
      try {
        invoke.resolve(saveToDownloads(args))
      } catch (ex: Throwable) {
        invoke.resolve(failure(JSObject(), codeFor(ex)))
      }
    }.start()
  }

  private fun saveToDownloads(args: SaveDownloadArgs): JSObject {
    val out = JSObject()
    val src = File(args.path)
    if (!DownloadRules.isInside(src, activity.cacheDir)) return failure(out, "invalid")
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return failure(out, "unsupported")
    val resolver = activity.contentResolver
    val name = DownloadRules.sanitizeName(args.name)
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, DownloadRules.normalizeMime(args.mime))
      put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val uri: Uri = try {
      resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
    } catch (ex: Exception) {
      return failure(out, codeFor(ex))
    } ?: return failure(out, "io")
    try {
      val output = resolver.openOutputStream(uri) ?: throw IOException("保存先を開けません")
      output.use { o -> src.inputStream().use { it.copyTo(o) } }
      val done = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
      resolver.update(uri, done, null, null)
      out.put("uri", uri.toString())
      out.put("name", displayName(uri) ?: name)
      return out
    } catch (ex: Exception) {
      // 途中まで書いた保存先は残さない（保留中の行を消す）
      try {
        resolver.delete(uri, null, null)
      } catch (_: Exception) {
      }
      return failure(out, codeFor(ex))
    }
  }

  private fun displayName(uri: Uri): String? =
    activity.contentResolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }

  /** 例外の原因の鎖をたどり、空き容量の不足だけ no_space にする（ほかは io・権限は permission） */
  private fun codeFor(ex: Throwable): String {
    var cur: Throwable? = ex
    while (cur != null) {
      if (cur is ErrnoException && cur.errno == OsConstants.ENOSPC) return "no_space"
      if (cur is SecurityException) return "permission"
      cur = cur.cause
    }
    return "io"
  }

  private fun failure(out: JSObject, code: String): JSObject {
    out.put("code", code)
    return out
  }

  /** 保存したファイルを、それを開けるアプリで開く（ACTION_VIEW・読み取りだけの権限）。MediaStore の保存先以外は開かない */
  @Command
  fun openDownload(invoke: Invoke) {
    val args = invoke.parseArgs(OpenDownloadArgs::class.java)
    val out = JSObject()
    val uri = Uri.parse(args.uri)
    if (!DownloadRules.isDownloadUri(uri.authority, uri.path)) {
      invoke.resolve(failure(out, "invalid"))
      return
    }
    try {
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, DownloadRules.normalizeMime(args.mime))
        clipData = ClipData.newRawUri(null, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
      invoke.resolve(out)
    } catch (_: ActivityNotFoundException) {
      invoke.resolve(failure(out, "no_app"))
    } catch (ex: Exception) {
      invoke.resolve(failure(out, "io"))
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
