package dev.disnans.apkupdater

import java.io.File
import java.io.IOException

/**
 * 添付・共有フォルダのファイルの保存と開く操作のうち、Android の API に頼らず決められる部分。
 * JVM のテストで確かめる（DownloadRulesTest）。
 */
object DownloadRules {
  private const val MAX_NAME = 200
  private const val FALLBACK_MIME = "application/octet-stream"
  private val MIME = Regex("^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$")

  /** 保存名。区切り・制御文字は `_`、前後の空白と末尾の `.` は捨てる。空・`.`・`..` は `download` にする（Rust 側でも同じ規則で整えてある） */
  fun sanitizeName(raw: String): String {
    val cleaned = raw
      .map { c -> if (c == '/' || c == '\\' || c.code < 0x20 || c.code == 0x7f) '_' else c }
      .joinToString("")
      .trim()
      .trimEnd('.', ' ')
    val base = if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") "download" else cleaned
    return if (base.length > MAX_NAME) base.substring(0, MAX_NAME) else base
  }

  /** 型（MIME）。形が合わなければ application/octet-stream（開く先を勝手に決めない） */
  fun normalizeMime(raw: String?): String {
    val value = raw?.trim()?.lowercase() ?: return FALLBACK_MIME
    return if (MIME.matches(value)) value else FALLBACK_MIME
  }

  /** MediaStore の保存先（content://media/.../downloads/...）だけ開く。それ以外（ほかのプロバイダー）は開かない */
  fun isDownloadUri(authority: String?, path: String?): Boolean =
    authority == "media" && path != null && path.startsWith("/external") && path.contains("/downloads/")

  /** file が dir の中のものか（シンボリックリンクを辿った先で決める）。dir そのものは含めない */
  fun isInside(file: File, dir: File): Boolean = try {
    val target = file.canonicalFile.toPath()
    val root = dir.canonicalFile.toPath()
    target != root && target.startsWith(root)
  } catch (_: IOException) {
    false
  }
}
