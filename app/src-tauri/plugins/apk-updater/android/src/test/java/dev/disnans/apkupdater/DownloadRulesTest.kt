package dev.disnans.apkupdater

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 保存名・型・保存先の判定（JVM。Android の API は使わない） */
class DownloadRulesTest {
  @Test
  fun sanitizeKeepsNormalNamesAndDropsSeparators() {
    assertEquals("photo.png", DownloadRules.sanitizeName("photo.png"))
    assertEquals("a_b_c.txt", DownloadRules.sanitizeName("a/b\\c.txt"))
    assertEquals("a_b_.txt", DownloadRules.sanitizeName("a\u0000b\u001f.txt"))
    assertEquals("a_b.txt", DownloadRules.sanitizeName("a\nb.txt"))
  }

  @Test
  fun sanitizeFallsBackForEmptyAndDots() {
    assertEquals("download", DownloadRules.sanitizeName(""))
    assertEquals("download", DownloadRules.sanitizeName("   "))
    assertEquals("download", DownloadRules.sanitizeName("."))
    assertEquals("download", DownloadRules.sanitizeName(".."))
    assertEquals("name", DownloadRules.sanitizeName("name. "))
  }

  @Test
  fun sanitizeCapsTheLength() {
    val long = "a".repeat(300) + ".pdf"
    assertEquals(200, DownloadRules.sanitizeName(long).length)
  }

  @Test
  fun dotfilesKeepTheirName() {
    assertEquals(".bashrc", DownloadRules.sanitizeName(".bashrc"))
  }

  @Test
  fun mimeIsKeptWhenWellFormedAndDefaultsOtherwise() {
    assertEquals("image/png", DownloadRules.normalizeMime("image/png"))
    assertEquals("application/pdf", DownloadRules.normalizeMime(" Application/PDF "))
    assertEquals("application/octet-stream", DownloadRules.normalizeMime(null))
    assertEquals("application/octet-stream", DownloadRules.normalizeMime(""))
    assertEquals("application/octet-stream", DownloadRules.normalizeMime("text/html; charset=x"))
    assertEquals("application/octet-stream", DownloadRules.normalizeMime("bad"))
    assertEquals("application/octet-stream", DownloadRules.normalizeMime("a/b/c"))
  }

  @Test
  fun onlyMediaStoreDownloadsCanBeOpened() {
    assertTrue(DownloadRules.isDownloadUri("media", "/external/downloads/42"))
    assertTrue(DownloadRules.isDownloadUri("media", "/external_primary/downloads/42"))
    assertFalse(DownloadRules.isDownloadUri("media", "/external/images/media/42"))
    assertFalse(DownloadRules.isDownloadUri("com.other", "/external/downloads/42"))
    assertFalse(DownloadRules.isDownloadUri("media", null))
  }

  @Test
  fun insideMeansStrictlyUnderTheDirectory() {
    val root = Files.createTempDirectory("dl-rules").toFile()
    try {
      val cache = File(root, "cache").apply { mkdirs() }
      val inside = File(cache, "downloads/x.part").apply { parentFile.mkdirs(); writeText("x") }
      assertTrue(DownloadRules.isInside(inside, cache))
      assertFalse(DownloadRules.isInside(cache, cache))
      assertFalse(DownloadRules.isInside(File(root, "other.txt").apply { writeText("y") }, cache))
      assertFalse(DownloadRules.isInside(File(cache, "../other.txt"), cache))
      // シンボリックリンクで外へ出る場合は、外として扱う（リンクを辿った先で決める）
      val outside = File(root, "secret.txt").apply { writeText("s") }
      val link = File(cache, "link.txt")
      try {
        Files.createSymbolicLink(link.toPath(), outside.toPath())
        assertFalse(DownloadRules.isInside(link, cache))
      } catch (_: UnsupportedOperationException) {
        // このファイルシステムはリンクを作れない（確かめない）
      }
    } finally {
      root.deleteRecursively()
    }
  }
}
