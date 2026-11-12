package dev.disnans.notifier

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Log
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.util.concurrent.Executors

/** 最近の画像（添付パネル）とクリップボード（画像・文字・有無）。権限は初回のパネルで求め、拒否なら空の一覧 */
internal class NotifierMedia(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity
  private val mediaExecutor by lazy { Executors.newSingleThreadExecutor() }

  /** 写真の読み取りの状態。granted / limited（部分的な許可）/ denied */
  private fun photoPermission(): String {
    if (Build.VERSION.SDK_INT >= 33) {
      return when {
        bridge.permissionState("media") == PermissionState.GRANTED -> "granted"
        Build.VERSION.SDK_INT >= 34 && bridge.permissionState("visual") == PermissionState.GRANTED -> "limited"
        else -> "denied"
      }
    }
    return if (bridge.permissionState("storage") == PermissionState.GRANTED) "granted" else "denied"
  }

  private fun permissionObject(): JSObject {
    val ret = JSObject()
    ret.put("permission", photoPermission())
    return ret
  }

  /** 新しい写真の一覧。許可が無ければ空（ダイアログは出さない） */
  fun recentImages(invoke: Invoke) {
    val args = invoke.parseArgs(RecentImagesArgs::class.java)
    val permission = photoPermission()
    Log.i(LOG_TAG, "[photos] recent_images permission=$permission sdk=${Build.VERSION.SDK_INT}")
    if (permission == "denied") {
      val ret = JSObject()
      ret.put("permission", permission)
      ret.put("images", JSArray())
      invoke.resolve(ret)
      return
    }
    val limit = args.limit.coerceIn(1, 60)
    mediaExecutor.execute {
      try {
        val arr = JSArray()
        for (item in RecentImages.list(activity, limit)) arr.put(item)
        val ret = JSObject()
        ret.put("permission", permission)
        ret.put("images", arr)
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "一覧を作れませんでした") }
      }
    }
  }

  /**
   * 許可を求める。結果の permission を返す。
   * 34 以上は READ_MEDIA_IMAGES と READ_MEDIA_VISUAL_USER_SELECTED を一緒に求める（片方だけだと部分的な許可の選択肢が出ない）。
   * 部分的な許可のときも、全部の許可へ上げられるように求め直す（システムが出すかは OS の判断）。
   */
  fun requestRecentImagesPermission(invoke: Invoke) {
    val state = photoPermission()
    if (state == "granted") {
      invoke.resolve(permissionObject())
      return
    }
    val aliases = when {
      Build.VERSION.SDK_INT >= 34 -> arrayOf("media", "visual")
      Build.VERSION.SDK_INT >= 33 -> arrayOf("media")
      else -> arrayOf("storage")
    }
    Log.i(LOG_TAG, "[photos] request permission from=$state aliases=${aliases.joinToString()}")
    bridge.requestPermissions(aliases, invoke, RECENT_PERMISSION_CALLBACK)
  }

  /** 許可の結果（@PermissionCallback から） */
  fun recentPermissionResult(invoke: Invoke) {
    invoke.resolve(permissionObject())
  }

  /** 写真 1 枚の本体（base64）。id は recentImages の id（content URI） */
  fun readImage(invoke: Invoke) {
    val args = invoke.parseArgs(ReadImageArgs::class.java)
    if (photoPermission() == "denied") {
      invoke.reject("写真へのアクセスが許可されていません", "denied")
      return
    }
    mediaExecutor.execute {
      try {
        val ret = RecentImages.read(activity, args.id)
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "読めませんでした") }
      }
    }
  }

  /**
   * クリップボードの画像（前面のときだけ読める）。画像が無ければ null（`resolve()` は JS の null）。
   * 画像の URI（MIME が画像と分かるもの）を、写真と同じ上限で読む。
   */
  fun clipboardImage(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val clip = clipboard?.primaryClip
    var found: Uri? = null
    var foundMime = ""
    if (clip != null) {
      for (i in 0 until clip.itemCount) {
        val candidate = clip.getItemAt(i).uri ?: continue
        val type = activity.contentResolver.getType(candidate) ?: continue
        if (type.startsWith("image/")) {
          found = candidate
          foundMime = type
          break
        }
      }
    }
    val uri = found
    if (uri == null) {
      invoke.resolve()
      return
    }
    val mime = foundMime
    mediaExecutor.execute {
      try {
        val ret = RecentImages.clipboard(activity, uri, mime)
        activity.runOnUiThread { invoke.resolve(ret) }
      } catch (ex: Exception) {
        activity.runOnUiThread { invoke.reject(ex.message ?: "読めませんでした") }
      }
    }
  }

  /**
   * クリップボードに何があるか（中身は読まない）。{ text, image } の真偽。
   * 説明（primaryClipDescription）だけを見るので、Android 12 以降の「貼り付けました」の通知は出ない
   */
  fun clipboardPeek(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val desc = clipboard?.primaryClipDescription
    var text = false
    var image = false
    if (desc != null) {
      for (i in 0 until desc.mimeTypeCount) {
        val type = desc.getMimeType(i)
        if (type.startsWith("text/")) text = true
        if (type.startsWith("image/")) image = true
      }
    }
    val ret = JSObject()
    ret.put("text", text)
    ret.put("image", image)
    invoke.resolve(ret)
  }

  /** クリップボードの文字（前面のときだけ読める）。文字が無ければ null（`resolve()` は JS の null） */
  fun clipboardText(invoke: Invoke) {
    val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
    val clip = clipboard?.primaryClip
    if (clip == null || clip.itemCount == 0 || !clip.description.hasMimeType("text/*")) {
      invoke.resolve()
      return
    }
    val text = clip.getItemAt(0).coerceToText(activity)?.toString()
    if (text.isNullOrEmpty()) {
      invoke.resolve()
      return
    }
    val ret = JSObject()
    ret.put("text", text)
    invoke.resolve(ret)
  }

  companion object {
    private const val LOG_TAG = "disnans"
    /** @PermissionCallback の名前（プラグインの同名のメソッドに対応する） */
    const val RECENT_PERMISSION_CALLBACK = "recentImagesPermissionCallback"
  }
}
