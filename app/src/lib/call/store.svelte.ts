import type { CallMember } from '../protocol/CallMember';
import type { CallStatus } from '../protocol/CallStatus';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { IconRef } from '../icons.svelte';
import { startCapture, type Capture } from './capture';
import {
  EV_AUDIO,
  Framer,
  LEVEL_MS,
  PeakLimiter,
  clipCurve,
  clampLimitDb,
  dbToLinear,
  OUTPUTS_REFRESH_TICKS,
  RELAY_HOLD_MS,
  RELAY_RATE,
  RELAY_SILENCE,
  Resampler,
  base64ToPcm,
  byteLevel,
  diffPeers,
  floatToInt16,
  int16ToFloat,
  notificationContent,
  pcmToBase64,
  pickOutput,
  randomId,
  rms,
  scheduleFrame,
  updateSpeaking,
} from './pure';
import type { CallSettings } from './settings.svelte';

// 通話（みんな共通の1部屋）。参加者の一覧・kick・音声の中継はサーバー（call.* イベント）が受け持つ。
// 音声は全員のあいだをサーバー経由（call.emit の audio。16kHz モノラル PCM）で流す（WebRTC は使わない）。
// ここは画面に触れず、画面は participants などを読む

/** 本体から借りる機能（テストで差し替える） */
export type CallDeps = {
  send(ev: ClientEvent): void;
  meId(): string;
  nameOf(id: string): string;
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(opts: { title: string; body?: string; okLabel: string; danger?: boolean }): Promise<boolean>;
  /** 画面を切っても動き続けるための常駐（Android） */
  hold(opts: Disnans.BackgroundOptions): Promise<Disnans.BackgroundHandle>;
  audio: Disnans.Audio;
  settings: CallSettings;
  /** この端末の種類（smartphone / tablet / laptop / monitor） */
  deviceKind(): string;
  /** 通話の設定画面を開く */
  openSettings(): void;
  now(): number;
  /** WebSocket でまだ送り出せていないバイト数（無ければ 0 とみなす） */
  buffered?(): number;
};

/** 画面・プラグインに見せる参加者1人分 */
export type CallParticipant = {
  peer: string;
  userId: string;
  self: boolean;
  muted: boolean;
  deafened: boolean;
  connected: boolean;
  speaking: boolean;
  /** 自分の側だけで消音している */
  localMuted: boolean;
  device: string | null;
};

/** 参加者から届いた、プラグインのデータ（call.emit） */
export type CallDataEvent = { peer: string; userId: string; payload: unknown };

/** プラグインが使えるイベント名。audio は本体の音声が使う */
const RESERVED_EVENTS = new Set([EV_AUDIO]);

/** 通話のバーに足すボタン */
export type BarButtonDef = { icon: IconRef; label: string; onClick: () => void; active?: boolean; disabled?: boolean; location?: 'both' | 'view' };
export type BarButton = BarButtonDef & { id: number };

/** 通話の画面（CallView）に、プラグインが足す領域 */
export type CallPanelDef = { label: string; order?: number };
export type CallPanelEntry = { id: number; label: string; order: number; el: HTMLElement; visible: boolean };
type PanelState = { mounted: boolean; listeners: Set<(mounted: boolean) => void> };

type PeerView = { speaking: boolean; localMuted: boolean };

type Meter = { analyser: AnalyserNode; buf: Uint8Array; lastLoud: number; speaking: boolean };

type RelayIn = { gain: GainNode; meter: Meter | null; st: { next: number }; limiter: PeakLimiter | null };

/** 通話にいる自分以外の接続1つ分の状態 */
type Entry = {
  peer: string;
  userId: string;
  status: CallStatus;
  relay: RelayIn | null;
  localMuted: boolean;
};

function makeEntry(m: CallMember): Entry {
  return { peer: m.peer, userId: m.user_id, status: m.status, relay: null, localMuted: false };
}

function makeMeter(analyser: AnalyserNode): Meter {
  analyser.fftSize = 512;
  return { analyser, buf: new Uint8Array(analyser.fftSize), lastLoud: 0, speaking: false };
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}

/** 無音を防ぐ信号（聞こえない大きさ・低さ） */
/** 参加を送ったあと、サーバーの参加者一覧に自分が居るかを確かめるまでの時間（診断用） */
const LISTED_CHECK_MS = 3000;
const KEEPALIVE_HZ = 20;
const KEEPALIVE_GAIN = 0.0001;

export class CallStore {
  // ---- 画面が読む状態（リアクティブ） ----
  /** サーバーが知っている通話の参加者（自分を含む） */
  members = $state.raw<CallMember[]>([]);
  joined = $state(false);
  /** 参加を送ったあと、サーバーの参加者一覧に自分が載ったか（載るまでは「参加中…」。自分のアイコンは出さない） */
  listed = $state(false);
  /** 通話に参加しているあいだ、チャットの接続が切れているか（取りこぼし中） */
  linkDown = $state(false);
  joining = $state(false);
  muted = $state(false);
  /** 相手の声を全部消している（スピーカーミュート） */
  deafened = $state(false);
  /** 選べる出力先 */
  outputs = $state.raw<Disnans.AudioOutput[]>([]);
  barButtons = $state.raw<BarButton[]>([]);
  /** 通話の画面に出す、プラグインの領域（order の順） */
  panels = $state.raw<CallPanelEntry[]>([]);
  private peerView = $state.raw<Record<string, PeerView>>({});
  private selfSpeaking = $state(false);

  // ---- 内部 ----
  private peerId = '';
  private entries = new Map<string, Entry>();
  private localStream: MediaStream | null = null;
  private micGain: GainNode | null = null;
  private captureSrc: AudioNode | null = null;
  private capture: Capture | null = null;
  private resampler: Resampler | null = null;
  private framer = new Framer();
  private relaySeq = 0;
  private relayLoudAt = 0;
  private outputsBusy = false;
  private outputsTick = 0;
  private ctx: AudioContext | null = null;
  /** 通話中、画面が戻ったときに AudioContext を動かし直す（別のアプリを開いたあとに止まっていることがある） */
  private readonly onVisible = (): void => {
    this.logAudio('visibility');
    if (document.visibilityState === 'visible') this.keepContextRunning();
  };
  private ctxDetach: (() => void) | null = null;
  private localMeter: Meter | null = null;
  /** 受け取った音の合計を上限で抑える最後の段（無ければ出力先に直接） と、その設定の控え */
  private limitBus: WaveShaperNode | null = null;
  private limitKey = '';
  private worker: { terminate(): void } | null = null;
  private background: Disnans.BackgroundHandle | null = null;
  private notifyKey = '';
  private buttonSeq = 0;
  private panelSeq = 0;
  private panelState = new Map<number, PanelState>();
  private eventListeners = new Map<string, Set<(e: CallDataEvent) => void>>();
  private changeListeners = new Set<() => void>();
  private changeSig = '';

  constructor(private deps: CallDeps) {}

  private get settings() {
    return this.deps.settings.value;
  }

  // ---- 読み取り ----

  /** 自分の接続の ID（参加していなければ空） */
  get myPeer(): string {
    return this.peerId;
  }

  /** 自分以外の参加者 */
  private get others(): CallMember[] {
    return this.members.filter((m) => m.peer !== this.peerId);
  }

  /** 上部のバー用。通話の全画面だけに出すボタンは除く */
  get topBarButtons(): BarButton[] {
    return this.barButtons.filter((b) => b.location !== 'view');
  }

  /** 通話のバーを出すか（参加中、またはだれかがいる） */
  get visible(): boolean {
    return this.joined || this.joining || this.others.length > 0;
  }

  /** 参加者。参加中なら自分が先頭 */
  /** 参加を送ったが、まだサーバーの一覧に載っていない */
  get pending(): boolean {
    return this.joined && !this.listed;
  }

  get participants(): CallParticipant[] {
    const out: CallParticipant[] = [];
    // 自分は、サーバーの一覧に載ってから（入れていないのに自分を出さない）。接続中（joining）は出さない
    if (this.listed && this.joined) {
      out.push({
        peer: this.peerId,
        userId: this.deps.meId(),
        self: true,
        muted: this.muted,
        deafened: this.deafened,
        connected: this.joined,
        speaking: this.selfSpeaking && !this.muted,
        localMuted: false,
        device: this.deps.deviceKind(),
      });
    }
    for (const m of this.others) {
      const v = this.peerView[m.peer];
      out.push({
        peer: m.peer,
        userId: m.user_id,
        self: false,
        muted: m.status.muted,
        deafened: m.status.deafened,
        connected: true,
        speaking: (v?.speaking ?? false) && !m.status.muted && !v?.localMuted,
        localMuted: v?.localMuted ?? false,
        device: m.status.device,
      });
    }
    return out;
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
        if (this.joined) {
          this.leave(false, 'kicked');
          this.deps.toast(`${this.deps.nameOf(ev.by)}さんに通話から外されました`, 'info');
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
    console.warn(`[call] サーバーが通話の操作を受け付けませんでした: code=${code} message=${message}`);
    if (!this.joined) return;
    if (code === 'peer_in_use' && !this.rejoinRetried) {
      this.rejoinRetried = true;
      this.rejoin();
      return;
    }
    // 参加が一覧に載る前の失敗（参加そのものが通らなかった）
    if (!this.listed) {
      this.failJoin(message);
      return;
    }
    // 載ってからの not_in_call: サーバーは自分を参加者と見ていない。状態を合わせて外れる
    if (code === 'not_in_call') {
      this.leave(false, 'not-listed');
      this.deps.toast('通話から外れました', 'info');
    }
  }

  /** 参加が通らなかった（一覧に載らない・拒否された）。通話の表示を閉じて、理由を知らせる */
  private failJoin(reason: string): void {
    console.warn(`[call] 参加できませんでした: ${reason}`);
    this.leave(true, 'join-failed');
    this.deps.toast(`通話に入れませんでした（${reason}）`, 'error');
  }

  /** 新しい接続 ID で入り直す（サーバーの通話の一覧に自分を入れ直す） */
  private rejoin(): void {
    this.peerId = randomId();
    this.listed = false;
    this.deps.send({ type: 'call.join', peer: this.peerId, status: this.status() });
    this.checkListed();
  }

  /**
   * 診断: 入る（call.join）を送って少し後に、サーバーの参加者一覧に自分が居るか確かめる。
   * 居なければ、入れなかった（拒否・未達・外された）ので、console.warn に残す。
   */
  private checkListed(): void {
    const peer = this.peerId;
    setTimeout(() => {
      if (!this.joined || this.peerId !== peer || this.listed) return;
      console.warn(`[call] 参加の送信後も、サーバーの参加者一覧に自分がいません: peer=${peer} members=${this.members.length}`);
      this.failJoin('サーバーから返事がありませんでした');
    }, LISTED_CHECK_MS);
  }

  /**
   * チャットの接続が切れた・戻った（client.subscribeLink）。切れているあいだは音声を取りこぼす（許容）。
   * 戻ったら hello（onReconnect）で入り直す。ここでは利用者へ知らせるだけ。
   */
  onLink(up: boolean): void {
    if (!this.joined) return;
    if (up) {
      if (this.linkDown) {
        this.linkDown = false;
        this.deps.toast('通話の接続が戻りました', 'info');
      }
      return;
    }
    if (this.linkDown) return;
    this.linkDown = true;
    this.deps.toast('通話の接続が切れました。つながると自動で入り直します', 'info');
  }

  /** つなぎ直したら、サーバーは自分を通話から外している。入り直す */
  private onReconnect(): void {
    if (!this.joined) return;
    // 前の接続 ID は、前の接続がサーバーに残っているあいだは使えない（peer_in_use）。新しい ID で入る
    this.rejoinRetried = false;
    this.rejoin();
  }

  /** peer_in_use の再入りを、1 回の入り直しにつき 1 度だけにする */
  private rejoinRetried = false;

  private onState(members: CallMember[]): void {
    this.members = members;
    if (this.joined && this.peerId) {
      const here = members.some((m) => m.peer === this.peerId);
      if (here) {
        this.listed = true;
      } else if (this.listed) {
        // 載っていたのに、いなくなった（サーバーが外した・接続が替わった）。通話から外れる
        this.leave(false, 'not-listed');
        this.deps.toast('通話から外れました', 'info');
        return;
      }
    }
    if (this.joined) this.reconcile();
    this.refresh();
  }

  /** サーバーの参加者に合わせて、接続の管理を増減する */
  private reconcile(): void {
    const others = this.others;
    const { removed } = diffPeers(
      [...this.entries.keys()],
      others.map((m) => m.peer),
      this.peerId,
    );
    for (const peer of removed) {
      const e = this.entries.get(peer);
      if (e) e.relay = null;
      this.entries.delete(peer);
    }
    for (const m of others) {
      let e = this.entries.get(m.peer);
      if (!e) {
        e = makeEntry(m);
        this.entries.set(m.peer, e);
      }
      e.userId = m.user_id;
      e.status = m.status;
    }
  }

  private onCallEvent(peer: string, name: string, payload: unknown): void {
    if (!this.joined) return;
    if (name === EV_AUDIO) {
      this.onRelayAudio(peer, payload);
      return;
    }
    const e = this.entries.get(peer);
    const set = this.eventListeners.get(name);
    if (!e || !set) return;
    for (const cb of [...set]) this.safe(() => cb({ peer, userId: e.userId, payload }));
  }

  // ---- 状態の送信 ----

  private status(): CallStatus {
    return { muted: this.muted, deafened: this.deafened, device: this.deps.deviceKind() };
  }

  private sendStatus(): void {
    if (this.joined) this.deps.send({ type: 'call.update', status: this.status() });
  }

  // ---- 参加・退出 ----

  async join(): Promise<void> {
    if (this.joined || this.joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      // WebKitGTK では、メディアストリームの設定が効いていない・安全なコンテキストでないと mediaDevices が無い
      const why = `mediaDevices なし（secureContext=${String(window.isSecureContext)}, origin=${location.origin}）`;
      console.error('[call] マイクを使えません:', why);
      this.deps.toast(`この環境ではマイクを使えません（${why}）。アプリ版で使ってください`, 'error');
      return;
    }
    this.joining = true;
    this.refresh();
    try {
      let stream: MediaStream;
      try {
        stream = await this.openMic();
      } catch (e) {
        const name = errName(e);
        console.error('[call] マイクを開けませんでした', e);
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.deps.toast(`マイクの使用が許可されていません（${name}）。端末の設定で許可してください`, 'error');
        } else if (name === 'NotFoundError') {
          this.deps.toast('マイクが見つかりません', 'error');
        } else {
          this.deps.toast(`マイクを開けませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        return;
      }
      // マイクの許可を得たあとで常駐を始める（Android 14 以降は許可前だと失敗する）
      try {
        this.notifyKey = '';
        this.background = await this.deps.hold({
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
        this.deps.toast('画面を消すと通話が切れることがあります', 'info');
      }

      this.localStream = stream;
      try {
        this.ctx = new AudioContext();
        void this.ctx.resume().catch(() => {});
        // 別のアプリを開いたとき、WebView が裏に回って AudioContext が止められることがある。止まったら動かし直す
        this.ctx.onstatechange = () => this.onContextState();
        this.startKeepAlive(this.ctx);
        document.addEventListener('visibilitychange', this.onVisible);
        this.watchMicTracks(stream);
        this.ctxDetach = this.deps.audio.attach(this.ctx);
        this.localMeter = makeMeter(this.ctx.createAnalyser());
        await this.setupSend(stream, this.ctx, this.localMeter);

        this.peerId = randomId();
        this.rejoinRetried = false;
        this.muted = this.settings.joinMuted;
        this.deafened = false;
        this.applyMute();
        this.joined = true;
        this.listed = false;
        console.info(`[call] join を送ります: peer=${this.peerId}`);
        this.deps.send({ type: 'call.join', peer: this.peerId, status: this.status() });
        this.checkListed();
        void this.restoreOutput();
        this.startWorker();
        this.reconcile();
      } catch (e) {
        // マイクを開いたあとの失敗（AudioContext など）。握りつぶさず原因を出し、開いたマイクも閉じる
        console.error('[call] 通話に参加できませんでした', e);
        this.deps.toast(`通話に参加できませんでした: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, 'error');
        this.leave(this.joined, 'join-error');
        stream.getTracks().forEach((t) => t.stop());
      }
    } finally {
      this.joining = false;
      this.refresh();
    }
  }

  /** 抜ける。sendLeave が false なのは、サーバーに外されたとき */
  leave(sendLeave = true, reason = 'user'): void {
    if (!this.joined && !this.localStream) return;
    console.info(`[call] 通話から抜けます: reason=${reason} sendLeave=${sendLeave}`);
    if (this.joined && sendLeave) this.deps.send({ type: 'call.leave' });
    this.joined = false;
    this.listed = false;
    this.linkDown = false;
    this.deafened = false;
    this.outputs = [];
    this.stopWorker();
    this.entries.clear();
    this.peerView = {};
    this.selfSpeaking = false;
    this.peerId = '';
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    this.micGain = null;
    this.captureSrc = null;
    this.stopCapture();
    this.localMeter = null;
    this.ctxDetach?.();
    this.ctxDetach = null;
    if (this.ctx) this.ctx.onstatechange = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.limitBus = null;
    this.limitKey = '';
    this.background?.();
    this.background = null;
    this.refresh();
  }

  /** 通話中に AudioContext が止まっていたら動かし直す */
  private keepContextRunning(): void {
    if (this.joined && this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  /** 診断（console.info。Android では WebView のログとして出る）。状態と、時計が進んでいるかを残す */
  private logAudio(reason: string): void {
    const ctx = this.ctx;
    if (!this.joined || !ctx) return;
    console.info(`[call] audio ${reason}: state=${ctx.state} t=${ctx.currentTime.toFixed(2)} visibility=${document.visibilityState}`);
  }

  /**
   * 無音が続くと、WebView は出力の経路を閉じる（音が来ると開き直すが、そのあいだ数秒は無音になる）。
   * 聞こえない程度の信号を流し続けて、無音にしない。
   */
  private startKeepAlive(ctx: AudioContext): void {
    if (typeof ctx.createOscillator !== 'function') return;
    this.keepAlive?.stop();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = KEEPALIVE_HZ;
    gain.gain.value = KEEPALIVE_GAIN;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    this.keepAlive = osc;
  }
  private keepAlive: OscillatorNode | null = null;

  private onContextState(): void {
    this.logAudio('statechange');
    this.keepContextRunning();
  }

  /** マイクが途中で止まった（OS やほかのアプリに取られた）ことを知らせる。stop() では発火しない */
  private watchMicTracks(stream: MediaStream): void {
    for (const track of stream.getAudioTracks()) {
      track.onended = () => {
        console.warn('[call] マイクが止まりました');
        if (this.joined) this.deps.toast('マイクが止まりました。通話し直してください', 'error');
      };
    }
  }

  /** マイクを開く。選んだ機器が使えなければ既定の機器で開き直す */
  private async openMic(): Promise<MediaStream> {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const id = this.settings.inputId;
    if (id) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: id } }, video: false });
      } catch (e) {
        if (errName(e) !== 'OverconstrainedError' && errName(e) !== 'NotFoundError') throw e;
      }
    }
    return await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }

  /** マイク → 音量（GainNode）→ 取り出す。通せないとき（AudioContext が動かない環境）は、マイクをそのまま取り出す */
  private async setupSend(stream: MediaStream, ctx: AudioContext, meter: Meter): Promise<void> {
    this.micGain = null;
    this.captureSrc = null;
    try {
      await ctx.resume();
      if (ctx.state !== 'running' || !ctx.createGain) throw new Error('AudioContext が動いていません');
      const gain = ctx.createGain();
      ctx.createMediaStreamSource(stream).connect(gain);
      gain.connect(meter.analyser);
      this.micGain = gain;
      this.captureSrc = gain;
      this.applyMicVolume();
    } catch (e) {
      console.warn('[call] マイクの音量を調整できません。そのまま送ります', e);
      const src = ctx.createMediaStreamSource(stream);
      src.connect(meter.analyser);
      this.captureSrc = src;
    }
  }

  // ---- ミュート・音量 ----

  applyMicVolume(): void {
    if (this.micGain) this.micGain.gain.value = this.settings.micVolume;
  }

  applyOutVolume(): void {
    for (const e of this.entries.values()) this.applyEntryAudio(e);
  }

  /** 相手1人分の音（GainNode）に、音量・消音を反映する */
  private applyEntryAudio(e: Entry): void {
    const silent = e.localMuted || this.deafened;
    if (e.relay) e.relay.gain.gain.value = silent ? 0 : this.settings.outVolume;
  }

  toggleMute(): void {
    if (!this.joined) {
      this.deps.toast('通話に参加していません', 'error');
      return;
    }
    this.muted = !this.muted;
    this.applyMute();
    this.sendStatus();
    this.refresh();
  }

  private applyMute(): void {
    // 送る音は onCapture でも止める。マイクそのものも止める
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
  }

  toggleDeafen(): void {
    if (!this.joined) {
      this.deps.toast('通話に参加していません', 'error');
      return;
    }
    this.deafened = !this.deafened;
    for (const e of this.entries.values()) this.applyEntryAudio(e);
    this.sendStatus();
    this.refresh();
  }

  /** 相手1人を、自分の側だけで消音する／戻す */
  toggleLocalMute(peer: string): void {
    const e = this.entries.get(peer);
    if (!e) return;
    e.localMuted = !e.localMuted;
    this.applyEntryAudio(e);
    this.refresh();
  }

  /** 参加者を通話から外す（確認のあと、サーバーに頼む。外された人には call.kicked が届く） */
  async kick(peer: string): Promise<void> {
    const m = this.others.find((x) => x.peer === peer);
    if (!this.joined || !m) return;
    const name = this.deps.nameOf(m.user_id);
    const ok = await this.deps.confirm({
      title: `${name}さんを通話から外しますか？`,
      body: '相手の通話は切れます。相手はまた参加できます。',
      okLabel: '外す',
      danger: true,
    });
    if (!ok || !this.joined) return;
    this.deps.send({ type: 'call.kick', peer });
  }

  // ---- 音の出力先 ----

  /** 選べる出力先を取り直す。変わっていたら画面を更新する */
  async refreshOutputs(): Promise<void> {
    if (this.outputsBusy) return;
    this.outputsBusy = true;
    try {
      const list = await this.deps.audio.listOutputs();
      if (JSON.stringify(list) !== JSON.stringify(this.outputs)) this.outputs = list;
    } catch (e) {
      console.warn('[call] 出力先の一覧を取れません', e);
    } finally {
      this.outputsBusy = false;
    }
  }

  /** 参加したとき、前に選んだ出力先に戻す（なければ本体の既定: イヤホンがあればそれ、なければスピーカー） */
  private async restoreOutput(): Promise<void> {
    await this.refreshOutputs();
    const want = pickOutput(this.outputs, this.settings.output);
    if (want && !want.selected) await this.applyOutput(want);
  }

  private async applyOutput(o: Disnans.AudioOutput): Promise<boolean> {
    const ok = await this.deps.audio.setOutput(o.id).catch(() => false);
    if (ok) await this.refreshOutputs();
    return ok;
  }

  async chooseOutput(id: string): Promise<void> {
    const o = this.outputs.find((x) => x.id === id);
    if (!o) return;
    if (!(await this.applyOutput(o))) {
      this.deps.toast('出力先を切り替えられませんでした', 'error');
      return;
    }
    this.deps.settings.patch({ output: { id: o.id, kind: o.kind, label: o.label } });
  }

  /** 次の出力先へ（コマンド用） */
  async cycleOutput(): Promise<void> {
    if (!this.joined) {
      this.deps.toast('通話に参加していません', 'error');
      return;
    }
    await this.refreshOutputs();
    if (this.outputs.length < 2) {
      this.deps.toast('切り替えられる出力先がありません', 'info');
      return;
    }
    const i = this.outputs.findIndex((o) => o.selected);
    const next = this.outputs[(i + 1) % this.outputs.length];
    await this.chooseOutput(next.id);
    this.deps.toast(`出力先: ${next.label}`, 'info');
  }

  // ---- タイマー ----

  /** タイマーは Worker で回す（画面が裏に回ってもメインスレッドのタイマーのように間引かれにくい） */
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

  /** LEVEL_MS ごと。出力先の取り直し・声の取り出しを始める・音量を見る */
  tick(): void {
    if (!this.joined) return;
    const now = this.deps.now();
    let changed = false;
    if (++this.outputsTick >= OUTPUTS_REFRESH_TICKS) {
      this.outputsTick = 0;
      void this.refreshOutputs();
    }
    if (this.entries.size > 0) this.ensureCapture();
    if (this.localMeter && this.updateMeter(this.localMeter, now, this.muted)) changed = true;
    for (const e of this.entries.values()) {
      const m = e.relay?.meter;
      if (m && this.updateMeter(m, now, e.status.muted || e.localMuted)) changed = true;
    }
    if (changed) this.refresh();
  }

  private updateMeter(m: Meter, now: number, silent: boolean): boolean {
    let level = 0;
    if (!silent) {
      m.analyser.getByteTimeDomainData(m.buf as Uint8Array<ArrayBuffer>);
      level = byteLevel(m.buf);
    }
    return updateSpeaking(m, level, now, silent);
  }

  // ---- 音声（サーバーの call.emit を通す。相手がいる間だけ送る） ----

  private ensureCapture(): void {
    const ctx = this.ctx;
    const src = this.captureSrc;
    if (this.capture || !ctx || !src) return;
    this.resampler = new Resampler(ctx.sampleRate);
    this.framer = new Framer();
    this.capture = startCapture(ctx, src, (chunk) => this.onCapture(chunk));
  }

  private stopCapture(): void {
    try {
      this.capture?.stop();
    } catch {
      /* すでに外れている */
    }
    this.capture = null;
    this.resampler = null;
  }

  /** マイクの音（AudioContext の周波数）を 16kHz に直して送る */
  private onCapture(chunk: Float32Array): void {
    if (!this.joined || !this.resampler || this.entries.size === 0) return;
    const volume = this.micGain ? 1 : this.settings.micVolume;
    const out = this.resampler.push(chunk);
    for (const frame of this.framer.push(out)) {
      if (this.muted) continue;
      if (volume !== 1) for (let i = 0; i < frame.length; i++) frame[i] *= volume;
      const now = this.deps.now();
      if (rms(frame) > RELAY_SILENCE) this.relayLoudAt = now;
      else if (now - this.relayLoudAt > RELAY_HOLD_MS) continue;
      this.deps.send({ type: 'call.emit', name: EV_AUDIO, payload: { seq: this.relaySeq++, pcm: pcmToBase64(floatToInt16(frame)) } });
    }
  }

  /** 上限の設定（オフなら null） */
  private limitDb(): number | null {
    return this.settings.limiter ? clampLimitDb(this.settings.limitDb) : null;
  }

  /** 受け取りの出口。合計を抑える段があれば、いまの上限に合わせて返す（無ければ出力先に直接） */
  private receiveOut(ctx: AudioContext, db: number | null): AudioNode {
    if (typeof ctx.createWaveShaper !== 'function') return ctx.destination;
    if (!this.limitBus) {
      this.limitBus = ctx.createWaveShaper();
      this.limitBus.connect(ctx.destination);
    }
    const key = db === null ? 'off' : String(db);
    if (key !== this.limitKey) {
      this.limitKey = key;
      // オフなら曲線を外し、合計が 1 を超えてもこの段では加工しない
      this.limitBus.curve = db === null ? null : clipCurve(dbToLinear(db));
    }
    return this.limitBus;
  }

  private onRelayAudio(peer: string, payload: unknown): void {
    const p = payload as { pcm?: unknown } | null;
    const ctx = this.ctx;
    const e = this.entries.get(peer);
    if (!ctx || !p || !e || e.status.muted || e.localMuted || this.deafened) return;
    const pcm = base64ToPcm(p.pcm);
    if (!pcm) return;
    try {
      const db = this.limitDb();
      const out = this.receiveOut(ctx, db);
      if (!e.relay) {
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        gain.connect(out);
        gain.connect(analyser);
        e.relay = { gain, meter: makeMeter(analyser), st: { next: 0 }, limiter: null };
        this.applyEntryAudio(e);
      }
      // 大きすぎる音を上限で抑える（音量の設定より前。端末の音量ではなく、受け取った音の大きさで決める）
      let samples = int16ToFloat(pcm);
      if (db !== null) {
        e.relay.limiter ??= new PeakLimiter(RELAY_RATE, db);
        e.relay.limiter.setCeilingDb(db);
        samples = e.relay.limiter.process(samples);
      } else {
        // 入れ直したときに、オフにする前の先読みの音を再生しない
        e.relay.limiter = null;
      }
      const buf = ctx.createBuffer(1, samples.length, RELAY_RATE);
      buf.getChannelData(0).set(samples);
      const at = scheduleFrame(e.relay.st, ctx.currentTime, pcm.length / RELAY_RATE);
      if (at === null) return;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(e.relay.gain);
      node.start(at);
    } catch (err) {
      console.warn('[call] リレーの音を鳴らせません', err);
    }
  }

  // ---- 拡張 API（プラグインから: disnans.call） ----

  /** 通話の参加者全員に、データを送る（サーバー経由。保存しない）。通話に参加していなければ例外 */
  emit(name: string, payload: unknown): void {
    if (!this.joined) throw new Error('通話に参加していません');
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) throw new Error('イベント名は 1〜64 文字にしてください');
    if (RESERVED_EVENTS.has(name)) throw new Error(`イベント名 ${name} は本体が使います`);
    this.deps.send({ type: 'call.emit', name, payload });
  }

  /** 参加者が emit したデータを受け取る。戻り値の関数で外す */
  onEvent(name: string, cb: (e: CallDataEvent) => void): Disnans.Cleanup {
    let set = this.eventListeners.get(name);
    if (!set) this.eventListeners.set(name, (set = new Set()));
    set.add(cb);
    return () => void this.eventListeners.get(name)?.delete(cb);
  }

  onChange(cb: () => void): Disnans.Cleanup {
    this.changeListeners.add(cb);
    return () => void this.changeListeners.delete(cb);
  }

  /** 通話のバーにボタンを足す。返り値で更新・削除 */
  addBarButton(def: BarButtonDef): { update(patch: Partial<BarButtonDef>): void; remove(): void } {
    const id = ++this.buttonSeq;
    this.barButtons = [...this.barButtons, { ...def, id }];
    return {
      update: (patch) => {
        this.barButtons = this.barButtons.map((b) => (b.id === id ? { ...b, ...patch, id } : b));
      },
      remove: () => {
        this.barButtons = this.barButtons.filter((b) => b.id !== id);
      },
    };
  }

  /** WebSocket でまだ送り出せていないバイト数。映像を送るプラグインは、多いあいだ次のフレームを待つ */
  get bufferedAmount(): number {
    try {
      return this.deps.buffered?.() ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * 通話の画面（全画面の通話タブ）に、プラグインの領域を足す。el はプラグインが中身を書く要素で、
   * 通話の画面が開いている間だけ文書に入る（閉じても中身は保たれる）。
   */
  addPanel(def: CallPanelDef): Disnans.CallPanel {
    const id = ++this.panelSeq;
    const el = document.createElement('div');
    el.className = 'call-plugin-panel';
    const state: PanelState = { mounted: false, listeners: new Set() };
    this.panelState.set(id, state);
    const entry: CallPanelEntry = { id, label: String(def.label ?? ''), order: Number(def.order ?? 0) || 0, el, visible: false };
    this.panels = [...this.panels, entry].sort((a, b) => a.order - b.order || a.id - b.id);
    const set = (patch: Partial<CallPanelEntry>) => {
      this.panels = this.panels.map((p) => (p.id === id ? { ...p, ...patch } : p));
    };
    return {
      el,
      get mounted() {
        return state.mounted;
      },
      get visible() {
        return entry.visible;
      },
      setVisible: (v) => {
        entry.visible = !!v;
        set({ visible: entry.visible });
      },
      onMount: (cb) => {
        state.listeners.add(cb);
        return () => void state.listeners.delete(cb);
      },
      remove: () => {
        this.panels = this.panels.filter((p) => p.id !== id);
        this.panelState.delete(id);
        state.listeners.clear();
        el.remove();
      },
    };
  }

  /** 通話の画面が、領域の要素を文書に入れた・外した（CallView から呼ぶ） */
  panelMounted(id: number, mounted: boolean): void {
    const state = this.panelState.get(id);
    if (!state || state.mounted === mounted) return;
    state.mounted = mounted;
    for (const cb of [...state.listeners]) this.safe(() => cb(mounted));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error('[call] プラグインのコールバックで例外', e);
    }
  }

  // ---- 画面・通知の更新 ----

  private notification() {
    return notificationContent({ muted: this.muted, deafened: this.deafened, count: this.participants.length });
  }

  /** 人数やミュートが変わったら、通知を差し替える */
  private updateNotification(): void {
    if (!this.background) return;
    const content = this.notification();
    const key = JSON.stringify(content);
    if (key === this.notifyKey) return;
    this.notifyKey = key;
    this.background.update(content);
  }

  /** 接続の状態（つながった・しゃべっている・消音）を画面用に写す */
  private syncView(): void {
    const view: Record<string, PeerView> = {};
    for (const e of this.entries.values()) {
      view[e.peer] = { speaking: !!e.relay?.meter?.speaking, localMuted: e.localMuted };
    }
    if (JSON.stringify(view) !== JSON.stringify(this.peerView)) this.peerView = view;
    const me = !!this.localMeter?.speaking;
    if (me !== this.selfSpeaking) this.selfSpeaking = me;
  }

  private refresh(): void {
    this.syncView();
    this.updateNotification();
    const sig = JSON.stringify([this.joined, this.joining, this.participants.map((p) => [p.peer, p.userId, p.muted, p.deafened, p.connected, p.localMuted, p.speaking, p.device])]);
    if (sig === this.changeSig) return;
    this.changeSig = sig;
    for (const cb of [...this.changeListeners]) this.safe(cb);
  }
}
