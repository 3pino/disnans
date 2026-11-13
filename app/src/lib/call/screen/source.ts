import { QUALITY_PRESETS } from './codec';
import { DIFF_THRESHOLD } from './diff';
import { KEEPALIVE_FRAME_MS } from './pacing';
import { SCREEN_FRAME, SCREEN_QUERY, SCREEN_STATE } from './receiver.svelte';
import type { ScreenCapturePort, ScreenFrame, ScreenSettingsValue, ScreenSource } from './types';
import { captureFailure, isCaptureCancelled, pickVideo, stopTracks } from './webCapture';

/**
 * 共有する映像の取得元（ポート）。OS ごとの違い（getDisplayMedia / Android のネイティブ中継 / Linux の取得）は
 * ここのアダプターが持ち、共有の store は取得元がどれかを知らない。選ぶのは store を作るときの 1 回だけ（selectScreenSource）。
 */
export type ScreenHooks = {
  /** 取得したフレーム（ネイティブの取得だけ。web は stream を返す） */
  onFrame(frame: ScreenFrame): void;
  /** OS 側（通知欄の停止など）で終わった */
  onEnd(): void;
};

export type ScreenAcquired = {
  /** web の取得。ネイティブはフレームを onFrame に流すので null */
  stream: MediaStream | null;
  /** 取得したものを（共有を始めずに）捨てる。ネイティブは何もしない（遅い完了は橋が取得番号で破棄する） */
  discard(): void;
};

export type ScreenFailure = { silent: boolean; message: string };

export interface ScreenSourcePort {
  /** 取得したフレームを通話へ送るのが、取得側（ネイティブ）か。true なら JS の送り手・状態・問い合わせを持たない */
  readonly relay: boolean;
  canStart(source: ScreenSource): boolean;
  start(source: ScreenSource, settings: ScreenSettingsValue, hooks: ScreenHooks): Promise<ScreenAcquired>;
  /** 取得中の品質調整（できない取得元では何もしない） */
  tune(patch: { quality?: number; scale?: number }): void;
  /** 取得の停止。許可待ちの途中でも届く。web は何もしない */
  stop(): Promise<void>;
  /** 失敗を、利用者に見せる形にする（キャンセルは silent） */
  failure(source: ScreenSource, error: unknown): ScreenFailure;
}

function failure(source: ScreenSource, error: unknown): ScreenFailure {
  return { silent: source === 'screen' && isCaptureCancelled(error), message: captureFailure(source, error) };
}

/** ブラウザー・Windows: getDisplayMedia / getUserMedia（カメラはどの環境でもここ） */
export class WebScreenSource implements ScreenSourcePort {
  readonly relay = false;
  canStart(source: ScreenSource): boolean {
    const media = globalThis.navigator?.mediaDevices;
    return source === 'camera' ? typeof media?.getUserMedia === 'function' : typeof media?.getDisplayMedia === 'function';
  }
  async start(source: ScreenSource, settings: ScreenSettingsValue, _hooks?: ScreenHooks): Promise<ScreenAcquired> {
    const stream = await pickVideo(source, settings.fps);
    return { stream, discard: () => stopTracks(stream) };
  }
  tune(_patch: { quality?: number; scale?: number }): void {}
  async stop(): Promise<void> {}
  failure = failure;
}

/** ネイティブの取得（OS の画面を橋から受ける）。送るのは JS の送り手か、ネイティブか（サブクラス） */
abstract class NativeScreenSource implements ScreenSourcePort {
  abstract readonly relay: boolean;
  constructor(protected readonly capture: ScreenCapturePort) {}
  canStart(source: ScreenSource): boolean { return source === 'screen'; }
  async start(_source: ScreenSource, settings: ScreenSettingsValue, hooks: ScreenHooks): Promise<ScreenAcquired> {
    const preset = QUALITY_PRESETS[settings.quality];
    await this.capture.start({
      maxEdge: preset.maxEdge, quality: preset.quality, fps: settings.fps,
      format: 'jpeg', color: settings.color, diffThreshold: DIFF_THRESHOLD, keepaliveMs: KEEPALIVE_FRAME_MS,
      ...(this.relay ? { callRelay: { frameEvent: SCREEN_FRAME, stateEvent: SCREEN_STATE, queryEvent: SCREEN_QUERY, state: { source: 'screen' } } } : {}),
      onEnd: hooks.onEnd,
    }, hooks.onFrame);
    return { stream: null, discard: () => {} };
  }
  tune(patch: { quality?: number; scale?: number }): void { void this.capture.update(patch).catch(() => {}); }
  stop(): Promise<void> { return this.capture.stop(); }
  failure = failure;
}

/** Linux: 橋からフレームを受け、JS の送り手が通話へ送る */
export class NativeFramesScreenSource extends NativeScreenSource {
  readonly relay = false;
}

/** Android: 取得から通話への送信までネイティブが持つ（前景・背景とも）。JS はプレビューだけ */
export class NativeRelayScreenSource extends NativeScreenSource {
  readonly relay = true;
  override tune(_patch: { quality?: number; scale?: number }): void {} // 調整もネイティブが持つ
}

/** 取得元を選ぶ（store を作るときの 1 回）。ネイティブの取得が無ければ web */
export function selectScreenSource(capture: ScreenCapturePort): ScreenSourcePort {
  if (!capture.supported) return new WebScreenSource();
  return capture.supportsCallRelay === true ? new NativeRelayScreenSource(capture) : new NativeFramesScreenSource(capture);
}
