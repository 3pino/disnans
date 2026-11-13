import type { CallMember } from '../protocol/CallMember';
import type { CallStatus } from '../protocol/CallStatus';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import { keepWebViewEnabled, setKeepWebViewResumed } from './nativeCall';
import { EV_AUDIO, LEVEL_MS, OUTPUTS_REFRESH_TICKS, joinStateOf, notificationContent, randomId } from './pure';
import { WebAudio, errName } from './webAudio';
import type { CallEngine, CallHost } from './types';

// WebView 所有の通話。参加・退出・ミュートと、サーバーの call.*（参加者の一覧・音声の中継・kick・生存）を受け持つ。
// 音の経路は WebAudio（webAudio.ts）。音声は全員のあいだをサーバー経由（call.emit の audio。16kHz モノラル PCM）で流す（WebRTC は使わない）。

/** 参加を送ったあと、サーバーの参加者一覧に自分が居るかを確かめるまでの時間（診断用） */
const LISTED_CHECK_MS = 3000;
/** 参加中であることを知らせる間隔（サーバーは ALIVE_TIMEOUT の 20 秒届かなければ外す） */
const ALIVE_MS = 5000;
/** 診断用に、直近に送った call.* を覚えておく件数 */
const TRAIL_MAX = 8;

export class WebCallEngine implements CallEngine {
  readonly nativeOwned = false;
  readonly audio: WebAudio;
  /** 診断: 直近に送った call.*（音声は連続をまとめる）。not_in_call の警告に添える */
  private trail: { label: string; at: number; count: number }[] = [];
  private trailStart = 0;
  private outputsTick = 0;
  private worker: { terminate(): void } | null = null;
  private background: Disnans.BackgroundHandle | null = null;
  private notifyKey = '';
  /** 外れてからの自動の入り直しを使ったか（手動で入り直したら戻す） */
  private autoRejoinUsed = false;
  private aliveAt = 0;
  /** peer_in_use の再入りを、1 回の入り直しにつき 1 度だけにする */
  private rejoinRetried = false;
  private backgroundNoticed = false;
  private serviceOff: (() => void) | null = null;

  constructor(private readonly h: CallHost) {
    this.audio = new WebAudio(h, (ev) => this.sendCall(ev));
  }

  // ---- サーバーからのイベント ----

  /** client.subscribe から受け取る。call.* 以外と hello を見る */
  onServerEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case 'hello':
        this.onReconnect();
        break;
      case 'call.state':
        this.onState(ev.members);
        break;
      case 'call.event':
        this.onCallEvent(ev.peer, ev.name, ev.payload);
        break;
      case 'call.kicked':
        if (this.h.joined) {
          this.leave(false, 'kicked');
          this.h.deps.toast(`${this.h.deps.nameOf(ev.by)}さんに通話から外されました`, 'info');
        }
        break;
      case 'error':
        this.onServerError(ev.code, ev.message);
        break;
    }
  }

  /**
   * サーバーのエラー（通話の操作が通らなかったとき）。診断のため種別と code を出す。
   * peer_in_use: つなぎ直しの入り直しで、前の接続（まだサーバーが切断に気づいていない）が同じ接続 ID を持っている。
   * 新しい接続 ID で一度だけ入り直す（前の接続は、サーバーが切断に気づいた時点で外れる）。
   */
  private onServerError(code: string, message: string): void {
    console.warn(`[call] サーバーが通話の操作を受け付けませんでした: code=${code} message=${message} 直近の送信=${this.trailText()}`);
    if (!this.h.joined) return;
    if (code === 'peer_in_use' && !this.rejoinRetried) {
      this.rejoinRetried = true;
      this.rejoin();
      return;
    }
    // 一覧に載る前の not_in_call は、参加の失敗ではない（音声・状態の送信が先に着いた応答）。3 秒の待ちで判定する
    if (!this.h.listed) {
      if (code !== 'not_in_call') this.failJoin(message);
      return;
    }
    // 載ってからの not_in_call: サーバーは自分を参加者と見ていない（見回りで外された）
    if (code === 'not_in_call') this.onRemoved();
  }

  /** 参加が通らなかった（一覧に載らない・拒否された）。通話の表示を閉じて、理由を知らせる */
  private failJoin(reason: string): void {
    console.warn(`[call] 参加できませんでした: ${reason} 直近の送信=${this.trailText()}`);
    this.leave(true, 'join-failed');
    this.h.deps.toast(`通話に入れませんでした（${reason}）`, 'error');
  }

  /** 新しい接続 ID で入り直す（サーバーの通話の一覧に自分を入れ直す） */
  private rejoin(): void {
    this.h.peerId = randomId();
    this.h.listed = false;
    this.sendCall({ type: 'call.join', peer: this.h.peerId, status: this.status() });
    this.checkListed();
  }

  /**
   * 診断: 入る（call.join）を送って少し後に、サーバーの参加者一覧に自分が居るか確かめる。
   * 居なければ、入れなかった（拒否・未達・外された）ので、console.warn に残す。
   */
  private checkListed(): void {
    const peer = this.h.peerId;
    setTimeout(() => {
      if (!this.h.joined || this.h.peerId !== peer || this.h.listed) return;
      console.warn(`[call] 参加の送信後も、サーバーの参加者一覧に自分がいません: peer=${peer} members=${this.h.members.length} 直近の送信=${this.trailText()}`);
      this.failJoin('サーバーから返事がありませんでした');
    }, LISTED_CHECK_MS);
  }

  /**
   * チャットの接続が切れた・戻った（client.subscribeLink）。切れているあいだは音声を取りこぼす（許容）。
   * 戻ったら hello（onReconnect）で入り直す。ここでは利用者へ知らせるだけ。
   */
  onLink(up: boolean): void {
    if (!this.h.joined) return;
    if (up) {
      if (this.h.linkDown) {
        this.h.linkDown = false;
        this.h.deps.toast('通話の接続が戻りました', 'info');
      }
      return;
    }
    if (this.h.linkDown) return;
    this.h.linkDown = true;
    this.h.deps.toast('通話の接続が切れました。つながると自動で入り直します', 'info');
  }

  /** つなぎ直したら、サーバーは自分を通話から外している。入り直す（入り直したことは 1 回知らせる） */
  private onReconnect(): void {
    if (!this.h.joined) return;
    // 前の接続 ID は、前の接続がサーバーに残っているあいだは使えない（peer_in_use）。新しい ID で入る
    this.rejoinRetried = false;
    this.rejoin();
    this.h.deps.toast('通話に再接続しました（接続が戻ったため）', 'info');
  }
  private noticeBackground(): void {
    if (this.backgroundNoticed) return;
    this.backgroundNoticed = true;
    console.warn('[call] 前景サービスが動いていません（バックグラウンドでは通話が切れることがあります）');
    this.h.deps.toast('バックグラウンドでは通話が切れることがあります', 'info');
  }

  private onState(members: CallMember[]): void {
    this.h.members = members;
    if (this.h.joined && this.h.peerId) {
      const here = members.some((m) => m.peer === this.h.peerId);
      if (here) {
        if (!this.h.listed) {
          this.h.listed = true;
          // 参加中に変えた状態（ミュートなど）を、載った時点で一度知らせる。そのあと積んだ emit を送る
          this.sendStatus();
          this.h.flushEmits();
        }
      } else if (this.h.listed) {
        // 載っていたのに、いなくなった（サーバーが外した・接続が替わった）
        this.onRemoved();
        return;
      }
    }
    if (this.h.joined) this.audio.reconcile();
    this.h.refresh();
  }

  /**
   * サーバーの一覧から自分が外れた（見回りで外された・接続が替わった）。JS が止まっていたあとに戻ったときも、ここに来る。
   * 一度だけ入り直す。入り直しが載らなければ rejoin → checkListed → failJoin で知らせて閉じる。
   * その入り直しもまた外れたら、通話から外れる。
   */
  private onRemoved(): void {
    if (!this.autoRejoinUsed) {
      this.autoRejoinUsed = true;
      console.warn('[call] サーバーの一覧から外れたので、入り直します');
      this.h.listed = false;
      this.rejoin();
      this.h.deps.toast('通話に再接続しました（サーバーの一覧から外れていたため）', 'info');
      return;
    }
    // 理由: 接続が切れていたなら ws_closed、切れていなかったのにサーバーが外したなら server_removed（サーバーの理由は見えない）
    const reason = this.h.linkDown ? 'ws_closed' : 'server_removed';
    this.leave(false, reason);
    this.h.deps.toast(`通話から外れました（理由: ${reason}）`, 'info');
  }

  private onCallEvent(peer: string, name: string, payload: unknown): void {
    if (name === EV_AUDIO) {
      this.audio.diag.add('recv');
      if (!this.h.joined) {
        this.audio.diag.add('recvDrop.notJoined');
        return;
      }
      this.audio.onRelayAudio(peer, payload);
      return;
    }
    if (!this.h.joined) return;
    const e = this.audio.entries.get(peer);
    if (!e) return;
    const event = { peer, userId: e.userId, payload };
    this.h.dispatch(name, event);
  }


  private status(): CallStatus {
    return { muted: this.h.muted, deafened: this.h.deafened, device: this.h.deps.deviceKind() };
  }

  /** call.* の送信は必ずここを通る（直近の送信を診断用に覚える） */
  private sendCall(ev: ClientEvent): void {
    const label = ev.type === 'call.emit' ? (ev.name === EV_AUDIO ? 'call.emit(audio)' : `call.emit(${ev.name})`) : ev.type;
    const at = this.h.deps.now() - this.trailStart;
    const last = this.trail.at(-1);
    if (last && last.label === label && label === 'call.emit(audio)') {
      last.count += 1;
      last.at = at;
    } else {
      this.trail.push({ label, at, count: 1 });
      if (this.trail.length > TRAIL_MAX) this.trail.shift();
    }
    this.h.deps.send(ev);
  }

  /** 診断用: 直近に送った call.* を「種別@経過ms」で並べる */
  private trailText(): string {
    return this.trail.map((t) => `${t.label}${t.count > 1 ? `×${t.count}` : ''}@${t.at}ms`).join(' > ') || '(なし)';
  }


  private startWorker(): void {
    this.stopWorker();
    try {
      const code = `setInterval(() => postMessage(0), ${LEVEL_MS});`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const w = new Worker(url);
      URL.revokeObjectURL(url);
      w.onmessage = () => this.tick();
      this.worker = w;
    } catch (e) {
      // Worker が使えなければ、ふつうのタイマーで代わりにする
      console.warn('[call] Worker を使えません', e);
      const id = window.setInterval(() => this.tick(), LEVEL_MS);
      this.worker = { terminate: () => window.clearInterval(id) };
    }
  }

  private stopWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }


  private sendStatus(): void {
    // 参加が一覧に載るまでは送らない（載ったときに、その時点の状態を一度送る）
    if (this.h.listed) this.sendCall({ type: 'call.update', status: this.status() });
  }

  // ---- 参加・退出 ----

  async join(): Promise<void> {
    const h = this.h;
    if (h.joined || h.joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // WebKitGTK では、メディアストリームの設定が効いていない・安全なコンテキストでないと mediaDevices が無い
      const why = `mediaDevices なし（secureContext=${String(window.isSecureContext)}, origin=${location.origin}）`;
      console.error('[call] マイクを使えません:', why);
      h.deps.toast(`この環境ではマイクを使えません（${why}）。アプリ版で使ってください`, 'error');
      return;
    }
    h.joining = true;
    h.refresh();
    try {
      let stream: MediaStream;
      try {
        stream = await this.audio.open();
      } catch (e) {
        const name = errName(e);
        console.error('[call] マイクを開けませんでした', e);
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          h.deps.toast(`マイクの使用が許可されていません（${name}）。デバイスの設定で許可してください`, 'error');
        } else if (name === 'NotFoundError') {
          h.deps.toast('マイクが見つかりません', 'error');
        } else {
          h.deps.toast(`マイクを開けませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        return;
      }
      // WebView を裏でも動かすかを、常駐の開始の前に決める
      setKeepWebViewResumed(keepWebViewEnabled());
      // マイクの許可を得たあとで常駐を始める（Android 14 以降は許可前だと失敗する）
      try {
        this.notifyKey = '';
        this.backgroundNoticed = false;
        this.serviceOff?.();
        this.serviceOff = h.deps.onServiceFailed?.(() => this.noticeBackground()) ?? null;
        this.background = await h.deps.hold({
          microphone: true,
          ...this.notification(),
          // アプリが裏にいても届く。届かないとき、切断は本体が通知を止める（dismiss）
          onAction: (id) => {
            if (id === 'mute') this.toggleMute();
            else if (id === 'deafen') this.toggleDeafen();
            else if (id === 'hangup') this.leave(true, 'notification-hangup');
          },
        });
        this.notifyKey = JSON.stringify(this.notification());
      } catch (e) {
        console.error('[call] 常駐を始められませんでした', e);
        this.noticeBackground();
      }

      try {
        await this.audio.start(stream);
        this.h.peerId = randomId();
        this.rejoinRetried = false;
        this.autoRejoinUsed = false;
        this.aliveAt = h.deps.now();
        // 参加時の状態。mic はミュート（旧い joinMuted と同じ）、speaker はスピーカーミュート（ミュートも入り、外すと一緒に外れる）
        const join = joinStateOf(h.settings.joinMode);
        h.muted = join.muted;
        h.deafened = join.deafened;
        h.muteByDeafen = join.deafened;
        this.audio.applyMute();
        this.audio.diag.reset(h.deps.now());
        h.joined = true;
        h.listed = false;
        console.info(`[call] join を送ります: peer=${h.peerId}`);
        this.trail = [];
        this.trailStart = h.deps.now();
        this.sendCall({ type: 'call.join', peer: h.peerId, status: this.status() });
        this.checkListed();
        void this.restoreOutputs();
        this.startWorker();
        this.audio.reconcile();
        this.audio.diagNow('参加');
      } catch (e) {
        // マイクを開いたあとの失敗（AudioContext など）。握りつぶさず原因を出し、開いたマイクも閉じる
        console.error('[call] 通話に参加できませんでした', e);
        h.deps.toast(`通話に参加できませんでした: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, 'error');
        this.leave(h.joined, 'join-error');
        stream.getTracks().forEach((t) => t.stop());
      }
    } finally {
      h.joining = false;
      h.refresh();
    }
  }

  /** 抜ける。sendLeave が false なのは、サーバーに外されたとき */
  leave(sendLeave: boolean, reason: string): void {
    const h = this.h;
    if (!h.joined && !this.audio.localStream) return;
    this.audio.diagNow(`退出: ${reason}`);
    console.info(`[call] 通話から抜けます: reason=${reason} sendLeave=${sendLeave}`);
    h.dropEmits();
    if (h.joined && sendLeave) this.sendCall({ type: 'call.leave' });
    h.joined = false;
    h.listed = false;
    h.linkDown = false;
    h.deafened = false;
    h.muteByDeafen = false;
    h.outputs = [];
    this.stopWorker();
    h.peerView = {};
    h.selfSpeaking = false;
    h.peerId = '';
    this.audio.stop();
    this.background?.();
    this.background = null;
    this.serviceOff?.();
    this.serviceOff = null;
    h.refresh();
  }

  // ---- ミュート・音量 ----

  applyMicVolume(): void { this.audio.applyMicVolume(); }
  applyOutVolume(): void { this.audio.applyOutVolume(); }

  toggleMute(): void {
    const h = this.h;
    h.muted = !h.muted;
    // ミュートを外したら、スピーカーミュートも外す（ミュートなしでスピーカーミュートにはしない）
    if (!h.muted && h.deafened) this.audio.setDeafened(false);
    this.audio.applyMute();
    this.sendStatus();
    h.refresh();
  }

  toggleDeafen(): void {
    this.audio.setDeafened(!this.h.deafened);
    this.audio.applyMute();
    this.sendStatus();
    this.h.refresh();
  }

  toggleLocalMute(peer: string): void {
    if (this.audio.toggleLocalMute(peer)) this.h.refresh();
  }

  kick(peer: string): void {
    this.sendCall({ type: 'call.kick', peer });
  }

  emit(name: string, payload: unknown): void {
    this.sendCall({ type: 'call.emit', name, payload });
  }

  get bufferedAmount(): number {
    try {
      return this.h.deps.buffered?.() ?? 0;
    } catch {
      return 0;
    }
  }

  async adopt(): Promise<void> {}
  onServerChanged(): void {}

  /** 参加したとき、前に選んだ出力先に戻す（Web は参加時に自分で呼ぶ。外から呼ぶ入口） */
  async restoreOutputs(): Promise<void> {
    await this.h.outputControl.restore();
  }

  /** LEVEL_MS ごと。生存の印・出力先の取り直し・声の取り出し・メーター */
  tick(): void {
    const h = this.h;
    if (!h.joined) return;
    const now = h.deps.now();
    // 生存の印。音声が止まっていても（ミュート・無音・画面が裏）送る。JS が止まればサーバーは外す
    if (h.listed && now - this.aliveAt >= ALIVE_MS) {
      this.aliveAt = now;
      this.sendCall({ type: 'call.alive' });
      this.audio.diag.add('alive');
    }
    this.audio.watchOutput(now);
    if (++this.outputsTick >= OUTPUTS_REFRESH_TICKS) {
      this.outputsTick = 0;
      void h.outputControl.refresh();
    }
    if (this.audio.tick(now)) h.refresh();
  }

  /** 接続の状態（しゃべっている・消音）を画面用に写す */
  syncView(): void {
    const h = this.h;
    h.peerView = this.audio.syncView(h.peerView);
    const me = !!this.audio.localMeter?.speaking;
    if (me !== h.selfSpeaking) h.selfSpeaking = me;
  }

  private notification() {
    return notificationContent({ muted: this.h.muted, deafened: this.h.deafened, count: this.h.participants.length });
  }

  /** 人数やミュートが変わったら、通知を差し替える */
  updateNotification(): void {
    if (!this.background) return;
    const content = this.notification();
    const key = JSON.stringify(content);
    if (key === this.notifyKey) return;
    this.notifyKey = key;
    this.background.update(content);
  }

  reportCallbackError(e: unknown): void {
    console.error('[call] プラグインのコールバックで例外', e);
  }
}
