import { capabilities, isAndroid } from '../platform';
import { MediaError } from './errors';
import type { ScreenCapturePort, ScreenPipPort, ScreenRelay, ScreenSnapshot } from '../call/screen/types';

/**
 * ネイティブの画面取得への橋渡し。通話の標準の画面共有（call/screen）と設定のプレビューだけが使う。プラグインへは公開しない。
 * - Android: MediaProjection で画面を撮り、縮小した JPEG / WebP を JS に渡す。
 * - Linux: portal / PipeWire → GStreamer で、選んだ画面を取得する。WebKitGTK の映像の描画には頼らない
 * - pip: Activity のピクチャーインピクチャー
 * 画面の取得は、ユーザーの許可のダイアログ（システム）と、通知欄の常駐（フォアグラウンドサービス）を伴う。
 * - snapshot: ダイアログなしの静止画 1 枚。デスクトップ（Windows / Linux）でも使える。
 *   デスクトップは本体の `screen_snapshot` コマンド（src-tauri/src/snapshot.rs）、Android は screen プラグインの `snapshot`（PixelCopy）
 */

// Android の Tauri（MediaProjection・PiP）。方針（capabilities.nativeScreen）から決める
const native = (): boolean => capabilities().nativeScreen === 'android';

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
 * ユーザーが許可のダイアログで断った（code が `cancelled`）ときは name を `AbortError` にする
 */
export function toCaptureError(e: unknown): Error {
  if (e instanceof Error) return e;
  const o = typeof e === 'object' && e !== null ? (e as { message?: unknown; code?: unknown }) : null;
  const message = typeof o?.message === 'string' ? o.message : typeof e === 'string' ? e : '画面を取得できませんでした';
  const err = new Error(message);
  if (o?.code === 'cancelled' || /\((?:denied|cancelled)\)/.test(message)) err.name = 'AbortError';
  return err;
}

type CaptureFramePayload = { data: string; mime: string; width: number; height: number; captureId?: number };
type CaptureEndPayload = { reason?: string; message?: string; captureId?: number };
type CallRelay = ScreenRelay;

let captureOff: (() => void)[] = [];
let capturing = false;
let captureOwner: object | null = null;
// ページの再作成後も古い取得の番号をすぐ再利用しない（ネイティブの遅い終了通知と区別する）。
let captureSeq = Date.now();
let captureBackend: 'android' | 'linux' | null = null;
type Retirement = { owner: object; backend: 'android' | 'linux'; seq: number; pending: Promise<void> | null };
let retirement: Retirement | null = null;

// ---- 通話へのネイティブ送信。フロントエンドと Android のネイティブは同じ APK に入るので、Android なら使える ----

/** 名前・状態の決まり（本体へ渡す前に、JS で確かめる）。違うものは invalid_argument */
const RELAY_RESERVED_NAMES = new Set(['audio']);
const RELAY_STATE_MAX_BYTES = 256;

function relayName(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64) throw new MediaError('invalid_argument', `${what} は 1〜64 文字の文字列にしてください`);
  if (RELAY_RESERVED_NAMES.has(v)) throw new MediaError('invalid_argument', `${what} の ${v} は本体が使います`);
  return v;
}

function relayState(v: unknown): Record<string, string | number | boolean> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new MediaError('invalid_argument', 'callRelay.state はオブジェクトにしてください');
  const entries: [string, string | number | boolean][] = [];
  for (const [k, x] of Object.entries(v)) {
    if (k === 'on') throw new MediaError('invalid_argument', 'callRelay.state のキー on は使えません');
    if (typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) entries.push([k, x]);
    else throw new MediaError('invalid_argument', 'callRelay.state の値は文字列・有限の数・真偽だけにしてください');
  }
  const out = Object.fromEntries(entries);
  if (new TextEncoder().encode(JSON.stringify(out)).length > RELAY_STATE_MAX_BYTES) {
    throw new MediaError('invalid_argument', `callRelay.state は ${RELAY_STATE_MAX_BYTES} バイトまでです`);
  }
  return out;
}

/** callRelay を確かめて、本体に渡す形にそろえる（名前が 3 つとも違うこと） */
export function validateCallRelay(r: unknown): CallRelay {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) throw new MediaError('invalid_argument', 'callRelay はオブジェクトにしてください');
  const o = r as Record<string, unknown>;
  const frameEvent = relayName(o.frameEvent, 'frameEvent');
  const stateEvent = relayName(o.stateEvent, 'stateEvent');
  const queryEvent = o.queryEvent === undefined ? undefined : relayName(o.queryEvent, 'queryEvent');
  const names = [frameEvent, stateEvent, ...(queryEvent === undefined ? [] : [queryEvent])];
  if (new Set(names).size !== names.length) throw new MediaError('invalid_argument', 'callRelay の 3 つの名前は互いに違うものにしてください');
  const state = o.state === undefined ? undefined : relayState(o.state);
  return {
    frameEvent,
    stateEvent,
    ...(queryEvent === undefined ? {} : { queryEvent }),
    ...(state === undefined ? {} : { state }),
  };
}

async function invokeCapture<T>(backend: 'android' | 'linux', operation: 'start' | 'stop' | 'update', args?: Record<string, unknown>): Promise<T> {
  if (backend === 'android') return invokeScreen<T>(`${operation}_capture`, args);
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(`linux_screen_${operation}`, operation === 'stop' ? undefined : { options: args });
}

/** Linux の停止は番号を持たないため、停止の受理まで次の取得を始めない。失敗なら再停止できる所有権を残す。 */
function retireCapture(owner: object): Promise<void> {
  let current = retirement;
  if (current && current.owner !== owner) return Promise.resolve();
  if (current?.pending) return current.pending;
  if (!current) {
    if (!capturing || captureOwner !== owner || !captureBackend) return Promise.resolve();
    current = { owner, backend: captureBackend, seq: captureSeq, pending: null };
    retirement = current;
    cleanup();
  }
  const run = current;
  run.pending = invokeCapture(run.backend, 'stop', run.backend === 'android' ? { captureId: run.seq } : undefined)
    .then(() => { if (retirement === run) retirement = null; })
    .catch(() => { throw new MediaError('stop_unconfirmed', '画面の取得の停止を確認できません。もう一度停止してください'); })
    .finally(() => { run.pending = null; });
  return run.pending;
}

/** 取得は OS ごとに一つ（所有者を取り違えないよう、停止・設定はこのポートを作った側だけが行う）。 */
function capturePort(): ScreenCapturePort {
  const owner = {};
  let request = 0;
  const api: ScreenCapturePort = {
  get supported() {
    return capabilities().nativeScreen !== null;
  },
  /** 通話へのネイティブ送信が使える。Android（この版の本体）だけ true。Linux・ブラウザーでは false */
  get supportsCallRelay() {
    return native();
  },
  async start(opts, onFrame) {
    if (!api.supported) throw new MediaError('unsupported', 'この環境では使えません');
    if ((capturing && captureOwner !== owner) || (retirement && retirement.owner !== owner)) throw new MediaError('busy', 'ほかの機能が画面を取得しています');
    // 通話への送信は Android だけ。ほかで頼まれたら、黙って別の経路に替えず、そのまま失敗させる
    const relay = opts.callRelay === undefined ? null : validateCallRelay(opts.callRelay);
    if (relay && !native()) throw new MediaError('unsupported', 'この環境では通話へ直接送れません（Android だけ対応しています）');
    const mine = ++request;
    if (capturing) await retireCapture(owner);
    else if (retirement?.owner === owner) {
      if (!retirement.pending) throw new MediaError('stop_unconfirmed', '画面の取得の停止を確認できません。もう一度停止してください');
      await retirement.pending;
    }
    if (mine !== request) throw new DOMException('画面の共有は終了しました', 'AbortError');
    if ((capturing && captureOwner !== owner) || (retirement && retirement.owner !== owner)) throw new MediaError('busy', 'ほかの機能が画面を取得しています');
    capturing = true;
    captureOwner = owner;
    const seq = ++captureSeq;
    const backend = capabilities().nativeScreen ?? 'android';
    captureBackend = backend;
    // 撮り始めた回（captureId）が今のものと違えば捨てる（Android も Linux も、本体は必ず captureId を返す）
    const idOk = (id: number | undefined) => id === seq;
    const frame = (f: CaptureFramePayload) => {
      if (!capturing || seq !== captureSeq || !idOk(f.captureId)) return;
      try {
        onFrame({ data: f.data, mime: f.mime, width: f.width, height: f.height });
      } catch (e) {
        console.error('画面キャプチャのフレームの処理で例外', e);
      }
    };
    const end = (e: CaptureEndPayload) => {
      if (!capturing || seq !== captureSeq || !idOk(e.captureId)) return;
      if (e.reason) console.info('[screen] 画面の取得を終了しました', e.reason, e.message ?? '');
      cleanup();
      opts.onEnd?.();
    };
    try {
      if (backend === 'linux') {
        const { listen: listenEvent } = await import('@tauri-apps/api/event');
        // 最初のフレームを取りこぼさないよう、購読が完了してから取得を始める
        const results = await Promise.allSettled([
          listenEvent<CaptureFramePayload>('linux-screen-frame', (e) => frame(e.payload)),
          listenEvent<CaptureEndPayload>('linux-screen-end', (e) => end(e.payload)),
        ]);
        const offs = results.flatMap((r) => r.status === 'fulfilled' ? [r.value] : []);
        const failed = results.find((r) => r.status === 'rejected');
        if (failed || !capturing || seq !== captureSeq) {
          offs.forEach((off) => off());
          throw failed?.reason ?? new DOMException('画面の共有は終了しました', 'AbortError');
        }
        captureOff = offs;
      } else {
        captureOff = [listen<CaptureFramePayload>('capture_frame', frame), listen<CaptureEndPayload>('capture_end', end)];
        await Promise.all([attached.get('capture_frame'), attached.get('capture_end')]);
      }
      if (!capturing || seq !== captureSeq) throw new DOMException('画面の共有は終了しました', 'AbortError');
      await invokeCapture(backend, 'start', {
        captureId: seq,
        ...(relay === null ? {} : { callRelay: relay }),
        maxEdge: opts.maxEdge,
        quality: opts.quality,
        fps: opts.fps,
        format: opts.format ?? 'jpeg',
        color: opts.color ?? 'full',
        // 変化の検出（ネイティブ側）。変わらない間は送らず、keepaliveMs ごとに 1 枚だけ送る
        diffThreshold: opts.diffThreshold ?? 1.5,
        keepaliveMs: opts.keepaliveMs ?? 5000,
      });
      // 開始の応答が来る前に止められていたら（新しい開始もない）、Android では撮り始めたものを止める
      if (seq !== captureSeq) {
        if (backend === 'android') void invokeCapture('android', 'stop', { captureId: seq }).catch(() => {});
        throw new DOMException('画面の共有は終了しました', 'AbortError');
      }
    } catch (e) {
      if (seq === captureSeq) cleanup();
      throw toCaptureError(e);
    }
  },
  async update(patch) {
    if (!capturing || captureOwner !== owner || !captureBackend) return;
    await invokeCapture(captureBackend, 'update', { ...patch, ...(captureBackend === 'android' ? { captureId: captureSeq } : {}) });
  },
  snapshot,
  async stop() {
    ++request; // 停止待ちの後に続く開始も取り消す（まだ OS を呼んでいなくても）。
    await retireCapture(owner);
  },
  };
  return api;
}

export const screenCaptureApi = capturePort();

function cleanup(): void {
  capturing = false;
  captureOwner = null;
  captureBackend = null;
  captureSeq++;
  for (const off of captureOff) off();
  captureOff = [];
}

// ---- 静止画 ----

/** プレビューなどに使う静止画の JPEG の品質 */
const SNAPSHOT_QUALITY = 0.85;

/**
 * デスクトップの `screen_snapshot` が返すバイナリ（先頭 12 バイトのヘッダー＋RGBA）を読む。
 * Rust 側に画像のエンコーダーを入れないよう、JPEG への符号化は canvas で行う（snapshotDesktop）
 */
export function decodeSnapshotBytes(buf: ArrayBuffer): { width: number; height: number; source: 'screen' | 'app'; rgba: Uint8ClampedArray } {
  if (buf.byteLength < 12) throw new MediaError('failed', '画面の画像が壊れています');
  const view = new DataView(buf);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const source = view.getUint8(8) === 0 ? 'screen' : 'app';
  const len = width * height * 4;
  if (!width || !height || buf.byteLength < 12 + len) throw new MediaError('failed', '画面の画像が壊れています');
  return { width, height, source, rgba: new Uint8ClampedArray(buf, 12, len) };
}

async function snapshotDesktop(): Promise<ScreenSnapshot> {
  const { invoke } = await import('@tauri-apps/api/core');
  const res = await invoke<ArrayBuffer | number[]>('screen_snapshot');
  const buf = res instanceof ArrayBuffer ? res : new Uint8Array(res).buffer;
  const { width, height, source, rgba } = decodeSnapshotBytes(buf);
  const cv = document.createElement('canvas');
  cv.width = width;
  cv.height = height;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new MediaError('failed', '画像を作れません');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  return { dataUrl: cv.toDataURL('image/jpeg', SNAPSHOT_QUALITY), width, height, source };
}

/** Android の snapshot の応答を待つ上限（ネイティブ側も 8 秒で打ち切る。応答そのものが来ないときのため） */
const SNAPSHOT_ANDROID_TIMEOUT_MS = 12_000;

/**
 * Android の snapshot の失敗を、利用者に見せられる文言の Error にする。
 * ネイティブ側の文言（「画面を撮れませんでした（理由）」）はそのまま使い、Tauri の英語のエラー（権限・コマンドが無い）は言い換える
 */
export function toSnapshotError(e: unknown): Error {
  const err = toCaptureError(e);
  const m = err.message;
  if (/not allowed|No command|not found|InvalidCommand/i.test(m)) {
    return new Error(`この版のアプリは画面の静止画に対応していません。アプリを更新してください（${m}）`);
  }
  if (/Plugin .* not initialized/i.test(m)) {
    return new Error(`画面の機能（screen プラグイン）が読み込まれていません（${m}）`);
  }
  if (!/画面を撮れ|画面を取得/.test(m)) return new Error(`画面を撮れませんでした（${m}）`);
  return err;
}

async function snapshotAndroid(): Promise<ScreenSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const f = await Promise.race([
      invokeScreen<CaptureFramePayload | null>('snapshot', { maxEdge: 1920, quality: SNAPSHOT_QUALITY }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`画面を撮れませんでした（${SNAPSHOT_ANDROID_TIMEOUT_MS / 1000} 秒待ってもアプリから応答がありません）`)),
          SNAPSHOT_ANDROID_TIMEOUT_MS,
        );
      }),
    ]);
    if (!f || typeof f.data !== 'string' || !f.data || !(f.width > 0) || !(f.height > 0)) {
      throw new MediaError('failed', '画面を撮れませんでした（アプリから届いた画像が空です）');
    }
    return { dataUrl: `data:${f.mime || 'image/jpeg'};base64,${f.data}`, width: f.width, height: f.height, source: 'app' };
  } catch (e) {
    throw toSnapshotError(e);
  } finally {
    clearTimeout(timer);
  }
}

/** 静止画を 1 枚撮る。選択や許可のダイアログは出さない */
async function snapshot(): Promise<ScreenSnapshot> {
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

export const pipApi: ScreenPipPort = {
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
