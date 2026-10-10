import { isAndroid, isTauri } from '../config';

/**
 * Android のネイティブ機能（screen プラグイン）への橋渡し。デスクトップ・ブラウザでは使えない（supported が false）。
 * - screenCapture（API v9）: MediaProjection で画面を撮り、縮小した JPEG / WebP を JS に渡す。WebView に getDisplayMedia が無いため
 * - pip（API v9）: Activity のピクチャーインピクチャー
 * 画面の取得は、ユーザーの許可のダイアログ（システム）と、通知欄の常駐（フォアグラウンドサービス）を伴う。
 */

const native = (): boolean => isTauri() && isAndroid();

async function invokeScreen<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`plugin:screen|${cmd}`, args);
}

/** プラグインのイベントを購読する。同じイベントに何度も付けないよう、最初の1回だけ付けて自分で配る */
const listeners = new Map<string, Set<(payload: never) => void>>();
const attached = new Map<string, Promise<void>>();

function listen<T>(event: string, cb: (payload: T) => void): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(cb as (payload: never) => void);
  if (!attached.has(event)) {
    const p = import('@tauri-apps/api/core')
      .then(({ addPluginListener }) =>
        addPluginListener<T>('screen', event, (payload) => {
          for (const f of [...(listeners.get(event) ?? [])]) (f as (p: T) => void)(payload);
        }),
      )
      .then(() => {})
      .catch((e) => {
        attached.delete(event);
        console.warn(`screen プラグインのイベント ${event} を受け取れません`, e);
      });
    attached.set(event, p);
  }
  return () => {
    set.delete(cb as (payload: never) => void);
  };
}

// ---- 画面のキャプチャ ----

type CaptureFramePayload = { data: string; mime: string; width: number; height: number };
type CaptureEndPayload = { reason?: string };

let captureOff: (() => void)[] = [];
let capturing = false;

export const screenCaptureApi: Disnans.ScreenCapture = {
  get supported() {
    return native();
  },
  async start(opts, onFrame) {
    if (!native()) throw new Error('この環境では使えません');
    if (capturing) await screenCaptureApi.stop();
    capturing = true;
    captureOff = [
      listen<CaptureFramePayload>('capture_frame', (f) => {
        try {
          onFrame({ data: f.data, mime: f.mime, width: f.width, height: f.height });
        } catch (e) {
          console.error('画面キャプチャのフレームの処理で例外', e);
        }
      }),
      listen<CaptureEndPayload>('capture_end', () => {
        const wasCapturing = capturing;
        cleanup();
        if (wasCapturing) opts.onEnd?.();
      }),
    ];
    try {
      await invokeScreen('start_capture', {
        maxEdge: opts.maxEdge,
        quality: opts.quality,
        fps: opts.fps,
        format: opts.format ?? 'jpeg',
        color: opts.color ?? 'full',
        // 変化の検出（ネイティブ側）。変わらない間は送らず、keepaliveMs ごとに 1 枚だけ送る
        diffThreshold: opts.diffThreshold ?? 1.5,
        keepaliveMs: opts.keepaliveMs ?? 5000,
      });
    } catch (e) {
      cleanup();
      throw e;
    }
  },
  async update(patch) {
    if (!capturing) return;
    await invokeScreen('update_capture', { ...patch });
  },
  async stop() {
    if (!capturing) return;
    cleanup();
    try {
      await invokeScreen('stop_capture');
    } catch (e) {
      console.warn('画面のキャプチャを止められませんでした', e);
    }
  },
};

function cleanup(): void {
  capturing = false;
  for (const off of captureOff) off();
  captureOff = [];
}

// ---- ピクチャーインピクチャー ----

let pipActive = false;
const pipCallbacks = new Set<(active: boolean) => void>();
let pipListening = false;

function ensurePipListener(): void {
  if (pipListening) return;
  pipListening = true;
  listen<{ active: boolean }>('pip_change', (e) => {
    pipActive = e.active === true;
    for (const cb of [...pipCallbacks]) {
      try {
        cb(pipActive);
      } catch (err) {
        console.error('PiP の変化の処理で例外', err);
      }
    }
  });
}

export const pipApi: Disnans.Pip = {
  get supported() {
    return native();
  },
  get active() {
    return pipActive;
  },
  async enter(opts) {
    if (!native()) return false;
    ensurePipListener();
    const res = await invokeScreen<{ entered?: boolean }>('enter_pip', {
      width: Math.max(1, Math.round(opts?.aspect?.width ?? 16)),
      height: Math.max(1, Math.round(opts?.aspect?.height ?? 9)),
    });
    return res?.entered === true;
  },
  onChange(cb) {
    if (native()) ensurePipListener();
    pipCallbacks.add(cb);
    return () => {
      pipCallbacks.delete(cb);
    };
  },
};
