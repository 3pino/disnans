package dev.disnans.notifier

/**
 * 二人（と再接続）の結合試験: 状態機械 2 つと、サーバーの規則だけを模した偽のサーバーをつなぐ。
 * 音声の中身は通さず、「届いたか・再生に載ったか」だけを見る（音は ByteArray のまま渡す）。
 * サーバーの規則（calls.rs）: 参加者は接続ごと、同じ peer は別の人が使えない（peer_in_use）、キックは外す。
 * 時計は持たない。タイマーは試験の中で手で発火させる。
 */
object NativeCallTwoPeerTest {
  private val settings = NativeCallSettings(1.0, 1.0, true, -6.0, false, null)
  private val status = NativeCallStatus(false, false, "smartphone")

  private class Client(val name: String, val user: String, peerIds: ArrayDeque<String>, val session: String = "s-$name") {
    val core = NativeCallCore(newPeer = { peerIds.removeFirst() })
    var connected = false
    val played = ArrayList<String>()
    var persisted: CallPersisted? = null
    val timers = ArrayList<Fx.Timer>()
  }

  private class Harness {
    val queue = ArrayDeque<Pair<Client, Input>>()
    val clients = LinkedHashMap<String, Client>()
    /** サーバー側の参加者（peer → 人と状態）。接続（クライアント）の対応も持つ */
    val members = LinkedHashMap<String, NativeCallMember>()
    val connOf = HashMap<String, Client>()

    fun add(name: String, user: String, vararg peers: String): Client {
      val c = Client(name, user, ArrayDeque(peers.toList()))
      clients[name] = c
      return c
    }

    fun run() {
      var guard = 0
      while (queue.isNotEmpty()) {
        check(++guard < 10_000) { "loop" }
        val (c, i) = queue.removeFirst()
        val step = c.core.handle(i)
        for (f in step.fx) exec(c, f)
      }
    }

    private fun exec(c: Client, f: Fx) {
      when (f) {
        is Fx.Connect -> {
          c.connected = true
          queue.add(c to Input.Hello(c.session, c.user))
        }
        is Fx.CloseSocket -> disconnect(c)
        is Fx.Send -> server(c, f.message)
        is Fx.StartService -> queue.add(c to Input.ServiceStarted(c.session, true))
        is Fx.Preflight -> queue.add(c to Input.Preflight(c.session, true, null))
        is Fx.StartAudio -> queue.add(c to Input.AudioStarted(c.session, true, null))
        is Fx.PlayFrame -> c.played.add(f.peer)
        is Fx.PersistWanted -> if (f.wanted) {
          // 保存は番号つきで実行し、結果を届ける（デバイスの層と同じ）
          if (c.core.wantedAttemptCurrent(f.attempt)) c.persisted = CallPersisted(true, f.config, settings, f.status, emptySet(), 1)
          queue.add(c to Input.WantedCommitted(c.session, f.attempt, c.persisted != null))
        } else {
          c.persisted = null
        }
        is Fx.Timer -> c.timers.add(f)
        else -> Unit
      }
    }

    private fun server(c: Client, m: Outbound) {
      when (m) {
        is Outbound.Join -> {
          val other = connOf[m.peer]
          if (other != null && other !== c && other.user != c.user) {
            queue.add(c to Input.ServerError(c.session, "peer_in_use"))
            return
          }
          // 同じ人・同じ peer は、古い接続を置き換える（サーバーの規則）
          members[m.peer] = NativeCallMember(m.peer, c.user, m.status)
          connOf[m.peer] = c
          broadcast()
        }
        Outbound.Leave -> {
          removeConnMembers(c)
          broadcast()
        }
        Outbound.Alive -> Unit
        is Outbound.Update -> {
          val peer = members.values.firstOrNull { connOf[it.peer] === c }?.peer ?: return
          members[peer] = members.getValue(peer).copy(status = m.status)
          broadcast()
        }
        is Outbound.Kick -> {
          val target = connOf[m.peer] ?: return
          members.remove(m.peer)
          connOf.remove(m.peer)
          queue.add(target to Input.Kicked(target.session))
          broadcast()
        }
        is Outbound.Emit -> Unit
      }
    }

    private fun removeConnMembers(c: Client) {
      val mine = connOf.entries.filter { it.value === c }.map { it.key }
      for (p in mine) {
        members.remove(p)
        connOf.remove(p)
      }
    }

    private fun broadcast() {
      val list = members.values.toList()
      for (c in clients.values) if (c.connected) queue.add(c to Input.Members(c.session, list))
    }

    /** 接続が切れた（サーバー側も、その接続の参加者を外す） */
    fun drop(c: Client) {
      removeConnMembers(c)
      c.connected = false
      queue.add(c to Input.SocketFailed(c.session, "remote_closed"))
      broadcast()
    }

    private fun disconnect(c: Client) {
      removeConnMembers(c)
      c.connected = false
      broadcast()
    }

    fun fire(c: Client, key: TimerKey) {
      val t = c.timers.last { it.key == key }
      queue.add(c to Input.Timer(c.session, key, t.token))
    }

    /** `from` の音（PCM16 の 1 フレームのバイト）を、ほかの接続へ中継する */
    fun speak(from: Client, bytes: ByteArray) {
      val peer = connOf.entries.firstOrNull { it.value === from }?.key ?: return
      for (c in clients.values) if (c !== from && c.connected) queue.add(c to Input.AudioIn(c.session, peer, bytes))
    }
  }

  private fun start(h: Harness, c: Client) {
    h.queue.add(c to Input.Prepare(NativeCallStartArgs(c.session, "https://example.invalid", c.user, null, status, settings, emptyList())))
    h.queue.add(c to Input.StartPrepared(c.session))
    h.run()
  }

  fun run() {
    val frame = ByteArray(1600) { (it % 7).toByte() }

    // 1. 二人が参加する。どちらも参加中になり、互いの音が届く（相手の peer で再生される）
    run {
      val h = Harness()
      val a = h.add("a", "ua", "pa")
      val b = h.add("b", "ub", "pb")
      start(h, a)
      start(h, b)
      Check.eq("joined", a.core.snapshot().phase.wire, "a joined")
      Check.eq("joined", b.core.snapshot().phase.wire, "b joined")
      Check.eq(2, a.core.snapshot().members.size, "a sees both")
      Check.that(a.persisted?.wanted == true && b.persisted?.wanted == true) { "both wanted saved after audio start" }
      h.speak(a, frame)
      h.run()
      Check.eq(listOf("pa"), b.played, "b plays a")
      Check.that(a.played.isEmpty()) { "a does not play its own voice" }
    }

    // 2. 相手がミュートすると、こちらはその相手の音を受けない（状態が届いてから）
    run {
      val h = Harness()
      val a = h.add("a", "ua", "pa")
      val b = h.add("b", "ub", "pb")
      start(h, a)
      start(h, b)
      h.queue.add(a to Input.Control(a.session, NativeCallControlPatch(muted = true)))
      h.run()
      h.speak(a, ByteArray(1600))
      h.run()
      Check.that(b.played.isEmpty()) { "muted sender is not played" }
      h.queue.add(a to Input.Control(a.session, NativeCallControlPatch(muted = false)))
      h.run()
      h.speak(a, ByteArray(1600))
      h.run()
      Check.eq(listOf("pa"), b.played, "unmuted sender plays again")
    }

    // 3. キック: 外された側は止まり、wanted を消す。残る側の一覧からも消える
    run {
      val h = Harness()
      val a = h.add("a", "ua", "pa")
      val b = h.add("b", "ub", "pb")
      start(h, a)
      start(h, b)
      h.queue.add(b to Input.Kick(b.session, "pa"))
      h.run()
      Check.eq("idle", a.core.snapshot().phase.wire, "kicked peer stops")
      Check.that(a.persisted == null) { "kicked peer clears saved wanted" }
      Check.eq(listOf("pb"), b.core.snapshot().members.map { it.peer }, "kicker sees the other gone")
    }

    // 4. 接続が切れて戻る: 同じ peer で入り直す（一覧に戻り、音が戻る）
    run {
      val h = Harness()
      val a = h.add("a", "ua", "pa")
      val b = h.add("b", "ub", "pb")
      start(h, a)
      start(h, b)
      h.drop(b)
      h.run()
      Check.eq("recovering", b.core.snapshot().phase.wire, "b recovering")
      Check.that(b.core.snapshot().wanted) { "b still wanted while recovering" }
      h.fire(b, TimerKey.RETRY)
      h.run()
      Check.eq("joined", b.core.snapshot().phase.wire, "b rejoined")
      Check.eq("pb", b.core.snapshot().peer, "same peer after reconnect")
      h.speak(a, frame)
      h.run()
      Check.eq(listOf("pa"), b.played, "audio returns after reconnect")
    }

    // 5. peer_in_use: 別の人が同じ peer を使うと、参加者は peer を作り直して入り直す（一度だけ）
    run {
      val h = Harness()
      val a = h.add("a", "ua", "pa")
      val c = h.add("c", "uc", "pa", "pc2") // 同じ peer を使おうとする
      start(h, a)
      start(h, c)
      Check.eq("joined", c.core.snapshot().phase.wire, "c joined after regenerating peer")
      Check.eq("pc2", c.core.snapshot().peer, "regenerated peer")
    }

    // 6. 再起動（保存された wanted から）: 同じ peer で戻り、音も戻る
    run {
      val h = Harness()
      val a = h.add("a", "ua", "pa")
      val b = h.add("b", "ub", "pb")
      start(h, a)
      start(h, b)
      val saved = b.persisted!!
      // プロセスが死んだ（接続は切れ、状態は消えた）。新しい機で、保存から再開する
      h.drop(b)
      h.run()
      // 再起動は保存された通話の ID（session）をそのまま使う
      val b2 = Client("b2", "ub", ArrayDeque(listOf("unused")), saved.config!!.session)
      h.clients["b2"] = b2
      val step = b2.core.handle(Input.Adopt(saved, permissionOk = true))
      for (f in step.fx) if (f is Fx.StartService) h.queue.add(b2 to Input.ServiceStarted(b2.session, true))
      h.run()
      Check.eq("pb", saved.config!!.peer, "saved peer")
      Check.eq("joined", b2.core.snapshot().phase.wire, "restart rejoined")
      Check.eq("pb", b2.core.snapshot().peer, "restart reuses saved peer")
    }

    // 7. 保存が無ければ、再起動は何も始めない（強制終了のあと）
    run {
      val core = NativeCallCore(newPeer = { "x" })
      val step = core.handle(Input.Adopt(null, permissionOk = true))
      Check.that(step.fx.none { it is Fx.Connect || it is Fx.StartService || it is Fx.StartAudio }) { "no start without wanted" }
    }
  }

  @JvmStatic fun main(args: Array<String>) {
    run()
    println("NativeCallTwoPeerTest: ${Check.count} checks passed")
  }
}
