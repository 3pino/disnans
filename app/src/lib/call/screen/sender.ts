/**
 * 画面（web の取り込み・ネイティブのフレーム）を、通話へ分割して送る（送り手）。
 * 状態（screen.state）・問い合わせ（screen.query）は送らない（エンジンが送る）。
 * 通話の対象の判定・停止の権限は持たない。ストリームのトラックも止めない（エンジンが持つ）。
 * examples/screenshare/main.js の送り手の部分を移したもの（式と定数は同じ）。
 */
import type { ScreenCallPort, ScreenFrame, ScreenSettingsPort } from './types';
import { encodeFrame, fitSize } from './codec';
import { splitFrame } from './protocol';
import { BACKLOG_LIMIT, QUALITY_PRESETS, SERVER_BUDGET_KBPS, frameWeight, nextInterval, tuneQuality } from './pacing';
import { frameDiff, framePeakDiff, isBlankFrame, shouldSend } from './diff';

/** 見る人がいないときに様子を見る間隔（ミリ秒） */
const IDLE_MS = 1000;
/** 動画がまだ始まっていない（videoWidth が 0）ときのやり直しの間隔（ミリ秒） */
const VIDEO_WAIT_MS = 100;
/** 送信待ちが減るのを待つ間隔（ミリ秒） */
const BACKLOG_RETRY_MS = 30;
/** 取り込みが続けて失敗したとみなす時間（ミリ秒） */
const VIDEO_STALL_MS = 5000;
/** 変化の判定に使う縮小画像の大きさ */
const DIFF_W = 64;
const DIFF_H = 36;
/** 色数を減らすとき、画像の形式を選び直す間隔（フレーム数） */
const PROBE_EVERY = 30;

/** call.emit のイベント名（送り手が使う唯一のイベント） */
export const EVENT_FRAME = 'screen.frame';

/** 取り込みの 1 枚（<video> か ImageCapture の結果） */
type Grabbed = { source: CanvasImageSource; w: number; h: number; close?: () => void };
type ImageCaptureLike = { grabFrame(): Promise<ImageBitmap> };
type TuneState = { quality: number; scale: number };

// Native と JS の取得を切り替えても、同じ peer の番号を 0 へ戻さない。
let lastFrameId = Date.now();
function nextFrameId(): number { return (lastFrameId = Math.max(lastFrameId + 1, Date.now())); }

export type ScreenSenderDeps = {
  call: ScreenCallPort;
  settings: ScreenSettingsPort;
  /** 送れない・取れないと知らせる（固定の理由の文字列のみ。例外の文言やトラック名は渡さない） */
  onStall: (reason: string) => void;
  onTune?: (value: Readonly<TuneState>) => void;
  now?: () => number;
};

export class ScreenSender {
  readonly #call: ScreenCallPort;
  readonly #settings: ScreenSettingsPort;
  readonly #onStall: (reason: string) => void;
  readonly #onTune?: (value: Readonly<TuneState>) => void;
  readonly #now: () => number;

  #video: HTMLVideoElement | null = null;
  #stream: MediaStream | null = null;
  #imageCapture: ImageCaptureLike | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #diffCanvas: HTMLCanvasElement | null = null;
  #active = false;
  /** 送り手の世代（stop のたびに進む）。古い非同期の続きは何もしない */
  #epoch = 0;
  #mode: 'none' | 'web' | 'native' = 'none';
  #timer: ReturnType<typeof setTimeout> | null = null;
  #ticking = false;
  #tickEpoch = -1;

  #tuned: TuneState = { quality: 0.6, scale: 1 };
  #format: string | null = null;
  #framesSinceProbe = 0;
  #lastDiff: Uint8ClampedArray | null = null;
  #lastSentAt = 0;
  #lastGrabAt = 0;
  #startedAt = 0;
  #audienceKey = '';
  #stallReported = false;

  #pendingNative: ScreenFrame | null = null;
  #lastNative: ScreenFrame | null = null;
  #nativeTimer: ReturnType<typeof setTimeout> | null = null;
  #nativeNextAt = 0;

  constructor(deps: ScreenSenderDeps) {
    this.#call = deps.call;
    this.#settings = deps.settings;
    this.#onStall = deps.onStall;
    this.#onTune = deps.onTune;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** 画面の映像（取り込み用。見せない・音は無い）。取り込みが無いときは null */
  get video(): HTMLVideoElement | null {
    return this.#video;
  }

  /**
   * web の取り込みを始める。映像を置く要素を作り、送りの周期を始める。
   * stream の停止はしない（エンジンが持つ）。
   */
  startWeb(stream: MediaStream): HTMLVideoElement {
    this.#halt();
    const video = document.createElement('video');
    video.className = 'screenshare-capture-video';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.setAttribute('style', 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none');
    video.srcObject = stream;
    document.body.append(video);
    void Promise.resolve(video.play()).catch(() => {
      if (this.#active && this.#video === video) this.#onStall('video_play_failed');
    });
    this.#video = video;
    this.#stream = stream;
    this.#imageCapture = null;
    this.#mode = 'web';
    this.#active = true;
    this.#startedAt = this.#now();
    this.#lastGrabAt = 0;
    this.#resetTuning();
    this.#scheduleTick(0);
    return video;
  }

  /** ネイティブの取得の送りを始める（エンジンが、ネイティブで共有を始めたときに一度だけ呼ぶ） */
  startNative(): void {
    this.#halt();
    this.#mode = 'native';
    this.#active = true;
    this.#resetTuning();
  }

  /** ネイティブの取得のフレームを送る（予算の間隔で。送れない間に来た古いものは捨てる）。startNative のあいだだけ */
  offerNative(frame: ScreenFrame): void {
    if (this.#mode !== 'native' || !this.#active) return;
    this.#lastNative = frame;
    this.#pendingNative = frame;
    // 予約が遅れているときは、取り消していま送り直す
    if (this.#nativeTimer !== null && this.#nativeNextAt <= this.#now()) {
      clearTimeout(this.#nativeTimer);
      this.#nativeTimer = null;
    }
    this.#flushNative();
  }

  /** 見る人が増えた・問い合わせが来た: 共有中なら、画面をすぐに送り直す */
  announce(): void {
    if (!this.#active) return;
    if (this.#mode === 'web') {
      this.#audienceKey = '';
      if (!this.#inFlight()) this.#scheduleTick(0);
    } else if (this.#mode === 'native' && this.#lastNative && this.#hasAudience()) {
      this.#audienceKey = '';
      this.#pendingNative = this.#lastNative;
      this.#flushNative();
    }
  }

  /** 今の画質の調整（ネイティブの取得へ渡すのはエンジンの役目） */
  get tuned(): Readonly<TuneState> {
    return this.#tuned;
  }

  /** 送りを止める（タイマー・取り込みの要素・保留のフレームを捨てる）。ストリームは止めない */
  stop(): void {
    this.#halt();
  }

  // ---- 内部 ----

  #halt(): void {
    this.#epoch++;
    this.#active = false;
    this.#mode = 'none';
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#nativeTimer !== null) clearTimeout(this.#nativeTimer);
    this.#nativeTimer = null;
    this.#pendingNative = null;
    this.#lastNative = null;
    this.#lastDiff = null;
    this.#imageCapture = null;
    this.#stream = null;
    if (this.#video) {
      this.#video.pause();
      this.#video.srcObject = null;
      this.#video.remove();
    }
    this.#video = null;
  }

  #resetTuning(): void {
    this.#tuned = { quality: QUALITY_PRESETS[this.#settings.value.quality].quality, scale: 1 };
    this.#format = null;
    this.#framesSinceProbe = 0;
    this.#stallReported = false;
  }

  #hasAudience(): boolean {
    return this.#call.participants.some((p) => !p.self);
  }

  #inFlight(): boolean {
    return this.#ticking && this.#tickEpoch === this.#epoch;
  }

  #scheduleTick(delay: number): void {
    if (!this.#active || this.#mode !== 'web') return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#frameTick(), Math.max(0, delay));
  }

  /** 1 フレームぶんの処理。次の呼び出しを自分で予約する */
  async #frameTick(): Promise<void> {
    this.#timer = null;
    if (!this.#active || this.#inFlight()) return;
    const epoch = this.#epoch;
    const t0 = this.#now();
    let delay: number;
    this.#ticking = true;
    this.#tickEpoch = epoch;
    try {
      if (!this.#call.joined) {
        this.stop();
        this.#onStall('left_call');
        return;
      }
      if (!this.#call.listed || !this.#hasAudience()) delay = IDLE_MS;
      else if ((this.#call.bufferedAmount ?? 0) > BACKLOG_LIMIT) delay = BACKLOG_RETRY_MS;
      else delay = await this.#captureAndSend(epoch);
    } catch {
      if (epoch !== this.#epoch) return;
      this.stop();
      this.#onStall('send_failed');
      return;
    } finally {
      if (this.#tickEpoch === epoch) this.#ticking = false;
    }
    if (epoch !== this.#epoch || !this.#active) return;
    if (this.#timer === null) this.#timer = setTimeout(() => void this.#frameTick(), Math.max(0, delay - (this.#now() - t0)));
  }

  /** 画面を 1 枚取り込む。<video> に描けなければ ImageCapture（あれば）を使う。まだ映像が無ければ null */
  async #grab(): Promise<Grabbed | null> {
    if (this.#imageCapture) {
      const bmp = await this.#imageCapture.grabFrame();
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    }
    const video = this.#video;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    return { source: video, w: video.videoWidth, h: video.videoHeight };
  }

  async #captureAndSend(epoch: number): Promise<number> {
    const g = await this.#grab();
    if (epoch !== this.#epoch) {
      g?.close?.();
      return VIDEO_WAIT_MS;
    }
    if (!g) {
      this.#noteStall('映像が始まりません');
      return VIDEO_WAIT_MS;
    }
    try {
      return this.#encodeAndSend(g);
    } finally {
      g.close?.();
    }
  }

  /** 取り込めない状態が続いたら、ImageCapture に替える。それでもだめなら一度だけ知らせる（トラックの名前やログは出さない） */
  #noteStall(why: string): void {
    const now = this.#now();
    if (now - (this.#lastGrabAt || this.#startedAt) < VIDEO_STALL_MS) return;
    const track = this.#stream?.getVideoTracks()[0];
    const Ctor = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
    if (!this.#imageCapture && track && typeof Ctor === 'function') {
      try {
        this.#imageCapture = new Ctor(track);
        this.#lastGrabAt = now;
        return;
      } catch {
        // ImageCapture を使えない環境
      }
    }
    if (this.#stallReported) return;
    this.#stallReported = true;
    this.#onStall(`video_stalled:${why}`);
  }

  #canvasFor(which: 'send' | 'diff'): HTMLCanvasElement {
    if (which === 'send') return this.#canvas ?? (this.#canvas = document.createElement('canvas'));
    return this.#diffCanvas ?? (this.#diffCanvas = document.createElement('canvas'));
  }

  /** 縮小して変化を見て、変わったときだけ符号化して送る */
  #encodeAndSend(g: Grabbed): number {
    const settings = this.#settings.value;
    const preset = QUALITY_PRESETS[settings.quality];
    const minInterval = 1000 / settings.fps;

    const dc = this.#canvasFor('diff');
    dc.width = DIFF_W;
    dc.height = DIFF_H;
    const dctx = dc.getContext('2d', { willReadFrequently: true });
    if (!dctx) throw new Error('canvas を使えません');
    dctx.drawImage(g.source, 0, 0, DIFF_W, DIFF_H);
    const data = dctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
    if (isBlankFrame(data)) {
      this.#noteStall('映像が空です');
      return VIDEO_WAIT_MS;
    }
    const now = this.#now();
    this.#lastGrabAt = now;
    const key = this.#call.participants.map((p) => p.peer).join(',');
    const force = key !== this.#audienceKey;
    const send = shouldSend({
      diff: frameDiff(this.#lastDiff, data),
      peak: framePeakDiff(this.#lastDiff, data),
      sinceSentMs: now - this.#lastSentAt,
      force,
    });
    if (!send) return minInterval;
    this.#lastDiff = data;
    this.#audienceKey = key;

    const size = fitSize(g.w, g.h, preset.maxEdge, this.#tuned.scale);
    const probe = this.#format === null || this.#framesSinceProbe >= PROBE_EVERY;
    const out = encodeFrame(this.#canvasFor('send'), g.source, size.w, size.h, {
      color: settings.color,
      quality: this.#tuned.quality,
      format: probe ? null : this.#format,
    });
    if (probe) this.#framesSinceProbe = 0;
    this.#framesSinceProbe++;
    this.#format = out.mime;
    if (!out.b64) throw new Error('画像にできません');

    const chunks = this.#emitFrame(out.b64);
    this.#lastSentAt = now;
    this.#tuned = tuneQuality(this.#tuned, out.b64.length, preset);
    return nextInterval({ fps: settings.fps, weight: frameWeight(out.b64.length, chunks), budgetKBps: SERVER_BUDGET_KBPS });
  }

  /** 符号化したフレームを分割して送る。分割数を返す */
  #emitFrame(b64: string): number {
    const chunks = splitFrame(nextFrameId(), b64);
    for (const c of chunks) this.#call.emit(EVENT_FRAME, c);
    return chunks.length;
  }

  #flushNative(): void {
    if (!this.#active || this.#mode !== 'native' || this.#nativeTimer !== null || !this.#pendingNative) return;
    let wait = this.#nativeNextAt - this.#now();
    if (!this.#call.listed) wait = Math.max(wait, IDLE_MS);
    if (wait <= 0 && (this.#call.bufferedAmount ?? 0) > BACKLOG_LIMIT) wait = BACKLOG_RETRY_MS;
    if (wait > 0) {
      this.#nativeTimer = setTimeout(() => {
        this.#nativeTimer = null;
        this.#flushNative();
      }, wait);
      return;
    }
    const f = this.#pendingNative;
    this.#pendingNative = null;
    if (!this.#call.joined) {
      this.stop();
      this.#onStall('left_call');
      return;
    }
    if (!this.#hasAudience()) return;
    try {
      const chunks = this.#emitFrame(f.data);
      this.#lastSentAt = this.#now();
      this.#audienceKey = this.#call.participants.map((p) => p.peer).join(',');
      const preset = QUALITY_PRESETS[this.#settings.value.quality];
      this.#nativeNextAt = this.#now() + nextInterval({
        fps: this.#settings.value.fps,
        weight: frameWeight(f.data.length, chunks),
        budgetKBps: SERVER_BUDGET_KBPS,
      });
      const next = tuneQuality(this.#tuned, f.data.length, preset);
      const changed = next.quality !== this.#tuned.quality || next.scale !== this.#tuned.scale;
      this.#tuned = next;
      if (changed) this.#onTune?.(next);
    } catch {
      this.stop();
      this.#onStall('send_failed');
    }
  }
}
