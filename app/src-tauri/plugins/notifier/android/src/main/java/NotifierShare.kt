package dev.disnans.notifier

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/** 他のアプリからの共有（ACTION_SEND / ACTION_SEND_MULTIPLE）。JS へ届ける。届かない分は take_shared で受け取る */
internal class NotifierShare(private val bridge: NotifierBridge) {
  private val activity get() = bridge.activity
  private val shareLock = Any()
  /** 届け先（JS）がまだ受け取っていない共有。1件 = 1回の共有 */
  private val pendingShares = ArrayList<JSObject>()
  private val shareExecutor = Executors.newSingleThreadExecutor()

  /**
   * 共有の intent なら、content:// のファイルをアプリのキャッシュにコピーして JS に渡す（別スレッドで）。
   * 巨大な base64 を IPC に流さないよう、JS には名前・MIME・キャッシュ上のパスだけを渡し、中身は read_shared_file で読む。
   * 処理した intent は true。
   */
  fun handle(intent: Intent?): Boolean {
    if (intent == null) return false
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
    if (intent.getBooleanExtra(EXTRA_SHARE_HANDLED, false)) return true
    intent.putExtra(EXTRA_SHARE_HANDLED, true)

    val uris = LinkedHashSet<Uri>()
    @Suppress("DEPRECATION")
    if (action == Intent.ACTION_SEND) {
      (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let { uris.add(it) }
    } else {
      intent.getParcelableArrayListExtra<android.os.Parcelable>(Intent.EXTRA_STREAM)?.forEach { (it as? Uri)?.let(uris::add) }
    }
    val clip = intent.clipData
    if (uris.isEmpty() && clip != null) {
      for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
    }
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    val type = intent.type
    // 他のアプリの URI 権限は、この intent を受けている間だけ。コピーが終わるまで intent を保持する
    shareExecutor.execute {
      val item = JSObject()
      val files = JSArray()
      val errors = JSArray()
      cleanShareCache()
      val dir = File(File(activity.cacheDir, SHARE_DIR), UUID.randomUUID().toString())
      for (uri in uris) {
        try {
          files.put(copyShared(uri, type, dir))
        } catch (ex: Exception) {
          errors.put("${uri.lastPathSegment ?: "ファイル"}: ${ex.message ?: ex.javaClass.simpleName}")
        }
      }
      item.put("files", files)
      item.put("errors", errors)
      if (!text.isNullOrEmpty()) item.put("text", text)
      activity.runOnUiThread {
        synchronized(shareLock) { pendingShares.add(item) }
        flush()
      }
    }
    return true
  }

  /** content:// の1ファイルをキャッシュにコピーする。上限を超えたら例外 */
  private fun copyShared(uri: Uri, fallbackType: String?, dir: File): JSObject {
    // file:// などは、このアプリ自身の非公開ファイルを指せてしまうので受け付けない
    if (uri.scheme != "content") throw IllegalArgumentException("対応していない共有です")
    val resolver = activity.contentResolver
    var name: String? = null
    var size = -1L
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        val si = c.getColumnIndex(OpenableColumns.SIZE)
        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
        if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
      }
    }
    if (size > MAX_SHARE_BYTES) throw IllegalArgumentException("大きすぎます（${MAX_SHARE_BYTES / 1024 / 1024} MB まで）")
    val mime = resolver.getType(uri) ?: fallbackType?.takeIf { !it.endsWith("/*") } ?: "application/octet-stream"
    val safe = (name ?: uri.lastPathSegment ?: "shared").substringAfterLast('/').replace('\\', '_').ifEmpty { "shared" }
    dir.mkdirs()
    val out = File(dir, safe)
    var total = 0L
    resolver.openInputStream(uri)?.use { input ->
      out.outputStream().use { o ->
        val buf = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buf)
          if (n < 0) break
          total += n
          if (total > MAX_SHARE_BYTES) {
            o.close()
            out.delete()
            throw IllegalArgumentException("大きすぎます（${MAX_SHARE_BYTES / 1024 / 1024} MB まで）")
          }
          o.write(buf, 0, n)
        }
      }
    } ?: throw IllegalStateException("開けませんでした")
    val f = JSObject()
    f.put("path", out.absolutePath)
    f.put("name", safe)
    f.put("mime", mime)
    f.put("size", total)
    return f
  }

  /** 古い共有のコピーを消す（JS が読み取って消すが、読まれなかった分の掃除） */
  private fun cleanShareCache() {
    val root = File(activity.cacheDir, SHARE_DIR)
    val limit = System.currentTimeMillis() - 24L * 60 * 60 * 1000
    root.listFiles()?.forEach { if (it.lastModified() < limit) it.deleteRecursively() }
  }

  /** リスナー（JS）がいれば、溜まった共有を全部届ける。いなければ take_shared を待つ */
  fun flush() {
    if (!bridge.hasListener("share")) return
    val items = synchronized(shareLock) { ArrayList(pendingShares).also { pendingShares.clear() } }
    for (item in items) bridge.trigger("share", item)
  }

  /** 起動時（コールドスタート）に共有されていた分を受け取る */
  fun take(invoke: Invoke) {
    val arr = JSArray()
    synchronized(shareLock) {
      for (item in pendingShares) arr.put(item)
      pendingShares.clear()
    }
    val ret = JSObject()
    ret.put("shares", arr)
    invoke.resolve(ret)
  }

  fun shutdown() {
    shareExecutor.shutdown()
  }

  companion object {
    private const val EXTRA_SHARE_HANDLED = "dev.disnans.notifier.SHARE_HANDLED"
    private const val SHARE_DIR = "disnans-share"
    /** 1ファイルの上限。サーバーに上限はないが、JS が全体をメモリに読むのでデバイスの都合で決めている */
    private const val MAX_SHARE_BYTES = 200L * 1024 * 1024
  }
}
