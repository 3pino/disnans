package dev.disnans.notifier

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.TimeUnit

/**
 * 既読の位置の同期（常駐サービス）。通知の取り下げと、既読の通知を出さないことの元になる。
 *
 * - 接続（hello）のたびに、そのアカウントの既読の位置を `GET /api/me/read` で読む（サーバーの権威ある値。
 *   サーバーは hello に既読の位置を入れないため、落ちていた間に読んだものもここで追いつく）。
 * - 以後の `read.updated` で進める。位置は進むだけ。
 * - 結果と通信は、接続の世代（SyncOwner）とアカウントで確かめてから使う。古い接続・ほかのアカウント・停止後は捨てる。
 * - ログは固定の語と件数だけ（ID・サーバー・ユーザー・本文・例外は出さない）。
 *
 * このファイルは Android の部品を使わない（JVM のテストで、偽物の口を使って確かめる）。
 */

/** 既読の位置を読んだ結果。失敗は固定の理由だけ */
internal sealed class ReadFetch {
  data class Ok(val lastRead: String) : ReadFetch()
  data class Failed(val code: String) : ReadFetch()
}

/** 既読の位置を取りに行く口（本物は HTTP）。callback はどのスレッドから呼ばれてもよい。戻り値で取り消せる */
internal fun interface ReadMarkerSource {
  fun fetch(base: String, callback: (ReadFetch) -> Unit): () -> Unit
}

/** アカウントごとの既読の位置の保存（本物は Prefs） */
internal interface MarkerStore {
  fun lastRead(account: String): String?
  fun setLastRead(account: String, messageId: String)
}

/** 表示中の通知の口（本物は NotificationManager） */
internal interface NoteStore {
  fun active(): List<NotifyPolicy.ActiveNote>
  fun cancel(tag: String?, id: Int)
}

private val mapper = ObjectMapper()

/**
 * `GET /api/me/read` の応答（配列の先頭の last_read_id）を読む。
 * 失敗の理由は固定: http（2xx 以外）・parse（形が違う）。
 */
internal fun readMarkerFrom(status: Int, body: String?): ReadFetch {
  if (status !in 200..299) return ReadFetch.Failed("http")
  val node: JsonNode = try {
    mapper.readTree(body.orEmpty()) ?: return ReadFetch.Failed("parse")
  } catch (ex: Exception) {
    return ReadFetch.Failed("parse")
  }
  val id = if (node.isArray && node.size() > 0) node[0].get("last_read_id")?.takeIf { it.isTextual }?.asText() else null
  return if (id.isNullOrEmpty()) ReadFetch.Failed("parse") else ReadFetch.Ok(id)
}

/** 既読の位置を読むための HTTP の口。接続・読み取りの各段と、1 回の全体の上限（15 秒）で切る */
internal fun newReadMarkerClient(): OkHttpClient = OkHttpClient.Builder()
  .connectTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  .callTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
  .build()

internal const val READ_TIMEOUT_SECONDS = 15L

/**
 * 通信の失敗の固定の理由。全体の時間切れ（callTimeout・読み取りの時間切れ）は InterruptedIOException。
 * 取り消しは OkHttp が canceled を立てる（時間切れでも立つので、先に時間切れを見る）。例外の中身は使わない。
 */
internal fun failureCode(call: Call, e: IOException): String = when {
  e is InterruptedIOException -> "timeout"
  call.isCanceled() -> "canceled"
  else -> "network"
}

/** 既読の位置の本物の取得（HTTP。WebSocket と同じ端末の身元で届く） */
internal class OkReadMarkerSource(private val client: OkHttpClient) : ReadMarkerSource {
  override fun fetch(base: String, callback: (ReadFetch) -> Unit): () -> Unit {
    val request = try {
      Request.Builder().url("$base/api/me/read").get().build()
    } catch (ex: IllegalArgumentException) {
      callback(ReadFetch.Failed("url"))
      return {}
    }
    val call = client.newCall(request)
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        callback(ReadFetch.Failed(failureCode(call, e)))
      }

      override fun onResponse(call: Call, response: Response) {
        // 本文の読み取りは途中で切れることがある（IOException）。OkHttp の受け手で投げると、そのまま落ちるので、ここで受ける
        val result = try {
          response.use { r -> readMarkerFrom(r.code, r.body?.string()) }
        } catch (ex: IOException) {
          ReadFetch.Failed(failureCode(call, ex))
        }
        callback(result)
      }
    })
    return { call.cancel() }
  }
}

/**
 * 接続の持ち主: どの接続（世代）と、どのアカウントの結果を使ってよいかを決める。
 * 接続（つなぎ直し・回線の切り替え）ごとに世代を進め、古い世代の受信・通信の結果は使わない。
 * 停止したら、以後は何も使わない。通信は持ち主が取り消す（捨てるときに止める）。
 * 呼ぶのはメインのスレッドだけ（通信の結果は、呼ぶ前にメインへ移す）。
 */
internal class SyncOwner {
  var generation: Long = 0L
    private set
  var stopped: Boolean = false
    private set
  private var account: String? = null
  private var inFlight: (() -> Unit)? = null

  /** 接続を始める（つなぎ直し・回線の切り替え）。前の接続の結果と通信は捨てる。新しい世代を返す */
  fun beginConnection(): Long {
    generation++
    account = null
    cancelInFlight()
    return generation
  }

  /** 停止する。以後はどの世代の結果も使わない */
  fun stop() {
    stopped = true
    generation++
    account = null
    cancelInFlight()
  }

  /** 世代がまだ今のもので、停止していないか */
  fun isCurrent(gen: Long): Boolean = !stopped && gen == generation

  /** この世代で分かっているアカウント（今の世代でなければ null） */
  fun accountFor(gen: Long): String? = if (isCurrent(gen)) account else null

  /** hello で分かったアカウントを、この世代に決める（今の世代のときだけ） */
  fun setAccount(gen: Long, key: String): Boolean {
    if (!isCurrent(gen)) return false
    account = key
    return true
  }

  /** この世代・このアカウントの結果を使ってよいか */
  fun isCurrentAccount(gen: Long, key: String): Boolean = isCurrent(gen) && account == key

  /** 進行中の通信を持つ。次に捨てるとき（接続・アカウント・停止）取り消す */
  fun track(cancel: () -> Unit) {
    cancelInFlight()
    inFlight = cancel
  }

  private fun cancelInFlight() {
    val c = inFlight
    inFlight = null
    c?.invoke()
  }
}

/** 既読の位置の同期本体（SyncOwner の判断に従い、既読の位置を進め、通知を取り下げる） */
internal class ReadSync(
  private val owner: SyncOwner,
  private val source: ReadMarkerSource,
  private val markers: MarkerStore,
  private val notes: NoteStore,
  /** 結果をメインのスレッドで処理するための口（テストでは同じスレッドで実行する） */
  private val post: (() -> Unit) -> Unit,
  private val log: (String) -> Unit,
) {
  /** hello: この接続のアカウントが分かった。既読の位置を読む */
  fun onHello(gen: Long, base: String, userId: String) {
    if (!owner.isCurrent(gen)) return
    if (userId.isEmpty()) {
      log("read-sync skipped reason=no-user")
      return
    }
    val key = NotifyPolicy.accountKey(base, userId)
    owner.setAccount(gen, key)
    val cancel = source.fetch(base) { result -> post { onFetched(gen, key, result) } }
    owner.track(cancel)
  }

  private fun onFetched(gen: Long, key: String, result: ReadFetch) {
    if (!owner.isCurrentAccount(gen, key)) {
      log("read-sync dropped reason=stale")
      return
    }
    when (result) {
      is ReadFetch.Ok -> applyMarker(key, result.lastRead)
      is ReadFetch.Failed -> log("read-sync failed reason=${result.code}")
    }
  }

  /** read.updated: この接続のアカウントの既読の位置が進んだ */
  fun onReadUpdated(gen: Long, lastRead: String?) {
    val key = owner.accountFor(gen) ?: return
    if (lastRead.isNullOrEmpty()) return
    applyMarker(key, lastRead)
  }

  /** 既読の位置を進め（戻さない）、そこまで読んだこのアカウントの通知を取り下げる。取り下げた件数を返す */
  fun applyMarker(key: String, lastRead: String): Int {
    val prev = markers.lastRead(key)
    val next = NotifyPolicy.maxMarker(prev, lastRead) ?: return 0
    if (next != prev) markers.setLastRead(key, next)
    val targets = NotifyPolicy.cancelTargets(notes.active(), key, next)
    for (t in targets) notes.cancel(t.tag, t.id)
    if (targets.isNotEmpty()) log("read-sync cancelled count=${targets.size}")
    return targets.size
  }
}

/** サーバーからの 1 件の意味（通知サービスが使う分だけ） */
internal sealed class ServerMessage {
  data class Hello(val userId: String) : ServerMessage()
  data class ReadUpdated(val lastRead: String?) : ServerMessage()
  object Notify : ServerMessage()
  object Other : ServerMessage()
}

internal fun parseServerMessage(text: String): ServerMessage {
  val node: JsonNode? = try {
    mapper.readTree(text)
  } catch (ex: Exception) {
    null
  }
  if (node == null) return ServerMessage.Other
  return when (node.get("type")?.asText()) {
    "hello" -> ServerMessage.Hello(node.get("me")?.get("id")?.takeIf { it.isTextual }?.asText().orEmpty())
    "read.updated" -> ServerMessage.ReadUpdated(node.get("marker")?.get("last_read_id")?.takeIf { it.isTextual }?.asText())
    "notify" -> ServerMessage.Notify
    else -> ServerMessage.Other
  }
}

/**
 * WebSocket の 1 件を処理する（メインのスレッドで呼ぶ）。
 * hello と read.updated は既読の同期へ。notify は onNotify へ（表示は通知サービスが決める）。
 */
internal fun handleServerText(text: String, gen: Long, base: String, sync: ReadSync, owner: SyncOwner, onNotify: () -> Unit) {
  if (!owner.isCurrent(gen)) return
  when (val msg = parseServerMessage(text)) {
    is ServerMessage.Hello -> sync.onHello(gen, base, msg.userId)
    is ServerMessage.ReadUpdated -> sync.onReadUpdated(gen, msg.lastRead)
    ServerMessage.Notify -> onNotify()
    ServerMessage.Other -> Unit
  }
}
