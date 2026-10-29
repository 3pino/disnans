package dev.disnans.notifier

/**
 * 状態機械の試験（時計・通信・音声は無し。命令の列と順番を確かめる）。
 * 各場面で、サーバーやデバイスから届く入力を、ここで手で与える。
 */
object NativeCallCoreTest {
  /** 保存先の模型。保存の命令は、ここで（呼ぶ側と同じように、番号を確かめてから）書く */
  private class FakeDisk {
    var wanted = false
    fun run(core: NativeCallCore, fx: List<Fx>) {
      for (f in fx) {
        if (f !is Fx.PersistWanted) continue
        if (f.wanted) {
          if (core.wantedAttemptCurrent(f.attempt)) wanted = true
        } else {
          wanted = false
        }
      }
    }
  }

  private const val ME = "me-user"
  private const val SESSION = "s1"
  private val mapper = com.fasterxml.jackson.databind.ObjectMapper()
  private val status = NativeCallStatus(muted = false, deafened = false, device = "smartphone")
  private val settings = NativeCallSettings(micVolume = 1.0, outVolume = 1.0, limiter = true, limitDb = -6.0, rawInput = false, outputId = null)
  private fun json(t: String) = mapper.readTree(t)

  private fun req(session: String = SESSION) = NativeCallStartArgs(
    session = session, serverUrl = "https://example.invalid", expectedUserId = ME, devUser = null,
    status = status, settings = settings, localMuted = emptyList(),
  )

  private class H {
    var n = 0
    val core = NativeCallCore({ "p${++n}" })
    val log = ArrayList<Fx>()
    fun step(i: Input): Step {
      val s = core.handle(i)
      log.addAll(s.fx)
      return s
    }
    fun clear() = log.clear()
    inline fun <reified T : Fx> all(): List<T> = log.filterIsInstance<T>()
    fun sent(): List<Outbound> = all<Fx.Send>().map { it.message }
    fun has(pred: (Fx) -> Boolean) = log.any(pred)

    /** 音声の開始の直前まで。返り値は音声の開始の結果（保存の命令を含む） */
    fun untilAudio(session: String = SESSION): Step {
      step(Input.Prepare(req(session)))
      step(Input.StartPrepared(session))
      step(Input.ServiceStarted(session, true))
      step(Input.Preflight(session, true, null))
      step(Input.Hello(session, ME))
      step(Input.Members(session, listOf(NativeCallMember(core.snapshot().peer!!, ME, status))))
      return step(Input.AudioStarted(session, true, null))
    }

    /** 参加まで（初回）。保存の結果も届ける。peer は p1 */
    fun joinedFirstTime(session: String = SESSION) {
      val s = untilAudio(session)
      s.fx.filterIsInstance<Fx.PersistWanted>().firstOrNull()?.let { step(Input.WantedCommitted(session, it.attempt, true)) }
    }
  }

  fun run() {
    // 1. 初回の参加: 一覧に自分が載ってから音声を始め、音声が始まってから wanted を保存する
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      val afterPreflight = h.step(Input.Preflight(SESSION, true, null))
      Check.that(afterPreflight.fx.any { it is Fx.Connect }) { "connect after preflight" }
      h.step(Input.Hello(SESSION, ME))
      Check.that(h.sent().any { it is Outbound.Join }) { "join after hello" }
      h.clear()
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status))))
      Check.that(h.all<Fx.StartAudio>().size == 1) { "audio starts after own membership" }
      Check.that(!h.has { it is Fx.PersistWanted }) { "wanted not saved before audio starts" }
      val started = h.step(Input.AudioStarted(SESSION, true, null))
      val wanted = started.fx.filterIsInstance<Fx.PersistWanted>()
      Check.eq(1, wanted.size, "wanted saved once")
      Check.eq(true, wanted[0].wanted, "wanted true")
      Check.eq("joining", h.core.snapshot().phase.wire, "not joined until the save is confirmed")
      Check.that(!h.core.snapshot().wanted) { "not wanted until the save is confirmed" }
      h.step(Input.WantedCommitted(SESSION, wanted[0].attempt, true))
      Check.eq("joined", h.core.snapshot().phase.wire, "joined")
      Check.that(h.core.snapshot().wanted) { "snapshot wanted" }
    }

    // 2. 合言葉の違う相手（hello の ID が違う）は参加させない。wanted は保存しない
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      h.step(Input.Preflight(SESSION, true, null))
      h.clear()
      h.step(Input.Hello(SESSION, "someone-else"))
      Check.that(h.sent().none { it is Outbound.Join }) { "no join for wrong identity" }
      Check.that(h.has { it is Fx.StopService }) { "service stops" }
      Check.eq("identity_mismatch", h.core.snapshot().error?.code, "error code")
      Check.eq("idle", h.core.snapshot().phase.wire, "back to idle")
    }

    // 3. 初回の一覧が載らない: 再試行せず止める（wanted は無いまま）
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      h.step(Input.Preflight(SESSION, true, null))
      h.step(Input.Hello(SESSION, ME))
      val timers = h.all<Fx.Timer>().filter { it.key == TimerKey.LISTED }
      Check.eq(1, timers.size, "listed timer armed")
      h.clear()
      h.step(Input.Timer(SESSION, TimerKey.LISTED, timers[0].token))
      Check.eq("join_timeout", h.core.snapshot().error?.code, "timeout error")
      Check.that(!h.has { it is Fx.PersistWanted && it.wanted }) { "no wanted on failed initial join" }
      Check.that(!h.all<Fx.Timer>().any { it.key == TimerKey.RETRY }) { "no retry on initial failure" }
      Check.eq("idle", h.core.snapshot().phase.wire, "idle")
    }

    // 4. 準備中に止めたら、あとから届く開始の結果は無視する（古い開始が効かない）
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.CancelPrepared(SESSION, "user"))
      Check.eq("idle", h.core.snapshot().phase.wire, "idle after cancel")
      val late = h.step(Input.StartPrepared(SESSION))
      Check.eq(false, late.outcome.ok, "late start rejected")
      h.clear()
      h.step(Input.ServiceStarted(SESSION, true))
      Check.that(h.log.isEmpty()) { "late service start ignored" }
    }

    // 5. 参加の途中で止める: wanted を先に消し、その後に後始末（順番）
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      h.clear()
      h.step(Input.Stop(SESSION, "user"))
      val kinds = h.log.map { it::class.simpleName + (if (it is Fx.PersistWanted) "(${it.wanted})" else "") }
      val iWanted = kinds.indexOfFirst { it == "PersistWanted(false)" }
      val iClose = kinds.indexOfFirst { it == "CloseSocket" }
      val iStop = kinds.indexOfFirst { it == "StopService" }
      Check.that(iWanted >= 0 && iWanted < iClose && iClose < iStop) { "order wanted<close<stop: $kinds" }
      Check.eq("idle", h.core.snapshot().phase.wire, "idle after stop")
    }

    // 6. 止めたあとに届く古い入力（ハロー・一覧・音声）は効かない
    run {
      val h = H()
      h.joinedFirstTime()
      h.step(Input.Stop(SESSION, "user"))
      h.clear()
      h.step(Input.Hello(SESSION, ME))
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status))))
      h.step(Input.AudioIn(SESSION, "p9", byteArrayOf(0, 0)))
      h.step(Input.Level(SESSION, null, 0.5, 100))
      Check.that(h.log.isEmpty()) { "stale inputs after stop: ${h.log}" }
    }

    // 7. 再起動（intent が null）: 保存された wanted のとき、同じ peer で再開する（開始の要求は 1 回）
    run {
      val cfg = CallSessionConfig(SESSION, "https://example.invalid", ME, null, "pOld")
      val persisted = CallPersisted(wanted = true, config = cfg, settings = settings, status = status, localMuted = emptySet(), generation = 5)
      val h = H()
      val s0 = h.step(Input.Adopt(persisted, permissionOk = true))
      Check.that(s0.fx.any { it is Fx.StartService }) { "adopt starts the service only because wanted" }
      Check.eq(6L, h.core.snapshot().generation, "generation bumped on bootstrap")
      h.step(Input.ServiceStarted(SESSION, true))
      h.step(Input.Preflight(SESSION, true, null))
      h.clear()
      h.step(Input.Hello(SESSION, ME))
      val join = h.sent().filterIsInstance<Outbound.Join>()
      Check.eq(1, join.size, "one join")
      Check.eq("pOld", join[0].peer, "same peer after restart")
      h.step(Input.Members(SESSION, listOf(NativeCallMember("pOld", ME, status))))
      h.step(Input.AudioStarted(SESSION, true, null))
      Check.eq("joined", h.core.snapshot().phase.wire, "joined after restart")
      Check.that(!h.has { it is Fx.PersistWanted }) { "no re-save of wanted needed" }
    }

    // 8. wanted が無い・権限が無い再起動は、何も始めない
    run {
      val h = H()
      val s0 = h.step(Input.Adopt(null, permissionOk = true))
      Check.that(s0.fx.all { it is Fx.StopService }) { "no wanted: only stop" }
      Check.that(s0.fx.none { it is Fx.StartService || it is Fx.Connect || it is Fx.StartAudio }) { "no start" }
      val cfg = CallSessionConfig(SESSION, "u", ME, null, "p")
      val p = CallPersisted(true, cfg, settings, status, emptySet(), 1)
      val h2 = H()
      val s1 = h2.step(Input.Adopt(p, permissionOk = false))
      Check.that(s1.fx.any { it is Fx.PersistWanted && !it.wanted }) { "permission loss clears wanted" }
      Check.that(s1.fx.none { it is Fx.StartService }) { "no service without permission" }
    }

    // 9. 読み取りは何も始めない（保存された wanted があっても）
    run {
      val h = H()
      val snap = h.core.snapshot()
      Check.eq("idle", snap.phase.wire, "snapshot idle")
      Check.that(h.log.isEmpty()) { "snapshot produces no effects" }
    }

    // 10. 切れたあとの再接続: 1,2,4,8,16,30,30 秒（wanted のあいだ）
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.SocketFailed(SESSION, "net"))
      val delays = ArrayList<Long>()
      var token = h.all<Fx.Timer>().single { it.key == TimerKey.RETRY }.also { delays += it.delayMs }.token
      repeat(6) {
        h.clear()
        h.step(Input.Timer(SESSION, TimerKey.RETRY, token))
        Check.that(h.all<Fx.Connect>().size == 1) { "retry connects" }
        h.step(Input.SocketFailed(SESSION, "net"))
        val t = h.all<Fx.Timer>().single { it.key == TimerKey.RETRY }
        delays += t.delayMs
        token = t.token
      }
      Check.eq(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), delays, "backoff")
    }

    // 11. キック: 再参加しない。wanted を消す
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.Kicked(SESSION, by = "kicker"))
      Check.that(h.log.indexOfFirst { it is Fx.PersistWanted } < h.log.indexOfFirst { it is Fx.StopService }) { "wanted cleared first" }
      Check.that(h.sent().none { it is Outbound.Join }) { "no rejoin after kick" }
      Check.eq("idle", h.core.snapshot().phase.wire, "idle after kick")
      val err = h.core.snapshot().error
      Check.eq("kicked", err?.code, "kick error code")
      Check.eq("kicker", err?.by, "kick error carries who removed us")
    }

    // 12. 一覧から外された: 一度だけ入り直す。二度目は止める
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.Members(SESSION, emptyList()))
      Check.eq(1, h.sent().count { it is Outbound.Join }, "rejoin once")
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status))))
      h.clear()
      h.step(Input.Members(SESSION, emptyList()))
      Check.that(h.sent().none { it is Outbound.Join }) { "no second rejoin" }
      Check.eq("idle", h.core.snapshot().phase.wire, "stopped after second removal")
    }

    // 13. peer_in_use: この通話の peer を一度だけ作り直す。二度目は再試行（wanted のとき）
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      h.step(Input.Preflight(SESSION, true, null))
      h.step(Input.Hello(SESSION, ME))
      h.clear()
      h.step(Input.ServerError(SESSION, "peer_in_use"))
      val joins = h.sent().filterIsInstance<Outbound.Join>()
      Check.eq(1, joins.size, "one rejoin")
      Check.that(joins[0].peer != "p1") { "peer regenerated" }
      h.clear()
      h.step(Input.ServerError(SESSION, "peer_in_use"))
      Check.eq("peer_in_use", h.core.snapshot().error?.code, "second peer_in_use fails the initial join")
    }

    // 14. ミュートと、スピーカーミュート（JS と同じ式: ミュートを外すとスピーカーも外れる）
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.Control(SESSION, NativeCallControlPatch(muted = true)))
      Check.that(h.all<Fx.SetCapture>().single().enabled.not()) { "capture disabled when muted" }
      Check.that(h.sent().any { it is Outbound.Update && it.status.muted }) { "status update sent" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(deafened = true)))
      Check.that(h.core.snapshot().muted && h.core.snapshot().muteByDeafen.not()) { "already muted: deafen does not own the mute" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(deafened = false)))
      Check.that(h.core.snapshot().muted) { "undeafen keeps the user mute" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(muted = false)))
      Check.that(!h.core.snapshot().muted) { "unmute" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(deafened = true)))
      val s = h.core.snapshot()
      Check.that(s.muted && s.muteByDeafen && s.deafened) { "deafen mutes and remembers it" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(muted = false)))
      val u = h.core.snapshot()
      Check.that(!u.muted && !u.deafened) { "unmute while deafened also undeafens (web rule)" }
    }

    // 15. 受け取りの絞り込み: 知らない・ミュート・聞かない・一覧に無い相手は捨てる
    run {
      val h = H()
      h.joinedFirstTime()
      h.step(Input.Members(SESSION, listOf(
        NativeCallMember("p1", ME, status),
        NativeCallMember("p9", "u9", NativeCallStatus(muted = true, deafened = false, device = null)),
        NativeCallMember("pA", "uA", status),
      )))
      h.clear()
      h.step(Input.AudioIn(SESSION, "p9", byteArrayOf(0, 0)))
      h.step(Input.AudioIn(SESSION, "nobody", byteArrayOf(0, 0)))
      Check.that(h.all<Fx.PlayFrame>().isEmpty()) { "muted and unknown dropped" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(peerMute = NativeCallPeerMute("pA", true))))
      h.step(Input.AudioIn(SESSION, "pA", byteArrayOf(0, 0)))
      Check.that(h.all<Fx.PlayFrame>().isEmpty()) { "locally muted peer dropped" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(peerMute = NativeCallPeerMute("pA", false))))
      h.step(Input.Control(SESSION, NativeCallControlPatch(deafened = true)))
      h.step(Input.AudioIn(SESSION, "pA", byteArrayOf(0, 0)))
      Check.that(h.all<Fx.PlayFrame>().isEmpty()) { "deafened drops everything" }
      h.step(Input.Control(SESSION, NativeCallControlPatch(deafened = false)))
      h.step(Input.AudioIn(SESSION, "pA", byteArrayOf(0, 0)))
      Check.eq(1, h.all<Fx.PlayFrame>().size, "normal peer plays")
      Check.eq(1L, h.core.counters["audio.drop.unknown"] ?: 0L, "one unknown-peer frame counted")
    }

    // 16. 出力の音量（相手ごと）: 聞かないときは 0、音量は outVolume
    run {
      val h = H()
      h.joinedFirstTime()
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status), NativeCallMember("pA", "uA", status))))
      h.clear()
      h.step(Input.Control(SESSION, NativeCallControlPatch(settings = NativeCallSettingsPatch(outVolume = 0.5))))
      val g = h.all<Fx.SetPeerGains>().last().gains
      Check.near(0.5, g["pA"] ?: -1.0, 0.0, "peer gain from outVolume")
      h.step(Input.Control(SESSION, NativeCallControlPatch(deafened = true)))
      val g2 = h.all<Fx.SetPeerGains>().last().gains
      Check.near(0.0, g2["pA"] ?: -1.0, 0.0, "deafened gain zero")
    }

    // 17. 上限・経路・生の入力の設定
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.Control(SESSION, NativeCallControlPatch(settings = NativeCallSettingsPatch(limiter = false))))
      Check.eq(null, h.all<Fx.SetLimit>().last().db, "limiter off")
      h.step(Input.Control(SESSION, NativeCallControlPatch(settings = NativeCallSettingsPatch(outputId = OutputIdPatch("speaker")))))
      Check.that(h.all<Fx.Route>().any { it.outputId == "speaker" }) { "route applied" }
      h.clear()
      h.step(Input.Control(SESSION, NativeCallControlPatch(settings = NativeCallSettingsPatch(rawInput = true))))
      Check.that(h.log.indexOfFirst { it is Fx.StopAudio } < h.log.indexOfLast { it is Fx.StartAudio }) { "raw input restarts capture" }
    }

    // 18. 送信（emit）: 参加していないと拒否、名前と大きさの決まり
    run {
      val h = H()
      Check.eq("no_session", h.step(Input.Emit(SESSION, "x", json("{}"))).outcome.code, "no session")
      h.joinedFirstTime()
      h.clear()
      Check.eq(false, h.step(Input.Emit(SESSION, "audio", json("{}"))).outcome.ok, "audio name reserved")
      Check.eq(false, h.step(Input.Emit(SESSION, "n".repeat(65), json("{}"))).outcome.ok, "name too long")
      Check.eq("too_large", h.step(Input.Emit(SESSION, "x", json("\"" + "a".repeat(64 * 1024) + "\""))).outcome.code, "too large")
      Check.eq(true, h.step(Input.Emit(SESSION, "game", json("{\"a\":1}"))).outcome.ok, "emit ok")
      Check.that(h.sent().any { it is Outbound.Emit && it.name == "game" }) { "emit sent" }
    }

    // 19. 権限の失効: 止める（wanted を先に消す）
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.PermissionLost(SESSION))
      Check.that(h.log.first { it is Fx.PersistWanted || it is Fx.StopService } is Fx.PersistWanted) { "wanted first" }
      Check.eq("idle", h.core.snapshot().phase.wire, "idle")
    }

    // 20. 保存に失敗したら、初回の参加は止める（失敗を閉じる。黙って続けない）
    run {
      val h = H()
      val pw = h.untilAudio().fx.filterIsInstance<Fx.PersistWanted>().single()
      h.step(Input.WantedCommitted(SESSION, pw.attempt, false))
      Check.eq("persist_failed", h.core.snapshot().error?.code, "persist failure stops")
      Check.eq("idle", h.core.snapshot().phase.wire, "idle")
      Check.that(!h.core.snapshot().wanted) { "not wanted after failed save" }
    }

    // 21. 話し中の表示: 音量が閾値を超えたら true、350ms 静かなら false
    run {
      val h = H()
      h.joinedFirstTime()
      h.step(Input.Control(SESSION, NativeCallControlPatch(muted = false)))
      val a = h.step(Input.Level(SESSION, null, 0.1, 1000))
      Check.that(a.fx.any { it is Fx.Publish && it.snapshot.speaking[""] == true }) { "speaking on" }
      val b = h.step(Input.Level(SESSION, null, 0.0, 1340))
      Check.that(b.fx.none { it is Fx.Publish && it.snapshot.speaking[""] == false }) { "still speaking within hold" }
      val c = h.step(Input.Level(SESSION, null, 0.0, 1400))
      Check.that(c.fx.any { it is Fx.Publish && it.snapshot.speaking[""] == false }) { "speaking off after hold" }
    }

    // 22. 公開の番号は増える（同じ番号は使わない）
    run {
      val h = H()
      val seqs = ArrayList<Long>()
      val s1 = h.step(Input.Prepare(req()))
      seqs += (s1.fx.filterIsInstance<Fx.Publish>().map { it.snapshot.seq }).ifEmpty { listOf(-1L) }
      val s2 = h.step(Input.StartPrepared(SESSION))
      seqs += s2.fx.filterIsInstance<Fx.Publish>().map { it.snapshot.seq }
      Check.that(seqs.zipWithNext().all { (a, b) -> b > a }) { "seq increases: $seqs" }
    }

    // 23. 初回の音声失敗は止める（再試行しない）。切れたあとの音声失敗は再試行する
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      h.step(Input.Preflight(SESSION, true, null))
      h.step(Input.Hello(SESSION, ME))
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status))))
      h.step(Input.AudioStarted(SESSION, false, "record_failed"))
      Check.eq("idle", h.core.snapshot().phase.wire, "initial audio failure stops")
      Check.that(!h.has { it is Fx.PersistWanted && it.wanted }) { "no wanted" }

      val g = H()
      g.joinedFirstTime()
      g.clear()
      g.step(Input.AudioFailed(SESSION, "mic_lost"))
      Check.that(g.all<Fx.Timer>().any { it.key == TimerKey.RETRY }) { "recovering after audio failure" }
    }

    // 24. 古いタイマー（トークンが違う）は効かない
    run {
      val h = H()
      h.step(Input.Prepare(req()))
      h.step(Input.StartPrepared(SESSION))
      h.step(Input.ServiceStarted(SESSION, true))
      h.step(Input.Preflight(SESSION, true, null))
      h.step(Input.Hello(SESSION, ME))
      val first = h.all<Fx.Timer>().single { it.key == TimerKey.LISTED }
      h.step(Input.Hello(SESSION, ME)) // 2 回目で、タイマーが張り直される
      val second = h.all<Fx.Timer>().last { it.key == TimerKey.LISTED }
      Check.that(second.token != first.token) { "timer token changes" }
      h.clear()
      h.step(Input.Timer(SESSION, TimerKey.LISTED, first.token))
      Check.that(h.log.isEmpty()) { "stale timer ignored" }
    }

    // 25. 生きている合図: 参加中は 5 秒ごとに alive を送る（送った数だけ）
    run {
      val h = H()
      h.joinedFirstTime()
      val t = h.all<Fx.Timer>().last { it.key == TimerKey.ALIVE }
      h.clear()
      h.step(Input.Timer(SESSION, TimerKey.ALIVE, t.token))
      Check.that(h.sent().any { it is Outbound.Alive }) { "alive sent" }
      Check.that(h.all<Fx.Timer>().any { it.key == TimerKey.ALIVE && it.delayMs == 5_000L }) { "alive re-armed" }
    }

    // 26. 準備は 1 つだけ
    run {
      val h = H()
      h.step(Input.Prepare(req("a")))
      Check.eq("busy", h.step(Input.Prepare(req("b"))).outcome.code, "second prepare busy")
    }

    // 27. 切れたあとに参加していたとき、wanted は保たれる（停止していない）
    run {
      val h = H()
      h.joinedFirstTime()
      h.step(Input.SocketFailed(SESSION, "net"))
      Check.that(h.core.snapshot().wanted) { "still wanted during recovery" }
      Check.eq("recovering", h.core.snapshot().phase.wire, "recovering")
    }

    // 29. 認証の拒否は再試行しない（wanted があっても止める）
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.SocketFailed(SESSION, "auth_rejected"))
      Check.that(h.all<Fx.Timer>().none { it.key == TimerKey.RETRY }) { "no retry on auth rejection" }
      Check.eq("idle", h.core.snapshot().phase.wire, "stopped on auth rejection")
      Check.eq(false, h.core.snapshot().wanted, "wanted cleared on auth rejection")
    }

    // 30. 設定の誤り（URL・ID）は、再試行しても直らないので止める
    run {
      val h = H()
      h.joinedFirstTime()
      h.clear()
      h.step(Input.SocketFailed(SESSION, "bad_server_url"))
      Check.that(h.all<Fx.Timer>().none { it.key == TimerKey.RETRY }) { "no retry on bad url" }
      Check.eq("idle", h.core.snapshot().phase.wire, "stopped on bad url")
    }

    // 31. 遅れた保存と停止の入れ違い: 停止のあとに実行された保存は、番号が無効なので書かれない（wanted は偽のまま）
    run {
      val h = H()
      val pw = h.untilAudio().fx.filterIsInstance<Fx.PersistWanted>().single()
      val disk = FakeDisk()
      // 保存（true）はまだ実行されていない。その間に停止が来る
      val stop = h.step(Input.Stop(SESSION, "user"))
      val iAudio = stop.fx.indexOfFirst { it is Fx.StopAudio }
      val iSave = stop.fx.indexOfFirst { it is Fx.PersistWanted && !it.wanted }
      Check.that(iAudio >= 0 && iAudio < iSave) { "audio stops before the durable clear" }
      disk.run(h.core, stop.fx)
      // 遅れた保存が実行されようとする: 番号が無効なので、書けない
      Check.that(!h.core.wantedAttemptCurrent(pw.attempt)) { "a stopped attempt is not current" }
      disk.run(h.core, listOf(pw))
      Check.eq(false, disk.wanted, "late commit must not write wanted=true")
      // 保存の結果が遅れて届いても、何も起きない
      val late = h.step(Input.WantedCommitted(SESSION, pw.attempt, true))
      Check.that(late.fx.isEmpty()) { "late commit result ignored" }
      Check.eq("idle", h.core.snapshot().phase.wire, "idle after late commit")
      Check.that(!h.core.snapshot().wanted) { "not rearmed" }
    }

    // 32. 保存が先に終わり、停止が後から来る: 停止の保存で偽に戻る（結果は残らない）
    run {
      val h = H()
      val pw = h.untilAudio().fx.filterIsInstance<Fx.PersistWanted>().single()
      val disk = FakeDisk()
      disk.run(h.core, listOf(pw))
      Check.eq(true, disk.wanted, "save completed before stop")
      h.step(Input.WantedCommitted(SESSION, pw.attempt, true))
      Check.eq("joined", h.core.snapshot().phase.wire, "joined")
      val stop = h.step(Input.Stop(SESSION, "user"))
      disk.run(h.core, stop.fx)
      Check.eq(false, disk.wanted, "durable clear wins")
      Check.eq("idle", h.core.snapshot().phase.wire, "idle")
    }

    // 33. 保存の途中で切れた: 初回は止まり、遅れた成功は無視される（wanted は偽のまま）
    run {
      val h = H()
      val pw = h.untilAudio().fx.filterIsInstance<Fx.PersistWanted>().single()
      val disk = FakeDisk()
      val drop = h.step(Input.SocketFailed(SESSION, "remote_closed"))
      Check.eq("idle", h.core.snapshot().phase.wire, "initial join stops on drop")
      disk.run(h.core, drop.fx)
      disk.run(h.core, listOf(pw))
      Check.eq(false, disk.wanted, "no write after the drop")
      h.step(Input.WantedCommitted(SESSION, pw.attempt, true))
      Check.that(!h.core.snapshot().wanted) { "late success does not rearm" }
    }

    // 34. 保存の前は、まだ参加済みではない（一覧と音声は動いていても、wanted は偽）
    run {
      val h = H()
      val started = h.untilAudio()
      Check.eq("joining", h.core.snapshot().phase.wire, "joining before save")
      Check.that(!h.core.snapshot().wanted) { "not wanted before save" }
      Check.that(started.fx.none { it is Fx.Publish && it.snapshot.phase == NativeCallPhase.JOINED }) { "no joined publish before save" }
    }

    // 35. 前の通話の遅れた音声の開始は、新しい通話を動かさない
    run {
      val h = H()
      h.untilAudio("A")
      h.step(Input.Stop("A", "user"))
      h.step(Input.Prepare(req("B")))
      val late = h.step(Input.AudioStarted("A", true, null))
      Check.that(late.fx.isEmpty()) { "old session audio start ignored" }
      Check.eq("joining", h.core.snapshot().phase.wire, "new session untouched (preparing)")
      Check.eq("B", h.core.snapshot().session, "session B is current")
    }

    // 36. 準備は資源を動かさない（開始の命令も接続もしない）
    run {
      val h = H()
      val step = h.step(Input.Prepare(req()))
      Check.that(step.fx.none { it is Fx.StartService || it is Fx.Connect || it is Fx.StartAudio || it is Fx.Preflight }) { "prepare starts nothing" }
    }

    // 37. 保存の結果が失敗したら、止めて、画面の文言は日本語になる
    run {
      val h = H()
      val pw = h.untilAudio().fx.filterIsInstance<Fx.PersistWanted>().single()
      h.step(Input.WantedCommitted(SESSION, pw.attempt, false))
      val e = h.core.snapshot().error
      Check.eq("persist_failed", e?.code, "code kept for logs")
      Check.that(e != null && e.message.contains("保存")) { "message is Japanese" }
      val j = NativeCallMessages.japanese("join_timeout")
      Check.that(j.contains("返事")) { "timeout message in Japanese" }
    }

    // 28. 停止は、いつでも効く（いまの通話の ID が無いと効かない）
    run {
      val h = H()
      h.joinedFirstTime()
      Check.eq(false, h.step(Input.Stop("other", "user")).outcome.ok, "stop of another session ignored")
      Check.eq("joined", h.core.snapshot().phase.wire, "still joined")
    }

    // 29. 一覧の変化は、自分の状態が変わらなくても画面へ配る（他人の離脱・参加・状態の変更）
    run {
      val h = H()
      h.joinedFirstTime()
      val other = "other-user"
      // 自分（p1）と別の人（p2）が載っている
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status), NativeCallMember("p2", other, status))))
      h.clear()
      // 他人が離脱（別の peer）: 自分は残る → 画面へ配る
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status))))
      val gone = h.all<Fx.Publish>()
      Check.eq(1, gone.size, "departure of another peer publishes")
      Check.eq(listOf("p1"), gone[0].snapshot.members.map { it.peer }, "published list has only self")
      h.clear()
      // 同じ人の別の peer が離脱（同じユーザー、peer が違う）も配る
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status), NativeCallMember("p3", ME, status))))
      h.clear()
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status))))
      Check.eq(1, h.all<Fx.Publish>().size, "same user other peer leaving publishes")
      h.clear()
      // 他人の参加と状態の変更も配る
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status), NativeCallMember("p4", other, status))))
      Check.eq(1, h.all<Fx.Publish>().size, "new member publishes")
      h.clear()
      val muted = NativeCallStatus(muted = true, deafened = false, device = "smartphone")
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status), NativeCallMember("p4", other, muted))))
      Check.eq(1, h.all<Fx.Publish>().size, "status change publishes")
      Check.eq(true, h.all<Fx.Publish>()[0].snapshot.members.first { it.peer == "p4" }.status.muted, "published status is the new one")
      h.clear()
      // 変化が無い一覧は配らない（同じ内容が何度届いても、画面の更新は増やさない）
      h.step(Input.Members(SESSION, listOf(NativeCallMember("p1", ME, status), NativeCallMember("p4", other, muted))))
      Check.that(h.all<Fx.Publish>().isEmpty()) { "identical list does not publish" }
    }
  }

  @JvmStatic fun main(args: Array<String>) {
    run()
    println("NativeCallCoreTest: ${Check.count} checks passed")
  }
}
