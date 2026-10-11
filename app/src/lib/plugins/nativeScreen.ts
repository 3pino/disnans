import { isAndroid, isTauri } from '../config';

/**
 * Android のネイティブ機能（screen プラグイン）への橋渡し。デスクトップ・ブラウザでは使えない（supported が false）。
 * - screenCapture（API v9）: MediaProjection で画面を撮り、縮小した JPEG / WebP を JS に渡す。WebView に getDisplayMedia が無いため
 * - pip（API v9）: Activity のピクチャーインピクチャー
 * 画面の取得は、ユーザーの許可のダイアログ（システム）と、通知欄の常駐（フォアグラウンドサービス）を伴う。
 * - screenCapture.snapshot（API v11）: ダイアログなしの静止画 1 枚。デスクトップ（Windows / Linux）でも使える。
 *   デスクトップは本体の `screen_snapshot` コマンド（src-tauri/src/snapshot.rs）、Android は screen プラグインの `snapshot`（PixelCopy）
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

/**
 * ネイティブのプラグインのエラー（`{ message, code }` のオブジェクトで届く）を Error にする。
 * ユーザーが許可のダイアログで断った（code が `cancelled`）ときは name を `AbortError` にする（API v10）
 */
export function toCaptureError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = typeof e === 'object' && e !== null ? (e as { message?: unknown; code?: unknown }) : null;
  const message = typeof o?.message === 'string' ? o.message : typeof e === 'string' ? e : '画面を取得できませんでした';
  const err = new Error(message);
  if (o?.code === 'cancelled' || /\((?:denied|cancelled)\)/.test(message)) err.name = 'AbortError';
  return err;
}

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
      throw toCaptureError(e);
    }
  },
  async update(patch) {
    if (!capturing) return;
    await invokeScreen('update_capture', { ...patch });
  },
  snapshot,
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

// ---- 静止画（API v11） ----

/** プレビューなどに使う静止画の JPEG の品質 */
const SNAPSHOT_QUALITY = 0.85;

/**
 * デスクトップの `screen_snapshot` が返すバイナリ（先頭 12 バイトのヘッダー＋RGBA）を読む。
 * Rust 側に画像のエンコーダーを入れないよう、JPEG への符号化は canvas で行う（snapshotDesktop）
 */
export function decodeSnapshotBytes(buf: ArrayBuffer): { width: number; height: number; source: 'screen' | 'app'; rgba: Uint8ClampedArray } {
  if (buf.byteLength < 12) throw new Error('画面の画像が壊れています');
  const view = new DataView(buf);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const source = view.getUint8(8) === 0 ? 'screen' : 'app';
  const len = width * height * 4;
  if (!width || !height || buf.byteLength < 12 + len) throw new Error('画面の画像が壊れています');
  return { width, height, source, rgba: new Uint8ClampedArray(buf, 12, len) };
}

async function snapshotDesktop(): Promise<Disnans.ScreenSnapshot> {
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<ArrayBuffer | number[]>('screen_snapshot');
  const buf = res instanceof ArrayBuffer ? res : new Uint8Array(res).buffer;
  const { width, height, source, rgba } = decodeSnapshotBytes(buf);
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('画像を作れません');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return { dataUrl: cv.toDataURL('image/jpeg', SNAPSHOT_QUALITY), width, height, source };
}

async function snapshotAndroid(): Promise<Disnans.ScreenSnapshot> {
  try {
    const f = await invokeScreen<CaptureFramePayload>('snapshot', { maxEdge: 1920, quality: SNAPSHOT_QUALITY });
    return { dataUrl: `data:${f.mime};base64,${f.data}`, width: f.width, height: f.height, source: 'app' };
  } catch (e) {
    throw toCaptureError(e);
  }
}

/** 静止画を 1 枚撮る。選択や許可のダイアログは出さない */
async function snapshot(): Promise<Disnans.ScreenSnapshot> {
  if (!isTauri()) throw new Error('この環境では画面を撮れません');
  return isAndroid() ? snapshotAndroid() : snapshotDesktop();
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
