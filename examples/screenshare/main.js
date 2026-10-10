// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * 画面共有: 通話の拡張の実例（API v9 の disnans.call / screenCapture / pip / ui.onBack / ui.setImmersive）。
 *
 * できること:
 * 1. 通話のバーの [画面を共有] を押すと画面を選び、縮小した画像（JPEG / WebP / PNG）を一定間隔で call.emit（サーバー中継）に流す。
 *    もう一度押すと止まる。OS 側で止めた・通話から抜けたときも止まる。
 *    取得は、getDisplayMedia があればそれ（デスクトップ）、無ければ本体のネイティブ（disnans.screenCapture。Android の MediaProjection）
 * 2. 誰かが共有を始めると、ステータス欄に [○○の画面を見る] が出る。押すと全画面の表示が開き、共有者が複数なら上のタブで切り替えられる。
 *    ピンチ・ホイールで拡大縮小、ドラッグでパン、ダブルタップ（ダブルクリック）で元に戻す。
 *    [全画面]（Android は没入モード、ほかは Fullscreen API）、[PiP]（Android は Activity の PiP、デスクトップは canvas の captureStream を <video> の PiP に）、
 *    [閉じる]（Esc・戻るジェスチャーでも閉じる）。共有者が止めた・通話から抜けたら自動で消える
 * 3. 設定で、FPS（5 / 20）・画質（解像度と品質）・色数（フルカラー / 256 色 / グレースケール）を選べる。
 *    今の設定で、エンコード後の画像と 1 フレームのおおよそのサイズ・帯域をプレビューできる
 *
 * 映像も WebRTC ではなくサーバー経由（友達は別ネットワークで、P2P がつながらないため）。
 * サーバーは送り手ごとに「容量 4000・毎秒 3000 回復・1 回の重さ = 1 + payload の KB」で流量を制限し、超えた分を黙って捨てる
 * （crates/server/src/calls.rs）。音声が毎秒 40 ほど使うので、映像は毎秒 2400 KB（重さ）までに収める。
 * payload は JSON なので画像を base64 にして送る（4/3 倍になる）。1 回の上限 64 KB を超えるフレームは分割して送り、受け手が組み立てる。
 * 色数を減らす設定では、減色したあとの画像を JPEG / WebP / PNG の候補のうち小さいもので送る（JPEG は減色の効果が薄いため）。
 *
 * 使っている API（→ docs/PLUGINS.md）:
 * - call.addButton / update / onChange / onEvent / emit / participants / joined
 * - addStatusBarItem ............ 見る入口
 * - addSettingTab / loadData / saveData ... FPS・画質・色数の設定とプレビュー
 * - registerInterval / registerDomEvent / register ... 見張りのタイマー、Esc キー、後片付け
 * - ui.setting / segmented / button / icon / toast / onBack / setImmersive
 * - screenCapture / pip ......... Android のネイティブ（画面の取得と PiP）
 *
 * 純粋な関数（分割・組み立て・調整・拡大縮小の計算）は、テストのためにここから export している（main.js の default だけがプラグイン）。
 */

const { Plugin, ui } = disnans;

// ---- 定数 ----

/** call.emit のイベント名（`audio` は本体が使う） */
const EVENT_FRAME = 'screen.frame';
const EVENT_STATE = 'screen.state';

/** 1 回の payload に入れる base64 の文字数。上限の 64 KB に JSON の枠の余裕を見て、40 KB にしておく */
export const CHUNK_CHARS = 40 * 1024;
/** 1 フレームの分割数の上限（受け取る側の検査）。40 KB × 64 = 2.5 MB */
export const MAX_CHUNKS = 64;

/** 共有中の人が「まだ共有している」と知らせる間隔（ミリ秒）。あとから来た人も、これで共有に気づく */
const HEARTBEAT_MS = 3000;
/** この時間なにも届かない共有者は、いなくなったものとして消す（ミリ秒） */
const SHARER_TIMEOUT_MS = 10000;
/** 見張りのタイマーの間隔（ミリ秒） */
const WATCH_MS = 1000;
/** 画面が変わらなくても、あとから来た人のために送り直す間隔（ミリ秒） */
export const KEEPALIVE_FRAME_MS = 5000;
/** 見ている人がいないときに、様子を見る間隔（ミリ秒） */
const IDLE_MS = 1000;
/** フレームを送る間隔の上限（ミリ秒）。重いフレームが続いても、これより遅くはしない */
export const MAX_DELAY_MS = 5000;
/** 動画がまだ始まっていない（videoWidth が 0）ときのやり直しの間隔（ミリ秒） */
const VIDEO_WAIT_MS = 100;

/** 変化の判定に使う縮小画像の大きさ */
const DIFF_W = 32;
const DIFF_H = 18;
/** 縮小画像の 1 画素・1 色あたりの差の平均がこれ以下なら「変わっていない」（0〜255） */
export const DIFF_THRESHOLD = 1.5;

/** 画質を下げるときの下限 */
const MIN_QUALITY = 0.35;
const MIN_SCALE = 0.4;

/**
 * 映像に使ってよい 1 秒あたりの重さ（サーバーの重さと同じ単位。1 + payload の KB）。
 * サーバーの回復が毎秒 3000 で、音声が 40 ほどなので、余裕を見て 2400 にしておく
 */
export const SERVER_BUDGET_KBPS = 2400;

/**
 * 画質の段階（解像度と JPEG / WebP の品質）。maxEdge は長辺の最大。
 * @typedef {{ label: string; maxEdge: number; quality: number }} QualityPreset
 * @type {Readonly<Record<string, QualityPreset>>}
 */
export const QUALITY_PRESETS = Object.freeze({
  p480: { label: '480p・品質 50%', maxEdge: 854, quality: 0.5 },
  p720: { label: '720p・品質 60%', maxEdge: 1280, quality: 0.6 },
  p1080: { label: '1080p・品質 80%', maxEdge: 1920, quality: 0.8 },
});

/** 前の版の画質の名前。保存してあった設定を読み替える */
const LEGACY_QUALITY = Object.freeze({ low: 'p480', standard: 'p720', high: 'p1080' });

/** 更新頻度（FPS）の選択肢 */
export const FPS_OPTIONS = [5, 20];

/**
 * 色数。full=そのまま / c256=256 色相当（R 3bit・G 3bit・B 2bit）に減色 / gray=グレースケール
 * @type {Readonly<Record<string, string>>}
 */
export const COLOR_MODES = Object.freeze({ full: 'フルカラー', c256: '256 色', gray: 'グレースケール' });

/** 画像の形式を選び直す間隔（フレーム数）。色数を減らす設定で、候補を全部試して小さいものを選ぶ */
const PROBE_EVERY = 30;

/**
 * 設定（その端末にだけ保存する）。
 * @typedef {object} ShareSettings
 * @property {number} fps         1 秒あたりのフレーム数の上限
 * @property {string} quality     QUALITY_PRESETS のキー
 * @property {string} color       COLOR_MODES のキー
 */
/** @type {Readonly<ShareSettings>} */
const DEFAULT_SETTINGS = Object.freeze({ fps: 5, quality: 'p720', color: 'full' });

/** 拡大の範囲 */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;
/** ダブルタップで拡大する倍率 */
const DOUBLE_TAP_ZOOM = 2.5;

// ---- 純粋な関数（テストする） ----

/**
 * 画面の取得（getDisplayMedia）が使える環境か。Android の WebView や Linux の WebKitGTK では無いことがある。
 * @param {{ mediaDevices?: { getDisplayMedia?: unknown } } | undefined | null} nav
 */
export function canShareScreen(nav) {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * 画面を取る方法。getDisplayMedia があればそれ（web）、無ければ本体のネイティブ（native。Android）、どちらも無ければ null。
 * @param {{ mediaDevices?: { getDisplayMedia?: unknown } } | undefined | null} nav
 * @param {{ supported?: boolean } | undefined | null} native disnans.screenCapture
 * @returns {'web' | 'native' | null}
 */
export function shareBackend(nav, native) {
  if (canShareScreen(nav)) return 'web';
  return native?.supported ? 'native' : null;
}

/**
 * フレーム（base64 の文字列）を、payload に入る大きさに分ける。
 * @typedef {{ f: number; i: number; n: number; d: string }} FrameChunk f=フレーム番号 i=何番目か n=全部で何個か d=base64 の一部
 * @param {number} frameId
 * @param {string} b64
 * @param {number} [chunkChars]
 * @returns {FrameChunk[]}
 */
export function splitFrame(frameId, b64, chunkChars = CHUNK_CHARS) {
  const n = Math.max(1, Math.ceil(b64.length / chunkChars));
  /** @type {FrameChunk[]} */
  const out = [];
  for (let i = 0; i < n; i++) out.push({ f: frameId, i, n, d: b64.slice(i * chunkChars, (i + 1) * chunkChars) });
  return out;
}

/**
 * 届いた payload が分割フレームの形か調べる（外から来る値なので疑って読む）。
 * @param {unknown} p
 * @returns {FrameChunk | null}
 */
export function parseChunk(p) {
  if (typeof p !== 'object' || p === null) return null;
  const { f, i, n, d } = /** @type {Record<string, unknown>} */ (p);
  if (!Number.isInteger(f) || !Number.isInteger(i) || !Number.isInteger(n) || typeof d !== 'string') return null;
  const [fi, ii, nn] = [/** @type {number} */ (f), /** @type {number} */ (i), /** @type {number} */ (n)];
  if (nn < 1 || nn > MAX_CHUNKS || ii < 0 || ii >= nn || d.length > 64 * 1024) return null;
  return { f: fi, i: ii, n: nn, d };
}

/**
 * 1 人の送り手の分割フレームを組み立てる。欠けたフレームは捨てる:
 * - 新しいフレームの先頭が届いたら、組み立て中の古いものは捨てる
 * - 完成済み・古い番号のかけらは無視する
 */
export class FrameAssembler {
  /** 組み立て中のフレーム番号（なければ -1） */
  #current = -1;
  /** 完成して渡した最新のフレーム番号 */
  #done = -1;
  /** @type {(string | undefined)[]} */
  #parts = [];
  #count = 0;
  #total = 0;

  /**
   * かけらを 1 つ渡す。フレームが揃ったら base64 全体を返す。
   * @param {FrameChunk} c
   * @returns {string | null}
   */
  push(c) {
    if (c.f <= this.#done || c.f < this.#current) return null;
    if (c.f > this.#current || c.n !== this.#total) {
      this.#current = c.f;
      this.#total = c.n;
      this.#parts = new Array(c.n);
      this.#count = 0;
    }
    if (this.#parts[c.i] === undefined) {
      this.#parts[c.i] = c.d;
      this.#count++;
    }
    if (this.#count < this.#total) return null;
    const data = this.#parts.join('');
    this.#done = c.f;
    this.#current = -1;
    this.#parts = [];
    this.#count = 0;
    return data;
  }
}

/**
 * base64 の先頭から画像の形式を見分ける。JPEG・WebP・PNG 以外（SVG など）は null（表示しない）。
 * 送り手がどの形式で送ってきても受け手が表示できるように、形式は画像そのものから読む。
 * @param {string} b64
 * @returns {'image/jpeg' | 'image/webp' | 'image/png' | null}
 */
export function sniffImageMime(b64) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png';
  // RIFF????WEBP（base64 では 'UklGR' で始まり、9 バイト目からの 'EBP' が 12 文字目からの 'RUJQ'）
  if (b64.startsWith('UklGR') && b64.slice(12, 16) === 'RUJQ') return 'image/webp';
  return null;
}

/**
 * 長辺が maxEdge に収まるように縮小した大きさ。拡大はしない。scale は画質調整の倍率。
 * @param {number} w
 * @param {number} h
 * @param {number} maxEdge
 * @param {number} [scale]
 */
export function fitSize(w, h, maxEdge, scale = 1) {
  const r = Math.min(1, (maxEdge * scale) / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * r)), h: Math.max(1, Math.round(h * r)) };
}

/**
 * フレーム 1 枚の重さ（サーバーの流量制限と同じ単位。分割した 1 回ごとに 1、さらに payload の KB）。
 * @param {number} bytes base64 の文字数
 * @param {number} chunks 分割数
 */
export function frameWeight(bytes, chunks) {
  return chunks + bytes / 1024;
}

/**
 * 次のフレームまでの間隔（ミリ秒）。fps の上限と、直前のフレームの重さが予算に収まる間隔のうち、長いほう。
 * @param {{ fps: number; weight: number; budgetKBps: number }} o
 */
export function nextInterval({ fps, weight, budgetKBps }) {
  const byFps = 1000 / Math.max(fps, 0.1);
  const byBudget = (weight / Math.max(budgetKBps, 1)) * 1000;
  return Math.min(MAX_DELAY_MS, Math.max(byFps, byBudget));
}

/**
 * 画質（JPEG の quality と縮小の倍率 scale）を、直前のフレームの大きさに合わせて 1 段階だけ動かす。
 * 1 フレームが予算の 6 割（毎秒 0.6 秒ぶん）を超えたら、まず quality を、下限に着いたら scale を下げる。
 * 3 割を下回るなら、scale、次に quality を戻す（行ったり来たりしないように間を空けている）。
 * @param {{ quality: number; scale: number }} cur
 * @param {number} bytes 直前のフレームの base64 の文字数
 * @param {QualityPreset} preset
 * @param {number} [budgetKBps]
 * @returns {{ quality: number; scale: number }}
 */
export function tuneQuality(cur, bytes, preset, budgetKBps = SERVER_BUDGET_KBPS) {
  const limit = budgetKBps * 1024 * 0.6;
  let { quality, scale } = cur;
  if (bytes > limit) {
    if (quality > MIN_QUALITY + 1e-9) quality = Math.max(MIN_QUALITY, quality - 0.1);
    else scale = Math.max(MIN_SCALE, scale * 0.8);
  } else if (bytes < limit * 0.5) {
    if (scale < 1) scale = Math.min(1, scale * 1.15);
    else quality = Math.min(preset.quality, quality + 0.05);
  }
  return { quality: Math.round(quality * 100) / 100, scale: Math.round(scale * 1000) / 1000 };
}

/**
 * 2 枚の縮小画像（RGBA）の差。1 色あたりの絶対差の平均（0〜255）。透明度は見ない。
 * @param {ArrayLike<number> | null} a
 * @param {ArrayLike<number> | null} b
 */
export function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 === 3) continue;
    sum += Math.abs(a[i] - b[i]);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * フレームを送るか。画面が変わったときと、強制のとき、しばらく送っていないとき（あとから来た人のため）だけ送る。
 * @param {{ diff: number; sinceSentMs: number; force: boolean }} o
 */
export function shouldSend({ diff, sinceSentMs, force }) {
  return force || diff > DIFF_THRESHOLD || sinceSentMs >= KEEPALIVE_FRAME_MS;
}

/**
 * 見ている人がいるか（自分以外の参加者がいるか）。いなければフレームを作らず送らない。
 * @param {readonly { self: boolean }[]} participants
 */
export function hasAudience(participants) {
  return participants.some((p) => !p.self);
}

/**
 * 保存した設定から、使える値だけを拾う。前の版の画質の名前（low / standard / high）は読み替える。
 * @param {unknown} saved
 * @returns {ShareSettings}
 */
export function parseSettings(saved) {
  const s = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    const o = /** @type {Record<string, unknown>} */ (saved);
    if (typeof o.fps === 'number' && FPS_OPTIONS.includes(o.fps)) s.fps = o.fps;
    if (typeof o.quality === 'string') {
      const q = Object.hasOwn(LEGACY_QUALITY, o.quality) ? LEGACY_QUALITY[/** @type {keyof typeof LEGACY_QUALITY} */ (o.quality)] : o.quality;
      if (Object.hasOwn(QUALITY_PRESETS, q)) s.quality = q;
    }
    if (typeof o.color === 'string' && Object.hasOwn(COLOR_MODES, o.color)) s.color = o.color;
  }
  return s;
}

// ---- 色数と形式 ----

/** R・G は 3bit（8 段階）、B は 2bit（4 段階）の値を 0〜255 に広げる表 */
const LEVELS8 = Uint8ClampedArray.from({ length: 8 }, (_, i) => Math.round((i * 255) / 7));
const LEVELS4 = Uint8ClampedArray.from({ length: 4 }, (_, i) => Math.round((i * 255) / 3));

/**
 * 画素（RGBA）の色数を減らす。渡した配列をそのまま書き換える。
 * - c256: R 3bit・G 3bit・B 2bit の 256 色
 * - gray: 輝度だけ（R=G=B）
 * @param {Uint8ClampedArray} data
 * @param {string} mode COLOR_MODES のキー
 */
export function applyColorMode(data, mode) {
  if (mode === 'c256') {
    for (let i = 0; i + 3 < data.length; i += 4) {
      data[i] = LEVELS8[data[i] >> 5];
      data[i + 1] = LEVELS8[data[i + 1] >> 5];
      data[i + 2] = LEVELS4[data[i + 2] >> 6];
    }
  } else if (mode === 'gray') {
    for (let i = 0; i + 3 < data.length; i += 4) {
      const y = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      data[i] = data[i + 1] = data[i + 2] = y;
    }
  }
}

/**
 * 色数の設定で試す画像の形式（小さいものが選ばれる）。
 * フルカラーは JPEG だけ。減色した画像は JPEG だと色がにじんで効果が薄いので、WebP・PNG（べた塗りが多い画面なら PNG が小さい）も試す。
 * @param {string} mode
 * @returns {string[]}
 */
export function candidateFormats(mode) {
  if (mode === 'c256') return ['image/png', 'image/webp'];
  if (mode === 'gray') return ['image/jpeg', 'image/webp', 'image/png'];
  return ['image/jpeg'];
}

/**
 * 形式ごとのサイズから、いちばん小さい形式を選ぶ（同じなら先に挙げたほう）。
 * @param {Readonly<Record<string, number>>} sizes
 * @returns {string | null}
 */
export function pickSmallest(sizes) {
  /** @type {string | null} */
  let best = null;
  for (const [mime, n] of Object.entries(sizes)) if (best === null || n < sizes[best]) best = mime;
  return best;
}

/**
 * 1 フレームのサイズと、動き続けたときの帯域の見積もり。
 * @param {number} b64Length 符号化した画像の base64 の文字数
 * @param {number} fps
 * @param {number} [budgetKBps]
 * @returns {{ imageBytes: number; bytesPerSec: number; capped: boolean }}
 */
export function estimateBandwidth(b64Length, fps, budgetKBps = SERVER_BUDGET_KBPS) {
  const imageBytes = Math.floor((b64Length * 3) / 4);
  // 実際に流れるのは base64（JSON）の長さ。サーバーの予算を超える分は、間隔が空く
  const raw = b64Length * fps;
  const cap = budgetKBps * 1024;
  return { imageBytes, bytesPerSec: Math.min(raw, cap), capped: raw > cap };
}

/**
 * バイト数を読みやすくする（KB / MB）。
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---- 拡大縮小・パン（見る側） ----

/**
 * 表示の変換。scale=倍率、x・y=中心からのずれ（ピクセル）。
 * @typedef {{ scale: number; x: number; y: number }} ViewState
 */

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 画像が舞台からはみ出さない範囲にパンを収める（小さければ中央）。
 * @param {ViewState} v
 * @param {{ w: number; h: number }} stage 舞台の大きさ
 * @param {{ w: number; h: number }} img 倍率 1 のときの画像の表示の大きさ
 * @returns {ViewState}
 */
export function clampView(v, stage, img) {
  const scale = clamp(v.scale, MIN_ZOOM, MAX_ZOOM);
  const maxX = Math.max(0, (img.w * scale - stage.w) / 2);
  const maxY = Math.max(0, (img.h * scale - stage.h) / 2);
  return { scale, x: clamp(v.x, -maxX, maxX), y: clamp(v.y, -maxY, maxY) };
}

/**
 * 点 (px, py)（舞台の中心からの位置）が動かないように、倍率を変える。
 * @param {ViewState} v
 * @param {number} newScale
 * @param {number} px
 * @param {number} py
 * @returns {ViewState}
 */
export function zoomAt(v, newScale, px, py) {
  const scale = clamp(newScale, MIN_ZOOM, MAX_ZOOM);
  const k = scale / v.scale;
  return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

/**
 * ピンチ（と 1 本指のパン）。始めたときの表示 v0・2 本の指の中点 m0・間隔 d0 と、いまの中点 m1・間隔 d1 から表示を求める。
 * 始めに指の下にあった点が、いまの中点の下に来るようにする。1 本指のパンは d0 = d1 で呼ぶ。
 * @param {ViewState} v0
 * @param {{ x: number; y: number }} m0
 * @param {number} d0
 * @param {{ x: number; y: number }} m1
 * @param {number} d1
 * @returns {ViewState}
 */
export function pinchView(v0, m0, d0, m1, d1) {
  const scale = clamp(v0.scale * (d0 > 0 ? d1 / d0 : 1), MIN_ZOOM, MAX_ZOOM);
  const cx = (m0.x - v0.x) / v0.scale;
  const cy = (m0.y - v0.y) / v0.scale;
  return { scale, x: m1.x - cx * scale, y: m1.y - cy * scale };
}

/**
 * ダブルタップか（前のタップから短い時間で、近い場所）。
 * @param {{ t: number; x: number; y: number } | null} prev
 * @param {{ t: number; x: number; y: number }} cur
 */
export function isDoubleTap(prev, cur) {
  return prev !== null && cur.t - prev.t < 320 && Math.hypot(cur.x - prev.x, cur.y - prev.y) < 36;
}

/**
 * デスクトップの PiP（canvas の captureStream を <video> で requestPictureInPicture）が使えるか。
 * @param {{ pictureInPictureEnabled?: boolean } | undefined | null} doc
 * @param {{ requestPictureInPicture?: unknown } | undefined | null} videoProto
 * @param {{ captureStream?: unknown } | undefined | null} canvasProto
 */
export function canWebPip(doc, videoProto, canvasProto) {
  return doc?.pictureInPictureEnabled === true && typeof videoProto?.requestPictureInPicture === 'function' && typeof canvasProto?.captureStream === 'function';
}

// ---- 符号化（DOM を使う。送る側とプレビューで共通） ----

/**
 * source（video / canvas / img）を w×h に縮小して canvas に描き、色数を減らし、画像にする。
 * @param {HTMLCanvasElement} cv 作業用（大きさは w×h になる）
 * @param {CanvasImageSource} source
 * @param {number} w
 * @param {number} h
 * @param {{ color: string; quality: number; format: string | null }} o format=null なら候補をすべて試して小さいものにする
 * @returns {{ b64: string; mime: string; sizes: Record<string, number> }}
 */
export function encodeFrame(cv, source, w, h, o) {
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', o.color === 'full' ? undefined : { willReadFrequently: true });
  if (!ctx) throw new Error('canvas を使えません');
  ctx.drawImage(source, 0, 0, w, h);
  if (o.color !== 'full') {
    const img = ctx.getImageData(0, 0, w, h);
    applyColorMode(img.data, o.color);
    ctx.putImageData(img, 0, 0);
  }
  /** @type {Record<string, number>} */
  const sizes = {};
  /** @type {Record<string, string>} */
  const images = {};
  for (const want of o.format ? [o.format] : candidateFormats(o.color)) {
    const url = cv.toDataURL(want, o.quality);
    const b64 = url.slice(url.indexOf(',') + 1);
    // 作れない形式は PNG などに替わって返ってくる。実際の形式で数える
    const mime = sniffImageMime(b64) ?? want;
    if (!(mime in sizes)) {
      sizes[mime] = b64.length;
      images[mime] = b64;
    }
  }
  const mime = pickSmallest(sizes) ?? 'image/jpeg';
  return { b64: images[mime] ?? '', mime, sizes };
}

/**
 * プレビュー用のサンプルの画面を描く（文字・図・写真のような部分が混ざった、よくある画面のつもり）。決まった絵になる。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 */
export function drawSample(ctx, w, h) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const u = h / 720;
  ctx.fillStyle = '#eef1f6';
  ctx.fillRect(0, 0, w, h);
  // 上のバーと左のサイドバー
  ctx.fillStyle = '#2f5d9e';
  ctx.fillRect(0, 0, w, 48 * u);
  ctx.fillStyle = '#ffffff';
  ctx.font = `${20 * u}px sans-serif`;
  ctx.fillText('disnans  画面共有のサンプル', 20 * u, 31 * u);
  ctx.fillStyle = '#dfe5ef';
  ctx.fillRect(0, 48 * u, 220 * u, h);
  for (let i = 0; i < 12; i++) {
    ctx.fillStyle = i === 2 ? '#2f5d9e' : '#9aa7bd';
    ctx.fillRect(20 * u, (80 + i * 44) * u, (110 + rnd() * 70) * u, 12 * u);
  }
  // 本文（文字のような細い線）
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = '#31384a';
    let x = 250 * u;
    const y = (92 + i * 22) * u;
    while (x < 640 * u) {
      const len = (14 + rnd() * 54) * u;
      ctx.fillRect(x, y, len, 6 * u);
      x += len + 8 * u;
    }
  }
  // 写真のような部分（なだらかな色の変化と細かいノイズ）
  const px = 680 * u;
  const py = 80 * u;
  const pw = 520 * u;
  const ph = 300 * u;
  const g = ctx.createLinearGradient(px, py, px + pw, py + ph);
  g.addColorStop(0, '#1d3b6e');
  g.addColorStop(0.5, '#e08a3c');
  g.addColorStop(1, '#3d8f5a');
  ctx.fillStyle = g;
  ctx.fillRect(px, py, pw, ph);
  for (let i = 0; i < 700; i++) {
    ctx.fillStyle = `rgba(${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)},${Math.floor(rnd() * 255)},0.35)`;
    const r = (2 + rnd() * 9) * u;
    ctx.fillRect(px + rnd() * (pw - r), py + rnd() * (ph - r), r, r);
  }
  // コードのような色つきの行
  ctx.fillStyle = '#1b1f2a';
  ctx.fillRect(250 * u, 420 * u, 950 * u, 260 * u);
  const colors = ['#e06c75', '#98c379', '#61afef', '#d19a66', '#c8ccd4'];
  for (let i = 0; i < 10; i++) {
    let x = 270 * u;
    const y = (440 + i * 24) * u;
    for (let k = 0; k < 6; k++) {
      ctx.fillStyle = colors[Math.floor(rnd() * colors.length)];
      const len = (30 + rnd() * 90) * u;
      ctx.fillRect(x, y, len, 8 * u);
      x += len + 10 * u;
    }
  }
}

// ---- 受け取る側 ----

/**
 * 共有している人 1 人分。
 * @typedef {object} Sharer
 * @property {string} peer
 * @property {Disnans.User} user
 * @property {FrameAssembler} assembler
 * @property {string | null} frame    最新のフレーム（base64）
 * @property {string | null} mime     frame の形式
 * @property {number} lastSeen        最後になにか届いた時刻（ミリ秒）
 */

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export default class ScreenSharePlugin extends Plugin {
  /** @type {ShareSettings} */
  settings = { ...DEFAULT_SETTINGS };
  /** @type {Disnans.Call} */
  call = /** @type {Disnans.Call} */ (/** @type {unknown} */ (null));

  // 共有する側
  sharing = false;
  /** 画面の取り方（共有中だけ） */
  /** @type {'web' | 'native' | null} */
  backend = null;
  /** @type {MediaStream | null} */
  stream = null;
  /** @type {HTMLVideoElement | null} */
  video = null;
  /** @type {HTMLCanvasElement | null} */
  canvas = null;
  /** @type {HTMLCanvasElement | null} */
  diffCanvas = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  timer = null;
  frameId = 0;
  lastHeartbeat = 0;
  lastSentAt = 0;
  /** @type {Uint8ClampedArray | null} */
  lastDiffData = null;
  /** 見ている人の顔ぶれ（変わったら画面が同じでも送る） */
  audienceKey = '';
  tuned = { quality: 0.6, scale: 1 };
  /** 画像の形式（null なら次のフレームで候補を試して決める） */
  format = /** @type {string | null} */ (null);
  framesSinceProbe = 0;
  /** 共有を始める操作の途中（getDisplayMedia / ネイティブの許可待ち）の二重実行を防ぐ */
  starting = false;
  /** ネイティブの取得で、まだ送っていない最新のフレームと、その送信の予約 */
  /** @type {Disnans.ScreenCaptureFrame | null} */
  pendingNative = null;
  /** @type {Disnans.ScreenCaptureFrame | null} */
  lastNative = null;
  nativeNextAt = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  nativeTimer = null;

  // 見る側
  /** @type {Map<string, Sharer>} */
  sharers = new Map();
  /** 閲覧表示で選んでいる共有者（なければ閉じている） */
  viewing = /** @type {string | null} */ (null);
  /** @type {HTMLElement | null} */
  overlay = null;
  /** 拡大縮小の状態 */
  view = /** @type {ViewState} */ ({ scale: 1, x: 0, y: 0 });
  /** 全画面の方法（なければ null）。immersive=Android の没入モード、dom=Fullscreen API */
  fullscreen = /** @type {'immersive' | 'dom' | null} */ (null);
  /** @type {(() => void) | null} */
  offBackViewer = null;
  /** @type {(() => void) | null} */
  offBackFullscreen = null;
  /** Android の PiP の間 */
  nativePip = false;
  /** デスクトップの PiP（canvas の captureStream を映した <video>） */
  /** @type {{ peer: string; canvas: HTMLCanvasElement; video: HTMLVideoElement } | null} */
  webPip = null;
  /** @type {HTMLElement} */
  statusEl = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
  /** @type {Disnans.CallButton | null} */
  button = null;

  // 設定のプレビュー
  /** @type {HTMLCanvasElement | null} */
  previewSource = null;
  previewCustom = false;
  previewSeq = 0;

  async onload() {
    this.call = disnans.call;
    this.settings = parseSettings(await this.loadData());
    this.resetTuning();

    // 共有ボタン。取得できない環境では出さない（見るだけ）
    if (shareBackend(navigator, disnans.screenCapture)) {
      this.button = this.call.addButton({
        icon: 'monitor-up',
        label: '画面を共有',
        onClick: () => void this.toggleShare(),
      });
      this.register(() => this.button?.remove());
    }

    this.statusEl = this.addStatusBarItem();
    this.statusEl.classList.add('screenshare-status');

    this.register(this.call.onChange(() => this.onCallChange()));
    this.register(this.call.onEvent(EVENT_STATE, (e) => this.onState(e)));
    this.register(this.call.onEvent(EVENT_FRAME, (e) => this.onFrame(e)));

    // 共有中の知らせと、消えた共有者の見張り
    this.registerInterval(window.setInterval(() => this.watch(), WATCH_MS));
    this.registerDomEvent(document, 'keydown', (ev) => {
      if (ev.key === 'Escape' && this.viewing !== null) this.closeViewer();
    });
    // Fullscreen API で全画面にしているとき、Esc や F11 で解除されたら表示も合わせる
    this.registerDomEvent(document, 'fullscreenchange', () => {
      if (this.fullscreen === 'dom' && !document.fullscreenElement) this.setFullscreenState(null);
    });
    // Android の PiP（小窓）に入った・戻った
    if (disnans.pip?.supported) {
      this.register(disnans.pip.onChange((active) => this.onNativePip(active)));
    }
    // 外すときは共有を止め、表示を片付ける（相手には止まったことを知らせる）
    this.register(() => {
      this.stopShare(true);
      this.closeViewer();
      this.stopWebPip();
    });

    this.addSettingTab({ display: (el) => this.displaySettings(el) });
    this.renderStatus();
  }

  onunload() {
    // register で登録したものは自動で片付く
  }

  // ---- 共有する側 ----

  resetTuning() {
    this.tuned = { quality: QUALITY_PRESETS[this.settings.quality].quality, scale: 1 };
    this.format = null;
    this.framesSinceProbe = 0;
  }

  async toggleShare() {
    if (this.sharing) this.stopShare(true);
    else await this.startShare();
  }

  async startShare() {
    if (this.sharing || this.starting) return;
    const backend = shareBackend(navigator, disnans.screenCapture);
    if (!backend) {
      ui.toast('この環境では画面を共有できません（見ることはできます）', 'error');
      return;
    }
    if (!this.call.joined) {
      ui.toast('通話に参加していません', 'error');
      return;
    }
    this.starting = true;
    try {
      if (backend === 'web') await this.startWeb();
      else await this.startNative();
    } finally {
      this.starting = false;
    }
  }

  /** getDisplayMedia で画面を選んで始める */
  async startWeb() {
    /** @type {MediaStream} */
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: this.settings.fps, max: 30 } },
        audio: false,
      });
    } catch (e) {
      // 選択画面でキャンセルしたとき（NotAllowedError）は知らせなくてよい
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) ui.toast('画面を取得できませんでした', 'error');
      return;
    }
    // 許可待ちのあいだに通話を抜けた・プラグインが外れた場合は使わない
    if (!this.call.joined) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    void Promise.resolve(video.play()).catch(() => {});
    this.stream = stream;
    this.video = video;
    this.backend = 'web';
    this.beginSharing();
    // OS の「共有を停止」ボタンなどで止められたとき
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => this.stopShare(true));
    this.timer = setTimeout(() => this.frameTick(), 0);
  }

  /** 本体のネイティブ（Android の MediaProjection）で始める。許可のダイアログが出る */
  async startNative() {
    const preset = QUALITY_PRESETS[this.settings.quality];
    try {
      await disnans.screenCapture.start(
        {
          maxEdge: preset.maxEdge,
          quality: this.tuned.quality,
          fps: this.settings.fps,
          format: 'jpeg',
          color: /** @type {'full' | 'c256' | 'gray'} */ (this.settings.color),
          diffThreshold: DIFF_THRESHOLD,
          keepaliveMs: KEEPALIVE_FRAME_MS,
          onEnd: () => this.stopShare(true),
        },
        (f) => this.onNativeFrame(f),
      );
    } catch (e) {
      // 許可のダイアログで断られたときも、ここに来る
      const msg = e instanceof Error ? e.message : String(e);
      if (!/cancel|denied|拒否|キャンセル/i.test(msg)) ui.toast('画面を取得できませんでした', 'error');
      return;
    }
    if (!this.call.joined) {
      void disnans.screenCapture.stop();
      return;
    }
    this.backend = 'native';
    this.beginSharing();
  }

  /** 共有の開始の共通の処理 */
  beginSharing() {
    this.sharing = true;
    this.lastDiffData = null;
    this.lastSentAt = 0;
    this.audienceKey = '';
    this.lastNative = null;
    this.pendingNative = null;
    this.nativeNextAt = 0;
    this.resetTuning();
    this.button?.update({ label: '共有を止める', icon: 'monitor-off', active: true });
    this.sendState(true);
    this.renderStatus();
  }

  /**
   * 共有を止める。
   * @param {boolean} notify 相手に止まったことを知らせる（通話から抜けたあとは送れないので false）
   */
  stopShare(notify) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.nativeTimer !== null) clearTimeout(this.nativeTimer);
    this.nativeTimer = null;
    this.pendingNative = null;
    this.lastNative = null;
    const was = this.sharing;
    const backend = this.backend;
    this.sharing = false;
    this.backend = null;
    if (backend === 'native') void disnans.screenCapture.stop().catch(() => {});
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.canvas = null;
    this.diffCanvas = null;
    this.lastDiffData = null;
    if (!was) return;
    this.button?.update({ label: '画面を共有', icon: 'monitor-up', active: false });
    if (notify && this.call.joined) this.sendState(false);
    this.renderStatus();
  }

  /** @param {boolean} on */
  sendState(on) {
    try {
      this.call.emit(EVENT_STATE, { on });
      this.lastHeartbeat = Date.now();
    } catch {
      // 通話から抜けた直後など。次の onChange で片付く
    }
  }

  /** 1 フレームぶんの処理。次の呼び出しを自分で予約する */
  frameTick() {
    this.timer = null;
    if (!this.sharing) return;
    const t0 = performance.now();
    /** @type {number} */
    let delay;
    try {
      if (!this.call.joined) {
        this.stopShare(false);
        return;
      }
      delay = hasAudience(this.call.participants) ? this.captureAndSend() : IDLE_MS;
    } catch (e) {
      console.error('[screenshare] フレームの送信に失敗', e);
      this.stopShare(false);
      ui.toast('画面共有を止めました', 'error');
      return;
    }
    this.timer = setTimeout(() => this.frameTick(), Math.max(0, delay - (performance.now() - t0)));
  }

  /**
   * 画面を縮小して送る。
   * @returns {number} 次のフレームまでの間隔（ミリ秒）
   */
  captureAndSend() {
    const video = this.video;
    if (!video || !video.videoWidth) return VIDEO_WAIT_MS;
    const preset = QUALITY_PRESETS[this.settings.quality];
    const minInterval = 1000 / this.settings.fps;

    // 変化の判定は、とても小さい画像どうしで比べる
    const dc = this.diffCanvas ?? (this.diffCanvas = document.createElement('canvas'));
    dc.width = DIFF_W;
    dc.height = DIFF_H;
    const dctx = dc.getContext('2d', { willReadFrequently: true });
    if (!dctx) throw new Error('canvas を使えません');
    dctx.drawImage(video, 0, 0, DIFF_W, DIFF_H);
    const data = dctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
    const key = this.call.participants.map((p) => p.peer).join(',');
    const now = Date.now();
    const force = key !== this.audienceKey;
    if (!shouldSend({ diff: frameDiff(this.lastDiffData, data), sinceSentMs: now - this.lastSentAt, force })) return minInterval;
    this.lastDiffData = data;
    this.audienceKey = key;

    const size = fitSize(video.videoWidth, video.videoHeight, preset.maxEdge, this.tuned.scale);
    const cv = this.canvas ?? (this.canvas = document.createElement('canvas'));
    // 色数を減らす設定では、ときどき候補の形式を全部試して小さいものを選び直す
    const probe = this.format === null || this.framesSinceProbe >= PROBE_EVERY;
    const out = encodeFrame(cv, video, size.w, size.h, {
      color: this.settings.color,
      quality: this.tuned.quality,
      format: probe ? null : this.format,
    });
    if (probe) this.framesSinceProbe = 0;
    this.framesSinceProbe++;
    this.format = out.mime;

    const chunks = this.emitFrame(out.b64);
    this.lastSentAt = now;

    this.tuned = tuneQuality(this.tuned, out.b64.length, preset);
    return nextInterval({
      fps: this.settings.fps,
      weight: frameWeight(out.b64.length, chunks),
      budgetKBps: SERVER_BUDGET_KBPS,
    });
  }

  /**
   * 符号化したフレームを分割して送る。
   * @param {string} b64
   * @returns {number} 分割数
   */
  emitFrame(b64) {
    const chunks = splitFrame(this.frameId++, b64);
    for (const c of chunks) this.call.emit(EVENT_FRAME, c);
    if (Date.now() - this.lastHeartbeat >= HEARTBEAT_MS) this.sendState(true);
    return chunks.length;
  }

  // ---- 共有する側（ネイティブの取得） ----

  /**
   * ネイティブから届いたフレーム（変化があったときと、一定時間ごとのもの）。予算に収まる間隔で送る。
   * 送れない間に新しいのが来たら、古いほうは捨てる。
   * @param {Disnans.ScreenCaptureFrame} f
   */
  onNativeFrame(f) {
    if (!this.sharing || this.backend !== 'native') return;
    this.lastNative = f;
    this.pendingNative = f;
    this.flushNative();
  }

  flushNative() {
    if (this.nativeTimer !== null || !this.pendingNative) return;
    const wait = this.nativeNextAt - Date.now();
    if (wait > 0) {
      this.nativeTimer = setTimeout(() => {
        this.nativeTimer = null;
        this.flushNative();
      }, wait);
      return;
    }
    const f = this.pendingNative;
    this.pendingNative = null;
    if (!this.call.joined) {
      this.stopShare(false);
      return;
    }
    if (!hasAudience(this.call.participants)) return;
    try {
      const chunks = this.emitFrame(f.data);
      this.lastSentAt = Date.now();
      this.audienceKey = this.call.participants.map((p) => p.peer).join(',');
      const preset = QUALITY_PRESETS[this.settings.quality];
      const interval = nextInterval({
        fps: this.settings.fps,
        weight: frameWeight(f.data.length, chunks),
        budgetKBps: SERVER_BUDGET_KBPS,
      });
      this.nativeNextAt = Date.now() + interval;
      const t = tuneQuality(this.tuned, f.data.length, preset);
      if (t.quality !== this.tuned.quality || t.scale !== this.tuned.scale) {
        this.tuned = t;
        void disnans.screenCapture.update({ quality: t.quality, scale: t.scale }).catch(() => {});
      }
    } catch (e) {
      console.error('[screenshare] フレームの送信に失敗', e);
      this.stopShare(false);
      ui.toast('画面共有を止めました', 'error');
    }
  }

  // ---- 受け取る側 ----

  /**
   * 共有者の記録を得る（いなければ、通話にいる人なら作る）。
   * @param {string} peer
   * @param {Disnans.User} user
   */
  sharerFor(peer, user) {
    let s = this.sharers.get(peer);
    if (!s) {
      s = { peer, user, assembler: new FrameAssembler(), frame: null, mime: null, lastSeen: Date.now() };
      this.sharers.set(peer, s);
      this.renderStatus();
    }
    s.lastSeen = Date.now();
    return s;
  }

  /** @param {Disnans.CallDataEvent} e */
  onState(e) {
    const on = typeof e.payload === 'object' && e.payload !== null && /** @type {{ on?: unknown }} */ (e.payload).on === true;
    if (on) {
      this.sharerFor(e.peer, e.user);
    } else {
      this.removeSharer(e.peer);
    }
  }

  /** @param {Disnans.CallDataEvent} e */
  onFrame(e) {
    const c = parseChunk(e.payload);
    if (!c) return;
    const s = this.sharerFor(e.peer, e.user);
    const data = s.assembler.push(c);
    if (data === null || !BASE64_RE.test(data)) return;
    // 画像の形式を見分けられないもの（SVG など）は表示しない
    const mime = sniffImageMime(data);
    if (!mime) return;
    s.frame = data;
    s.mime = mime;
    if (this.viewing === e.peer) this.showFrame();
    if (this.webPip?.peer === e.peer) this.drawWebPip(s);
  }

  /** @param {string} peer */
  removeSharer(peer) {
    if (!this.sharers.delete(peer)) return;
    if (this.webPip?.peer === peer) this.stopWebPip();
    if (this.viewing === peer) {
      // ほかに共有者がいればそちらへ、いなければ閉じる
      const next = this.sharers.keys().next();
      if (next.done) this.closeViewer();
      else this.selectSharer(next.value);
    }
    this.renderStatus();
  }

  /** 通話の状態が変わったとき */
  onCallChange() {
    if (!this.call.joined) {
      // 通話から抜けた: 共有を止め、見ていたものも消す
      this.stopShare(false);
      this.closeViewer();
      this.stopWebPip();
      if (this.sharers.size > 0) {
        this.sharers.clear();
        this.renderStatus();
      }
      return;
    }
    const peers = new Set(this.call.participants.map((p) => p.peer));
    for (const peer of [...this.sharers.keys()]) if (!peers.has(peer)) this.removeSharer(peer);
  }

  /** 毎秒: 共有の知らせを送り直し、音沙汰のない共有者を消す */
  watch() {
    const now = Date.now();
    for (const [peer, s] of [...this.sharers]) if (now - s.lastSeen > SHARER_TIMEOUT_MS) this.removeSharer(peer);
    if (this.sharing && this.call.joined && now - this.lastHeartbeat >= HEARTBEAT_MS) this.sendState(true);
    // ネイティブの取得は画面が変わらないと届かないので、見る人が増えたら最後のフレームを送り直す
    if (this.sharing && this.backend === 'native' && this.call.joined && this.lastNative) {
      const key = this.call.participants.map((p) => p.peer).join(',');
      if (key !== this.audienceKey && hasAudience(this.call.participants)) {
        this.audienceKey = key;
        this.pendingNative = this.lastNative;
        this.nativeNextAt = 0;
        this.flushNative();
      }
    }
  }

  // ---- 表示 ----

  /** ステータス欄: 誰かが共有中なら見るボタン */
  renderStatus() {
    const el = this.statusEl;
    if (!el) return;
    el.replaceChildren();
    for (const s of this.sharers.values()) {
      el.append(
        ui.button({
          text: `${s.user.display_name} の画面を見る`,
          icon: 'monitor-play',
          variant: 'ghost',
          onClick: () => this.openViewer(s.peer),
        }),
      );
    }
  }

  /** @param {string} peer */
  openViewer(peer) {
    if (!this.sharers.has(peer)) return;
    if (!this.overlay) {
      const overlay = document.createElement('div');
      overlay.className = 'screenshare-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-label', '画面共有');
      document.body.append(overlay);
      this.overlay = overlay;
      // 戻る操作（Android の戻るジェスチャーなど）で閉じる
      this.offBackViewer = ui.onBack(() => this.closeViewer());
    }
    this.selectSharer(peer);
  }

  /** @param {string} peer */
  selectSharer(peer) {
    this.viewing = peer;
    this.view = { scale: 1, x: 0, y: 0 };
    this.renderViewer();
  }

  closeViewer() {
    this.viewing = null;
    this.exitFullscreen();
    this.offBackViewer?.();
    this.offBackViewer = null;
    this.nativePip = false;
    this.overlay?.remove();
    this.overlay = null;
  }

  /** 閲覧表示を作り直す（共有者の増減・切り替えのとき） */
  renderViewer() {
    const overlay = this.overlay;
    if (!overlay || this.viewing === null) return;

    const tabs = document.createElement('div');
    tabs.className = 'screenshare-tabs';
    for (const s of this.sharers.values()) {
      const b = ui.button({ text: s.user.display_name, icon: 'monitor-play', variant: 'ghost', onClick: () => this.selectSharer(s.peer) });
      b.classList.add('screenshare-tab');
      if (s.peer === this.viewing) b.classList.add('screenshare-tab-selected');
      tabs.append(b);
    }
    const bar = document.createElement('div');
    bar.className = 'screenshare-bar';
    bar.append(tabs);
    if (this.canPip()) {
      bar.append(ui.button({ icon: 'picture-in-picture-2', label: 'PiP（小窓）で見る', variant: 'ghost', onClick: () => void this.togglePip() }));
    }
    bar.append(
      ui.button({ icon: 'expand', label: '全画面', variant: 'ghost', onClick: () => void this.toggleFullscreen() }),
      ui.button({ icon: 'x', label: '閉じる', variant: 'ghost', onClick: () => this.closeViewer() }),
    );

    // 全画面のあいだはバーを隠し、解除するボタンだけを浮かべる
    const exit = ui.button({ icon: 'shrink', label: '全画面を解除', variant: 'ghost', onClick: () => this.exitFullscreen() });
    exit.classList.add('screenshare-float');

    const stage = document.createElement('div');
    stage.className = 'screenshare-stage';
    this.attachGestures(stage);
    overlay.replaceChildren(bar, stage, exit);
    overlay.classList.toggle('screenshare-fullscreen', this.fullscreen !== null);
    overlay.classList.toggle('screenshare-pip', this.nativePip);
    this.showFrame();
  }

  /** 見ている共有者の最新のフレームを出す */
  showFrame() {
    const stage = this.overlay?.querySelector('.screenshare-stage');
    const s = this.viewing === null ? undefined : this.sharers.get(this.viewing);
    if (!stage || !s) return;
    if (!s.frame) {
      if (!stage.querySelector('.screenshare-wait')) {
        const p = document.createElement('p');
        p.className = 'screenshare-wait';
        p.textContent = `${s.user.display_name} の画面を待っています…`;
        stage.replaceChildren(p);
      }
      return;
    }
    let img = stage.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.className = 'screenshare-img';
      img.alt = `${s.user.display_name} の共有画面`;
      img.draggable = false;
      // 最初のフレームで大きさが決まったら、拡大の範囲を合わせる
      img.addEventListener('load', () => this.applyView());
      stage.replaceChildren(img);
    }
    img.src = `data:${s.mime ?? 'image/jpeg'};base64,${s.frame}`;
    this.applyView();
  }

  // ---- 拡大縮小・パン ----

  /** 舞台と画像の大きさ（倍率 1 のとき）。DOM から読む */
  measure() {
    const stage = this.overlay?.querySelector('.screenshare-stage');
    const img = stage?.querySelector('img');
    if (!stage || !img) return null;
    return { stage: { w: stage.clientWidth, h: stage.clientHeight }, img: { w: img.offsetWidth, h: img.offsetHeight } };
  }

  /** 拡大の状態を画像に反映する（はみ出さないように収める） */
  applyView() {
    const img = this.overlay?.querySelector('.screenshare-stage img');
    if (!(img instanceof HTMLImageElement)) return;
    const m = this.measure();
    if (m && m.stage.w > 0) this.view = clampView(this.view, m.stage, m.img);
    img.style.transform = this.view.scale === 1 ? '' : `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.scale})`;
  }

  /**
   * ピンチ・ドラッグ・ホイール・ダブルタップで拡大縮小とパンをする（Pointer Events。マウスもタッチも同じ）。
   * @param {HTMLElement} stage
   */
  attachGestures(stage) {
    /** @type {Map<number, { x: number; y: number }>} */
    const pointers = new Map();
    /** ジェスチャーを始めたときの表示と、指の中点・間隔 */
    let start = { view: this.view, mid: { x: 0, y: 0 }, dist: 1 };
    /** @type {{ t: number; x: number; y: number } | null} */
    let lastTap = null;
    let moved = false;

    /** 舞台の中心を原点にした位置 */
    const local = (/** @type {{ clientX: number; clientY: number }} */ e) => {
      const r = stage.getBoundingClientRect();
      return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
    };
    const pts = () => [...pointers.values()];
    const geometry = () => {
      const p = pts();
      if (p.length >= 2) {
        return { mid: { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 }, dist: Math.max(1, Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)) };
      }
      return { mid: p[0] ?? { x: 0, y: 0 }, dist: 1 };
    };
    const restart = () => {
      const g = geometry();
      start = { view: this.view, mid: g.mid, dist: g.dist };
    };

    stage.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, local(e));
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // 取れなくても動く
      }
      if (pointers.size === 1) moved = false;
      restart();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e));
      const g = geometry();
      if (Math.hypot(g.mid.x - start.mid.x, g.mid.y - start.mid.y) > 6 || pointers.size > 1) moved = true;
      this.view = pinchView(start.view, start.mid, start.dist, g.mid, g.dist);
      this.applyView();
    });
    const end = (/** @type {PointerEvent} */ e) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size > 0) {
        restart();
        return;
      }
      if (e.type === 'pointerup' && !moved) {
        const tap = { t: Date.now(), ...local(e) };
        if (isDoubleTap(lastTap, tap)) {
          // 拡大していれば元に戻し、していなければタップした点を拡大する
          this.view = this.view.scale > 1 ? { scale: 1, x: 0, y: 0 } : zoomAt(this.view, DOUBLE_TAP_ZOOM, tap.x, tap.y);
          this.applyView();
          lastTap = null;
        } else {
          lastTap = tap;
        }
      }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = local(e);
        this.view = zoomAt(this.view, this.view.scale * Math.exp(-e.deltaY * 0.0015), p.x, p.y);
        this.applyView();
      },
      { passive: false },
    );
  }

  // ---- 全画面 ----

  /** 全画面の状態を表示に反映する */
  /** @param {'immersive' | 'dom' | null} mode */
  setFullscreenState(mode) {
    this.fullscreen = mode;
    this.overlay?.classList.toggle('screenshare-fullscreen', mode !== null);
    // 戻る操作で、まず全画面を解除する（閲覧そのものを閉じる層より上）
    if (mode !== null && !this.offBackFullscreen) {
      this.offBackFullscreen = ui.onBack(() => this.exitFullscreen());
    } else if (mode === null) {
      this.offBackFullscreen?.();
      this.offBackFullscreen = null;
    }
    // 画面の大きさが変わるので、拡大の範囲を合わせ直す
    setTimeout(() => this.applyView(), 50);
  }

  async toggleFullscreen() {
    if (this.fullscreen !== null) {
      this.exitFullscreen();
      return;
    }
    const overlay = this.overlay;
    if (!overlay) return;
    // Android の WebView には Fullscreen API が無いので、本体のネイティブ（没入モード）を使う
    if (await ui.setImmersive(true)) {
      this.setFullscreenState('immersive');
      return;
    }
    try {
      await overlay.requestFullscreen();
      this.setFullscreenState('dom');
    } catch {
      ui.toast('この環境では全画面にできません', 'error');
    }
  }

  exitFullscreen() {
    const mode = this.fullscreen;
    if (mode === null) return;
    this.setFullscreenState(null);
    if (mode === 'immersive') void ui.setImmersive(false);
    else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }

  // ---- PiP ----

  /** PiP のボタンを出すか（Android のネイティブか、デスクトップの Chromium） */
  canPip() {
    if (disnans.pip?.supported) return true;
    return canWebPip(document, HTMLVideoElement.prototype, HTMLCanvasElement.prototype);
  }

  async togglePip() {
    if (this.viewing === null) return;
    if (disnans.pip?.supported) {
      const ok = await disnans.pip.enter({ aspect: { width: 16, height: 9 } }).catch(() => false);
      if (!ok) ui.toast('PiP にできませんでした', 'error');
      return;
    }
    if (this.webPip) {
      this.stopWebPip();
      return;
    }
    await this.startWebPip(this.viewing);
  }

  /** @param {boolean} active */
  onNativePip(active) {
    this.nativePip = active;
    this.overlay?.classList.toggle('screenshare-pip', active);
    if (active) {
      // 小窓では全画面の状態を解く（没入モードのままだと戻ったときに混乱する）
      this.exitFullscreen();
      this.view = { scale: 1, x: 0, y: 0 };
    }
    setTimeout(() => this.applyView(), 100);
  }

  /**
   * デスクトップの PiP: 受け取った画像を canvas に描き、その captureStream を映した <video> を PiP にする。
   * @param {string} peer
   */
  async startWebPip(peer) {
    const s = this.sharers.get(peer);
    if (!s?.frame) {
      ui.toast('画面が届いてから PiP にしてください', 'error');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 9;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.append(video);
    this.webPip = { peer, canvas, video };
    try {
      await this.drawWebPip(s);
      video.srcObject = canvas.captureStream(15);
      await video.play();
      video.addEventListener('leavepictureinpicture', () => {
        if (this.webPip?.video === video) this.stopWebPip();
      });
      await video.requestPictureInPicture();
    } catch (e) {
      console.warn('[screenshare] PiP にできません', e);
      this.stopWebPip();
      ui.toast('PiP にできませんでした', 'error');
    }
  }

  /**
   * PiP の canvas にフレームを描く。
   * @param {Sharer} s
   */
  drawWebPip(s) {
    const pip = this.webPip;
    if (!pip || !s.frame) return Promise.resolve();
    const { canvas } = pip;
    const img = new Image();
    return new Promise((resolve) => {
      img.onload = () => {
        if (this.webPip !== pip) return resolve(undefined);
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        canvas.getContext('2d')?.drawImage(img, 0, 0);
        resolve(undefined);
      };
      img.onerror = () => resolve(undefined);
      img.src = `data:${s.mime ?? 'image/jpeg'};base64,${s.frame}`;
    });
  }

  stopWebPip() {
    const pip = this.webPip;
    if (!pip) return;
    this.webPip = null;
    if (document.pictureInPictureElement === pip.video) void document.exitPictureInPicture().catch(() => {});
    pip.video.srcObject = null;
    pip.video.remove();
  }

  // ---- 設定 ----

  /** @param {HTMLElement} containerEl */
  displaySettings(containerEl) {
    ui.setting(containerEl, {
      name: 'FPS',
      icon: 'gauge',
      control: ui.segmented({
        label: 'FPS',
        value: String(this.settings.fps),
        options: FPS_OPTIONS.map((n) => ({ value: String(n), label: String(n) })),
        onChange: (v) => void this.setSetting('fps', Number(v)),
      }),
    });
    ui.setting(containerEl, {
      name: '画質',
      icon: 'image',
      control: ui.segmented({
        label: '画質',
        value: this.settings.quality,
        options: Object.entries(QUALITY_PRESETS).map(([value, p]) => ({ value, label: p.label })),
        onChange: (v) => void this.setSetting('quality', v),
      }),
    });
    ui.setting(containerEl, {
      name: '色数',
      icon: 'palette',
      control: ui.segmented({
        label: '色数',
        value: this.settings.color,
        options: Object.entries(COLOR_MODES).map(([value, label]) => ({ value, label })),
        onChange: (v) => void this.setSetting('color', v),
      }),
    });

    // プレビュー: 今の設定で符号化した画像と、1 フレームのおおよそのサイズ・帯域
    const box = document.createElement('div');
    box.className = 'screenshare-preview';
    const actions = document.createElement('div');
    actions.className = 'screenshare-preview-actions';
    if (canShareScreen(navigator)) {
      actions.append(
        ui.button({ text: '自分の画面で試す', icon: 'monitor-up', onClick: () => void this.capturePreview() }),
        ui.button({ text: 'サンプルに戻す', icon: 'image', variant: 'ghost', onClick: () => this.resetPreview() }),
      );
    }
    const img = document.createElement('img');
    img.className = 'screenshare-preview-img';
    img.alt = '今の設定での見え方';
    const info = document.createElement('p');
    info.className = 'screenshare-preview-info';
    box.append(img, info, actions);
    containerEl.append(box);
    this.previewEls = { img, info };
    this.refreshPreview();
  }

  /** @type {{ img: HTMLImageElement; info: HTMLElement } | null} */
  previewEls = null;

  /** プレビューの元の画面（自分の画面を取っていなければサンプル） */
  getPreviewSource() {
    if (this.previewSource) return this.previewSource;
    const cv = document.createElement('canvas');
    cv.width = 1920;
    cv.height = 1080;
    const ctx = cv.getContext('2d');
    if (ctx) drawSample(ctx, cv.width, cv.height);
    this.previewSource = cv;
    return cv;
  }

  resetPreview() {
    this.previewSource = null;
    this.previewCustom = false;
    this.refreshPreview();
  }

  /** 自分の画面を一度だけ取り込んで、プレビューの元にする */
  async capturePreview() {
    /** @type {MediaStream} */
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return;
    }
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      // 最初のフレームが来るまで待つ（最大 2 秒）
      for (let i = 0; i < 20 && !video.videoWidth; i++) await new Promise((r) => setTimeout(() => r(undefined), 100));
      await new Promise((r) => setTimeout(() => r(undefined), 150));
      if (!video.videoWidth) throw new Error('画面が取れません');
      const size = fitSize(video.videoWidth, video.videoHeight, 1920);
      const cv = document.createElement('canvas');
      cv.width = size.w;
      cv.height = size.h;
      cv.getContext('2d')?.drawImage(video, 0, 0, size.w, size.h);
      this.previewSource = cv;
      this.previewCustom = true;
    } catch (e) {
      ui.toast('画面を取り込めませんでした', 'error');
      console.warn('[screenshare] プレビューの取り込みに失敗', e);
    } finally {
      for (const t of stream.getTracks()) t.stop();
    }
    this.refreshPreview();
  }

  /** 今の設定でプレビューを作り直す */
  refreshPreview() {
    const els = this.previewEls;
    if (!els || !els.img.isConnected) return;
    const seq = ++this.previewSeq;
    try {
      const src = this.getPreviewSource();
      const preset = QUALITY_PRESETS[this.settings.quality];
      const size = fitSize(src.width, src.height, preset.maxEdge);
      const cv = document.createElement('canvas');
      const out = encodeFrame(cv, src, size.w, size.h, { color: this.settings.color, quality: preset.quality, format: null });
      if (seq !== this.previewSeq) return;
      els.img.src = `data:${out.mime};base64,${out.b64}`;
      const est = estimateBandwidth(out.b64.length, this.settings.fps);
      const kind = out.mime.replace('image/', '').toUpperCase();
      els.info.textContent =
        `${size.w}×${size.h}・${kind}・1 フレーム 約 ${formatBytes(est.imageBytes)}` +
        `・${this.settings.fps} FPS で動き続けると 約 ${formatBytes(est.bytesPerSec)}/秒` +
        (est.capped ? '（上限で間引かれます）' : '') +
        (this.previewCustom ? '' : '・サンプル画面');
    } catch (e) {
      els.info.textContent = 'プレビューを作れませんでした';
      console.warn('[screenshare] プレビューに失敗', e);
    }
  }

  /**
   * @template {keyof ShareSettings} K
   * @param {K} key
   * @param {ShareSettings[K]} value
   */
  async setSetting(key, value) {
    this.settings = parseSettings({ ...this.settings, [key]: value });
    this.resetTuning();
    this.refreshPreview();
    await this.saveData(this.settings);
  }
}
