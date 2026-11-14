import type { CallMember } from '../protocol/CallMember';
import type { CallStatus } from '../protocol/CallStatus';
import type { ClientEvent } from '../protocol/ClientEvent';
import { startCapture, type Capture } from './capture';
import { LATENCY_REPORT_MS, callLatency, clockText, type ClockPoint } from './latency';
import { AudioDiag, describeTrack, type DiagState } from './audioDiag';
import { isAndroid } from '../platform';
import {
  EV_AUDIO,
  Framer,
  micConstraints,
  PeakLimiter,
  clipCurve,
  clampLimitDb,
  dbToLinear,
  RELAY_HOLD_MS,
  RELAY_RATE,
  RELAY_SILENCE,
  Resampler,
  base64ToPcm,
  byteLevel,
  diffPeers,
  floatToInt16,
  int16ToFloat,
  pcmToBase64,
  rms,
  scheduleFrame,
  updateSpeaking,
} from './pure';
import type { CallHost } from './types';

// WebView 所有の通話の音声（WebAudio）。マイク・AudioContext・相手ごとの再生・上限・メーター・診断。
// シグナリング（call.* の送受信・参加・退出）は webEngine.ts。ここは「音の経路」だけを持つ。

export type Meter = { analyser: AnalyserNode; buf: Uint8Array; lastLoud: number; speaking: boolean };

type RelayIn = { gain: GainNode; meter: Meter | null; st: { next: number }; limiter: PeakLimiter | null };

/** 通話にいる自分以外の接続1つ分の状態 */
export type Entry = {
  peer: string;
  userId: string;
  status: CallStatus;
  relay: RelayIn | null;
  localMuted: boolean;
};

function makeEntry(m: CallMember): Entry {
  return { peer: m.peer, userId: m.user_id, status: m.status, relay: null, localMuted: false };
}

export function makeMeter(analyser: AnalyserNode): Meter {
  analyser.fftSize = 512;
  return { analyser, buf: new Uint8Array(analyser.fftSize), lastLoud: 0, speaking: false };
}

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}

/** AudioContext が動いている（running）のに出力の時計が進まないのが、この時間続いたら音の経路を作り直す */
const STALL_MS = 3000;
/** 作り直しの間隔（作り直しても止まったままのとき、何度も作り直さないため） */
const REBUILD_MIN_MS = 10000;
const KEEPALIVE_HZ = 20;
/**
 * keep-alive の既定の大きさ（dBFS）。Chromium は「音が出ている」ページを凍結しない。その判定の無音のしきい値は約 -72 dBFS。
 * Android では -60 dBFS（振幅 1e-3）の 20 Hz の正弦にする。スマホのスピーカーではほぼ鳴らず、人にはまず聞こえない。
 * デスクトップなど他の環境は、これまでどおり -80 dBFS（ほぼ無音）のまま。
 */
const KEEPALIVE_DB_ANDROID = -60;
const KEEPALIVE_DB_OTHER = -80;

/**
 * 通話用の AudioContext。周波数は 48000 を既定にする（Linux の既定の 44100 とマイクのずれを避けるため）。
 * 周波数の指定が通らなければ既定で作る
 */
const CTX_RATE_DEFAULT = 48000;
export function makeCallContext(): AudioContext {
  const rate = CTX_RATE_DEFAULT;
  try {
    return new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  } catch (e) {
    console.warn(`[call] AudioContext(${rate}Hz) を作れません。既定で作ります`, e);
    return new AudioContext();
  }
}

export class WebAudio {
  entries = new Map<string, Entry>();
  localStream: MediaStream | null = null;
  ctx: AudioContext | null = null;
  localMeter: Meter | null = null;
  /** 音声経路の診断（数の集計）。参加ごとに数え直す */
  diag = new AudioDiag();
  private micGain: GainNode | null = null;
  private captureSrc: AudioNode | null = null;
  /** 診断: マイクを開いた時刻と、最初にデータ・大きい音が見えた時刻（開いてからの ms） */
  micOpenAt: number | null = null;
  private micFirstData: number | null = null;
  private micFirstLoud: number | null = null;
  /** 診断: 取り始めの時計と、受けた音のフレーム数、次に時計を出す時刻 */
  clockStart: ClockPoint | null = null;
  private captureFrames = 0;
  clockAt = 0;
  private capture: Capture | null = null;
  private resampler: Resampler | null = null;
  private framer = new Framer();
  private relaySeq = 0;
  private relayLoudAt = 0;
  /** マイクの track に付けたリスナ（解除のため） */
  private micWatch: { track: MediaStreamTrack; type: 'mute' | 'unmute' | 'ended'; fn: () => void }[] = [];
  /** 通話中、画面が戻ったときに AudioContext を動かし直す（別のアプリを開いたあとに止まっていることがある） */
  readonly onVisible = (): void => {
    this.diagNow(document.visibilityState === 'visible' ? '表示' : '背景');
    if (document.visibilityState === 'visible') this.keepContextRunning();
  };
  ctxDetach: (() => void) | null = null;
  /** 受け取った音の合計を上限で抑える最後の段（無ければ出力先に直接） と、その設定の控え */
  private limitBus: WaveShaperNode | null = null;
  private limitKey = '';
  private keepAlive: OscillatorNode | null = null;

  constructor(private readonly h: CallHost, private readonly send: (ev: ClientEvent) => void) {}

  /** 出力の時計（ctx.currentTime）の見張り。進まないまま止まっているかを見る */
  private stallCtxTime = -1;
  private stallSince: number | null = null;
  private lastRebuildAt = Number.NEGATIVE_INFINITY;

  /**
   * AudioContext は running なのに時計が進まない（出力が裏で止められた）ときは、音の経路を作り直す。
   * suspended なら onContextState / keepContextRunning が動かすので、ここでは running のときだけ見る。
   */
  private checkOutputStall(now: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') {
      this.stallSince = null;
      return;
    }
    if (this.stallSince === null || ctx.currentTime !== this.stallCtxTime) {
      this.stallCtxTime = ctx.currentTime;
      this.stallSince = now;
      return;
    }
    if (now - this.stallSince < STALL_MS || now - this.lastRebuildAt < REBUILD_MIN_MS) return;
    const held = Math.round(now - this.stallSince);
    this.lastRebuildAt = now;
    this.stallSince = null;
    this.rebuildAudio(`出力の時計が ${held}ms 進んでいません（state=running）`);
  }


  /**
   * 音の経路（AudioContext・マイクの接続・受け取りの音）を作り直す。通話の参加者は変えない。
   * 作り直したあとは、マイクの送りと受け取りが次のフレームから新しい経路で動く。
   */
  private rebuildAudio(reason: string): void {
    const stream = this.localStream;
    if (!this.h.joined || !stream) return;
    console.warn(`[call] 音の経路を作り直します: ${reason}`);
    this.diag.add('rebuild');
    this.diagNow('音の再構築');
    this.stopCapture();
    this.captureSrc = null;
    this.micGain = null;
    this.limitBus = null;
    this.limitKey = '';
    for (const e of this.entries.values()) e.relay = null;
    this.ctxDetach?.();
    this.ctxDetach = null;
    if (this.ctx) this.ctx.onstatechange = null;
    void this.ctx?.close().catch(() => {});
    const ctx = makeCallContext();
    this.ctx = ctx;
    void ctx.resume().catch(() => {});
    ctx.onstatechange = () => this.onContextState();
    this.startKeepAlive(ctx);
    this.ctxDetach = this.h.deps.audio.attach(ctx);
    const meter = makeMeter(ctx.createAnalyser());
    this.localMeter = meter;
    this.logAudioSetup(stream, ctx);
    void this.setupSend(stream, ctx, meter).catch((e) => console.warn('[call] 作り直しの後のマイクの接続に失敗しました', e));
    this.h.refresh();
  }

  /** サーバーの参加者に合わせて、接続の管理を増減する */
  reconcile(): void {
    const others = this.h.others;
    const { removed } = diffPeers(
      [...this.entries.keys()],
      others.map((m) => m.peer),
      this.h.peerId,
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

  /** 通話中に AudioContext が止まっていたら動かし直す */
  private keepContextRunning(): void {
    if (this.h.joined && this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  /** 診断（console.info。Android では WebView のログとして出る）。状態と、時計が進んでいるかを残す */
  private logAudio(reason: string): void {
    const ctx = this.ctx;
    if (!this.h.joined || !ctx) return;
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
    const db = isAndroid() ? KEEPALIVE_DB_ANDROID : KEEPALIVE_DB_OTHER;
    osc.frequency.value = KEEPALIVE_HZ;
    gain.gain.value = dbToLinear(db);
    console.info(`[call] keep-alive を ${KEEPALIVE_HZ} Hz・既定 ${db} dBFS で動かします`);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    this.keepAlive = osc;
  }

  private onContextState(): void {
    this.logAudio('statechange');
    this.keepContextRunning();
  }

  /** マイクの状態変化（mute / unmute / ended）を 1 回ずつ記録する。ended は途中で止まった（OS やほかのアプリに取られた）ことで、stop() では発火しない */
  private watchMicTracks(stream: MediaStream): void {
    this.detachMicWatch();
    for (const track of stream.getAudioTracks()) {
      for (const type of ['mute', 'unmute', 'ended'] as const) {
        const fn = () => this.onMicEvent(track, type);
        track.addEventListener(type, fn);
        this.micWatch.push({ track, type, fn });
      }
    }
  }

  private onMicEvent(track: MediaStreamTrack, type: 'mute' | 'unmute' | 'ended'): void {
    this.diag.add(`micEvent.${type}`);
    console.info(`[call] マイク: ${type} ${describeTrack(track)}`);
    if (type !== 'ended') return;
    console.warn('[call] マイクが止まりました');
    if (this.h.joined) this.h.deps.toast('マイクが止まりました。通話し直してください', 'error');
  }

  private detachMicWatch(): void {
    for (const w of this.micWatch) w.track.removeEventListener(w.type, w.fn);
    this.micWatch = [];
  }

  /** 診断: 参加中の状態を即時に 1 行（参加・背景・表示・退出・音の再構築）。参加していなければ何もしない */
  diagNow(label: string): void {
    if (!this.h.joined) return;
    console.info(this.diag.immediate(this.h.deps.now(), label, this.diagState()));
  }

  private diagState(): DiagState {
    const ctx: AudioContext | null = this.ctx;
    let outTime: number | null = null;
    try {
      outTime = ctx?.getOutputTimestamp?.()?.contextTime ?? null;
    } catch {
      // 診断のための値。取れなくても参加・退出・再生は止めない
      outTime = null;
    }
    return {
      joined: this.h.joined,
      listed: this.h.listed,
      others: this.h.others.length,
      muted: this.h.muted,
      deafened: this.h.deafened,
      ctxState: ctx?.state ?? '-',
      ctxTime: ctx ? ctx.currentTime : null,
      outTime,
      capture: this.capture !== null,
      track: describeTrack(this.localStream?.getAudioTracks()[0]),
      entries: this.entries.size,
    };
  }

  /** マイクを開く。選んだ機器が使えなければ既定の機器で開き直す */
  private async openMic(): Promise<MediaStream> {

    const base = micConstraints();
    console.info(`[call] マイクを開きます: 要求=${JSON.stringify(base)}`);
    const id = this.h.settings.inputId;
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

  /** 診断: 音の経路の設定（遅れの原因の切り分け用）。ブラウザーが出さない値は ? */
  private logAudioSetup(stream: MediaStream, ctx: AudioContext): void {
    const track = stream.getAudioTracks?.()?.[0];
    const set = (track?.getSettings?.() ?? {}) as Record<string, unknown>;
    const out = (ctx as { outputLatency?: number }).outputLatency;
    // 機器の識別子（deviceId 等）は出さない。処理や遅れに関係する値だけ
    const mic = {
      sampleRate: set.sampleRate,
      channelCount: set.channelCount,
      latency: set.latency,
      echoCancellation: set.echoCancellation,
      noiseSuppression: set.noiseSuppression,
      autoGainControl: set.autoGainControl,
    };
    console.info(
      `[call] 音の設定: ctxRate=${ctx.sampleRate} baseLatency=${ctx.baseLatency ?? '?'} outputLatency=${out ?? '?'} state=${ctx.state} mic=${JSON.stringify(mic)}`,
    );
  }

  applyMicVolume(): void {
    if (this.micGain) this.micGain.gain.value = this.h.settings.micVolume;
  }

  applyOutVolume(): void {
    for (const e of this.entries.values()) this.applyEntryAudio(e);
  }

  /** 相手1人分の音（GainNode）に、音量・消音を反映する */
  private applyEntryAudio(e: Entry): void {
    const silent = e.localMuted || this.h.deafened;
    if (e.relay) e.relay.gain.gain.value = silent ? 0 : this.h.settings.outVolume;
  }

  applyMute(): void {
    // 送る音は onCapture でも止める。マイクそのものも止める
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.h.muted));
  }

  /**
   * スピーカーミュートを入れる／外す。入れるときはミュートも入れ、外すときは、スピーカーミュートが入れたミュートだけ外す。
   * 送信・通知の更新は呼び出し側（toggleMute / toggleDeafen）が行う
   */
  setDeafened(on: boolean): void {
    if (on && !this.h.deafened) {
      this.h.muteByDeafen = !this.h.muted;
      this.h.muted = true;
    } else if (!on && this.h.deafened) {
      if (this.h.muteByDeafen) this.h.muted = false;
      this.h.muteByDeafen = false;
    }
    this.h.deafened = on;
    for (const e of this.entries.values()) this.applyEntryAudio(e);
  }

  /** 診断: 取り始めからの時計のずれ（5 秒ごと）。ctx が壁より遅れる・受けた音が ctx より少ない、を見る */
  private reportClock(now: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.clockStart || !this.capture || now < this.clockAt) return;
    this.clockAt = now + LATENCY_REPORT_MS;
    const ts = (ctx as { getOutputTimestamp?: () => { contextTime?: number } }).getOutputTimestamp?.();
    const text = clockText(this.clockStart, { ctx: ctx.currentTime, wall: now, frames: this.captureFrames }, ctx.sampleRate);
    const out = ts?.contextTime !== undefined ? ` 出力の時刻=${ts.contextTime.toFixed(2)}s` : '';
    console.info(`[call] 時計: ${text}${out}`);
  }

  /** 診断: マイクを開いてから、最初にデータが来た時刻と、最初に大きい音が見えた時刻を 1 回ずつ出す */
  private noteMic(m: Meter, now: number): void {
    if (this.micOpenAt === null) return;
    const since = Math.round(now - this.micOpenAt);
    if (this.micFirstData === null && m.buf.some((v) => v !== 128)) {
      this.micFirstData = since;
      console.info(`[call] マイク: 最初のデータまで ${since}ms（開いてから）`);
    }
    if (this.micFirstLoud === null && m.speaking) {
      this.micFirstLoud = since;
      console.info(`[call] マイク: 最初の大きい音まで ${since}ms（開いてから）`);
    }
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
    this.capture = startCapture(ctx, src, (chunk, at) => this.onCapture(chunk, at));
    // 診断: 取り始めた時点の時計（ctx と壁と受けた音の数）。以後の差を見る
    this.clockStart = { ctx: ctx.currentTime, wall: this.h.deps.now(), frames: 0 };
    this.captureFrames = 0;
  }

  stopCapture(): void {
    try {
      this.capture?.stop();
    } catch {
      /* すでに外れている */
    }
    this.capture = null;
    this.resampler = null;
  }

  /** マイクの音（AudioContext の周波数）を 16kHz に直して送る */
  private onCapture(chunk: Float32Array, at?: number): void {
    this.captureFrames += chunk.length;
    this.diag.add('capCb');
    this.diag.add('capSamples', chunk.length);
    // 診断: マイクの塊が取れた時刻（ctx の時計）から、ここ（メインスレッド）に来るまでの遅れ
    if (at !== undefined && this.ctx) {
      const lag = this.ctx.currentTime - at - chunk.length / this.ctx.sampleRate;
      callLatency.add('取り出し後の待ち', Math.max(0, lag) * 1000);
    }
    // サーバーの一覧に自分が載るまで送らない（call.emit は制御のチェーンの外。先に着くと not_in_call になる）
    if (!this.h.listed || !this.resampler || this.entries.size === 0) {
      this.diag.add(!this.h.listed ? 'capSkip.notListed' : !this.resampler ? 'capSkip.noResampler' : 'capSkip.noPeers');
      return;
    }
    const out = this.resampler.push(chunk);
    for (const frame of this.framer.push(out)) this.sendFrame(frame);
  }

  /** 1 フレーム（16kHz・800 サンプル）を送る。ミュート・音量・無音の抑え方は、経路によらずここで揃える */
  private sendFrame(frame: Float32Array): void {
    if (this.h.muted) {
      this.diag.add('sendMuted');
      return;
    }
    const volume = this.micGain ? 1 : this.h.settings.micVolume;
    if (volume !== 1) for (let i = 0; i < frame.length; i++) frame[i] *= volume;
    const now = this.h.deps.now();
    if (rms(frame) > RELAY_SILENCE) this.relayLoudAt = now;
    else if (now - this.relayLoudAt > RELAY_HOLD_MS) {
      this.diag.add('sendSilent');
      return;
    }
    // 送ろうとした数（ネットワークへ届いたかは、ここでは分からない）
    this.diag.add('sendTry');
    this.send({ type: 'call.emit', name: EV_AUDIO, payload: { seq: this.relaySeq++, pcm: pcmToBase64(floatToInt16(frame)) } });
  }

  /** 上限の設定（オフなら null） */
  private limitDb(): number | null {
    return this.h.settings.limiter ? clampLimitDb(this.h.settings.limitDb) : null;
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

  onRelayAudio(peer: string, payload: unknown): void {
    const p = payload as { pcm?: unknown } | null;
    const ctx = this.ctx;
    const e = this.entries.get(peer);
    if (!ctx) return this.dropRecv('noCtx');
    if (!p) return this.dropRecv('badPayload');
    if (!e) return this.dropRecv('noPeer');
    if (e.status.muted || e.localMuted || this.h.deafened) return this.dropRecv('muted');
    const pcm = base64ToPcm(p.pcm);
    if (!pcm) return this.dropRecv('badPcm');
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
      // 大きすぎる音を上限で抑える（音量の設定より前。デバイスの音量ではなく、受け取った音の大きさで決める）
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
      if (at === null) {
        this.diag.add('playDrop.late');
        return;
      }
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(e.relay.gain);
      node.start(at);
      this.diag.add('play');
    } catch (err) {
      this.dropRecv('error');
      console.warn('[call] リレーの音を鳴らせません', err);
    }
  }

  private dropRecv(reason: string): void {
    this.diag.add(`recvDrop.${reason}`);
  }

  // ---- 開始・終了 ----

  /** 開いたマイクを覚え、AudioContext・マイクの接続・出力の見張りを作る（参加の途中。失敗したら例外） */
  async start(stream: MediaStream): Promise<void> {
    this.localStream = stream;
    this.ctx = makeCallContext();
    void this.ctx.resume().catch(() => {});
    // 別のアプリを開いたとき、WebView が裏に回って AudioContext が止められることがある。止まったら動かし直す
    this.ctx.onstatechange = () => this.onContextState();
    this.startKeepAlive(this.ctx);
    document.addEventListener('visibilitychange', this.onVisible);
    this.watchMicTracks(stream);
    this.ctxDetach = this.h.deps.audio.attach(this.ctx);
    this.localMeter = makeMeter(this.ctx.createAnalyser());
    await this.setupSend(stream, this.ctx, this.localMeter);
    this.logAudioSetup(stream, this.ctx);
    callLatency.reset(this.h.deps.now());
  }

  /** 音の経路をすべて閉じる（マイクも止める） */
  stop(): void {
    this.micOpenAt = null;
    this.clockStart = null;
    this.clockAt = 0;
    this.entries.clear();
    this.detachMicWatch();
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
  }

  /** マイクを開く（開いた時刻を診断に覚える） */
  async open(): Promise<MediaStream> {
    const stream = await this.openMic();
    this.micOpenAt = this.h.deps.now();
    this.micFirstData = null;
    this.micFirstLoud = null;
    return stream;
  }

  /** 通話の音の経路の、画面用の表示（話している人）を写す */
  syncView(peerView: Record<string, import('./types').PeerView>): Record<string, import('./types').PeerView> {
    const view: Record<string, import('./types').PeerView> = {};
    for (const e of this.entries.values()) {
      view[e.peer] = { speaking: !!e.relay?.meter?.speaking, localMuted: e.localMuted };
    }
    return JSON.stringify(view) !== JSON.stringify(peerView) ? view : peerView;
  }

  /** 相手1人を、自分の側だけで消音する／戻す。変えたら true */
  toggleLocalMute(peer: string): boolean {
    const e = this.entries.get(peer);
    if (!e) return false;
    e.localMuted = !e.localMuted;
    this.applyEntryAudio(e);
    return true;
  }

  /** LEVEL_MS ごと（声の取り出し・診断・メーター）。表示が変わったら true */
  tick(now: number): boolean {
    let changed = false;
    if (this.entries.size > 0) this.ensureCapture();
    if (this.diag.due(now)) console.info(this.diag.summary(now, this.diagState()));
    const report = callLatency.report(now);
    if (report) console.info(`[call] latency ${report}`);
    this.reportClock(now);
    if (this.localMeter && this.updateMeter(this.localMeter, now, this.h.muted)) changed = true;
    if (this.localMeter && !this.h.muted) this.noteMic(this.localMeter, now);
    for (const e of this.entries.values()) {
      const m = e.relay?.meter;
      if (m && this.updateMeter(m, now, e.status.muted || e.localMuted)) changed = true;
    }
    return changed;
  }

  /** 出力の時計を見張る（Web の tick から） */
  watchOutput(now: number): void {
    this.checkOutputStall(now);
  }
}
