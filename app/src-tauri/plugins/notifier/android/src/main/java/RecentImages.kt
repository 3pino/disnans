package dev.disnans.notifier

import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * 写真アプリの最新の写真（MediaStore）の一覧・サムネイル・本体。
 * 権限の確認は呼び出し側（NotifierPlugin）が行う。一覧は JS の添付パネルが使う。
 */
object RecentImages {
  /** サムネイルの長辺（px） */
  const val THUMB_EDGE = 256

  /** 本体の上限。JS が全体を base64 で受けるので、共有と同じにしている */
  const val MAX_BODY_BYTES = 200L * 1024 * 1024

  private const val MEDIA_AUTHORITY = "media"

  private val PROJECTION = arrayOf(
    MediaStore.Images.Media._ID,
    MediaStore.Images.Media.DISPLAY_NAME,
    MediaStore.Images.Media.MIME_TYPE,
    MediaStore.Images.Media.DATE_MODIFIED,
    MediaStore.Images.Media.WIDTH,
    MediaStore.Images.Media.HEIGHT,
    MediaStore.Images.Media.ORIENTATION,
  )

  /**
   * 新しい順に最大 `limit` 件。MediaStore の画像はすべて（拡張子では絞らない）。
   * サムネイルが作れないものは thumb を null にして残す。部分的な許可のときは、MediaStore が許可された写真だけを返す。
   */
  fun list(context: Context, limit: Int): List<JSObject> {
    val resolver = context.contentResolver
    val collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val out = ArrayList<JSObject>()
    val cursor = resolver.query(
      collection,
      PROJECTION,
      null,
      null,
      "${MediaStore.Images.Media.DATE_MODIFIED} DESC"
    ) ?: return out
    cursor.use { c ->
      val idCol = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
      val nameCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DISPLAY_NAME)
      val mimeCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
      val modCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_MODIFIED)
      val widthCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.WIDTH)
      val heightCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.HEIGHT)
      val orientCol = c.getColumnIndexOrThrow(MediaStore.Images.Media.ORIENTATION)
      while (out.size < limit && c.moveToNext()) {
        val itemUri = ContentUris.withAppendedId(collection, c.getLong(idCol))
        // BitmapFactory が読めない形式（HEIC など）も一覧に残す。サムネイルは null（GUI が名前の枠を出す）
        val thumb = thumbOf(resolver, itemUri, c.getInt(orientCol))
        val item = JSObject()
        item.put("id", itemUri.toString())
        item.put("name", c.getString(nameCol) ?: "image")
        item.put("mime", c.getString(mimeCol) ?: "image/jpeg")
        // DATE_MODIFIED は秒。JS は ms で扱う
        item.put("modified", c.getLong(modCol) * 1000L)
        item.put("width", dimension(c.getInt(widthCol)))
        item.put("height", dimension(c.getInt(heightCol)))
        item.put("thumb", thumb ?: JSONObject.NULL)
        out.add(item)
      }
    }
    return out
  }

  /** 写真の本体（base64）。MediaStore の画像だけ読む（ほかの provider の URI は受け付けない） */
  fun read(context: Context, id: String): JSObject {
    val uri = Uri.parse(id)
    if (uri.scheme != "content" || uri.authority != MEDIA_AUTHORITY) {
      throw IllegalArgumentException("写真ではありません")
    }
    val resolver = context.contentResolver
    return body(resolver, uri, displayName(resolver, uri) ?: uri.lastPathSegment ?: "image", resolver.getType(uri))
  }

  /** クリップボードの画像（content URI）の本体（base64）。呼び出し側が image/* を確かめた URI だけ渡す */
  fun clipboard(context: Context, uri: Uri, mime: String): JSObject {
    val resolver = context.contentResolver
    val name = displayName(resolver, uri) ?: "clipboard.${extensionOf(mime)}"
    return body(resolver, uri, name, mime)
  }

  private fun body(resolver: ContentResolver, uri: Uri, name: String, mime: String?): JSObject {
    val input = resolver.openInputStream(uri) ?: throw IllegalStateException("開けませんでした")
    val bytes = input.use { readLimited(it) }
    val ret = JSObject()
    ret.put("name", name)
    ret.put("mime", mime ?: "application/octet-stream")
    ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    return ret
  }

  private fun displayName(resolver: ContentResolver, uri: Uri): String? {
    var name: String? = null
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
      if (c.moveToFirst()) {
        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (i >= 0 && !c.isNull(i)) name = c.getString(i)
      }
    }
    return name
  }

  private fun extensionOf(mime: String): String = when (mime) {
    "image/png" -> "png"
    "image/jpeg" -> "jpg"
    "image/webp" -> "webp"
    "image/gif" -> "gif"
    "image/bmp" -> "bmp"
    else -> "img"
  }

  private fun readLimited(input: InputStream): ByteArray {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val n = input.read(buf)
      if (n < 0) break
      total += n
      if (total > MAX_BODY_BYTES) {
        throw IllegalArgumentException("大きすぎます（${MAX_BODY_BYTES / 1024 / 1024} MB まで）")
      }
      out.write(buf, 0, n)
    }
    return out.toByteArray()
  }

  /** 0 以下は不明（null）。JSON の null として入れる */
  private fun dimension(px: Int): Any = if (px > 0) px else JSONObject.NULL

  /**
   * 長辺 THUMB_EDGE の JPEG（data URL）。`orientation` は MediaStore の ORIENTATION（時計回りの度）で、
   * その分だけ回してから作る。読めないときは null（一覧に入れない）。
   */
  private fun thumbOf(resolver: ContentResolver, uri: Uri, orientation: Int): String? {
    val bounds = BitmapFactory.Options()
    bounds.inJustDecodeBounds = true
    val probe = resolver.openInputStream(uri) ?: return null
    probe.use { BitmapFactory.decodeStream(it, null, bounds) }
    val longest = maxOf(bounds.outWidth, bounds.outHeight)
    if (longest <= 0) return null

    // 2 のべき乗で間引いて読み、最後に THUMB_EDGE へ縮める（メモリを抑える）
    var sample = 1
    while (longest / (sample * 2) >= THUMB_EDGE) sample *= 2
    val opts = BitmapFactory.Options()
    opts.inSampleSize = sample
    val input = resolver.openInputStream(uri) ?: return null
    val decoded = input.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null

    val edge = maxOf(decoded.width, decoded.height)
    val scaled = if (edge > THUMB_EDGE) {
      val scale = THUMB_EDGE.toFloat() / edge
      Bitmap.createScaledBitmap(
        decoded,
        maxOf(1, (decoded.width * scale).toInt()),
        maxOf(1, (decoded.height * scale).toInt()),
        true
      )
    } else {
      decoded
    }
    val degrees = ((orientation % 360) + 360) % 360
    val upright = if (degrees != 0) {
      Bitmap.createBitmap(
        scaled,
        0,
        0,
        scaled.width,
        scaled.height,
        Matrix().apply { postRotate(degrees.toFloat()) },
        true
      )
    } else {
      scaled
    }
    val out = ByteArrayOutputStream()
    val ok = upright.compress(Bitmap.CompressFormat.JPEG, 80, out)
    if (upright !== scaled) upright.recycle()
    if (scaled !== decoded) scaled.recycle()
    decoded.recycle()
    if (!ok) return null
    return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
  }
}
