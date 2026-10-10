import type { CallMember } from '../protocol/CallMember';
import type { CallStatus } from '../protocol/CallStatus';
import type { ClientEvent } from '../protocol/ClientEvent';
import type { ServerEvent } from '../protocol/ServerEvent';
import type { IconRef } from '../icons.svelte';
import { startCapture, type Capture } from './capture';
import {
  CONNECT_TIMEOUT_MS,
  EV_AUDIO,
  EV_SIGNAL,
  Framer,
  LEVEL_MS,
  OUTPUTS_REFRESH_TICKS,
  RELAY_HOLD_MS,
  RELAY_RATE,
  RELAY_SILENCE,
  Resampler,
  base64ToPcm,
  byteLevel,
  classifyOffer,
  diffPeers,
  floatToInt16,
  int16ToFloat,
  isPolite,
  notificationContent,
  pcmToBase64,
  pickOutput,
  randomId,
  rms,
  rtcConfig,
  scheduleFrame,
  shouldOffer,
  updateSpeaking,
  usesRelay,
} from './pure';
import type { CallSettings } from './settings.svelte';

// 通話（みんな共通の1部屋）。参加者の一覧・kick・シグナリングの中継はサーバー（call.* イベント）が受け持ち、
// 音声・映像は WebRTC で直接つなぐ（メッシュ）。WebRTC を使えない環境（Linux の WebKitGTK など）は、その相手とのあいだだけ
// 音声をサーバー経由（call.emit の audio）で流す。ここは画面に触れず、画面は participants などを読む

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
  hasRtc(): boolean;
  now(): number;
};

/** 画面・プラグインに見せる参加者1人分 */
export type CallParticipant = {
  peer: string;
  userId: string;
  self: boolean;
  muted: boolean;
  deafened: boolean;
  /** 映像を送受信できる（WebRTC を使える） */
  canVideo: boolean;
  connected: boolean;
  speaking: boolean;
  /** 自分の側だけで消音している */
  localMuted: boolean;
  device: string | null;
};

/** 相手から届いたメディアのトラック */
export type CallRemoteTrack = { peer: string; userId: string; track: MediaStreamTrack; stream: MediaStream };

/** 通話のバーに足すボタン */
export type BarButtonDef = { icon: IconRef; label: string; onClick: () => void; active?: boolean; disabled?: boolean };
export type BarButton = BarButtonDef & { id: number };

type PeerView = { connected: boolean; speaking: boolean; localMuted: boolean };

type Meter = { analyser: AnalyserNode; buf: Uint8Array; lastLoud: number; speaking: boolean };

type RelayIn = { gain: GainNode; meter: Meter | null; st: { next: number } };

/** 通話にいる自分以外の接続1つ分の、接続の状態 */
type Entry = {
  peer: string;
  userId: string;
  status: CallStatus;
  pc: RTCPeerConnection | null;
  /** いまの接続の世代 ID。最初の offer を出す側が決め、両方の signal に付く */
  sid: string | null;
  pcStartedAt: number;
  pendingIce: RTCIceCandidateInit[];
  makingOffer: boolean;
  /** 送っているトラックの RTCRtpSender（トラックを外すときに使う） */
  senders: Map<MediaStreamTrack, RTCRtpSender>;
  stream: MediaStream | null;
  /** 声として扱っている音声トラック（最初に届いた音声） */
  voiceTrack: MediaStreamTrack | null;
  relay: RelayIn | null;
  audio: HTMLAudioElement | null;
  audioDetach: (() => void) | null;
  meter: Meter | null;
  localMuted: boolean;
  connected: boolean;
  /** この時刻までは接続し直さない（失敗が続いても連打しない） */
  nextCallAt: number;
};

function makeEntry(m: CallMember): Entry {
  return {
    peer: m.peer,
    userId: m.user_id,
    status: m.status,
    pc: null,
    sid: null,
    pcStartedAt: 0,
    pendingIce: [],
    makingOffer: false,
    senders: new Map(),
    stream: null,
    voiceTrack: null,
    relay: null,
    audio: null,
    audioDetach: null,
    meter: null,
    localMuted: false,
    connected: false,
    nextCallAt: 0,
  };
}

function makeMeter(analyser: AnalyserNode): Meter {
  analyser.fftSize = 512;
  return { analyser, buf: new Uint8Array(analyser.fftSize), lastLoud: 0, speaking: false };
}

function errName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}

export class CallStore {
  // ---- 画面が読む状態（リアクティブ） ----
  /** サーバーが知っている通話の参加者（自分を含む） */
  members = $state.raw<CallMember[]>([]);
  joined = $state(false);
  joining = $state(false);
  muted = $state(false);
  /** 相手の声を全部消している（スピーカーミュート） */
  deafened = $state(false);
  /** 選べる出力先 */
  outputs = $state.raw<Disnans.AudioOutput[]>([]);
  barButtons = $state.raw<BarButton[]>([]);
  private peerView = $state.raw<Record<string, PeerView>>({});
  private selfSpeaking = $state(false);

  // ---- 内部 ----
  private peerId = '';
  private entries = new Map<string, Entry>();
  private localStream: MediaStream | null = null;
  /** 相手に送る音（マイクの音量を通したもの。通せなければマイクそのもの） */
  private sendStream: MediaStream | null = null;
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
  private ctxDetach: (() => void) | null = null;
  private localMeter: Meter | null = null;
  private worker: { terminate(): void } | null = null;
  private background: Disnans.BackgroundHandle | null = null;
  private notifyKey = '';
  private buttonSeq = 0;
  /** プラグインが通話に足した映像などのトラック */
  private extraTracks: { track: MediaStreamTrack; stream: MediaStream }[] = [];
  private remote = new Map<MediaStreamTrack, CallRemoteTrack>();
  private changeListeners = new Set<() => void>();
  private trackListeners = new Set<(t: CallRemoteTrack) => void>();
  private trackEndListeners = new Set<(t: CallRemoteTrack) => void>();
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

  /** 通話のバーを出すか（参加中、またはだれかがいる） */
  get visible(): boolean {
    return this.joined || this.joining || this.others.length > 0;
  }

  /** この環境で映像を送受信できるか（WebRTC を使えない環境の中継は音声だけ） */
  get canVideo(): boolean {
    return this.deps.hasRtc();
  }

  /** 参加者。参加中なら自分が先頭 */
  get participants(): CallParticipant[] {
    const out: CallParticipant[] = [];
    if (this.joined || this.joining) {
      out.push({
        peer: this.peerId,
        userId: this.deps.meId(),
        self: true,
        muted: this.muted,
        deafened: this.deafened,
        canVideo: this.canVideo,
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
        canVideo: m.status.rtc,
        connected: v?.connected ?? false,
        speaking: (v?.speaking ?? false) && !m.status.muted && !v?.localMuted,
        localMuted: v?.localMuted ?? false,
        device: m.status.device,
      });
    }
    return out;
  }

  get remoteTracks(): CallRemoteTrack[] {
    return [...this.remote.values()];
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
          this.leave(false);
          this.deps.toast(`${this.deps.nameOf(ev.by)}さんに通話から外されました`, 'info');
        }
        break;
    }
  }

  /** つなぎ直したら、サーバーは自分を通話から外している。入り直し、WebRTC の接続もやり直す */
  private onReconnect(): void {
    if (!this.joined) return;
    for (const e of this.entries.values()) this.closePc(e);
    this.deps.send({ type: 'call.join', peer: this.peerId, status: this.status() });
  }

  private onState(members: CallMember[]): void {
    this.members = members;
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
      if (e) this.closePeer(e);
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
      if (this.usesRelay(e)) e.connected = true;
      this.maybeCall(e);
    }
  }

  private onCallEvent(peer: string, name: string, payload: unknown): void {
    if (!this.joined) return;
    if (name === EV_AUDIO) this.onRelayAudio(peer, payload);
    else if (name === EV_SIGNAL) void this.onSignal(peer, payload);
  }

  // ---- 状態の送信 ----

  private status(): CallStatus {
    return { muted: this.muted, deafened: this.deafened, rtc: this.deps.hasRtc(), device: this.deps.deviceKind() };
  }

  private sendStatus(): void {
    if (this.joined) this.deps.send({ type: 'call.update', status: this.status() });
  }

  // ---- 参加・退出 ----

  async join(): Promise<void> {
    if (this.joined || this.joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.deps.toast('この環境ではマイクを使えません（アプリ版で使ってください）', 'error');
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
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.deps.toast('マイクの使用が許可されていません。端末の設定で許可してください', 'error');
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
            else if (id === 'hangup') this.leave();
          },
        });
        this.notifyKey = JSON.stringify(this.notification());
      } catch (e) {
        console.error('[call] 常駐を始められませんでした', e);
        this.deps.toast('画面を消すと通話が切れることがあります', 'info');
      }

      this.localStream = stream;
      this.ctx = new AudioContext();
      void this.ctx.resume().catch(() => {});
      this.ctxDetach = this.deps.audio.attach(this.ctx);
      this.localMeter = makeMeter(this.ctx.createAnalyser());
      await this.setupSend(stream, this.ctx, this.localMeter);

      this.peerId = randomId();
      this.muted = this.settings.joinMuted;
      this.deafened = false;
      this.applyMute();
      this.joined = true;
      this.deps.send({ type: 'call.join', peer: this.peerId, status: this.status() });
      void this.restoreOutput();
      this.startWorker();
      this.reconcile();
    } finally {
      this.joining = false;
      this.refresh();
    }
  }

  /** 抜ける。sendLeave が false なのは、サーバーに外されたとき */
  leave(sendLeave = true): void {
    if (!this.joined && !this.localStream) return;
    if (this.joined && sendLeave) this.deps.send({ type: 'call.leave' });
    this.joined = false;
    this.deafened = false;
    this.outputs = [];
    this.stopWorker();
    for (const e of this.entries.values()) this.closePeer(e);
    this.entries.clear();
    this.extraTracks = [];
    this.peerView = {};
    this.selfSpeaking = false;
    this.peerId = '';
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.sendStream = null;
    this.micGain = null;
    this.captureSrc = null;
    this.stopCapture();
    this.localMeter = null;
    this.ctxDetach?.();
    this.ctxDetach = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.background?.();
    this.background = null;
    this.refresh();
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

  /** マイク → 音量（GainNode）→ 送る音、と通す。通せないとき（AudioContext が動かない環境）は、マイクをそのまま送る */
  private async setupSend(stream: MediaStream, ctx: AudioContext, meter: Meter): Promise<void> {
    this.sendStream = stream;
    this.micGain = null;
    this.captureSrc = null;
    try {
      await ctx.resume();
      if (ctx.state !== 'running' || !ctx.createGain || !ctx.createMediaStreamDestination) throw new Error('AudioContext が動いていません');
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(stream).connect(gain);
      gain.connect(dest);
      gain.connect(meter.analyser);
      this.micGain = gain;
      this.captureSrc = gain;
      this.sendStream = dest.stream;
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

  /** 相手1人分の音（WebRTC の <audio> とリレーの GainNode）に、音量・消音を反映する */
  private applyEntryAudio(e: Entry): void {
    const silent = e.localMuted || this.deafened;
    if (e.audio) {
      e.audio.muted = silent;
      e.audio.volume = this.settings.outVolume;
    }
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
    // 送る音（マイクの音量を通したもの）と、マイクそのものの両方を止める
    this.sendStream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
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

  /** LEVEL_MS ごと。つながらない接続のやり直し・足りない接続を張る・出力先の取り直し・音量を見る */
  tick(): void {
    if (!this.joined) return;
    const now = this.deps.now();
    let changed = false;
    for (const e of this.entries.values()) {
      if (e.pc && !e.connected && now - e.pcStartedAt > CONNECT_TIMEOUT_MS) this.closePc(e);
    }
    if (++this.outputsTick >= OUTPUTS_REFRESH_TICKS) {
      this.outputsTick = 0;
      void this.refreshOutputs();
    }
    // 足りない接続を張る。リレーで話す相手は、つながっていることにする
    for (const e of this.entries.values()) {
      this.maybeCall(e);
      if (this.usesRelay(e) && !e.connected) {
        e.connected = true;
        changed = true;
      }
    }
    if (this.needRelay()) this.ensureCapture();
    if (this.localMeter && this.updateMeter(this.localMeter, now, this.muted)) changed = true;
    for (const e of this.entries.values()) {
      const m = e.meter ?? e.relay?.meter;
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

  // ---- リレー（WebRTC を使えない相手との音声。サーバーの call.emit を通す） ----

  /** この相手とは WebRTC ではなくリレーで話す（どちらかが WebRTC を使えない） */
  private usesRelay(e: Entry): boolean {
    return usesRelay(this.deps.hasRtc(), e.status.rtc);
  }

  /** 自分の声をリレーで送る必要があるか（1人でもリレーの相手がいる） */
  private needRelay(): boolean {
    for (const e of this.entries.values()) if (this.usesRelay(e)) return true;
    return false;
  }

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
    if (!this.joined || !this.resampler || !this.needRelay()) return;
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

  private onRelayAudio(peer: string, payload: unknown): void {
    const p = payload as { pcm?: unknown } | null;
    const ctx = this.ctx;
    const e = this.entries.get(peer);
    // 双方が WebRTC を使えるなら、そちらで聞こえている
    if (!ctx || !p || !e || !this.usesRelay(e) || e.status.muted || e.localMuted || this.deafened) return;
    const pcm = base64ToPcm(p.pcm);
    if (!pcm) return;
    try {
      if (!e.relay) {
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        gain.connect(ctx.destination);
        gain.connect(analyser);
        e.relay = { gain, meter: makeMeter(analyser), st: { next: 0 } };
        this.applyEntryAudio(e);
      }
      const buf = ctx.createBuffer(1, pcm.length, RELAY_RATE);
      buf.getChannelData(0).set(int16ToFloat(pcm));
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

  // ---- WebRTC ----

  private makePc(e: Entry, sid: string): RTCPeerConnection {
    this.closePc(e);
    const pc = new RTCPeerConnection(rtcConfig(this.settings.stun));
    e.pc = pc;
    e.sid = sid;
    e.pcStartedAt = this.deps.now();
    e.pendingIce = [];
    e.makingOffer = false;
    e.connected = false;
    const peer = e.peer;
    const send = this.sendStream ?? this.localStream;
    for (const t of send?.getTracks() ?? []) pc.addTrack(t, send as MediaStream);
    for (const x of this.extraTracks) e.senders.set(x.track, pc.addTrack(x.track, x.stream));
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signal(peer, { kind: 'ice', sid, candidate: ev.candidate.toJSON() });
    };
    pc.onnegotiationneeded = () => void this.negotiate(e, pc);
    pc.ontrack = (ev) => {
      if (e.pc !== pc) return;
      this.onRemoteTrack(e, ev.track, ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.onconnectionstatechange = () => {
      if (e.pc !== pc) return;
      e.connected = pc.connectionState === 'connected';
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePc(e);
      this.refresh();
    };
    return pc;
  }

  /** 自分の peer ID が小さい相手にだけ、最初の offer を出す（接続を作ると negotiationneeded で offer が出る） */
  private maybeCall(e: Entry): void {
    if (!this.joined || !this.localStream || e.pc || !shouldOffer(this.peerId, e.peer) || this.usesRelay(e)) return;
    if (this.deps.now() < e.nextCallAt) return;
    this.makePc(e, randomId());
  }

  /** offer を作って送る（最初の接続も、トラックを足し引きしたときの再ネゴシエーションも） */
  private async negotiate(e: Entry, pc: RTCPeerConnection): Promise<void> {
    try {
      e.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable' || e.pc !== pc) return;
      await pc.setLocalDescription(offer);
      this.signal(e.peer, { kind: 'offer', sid: e.sid, sdp: pc.localDescription?.sdp ?? offer.sdp });
    } catch (err) {
      console.error('[call] offer を作れませんでした', err);
      if (e.pc === pc && !e.connected && pc.signalingState === 'stable') this.closePc(e);
    } finally {
      e.makingOffer = false;
    }
  }

  private signal(to: string, body: Record<string, unknown>): void {
    this.deps.send({ type: 'call.emit', name: EV_SIGNAL, payload: { to, ...body } });
  }

  private async onSignal(peer: string, payload: unknown): Promise<void> {
    const p = payload as { to?: unknown; kind?: unknown; sid?: unknown; sdp?: unknown; candidate?: unknown } | null;
    if (!this.deps.hasRtc() || !p || p.to !== this.peerId || typeof p.sid !== 'string') return;
    // 一覧にいない人（まだ届いていない・もう抜けた）は相手にしない
    const e = this.entries.get(peer);
    if (!e) return;
    const sid = p.sid;
    try {
      if (p.kind === 'offer' && typeof p.sdp === 'string') {
        const action = classifyOffer({
          sid,
          currentSid: e.pc ? e.sid : null,
          fromInitiator: shouldOffer(peer, this.peerId),
          collision: e.makingOffer || (e.pc?.signalingState ?? 'stable') !== 'stable',
          polite: isPolite(this.peerId, peer),
        });
        if (action === 'ignore') return;
        // 新しい世代の offer は、古い接続を置き換える（相手がやり直した）。同じ世代なら再ネゴシエーション
        const pc = action === 'replace' ? this.makePc(e, sid) : e.pc;
        if (!pc) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        await this.flushIce(e, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(peer, { kind: 'answer', sid, sdp: pc.localDescription?.sdp ?? answer.sdp });
      } else if (p.kind === 'answer' && typeof p.sdp === 'string' && e.pc && e.sid === sid) {
        const pc = e.pc;
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
        await this.flushIce(e, pc);
      } else if (p.kind === 'ice' && p.candidate && typeof p.candidate === 'object' && e.sid === sid) {
        const cand = p.candidate as RTCIceCandidateInit;
        if (e.pc && e.pc.remoteDescription) await e.pc.addIceCandidate(cand);
        else if (e.pc) e.pendingIce.push(cand);
      }
    } catch (err) {
      console.error('[call] シグナリングで例外', err);
    }
    this.refresh();
  }

  private async flushIce(e: Entry, pc: RTCPeerConnection): Promise<void> {
    const list = e.pendingIce;
    e.pendingIce = [];
    for (const c of list) {
      try {
        await pc.addIceCandidate(c);
      } catch (err) {
        console.warn('[call] ICE を追加できません', err);
      }
    }
  }

  /** 相手のトラックが届いた。最初の音声は声として鳴らし、ほかの音声・映像はプラグインに渡す */
  private onRemoteTrack(e: Entry, track: MediaStreamTrack, stream: MediaStream): void {
    if (track.kind === 'audio' && !e.voiceTrack) {
      e.voiceTrack = track;
      this.attachRemote(e, stream);
      return;
    }
    const info: CallRemoteTrack = { peer: e.peer, userId: e.userId, track, stream };
    if (this.remote.has(track)) return;
    this.remote.set(track, info);
    const end = () => this.dropRemote(track);
    track.addEventListener?.('ended', end);
    stream.addEventListener?.('removetrack', (ev) => {
      if ((ev as MediaStreamTrackEvent).track === track) end();
    });
    for (const cb of [...this.trackListeners]) this.safe(() => cb(info));
  }

  private dropRemote(track: MediaStreamTrack): void {
    const info = this.remote.get(track);
    if (!info) return;
    this.remote.delete(track);
    for (const cb of [...this.trackEndListeners]) this.safe(() => cb(info));
  }

  private attachRemote(e: Entry, stream: MediaStream): void {
    e.stream = stream;
    if (!e.audio) {
      const audio = new Audio();
      audio.autoplay = true;
      e.audio = audio;
    }
    e.audio.srcObject = stream;
    this.applyEntryAudio(e);
    e.audioDetach ??= this.deps.audio.attach(e.audio);
    void e.audio.play().catch((err) => console.warn('[call] 再生できません', err));
    if (this.ctx) {
      try {
        e.meter = makeMeter(this.ctx.createAnalyser());
        this.ctx.createMediaStreamSource(stream).connect(e.meter.analyser);
      } catch (err) {
        console.warn('[call] 音量を見られません', err);
      }
    }
  }

  private closePc(e: Entry): void {
    const pc = e.pc;
    if (pc) e.nextCallAt = this.deps.now() + 3000;
    e.pc = null;
    e.sid = null;
    e.connected = false;
    e.makingOffer = false;
    e.pendingIce = [];
    e.senders.clear();
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* すでに閉じている */
      }
    }
    e.audioDetach?.();
    e.audioDetach = null;
    if (e.audio) {
      e.audio.srcObject = null;
      e.audio = null;
    }
    e.stream = null;
    e.voiceTrack = null;
    e.meter = null;
    for (const info of [...this.remote.values()]) if (info.peer === e.peer) this.dropRemote(info.track);
  }

  private closePeer(e: Entry): void {
    this.closePc(e);
    e.relay = null;
  }

  // ---- 拡張 API（プラグインから: disnans.call） ----

  /** 映像などのトラックを通話に足す。WebRTC の相手には再ネゴシエーションで届く。返り値の関数で外す */
  addTrack(track: MediaStreamTrack, stream?: MediaStream): Disnans.Cleanup {
    if (!this.joined) throw new Error('通話に参加していません');
    if (!this.canVideo) throw new Error('この環境ではトラックを送れません（WebRTC を使えません）');
    if (this.extraTracks.some((x) => x.track === track)) return () => this.removeTrack(track);
    const s = stream ?? new MediaStream([track]);
    this.extraTracks.push({ track, stream: s });
    for (const e of this.entries.values()) {
      if (e.pc && !this.usesRelay(e)) e.senders.set(track, e.pc.addTrack(track, s));
    }
    return () => this.removeTrack(track);
  }

  removeTrack(track: MediaStreamTrack): void {
    const i = this.extraTracks.findIndex((x) => x.track === track);
    if (i < 0) return;
    this.extraTracks.splice(i, 1);
    for (const e of this.entries.values()) {
      const sender = e.senders.get(track);
      e.senders.delete(track);
      if (sender && e.pc && e.pc.signalingState !== 'closed') {
        try {
          e.pc.removeTrack(sender);
        } catch (err) {
          console.warn('[call] トラックを外せません', err);
        }
      }
    }
  }

  onChange(cb: () => void): Disnans.Cleanup {
    this.changeListeners.add(cb);
    return () => void this.changeListeners.delete(cb);
  }

  onTrack(cb: (t: CallRemoteTrack) => void): Disnans.Cleanup {
    this.trackListeners.add(cb);
    return () => void this.trackListeners.delete(cb);
  }

  onTrackEnd(cb: (t: CallRemoteTrack) => void): Disnans.Cleanup {
    this.trackEndListeners.add(cb);
    return () => void this.trackEndListeners.delete(cb);
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
      view[e.peer] = { connected: e.connected, speaking: !!(e.meter ?? e.relay?.meter)?.speaking, localMuted: e.localMuted };
    }
    if (JSON.stringify(view) !== JSON.stringify(this.peerView)) this.peerView = view;
    const me = !!this.localMeter?.speaking;
    if (me !== this.selfSpeaking) this.selfSpeaking = me;
  }

  private refresh(): void {
    this.syncView();
    this.updateNotification();
    const sig = JSON.stringify([this.joined, this.joining, this.participants.map((p) => [p.peer, p.userId, p.muted, p.deafened, p.connected, p.localMuted, p.speaking, p.canVideo, p.device])]);
    if (sig === this.changeSig) return;
    this.changeSig = sig;
    for (const cb of [...this.changeListeners]) this.safe(cb);
  }
}
