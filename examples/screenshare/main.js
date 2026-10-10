// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * 画面共有: 通話の拡張の実例（API v10 の disnans.call / screenCapture / pip / ui.onBack / ui.setImmersive）。
 *
 * できること:
 * 1. 通話のバーの [画面を共有] を押すと画面を選び、縮小した画像（JPEG / WebP / PNG）を一定間隔で call.emit（サーバー中継）に流す。
 *    もう一度押すと止まる。OS 側で止めた・通話から抜けたときも止まる。
 *    取得は、getDisplayMedia があればそれ（デスクトップ）、無ければ本体のネイティブ（disnans.screenCapture。Android の MediaProjection）
 * 2. 誰かが共有を始めると、ステータス欄に [○○の画面を見る] が出る。押すと全画面の表示が開き、共有者が複数なら上のタブで切り替えられる。
 *    通話の画面（「通話を開く」）にも、参加者の上に配信が出る（call.addPanel）。
 *    既定は画面全体が収まる表示。ピンチ・Ctrl+ホイール（トラックパッドのピンチ）でカーソルの位置を中心に拡大縮小、
 *    拡大中はドラッグ・ホイールで移動、ダブルタップ（ダブルクリック）で拡大／元に戻す。
 *    あとから通話に入った人は、入ったときに問い合わせ（screen.query）を送り、共有中の人がすぐに知らせ直す。
 *    [全画面]（Android は没入モード、ほかは Fullscreen API）、[PiP]（Android は Activity の PiP、デスクトップは canvas の captureStream を <video> の PiP に）、
 *    [閉じる]（Esc・戻るジェスチャーでも閉じる）。共有者が止めた・通話から抜けたら自動で消える
 * 3. 設定で、FPS（5 / 20）・画質（解像度と品質）・色数（フルカラー / 256 色 / グレースケール）を選べる。
 *    今の設定で、エンコード後の画像と 1 フレームのおおよそのサイズ・帯域をプレビューできる。
 *    プレビューの元は自分の実際の画面（共有中ならその画面、そうでなければ設定を開いたときに 1 回だけ取り込む。
 *    デスクトップは画面の選択、Android は許可のダイアログが出る）
 *
 * 映像も WebRTC ではなくサーバー経由（友達は別ネットワークで、P2P がつながらないため）。
 * サーバーは送り手ごとに「容量 4000・毎秒 3000 回復・1 回の重さ = 1 + payload の KB」で流量を制限し、超えた分を黙って捨てる
 * （crates/server/src/calls.rs）。音声が毎秒 40 ほど使うので、映像は毎秒 2400 KB（重さ）までに収める。
 * payload は JSON なので画像を base64 にして送る（4/3 倍になる）。1 回の上限 64 KB を超えるフレームは分割して送り、受け手が組み立てる。
 * 色数を減らす設定では、減色したあとの画像を JPEG / WebP / PNG の候補のうち小さいもので送る（JPEG は減色の効果が薄いため）。
 *
 * 使っている API（→ docs/PLUGINS.md）:
 * - call.addButton / addPanel / update / onChange / onEvent / emit / participants / joined / bufferedAmount
 * - addStatusBarItem ............ 見る入口
 * - addSettingTab / loadData / saveData ... FPS・画質・色数の設定とプレビュー
 * - registerInterval / registerDomEvent / register ... 見張りのタイマー、Esc キー、後片付け
 * - ui.setting / segmented / button / icon / toast / onBack / setImmersive
 * - screenCapture / pip ......... Android のネイティブ（画面の取得と PiP）
 *
 * 遅延を抑えるため、送信待ち（call.bufferedAmount）が多いあいだは次のフレームを作らずに待つ（古いフレームを溜めない）。
 *
 * 純粋な関数（分割・組み立て・調整・拡大縮小の計算）は、テストのためにここから export している（main.js の default だけがプラグイン）。
 */

const { Plugin, ui } = disnans;

// ---- 定数 ----

/** call.emit のイベント名（`audio` は本体が使う） */
const EVENT_FRAME = 'screen.frame';
const EVENT_STATE = 'screen.state';
/** 通話に入った人が「いま共有している人はいるか」と聞く。共有中の人は state とフレームを送り直す */
const EVENT_QUERY = 'screen.query';

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

/** 変化の判定に使う縮小画像の大きさ。細かい変化（文字の入力・カーソル）も拾えるよう、小さすぎない大きさにしている */
const DIFF_W = 64;
const DIFF_H = 36;
/** 縮小画像の 1 画素・1 色あたりの差の平均がこれ以下なら「変わっていない」（0〜255） */
export const DIFF_THRESHOLD = 1.5;
/** 縮小画像の 1 画素でも、RGB の平均の差がこれを超えたら「変わった」（平均では埋もれる小さな変化のため） */
export const PEAK_THRESHOLD = 24;

/**
 * 送信待ち（call.bufferedAmount）がこれより多いあいだは、次のフレームを作らずに待つ（バイト）。
 * 回線より速く送ると WebSocket の中にフレームが溜まり、そのぶん遅れて届くため
 */
export const BACKLOG_LIMIT = 192 * 1024;
/** 送信待ちが減るのを待つ間隔（ミリ秒） */
const BACKLOG_RETRY_MS = 30;
/** 共有を始めてから、これだけたっても画面の映像が取れなければ知らせる（ミリ秒） */
const VIDEO_STALL_MS = 5000;

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
/** Ctrl+ホイール（トラックパッドのピンチ）の拡大の速さ（1 ピクセルあたり）と、1 回の上限 */
const PINCH_ZOOM_RATE = 0.01;
const PINCH_MAX_DELTA = 30;
/** 修飾キーなしのホイールで拡大するときの速さと、1 回の上限 */
const WHEEL_ZOOM_RATE = 0.002;
const WHEEL_MAX_DELTA = 120;

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
 * 2 枚の縮小画像（RGBA）で、いちばん変わった画素の差（RGB の平均。0〜255）。小さな変化（文字の入力など）を拾う。
 * @param {ArrayLike<number> | null} a
 * @param {ArrayLike<number> | null} b
 */
export function framePeakDiff(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let peak = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    if (d > peak) peak = d;
  }
  return peak;
}

/**
 * 取り込んだ画像が空（全部透明）か。映像がまだ来ていない・canvas に描けない環境（一部の WebKitGTK など）で起きる。
 * @param {ArrayLike<number>} data RGBA
 */
export function isBlankFrame(data) {
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
  return true;
}

/**
 * フレームを送るか。画面が変わったときと、強制のとき、しばらく送っていないとき（あとから来た人のため）だけ送る。
 * diff は平均の差（frameDiff）、peak はいちばん変わった画素の差（framePeakDiff）。
 * @param {{ diff: number; peak?: number; sinceSentMs: number; force: boolean }} o
 */
export function shouldSend({ diff, peak = 0, sinceSentMs, force }) {
  return force || diff > DIFF_THRESHOLD || peak > PEAK_THRESHOLD || sinceSentMs >= KEEPALIVE_FRAME_MS;
}

/**
 * 許可のダイアログ・画面の選択でキャンセルされたときの例外か（知らせずに終える）。
 * getDisplayMedia は NotAllowedError（WebKit は AbortError のことも）、本体のネイティブ（API v10）は AbortError。
 * @param {unknown} e
 */
export function isCancelError(e) {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String(/** @type {{ name: unknown }} */ (e).name) : '';
  return name === 'NotAllowedError' || name === 'AbortError';
}

/**
 * 例外を短い文字にする（トースト・ログ用）。
 * @param {unknown} e
 */
export function describeError(e) {
  if (typeof e === 'object' && e !== null && 'message' in e) {
    // Error・DOMException（環境によっては Error を継承していない）・ネイティブの { message } のどれも
    const { name, message } = /** @type {{ name?: unknown; message: unknown }} */ (e);
    return typeof name === 'string' && name && name !== 'Error' ? `${name}: ${String(message)}` : String(message);
  }
  return String(e);
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
 * 画像を舞台に「全体が収まる」ように置いたときの大きさ（倍率 1 のときの表示の大きさ）。小さい画像は舞台いっぱいまで広げる。
 * @param {{ w: number; h: number }} natural 画像の元の大きさ
 * @param {{ w: number; h: number }} stage 舞台の大きさ
 */
export function containSize(natural, stage) {
  if (natural.w <= 0 || natural.h <= 0 || stage.w <= 0 || stage.h <= 0) return { w: 0, h: 0 };
  const r = Math.min(stage.w / natural.w, stage.h / natural.h);
  return { w: natural.w * r, h: natural.h * r };
}

/**
 * ホイールの操作を、拡大縮小か移動に読み替える。
 * - Ctrl（Mac は ⌘）+ ホイール: 拡大縮小。トラックパッドのピンチもブラウザーがこれにして渡してくる
 * - 拡大中のホイール: 移動（Shift なら横）
 * - 等倍のときに上へ回す: 拡大（埋め込みの表示では、ページのスクロールに譲る）
 * @param {{ deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }} e
 * @param {{ scale: number; embedded: boolean; pageHeight: number }} o
 * @returns {{ kind: 'zoom'; factor: number } | { kind: 'pan'; dx: number; dy: number } | null}
 */
export function wheelAction(e, o) {
  // 行・ページ単位（Firefox のマウスなど）をピクセルにそろえる
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.max(1, o.pageHeight) : 1;
  let dx = e.deltaX * unit;
  let dy = e.deltaY * unit;
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', factor: Math.exp(-clamp(dy, -PINCH_MAX_DELTA, PINCH_MAX_DELTA) * PINCH_ZOOM_RATE) };
  if (o.scale > MIN_ZOOM + 1e-6) {
    if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
    return { kind: 'pan', dx, dy };
  }
  if (!o.embedded && dy < 0) return { kind: 'zoom', factor: Math.exp(-clamp(dy, -WHEEL_MAX_DELTA, WHEEL_MAX_DELTA) * WHEEL_ZOOM_RATE) };
  return null;
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
 * base64 の画像を読み込んで canvas に描く（ネイティブの取得のフレームを、プレビューの元にするため）。
 * @param {string} b64
 * @param {string} mime
 * @returns {Promise<HTMLCanvasElement>}
 */
function imageToCanvas(b64, mime) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      cv.getContext('2d')?.drawImage(img, 0, 0);
      resolve(cv);
    };
    img.onerror = () => reject(new Error('画像を読み込めません'));
    img.src = `data:${mime};base64,${b64}`;
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(() => r(undefined), ms));

// ---- 表示の舞台（拡大縮小・パン） ----

/**
 * 共有された画面を 1 枚出す舞台。全画面の閲覧表示と、通話の画面の領域の両方で使う。
 * 既定は画面全体が収まる表示（contain）。ピンチ・Ctrl+ホイールで拡大縮小、拡大中はドラッグ・ホイールで移動、ダブルタップで拡大／元に戻す。
 */
class ScreenStage {
  /** @type {ViewState} */
  view = { scale: 1, x: 0, y: 0 };
  /** @type {HTMLImageElement | null} */
  img = null;
  /** @type {ResizeObserver | null} */
  ro = null;

  /**
   * @param {{ embedded: boolean }} opts embedded=通話の画面の中（ホイールをページのスクロールに譲ることがある）
   */
  constructor(opts) {
    this.embedded = opts.embedded;
    this.el = document.createElement('div');
    this.el.className = 'screenshare-stage';
    this.attachGestures();
    // 舞台の大きさが変わったら（ウィンドウの大きさ・全画面・回転）、収まる大きさを測り直す
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.applyView());
      this.ro.observe(this.el);
    }
  }

  /** @param {string} text */
  showWaiting(text) {
    this.img = null;
    const p = document.createElement('p');
    p.className = 'screenshare-wait';
    p.textContent = text;
    this.el.replaceChildren(p);
  }

  /**
   * @param {string} src data: URL
   * @param {string} alt
   */
  showImage(src, alt) {
    let img = this.img;
    if (!img || !img.isConnected || img.parentElement !== this.el) {
      img = document.createElement('img');
      img.className = 'screenshare-img';
      img.draggable = false;
      // 大きさが決まったら（最初のフレーム・縦横が変わったとき）、収まる大きさを合わせる
      img.addEventListener('load', () => this.applyView());
      this.el.replaceChildren(img);
      this.img = img;
    }
    img.alt = alt;
    if (img.getAttribute('src') !== src) img.src = src;
    this.applyView();
  }

  reset() {
    this.view = { scale: 1, x: 0, y: 0 };
    this.applyView();
  }

  /** 舞台と、倍率 1 のときの画像の表示の大きさ */
  measure() {
    const img = this.img;
    if (!img) return null;
    const stage = { w: this.el.clientWidth, h: this.el.clientHeight };
    const shown = containSize({ w: img.naturalWidth, h: img.naturalHeight }, stage);
    if (shown.w <= 0) return null;
    return { stage, img: shown };
  }

  /** 拡大の状態を画像に反映する（はみ出さないように収める） */
  applyView() {
    const img = this.img;
    if (!img) return;
    const m = this.measure();
    if (!m) return;
    this.view = clampView(this.view, m.stage, m.img);
    img.style.width = `${m.img.w}px`;
    img.style.height = `${m.img.h}px`;
    img.style.transform = `translate(-50%, -50%) translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.scale})`;
    this.el.classList.toggle('screenshare-zoomed', this.view.scale > MIN_ZOOM + 1e-6);
  }

  /**
   * 点 (px, py)（舞台の中心から）を中心に、倍率を factor 倍にする。
   * @param {number} factor
   * @param {number} px
   * @param {number} py
   */
  zoomBy(factor, px = 0, py = 0) {
    this.view = zoomAt(this.view, this.view.scale * factor, px, py);
    this.applyView();
  }

  destroy() {
    this.ro?.disconnect();
    this.ro = null;
    this.el.remove();
  }

  /** ピンチ・ドラッグ・ホイール・ダブルタップ（Pointer Events。マウスもタッチも同じ） */
  attachGestures() {
    const stage = this.el;
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
    const geometry = () => {
      const p = [...pointers.values()];
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
      // マウスは左ボタンだけ
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, local(e));
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        // 取れなくても動く
      }
      if (pointers.size === 1) moved = false;
      restart();
      stage.classList.toggle('screenshare-dragging', true);
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
      stage.classList.toggle('screenshare-dragging', false);
      if (e.type === 'pointerup' && !moved) {
        const tap = { t: Date.now(), ...local(e) };
        if (isDoubleTap(lastTap, tap)) {
          // 拡大していれば元に戻し、していなければタップした点を拡大する
          if (this.view.scale > MIN_ZOOM + 1e-6) this.reset();
          else this.zoomBy(DOUBLE_TAP_ZOOM, tap.x, tap.y);
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
        if (!this.img) return;
        const a = wheelAction(e, { scale: this.view.scale, embedded: this.embedded, pageHeight: stage.clientHeight });
        if (!a) return;
        e.preventDefault();
        if (a.kind === 'zoom') {
          const p = local(e);
          this.zoomBy(a.factor, p.x, p.y);
        } else {
          this.view = { ...this.view, x: this.view.x - a.dx, y: this.view.y - a.dy };
          this.applyView();
        }
      },
      { passive: false },
    );
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

/**
 * 取り込んだ 1 枚（canvas に描ける元と、その大きさ）。
 * @typedef {{ source: CanvasImageSource; w: number; h: number; close?: () => void }} Grabbed
 */

export default class ScreenSharePlugin extends Plugin {
  /** @type {ShareSettings} */
  settings = { ...DEFAULT_SETTINGS };
  /** @type {Disnans.Call} */
  call = /** @type {Disnans.Call} */ (/** @type {unknown} */ (null));

  // 共有する側
  sharing = false;
  /** 共有を始めるたびに増える（非同期の処理が、止めたあとの古い共有に触らないように） */
  shareSeq = 0;
  /** 画面の取り方（共有中だけ） */
  /** @type {'web' | 'native' | null} */
  backend = null;
  /** @type {MediaStream | null} */
  stream = null;
  /** @type {HTMLVideoElement | null} */
  video = null;
  /** getDisplayMedia の映像を <video> に描けないときの代わり（ImageCapture があれば） */
  /** @type {{ grabFrame(): Promise<ImageBitmap> } | null} */
  imageCapture = null;
  /** @type {HTMLCanvasElement | null} */
  canvas = null;
  /** @type {HTMLCanvasElement | null} */
  diffCanvas = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  timer = null;
  /** フレームの処理の途中（非同期の取り込みを待っている） */
  ticking = false;
  frameId = 0;
  lastHeartbeat = 0;
  lastSentAt = 0;
  /** 最後に映像が取れた時刻と、共有を始めた時刻（映像が来ないことに気づくため） */
  lastGrabAt = 0;
  shareStartedAt = 0;
  /** 映像が来ないことを、この共有ですでに知らせた */
  stallReported = false;
  /** @type {Uint8ClampedArray | null} */
  lastDiffData = null;
  /** 見ている人の顔ぶれ（変わったら画面が同じでも送る） */
  audienceKey = '';
  /** 通話の参加者（新しく来た人に、すぐ共有を知らせるため） */
  /** @type {Set<string>} */
  knownPeers = new Set();
  /** 前に見たときに通話に参加していたか（参加した瞬間に問い合わせるため） */
  wasJoined = false;
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
  /** 閲覧表示の舞台 */
  /** @type {ScreenStage | null} */
  stage = null;
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

  // 通話の画面の領域（call.addPanel）
  /** @type {Disnans.CallPanel | null} */
  panel = null;
  /** @type {ScreenStage | null} */
  panelStage = null;
  /** @type {HTMLElement | null} */
  panelBar = null;
  /** 領域で見ている共有者 */
  panelPeer = /** @type {string | null} */ (null);

  // 設定のプレビュー
  /** プレビューの元（自分の画面を取り込んだもの） */
  /** @type {HTMLCanvasElement | null} */
  previewSource = null;
  /** 設定を開いたときの自動の取り込みを、もう試した（断られたら何度も出さない） */
  previewAutoTried = false;
  previewBusy = false;
  previewSeq = 0;
  /** @type {{ img: HTMLImageElement; info: HTMLElement } | null} */
  previewEls = null;

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
    this.setupPanel();

    this.register(this.call.onChange(() => this.onCallChange()));
    this.register(this.call.onEvent(EVENT_STATE, (e) => this.onState(e)));
    this.register(this.call.onEvent(EVENT_FRAME, (e) => this.onFrame(e)));
    this.register(this.call.onEvent(EVENT_QUERY, () => this.onQuery()));

    // 共有中の知らせと、消えた共有者の見張り
    this.registerInterval(window.setInterval(() => this.watch(), WATCH_MS));
    this.registerDomEvent(document, 'keydown', (ev) => this.onKey(ev));
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
      this.panelStage?.destroy();
      this.panel?.remove();
      this.panel = null;
    });

    this.addSettingTab({ display: (el) => this.displaySettings(el) });
    this.renderStatus();
    // 通話の途中でプラグインを読み込んだ（更新・有効化）ときも、共有中の人を聞く
    this.onCallChange();
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
    // 押したボタンのフォーカスを外す（許可のダイアログから戻ったときに明るいまま残らないように）
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    this.starting = true;
    try {
      if (backend === 'web') await this.startWeb();
      else await this.startNative();
    } finally {
      this.starting = false;
    }
  }

  /**
   * getDisplayMedia で画面を選ぶ。キャンセルされたら null（知らせない）。
   * 制約を受け付けない環境（古い WebKit など）のために、だめなら制約なしでもう一度試す
   * @param {number} fps
   * @returns {Promise<MediaStream | null>}
   */
  async pickDisplay(fps) {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: 30 } }, audio: false });
    } catch (e) {
      if (isCancelError(e)) return null;
      if (!(e instanceof DOMException && (e.name === 'OverconstrainedError' || e.name === 'TypeError' || e.name === 'NotSupportedError'))) throw e;
      console.warn('[screenshare] 制約つきの getDisplayMedia に失敗。制約なしで試します', e);
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (e) {
      if (isCancelError(e)) return null;
      throw e;
    }
  }

  /**
   * getDisplayMedia の映像を映す <video>。WebKitGTK などは、文書に入っていない <video> のフレームを canvas に描けないことがあるので、
   * 見えない大きさで文書に入れておく
   * @param {MediaStream} stream
   */
  makeCaptureVideo(stream) {
    const video = document.createElement('video');
    video.className = 'screenshare-capture-video';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.srcObject = stream;
    document.body.append(video);
    void Promise.resolve(video.play()).catch((e) => console.warn('[screenshare] 取り込み用の映像を再生できません', e));
    return video;
  }

  /** getDisplayMedia で画面を選んで始める */
  async startWeb() {
    /** @type {MediaStream | null} */
    let stream;
    try {
      stream = await this.pickDisplay(this.settings.fps);
    } catch (e) {
      console.error('[screenshare] 画面を取得できません', e);
      ui.toast(`画面を取得できませんでした（${describeError(e)}）`, 'error');
      return;
    }
    if (!stream) return;
    // 許可待ちのあいだに通話を抜けた・プラグインが外れた場合は使わない
    if (!this.call.joined) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }

    const track = stream.getVideoTracks()[0];
    try {
      console.info('[screenshare] 画面の取得を始めます', track?.label, track?.getSettings?.());
    } catch {
      // getSettings が無い環境
    }
    this.stream = stream;
    this.video = this.makeCaptureVideo(stream);
    this.imageCapture = null;
    this.backend = 'web';
    this.beginSharing();
    // OS の「共有を停止」ボタンなどで止められたとき
    for (const t of stream.getVideoTracks()) {
      t.addEventListener('ended', () => {
        if (this.stream === stream) this.stopShare(true);
      });
    }
    this.scheduleTick(0);
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
      // 許可のダイアログでキャンセルしたとき（AbortError）は知らせない
      const msg = describeError(e);
      if (isCancelError(e) || /cancel|denied|拒否|キャンセル/i.test(msg)) return;
      console.error('[screenshare] 画面を取得できません', e);
      ui.toast(`画面を取得できませんでした（${msg}）`, 'error');
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
    this.shareSeq++;
    this.lastDiffData = null;
    this.lastSentAt = 0;
    this.lastGrabAt = 0;
    this.shareStartedAt = Date.now();
    this.stallReported = false;
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
    this.shareSeq++;
    this.backend = null;
    if (backend === 'native') void disnans.screenCapture.stop().catch(() => {});
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video.remove();
    }
    this.video = null;
    this.imageCapture = null;
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
    } catch (e) {
      // 通話から抜けた直後など。次の onChange で片付く
      console.warn('[screenshare] 共有の状態を送れません', e);
    }
  }

  /**
   * 次のフレームの処理を予約する（予約済みなら、早いほうに付け替える）。
   * @param {number} delay
   */
  scheduleTick(delay) {
    if (!this.sharing || this.backend !== 'web') return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.frameTick(), Math.max(0, delay));
  }

  /** 1 フレームぶんの処理。次の呼び出しを自分で予約する */
  async frameTick() {
    this.timer = null;
    if (!this.sharing || this.ticking) return;
    const seq = this.shareSeq;
    const t0 = performance.now();
    /** @type {number} */
    let delay;
    this.ticking = true;
    try {
      if (!this.call.joined) {
        this.stopShare(false);
        return;
      }
      if (!hasAudience(this.call.participants)) delay = IDLE_MS;
      // 送信待ちが溜まっているあいだは、新しいフレームを作らない（作っても遅れて届くだけ）
      else if ((this.call.bufferedAmount ?? 0) > BACKLOG_LIMIT) delay = BACKLOG_RETRY_MS;
      else delay = await this.captureAndSend(seq);
    } catch (e) {
      if (seq !== this.shareSeq) return;
      console.error('[screenshare] フレームの送信に失敗', e);
      this.stopShare(true);
      ui.toast(`画面共有を止めました（${describeError(e)}）`, 'error');
      return;
    } finally {
      this.ticking = false;
    }
    if (seq !== this.shareSeq || !this.sharing) return;
    if (this.timer === null) this.timer = setTimeout(() => void this.frameTick(), Math.max(0, delay - (performance.now() - t0)));
  }

  /**
   * 画面を 1 枚取り込む。<video> に描けなければ ImageCapture（あれば）を使う。まだ映像が来ていなければ null。
   * @returns {Promise<Grabbed | null>}
   */
  async grab() {
    const video = this.video;
    if (this.imageCapture) {
      const bmp = await this.imageCapture.grabFrame();
      return { source: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
    }
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    return { source: video, w: video.videoWidth, h: video.videoHeight };
  }

  /**
   * 映像が取れない（来ない・描けない）状態が続いたら、代わりの取り込み方に替え、それでもだめならログとトーストで知らせる。
   * @param {string} why
   */
  noteStall(why) {
    const now = Date.now();
    const since = now - (this.lastGrabAt || this.shareStartedAt);
    if (since < VIDEO_STALL_MS) return;
    const track = this.stream?.getVideoTracks()[0];
    const Ctor = /** @type {{ ImageCapture?: new (t: MediaStreamTrack) => { grabFrame(): Promise<ImageBitmap> } }} */ (/** @type {unknown} */ (globalThis)).ImageCapture;
    if (!this.imageCapture && track && typeof Ctor === 'function') {
      console.warn(`[screenshare] <video> から画面を取り込めません（${why}）。ImageCapture に替えます`);
      try {
        this.imageCapture = new Ctor(track);
        this.lastGrabAt = now;
        return;
      } catch (e) {
        console.warn('[screenshare] ImageCapture を使えません', e);
      }
    }
    if (this.stallReported) return;
    this.stallReported = true;
    const v = this.video;
    let settings = '';
    try {
      settings = JSON.stringify(track?.getSettings?.() ?? {});
    } catch {
      // 読めなくてもよい
    }
    console.error('[screenshare] 画面の映像を取り込めません', {
      why,
      readyState: v?.readyState,
      videoWidth: v?.videoWidth,
      paused: v?.paused,
      track: track && { label: track.label, readyState: track.readyState, muted: track.muted, enabled: track.enabled },
      settings,
    });
    ui.toast(`画面の映像を取り込めないため、相手には映っていません（${why}）。共有を止めて、もう一度試してください`, 'error');
  }

  /**
   * 画面を縮小して送る。
   * @param {number} seq 共有の番号（途中で止められたら何もしない）
   * @returns {Promise<number>} 次のフレームまでの間隔（ミリ秒）
   */
  async captureAndSend(seq) {
    const g = await this.grab();
    if (seq !== this.shareSeq) {
      g?.close?.();
      return VIDEO_WAIT_MS;
    }
    if (!g) {
      this.noteStall('映像が始まりません');
      return VIDEO_WAIT_MS;
    }
    try {
      return this.encodeAndSend(g);
    } finally {
      g.close?.();
    }
  }

  /**
   * @param {Grabbed} g
   * @returns {number} 次のフレームまでの間隔（ミリ秒）
   */
  encodeAndSend(g) {
    const preset = QUALITY_PRESETS[this.settings.quality];
    const minInterval = 1000 / this.settings.fps;

    // 変化の判定は、小さい画像どうしで比べる
    const dc = this.diffCanvas ?? (this.diffCanvas = document.createElement('canvas'));
    if (dc.width !== DIFF_W) dc.width = DIFF_W;
    if (dc.height !== DIFF_H) dc.height = DIFF_H;
    const dctx = dc.getContext('2d', { willReadFrequently: true });
    if (!dctx) throw new Error('canvas を使えません');
    dctx.clearRect?.(0, 0, DIFF_W, DIFF_H);
    dctx.drawImage(g.source, 0, 0, DIFF_W, DIFF_H);
    const data = dctx.getImageData(0, 0, DIFF_W, DIFF_H).data;
    // 何も描けていない（全部透明）なら送らない。続くなら知らせる
    if (isBlankFrame(data)) {
      this.noteStall('映像が空です');
      return VIDEO_WAIT_MS;
    }
    const now = Date.now();
    this.lastGrabAt = now;
    const key = this.call.participants.map((p) => p.peer).join(',');
    const force = key !== this.audienceKey;
    const decide = {
      diff: frameDiff(this.lastDiffData, data),
      peak: framePeakDiff(this.lastDiffData, data),
      sinceSentMs: now - this.lastSentAt,
      force,
    };
    if (!shouldSend(decide)) return minInterval;
    this.lastDiffData = data;
    this.audienceKey = key;

    const size = fitSize(g.w, g.h, preset.maxEdge, this.tuned.scale);
    const cv = this.canvas ?? (this.canvas = document.createElement('canvas'));
    // 色数を減らす設定では、ときどき候補の形式を全部試して小さいものを選び直す
    const probe = this.format === null || this.framesSinceProbe >= PROBE_EVERY;
    const out = encodeFrame(cv, g.source, size.w, size.h, {
      color: this.settings.color,
      quality: this.tuned.quality,
      format: probe ? null : this.format,
    });
    if (probe) this.framesSinceProbe = 0;
    this.framesSinceProbe++;
    this.format = out.mime;
    if (!out.b64) throw new Error('画像にできません（toDataURL が空）');

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

  /** 見る人が増えた・問い合わせが来た: 共有中なら、すぐに知らせて画面も送り直す */
  announce() {
    if (!this.sharing || !this.call.joined) return;
    this.sendState(true);
    if (this.backend === 'web') {
      this.audienceKey = '';
      if (!this.ticking) this.scheduleTick(0);
    } else if (this.backend === 'native' && this.lastNative && hasAudience(this.call.participants)) {
      this.audienceKey = '';
      this.pendingNative = this.lastNative;
      this.flushNative();
    }
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
    let wait = this.nativeNextAt - Date.now();
    // 送信待ちが溜まっているあいだは待つ（そのあいだに新しいフレームが来たら、そちらに替わる）
    if (wait <= 0 && (this.call.bufferedAmount ?? 0) > BACKLOG_LIMIT) wait = BACKLOG_RETRY_MS;
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
      ui.toast(`画面共有を止めました（${describeError(e)}）`, 'error');
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

  /** 通話に入った人からの問い合わせ */
  onQuery() {
    this.announce();
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
    if (this.panelPeer === e.peer) this.showPanelFrame();
    if (this.webPip?.peer === e.peer) void this.drawWebPip(s);
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
      this.wasJoined = false;
      this.knownPeers.clear();
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
    if (!this.wasJoined) {
      this.wasJoined = true;
      // 入った直後: 共有中の人に知らせ直してもらう（ハートビートを待たずに「〜の画面を見る」を出す）
      try {
        this.call.emit(EVENT_QUERY, {});
      } catch (e) {
        console.warn('[screenshare] 共有中の人を問い合わせられません', e);
      }
    }
    // 新しく来た人がいれば、共有中なら待たずに知らせる
    const added = [...peers].some((p) => !this.knownPeers.has(p));
    this.knownPeers = peers;
    if (added) this.announce();
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

  /** @param {KeyboardEvent} ev */
  onKey(ev) {
    if (this.viewing === null || !this.stage) return;
    if (ev.key === 'Escape') {
      this.closeViewer();
      return;
    }
    // 拡大縮小のキー（+ / - / 0）
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === '+' || ev.key === '=') this.stage.zoomBy(1.25);
    else if (ev.key === '-') this.stage.zoomBy(0.8);
    else if (ev.key === '0') this.stage.reset();
    else return;
    ev.preventDefault();
  }

  // ---- 表示 ----

  /** ステータス欄: 誰かが共有中なら見るボタン。通話の画面の領域も合わせる */
  renderStatus() {
    const el = this.statusEl;
    if (el) {
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
    this.renderPanel();
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
      this.stage = new ScreenStage({ embedded: false });
      // 戻る操作（Android の戻るジェスチャーなど）で閉じる
      this.offBackViewer = ui.onBack(() => this.closeViewer());
    }
    this.selectSharer(peer);
  }

  /** @param {string} peer */
  selectSharer(peer) {
    this.viewing = peer;
    if (this.stage) this.stage.view = { scale: 1, x: 0, y: 0 };
    this.renderViewer();
  }

  closeViewer() {
    const wasOpen = this.overlay !== null;
    this.viewing = null;
    this.exitFullscreen();
    this.offBackViewer?.();
    this.offBackViewer = null;
    this.nativePip = false;
    this.stage?.destroy();
    this.stage = null;
    this.overlay?.remove();
    this.overlay = null;
    // 閲覧表示のあいだ止めていた、通話の画面の領域を最新にする
    if (wasOpen) this.showPanelFrame();
  }

  /** 閲覧表示を作り直す（共有者の増減・切り替えのとき） */
  renderViewer() {
    const overlay = this.overlay;
    const stage = this.stage;
    if (!overlay || !stage || this.viewing === null) return;

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

    overlay.replaceChildren(bar, stage.el, exit);
    overlay.classList.toggle('screenshare-fullscreen', this.fullscreen !== null);
    overlay.classList.toggle('screenshare-pip', this.nativePip);
    this.showFrame();
  }

  /** 見ている共有者の最新のフレームを出す */
  showFrame() {
    const stage = this.stage;
    const s = this.viewing === null ? undefined : this.sharers.get(this.viewing);
    if (!stage || !s) return;
    if (!s.frame) stage.showWaiting(`${s.user.display_name} の画面を待っています…`);
    else stage.showImage(`data:${s.mime ?? 'image/jpeg'};base64,${s.frame}`, `${s.user.display_name} の共有画面`);
  }

  // ---- 通話の画面の領域（call.addPanel） ----

  setupPanel() {
    if (typeof this.call.addPanel !== 'function') return;
    const panel = this.call.addPanel({ label: '画面共有' });
    this.panel = panel;
    panel.el.classList.add('screenshare-panel');
    const bar = document.createElement('div');
    bar.className = 'screenshare-panel-bar';
    const stage = new ScreenStage({ embedded: true });
    panel.el.append(bar, stage.el);
    this.panelBar = bar;
    this.panelStage = stage;
    // 通話の画面が開いたら、最新のフレームを出して大きさを測り直す
    this.register(
      panel.onMount((mounted) => {
        if (mounted) this.showPanelFrame();
      }),
    );
  }

  /** 通話の画面の領域を、共有者に合わせて作り直す */
  renderPanel() {
    const panel = this.panel;
    const bar = this.panelBar;
    if (!panel || !bar) return;
    if (this.panelPeer === null || !this.sharers.has(this.panelPeer)) {
      const first = this.sharers.keys().next();
      this.panelPeer = first.done ? null : first.value;
      this.panelStage?.reset();
    }
    panel.setVisible(this.panelPeer !== null);
    bar.replaceChildren();
    if (this.panelPeer === null) return;
    const tabs = document.createElement('div');
    tabs.className = 'screenshare-tabs';
    for (const s of this.sharers.values()) {
      const b = ui.button({
        text: `${s.user.display_name} の画面`,
        icon: 'monitor-play',
        variant: 'ghost',
        onClick: () => {
          this.panelPeer = s.peer;
          this.panelStage?.reset();
          this.renderPanel();
        },
      });
      b.classList.add('screenshare-tab');
      if (s.peer === this.panelPeer) b.classList.add('screenshare-tab-selected');
      tabs.append(b);
    }
    const peer = this.panelPeer;
    bar.append(tabs, ui.button({ icon: 'maximize-2', label: '大きく見る', variant: 'ghost', onClick: () => this.openViewer(peer) }));
    this.showPanelFrame();
  }

  /** 通話の画面の領域に、選んでいる共有者の最新のフレームを出す（画面に出ていない・閲覧表示が上にあるあいだは省く） */
  showPanelFrame() {
    const stage = this.panelStage;
    const s = this.panelPeer === null ? undefined : this.sharers.get(this.panelPeer);
    if (!stage || !s || !this.panel?.mounted || this.overlay) return;
    if (!s.frame) stage.showWaiting(`${s.user.display_name} の画面を待っています…`);
    else stage.showImage(`data:${s.mime ?? 'image/jpeg'};base64,${s.frame}`, `${s.user.display_name} の共有画面`);
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
    // 画面の大きさが変わるので、拡大の範囲を合わせ直す（ResizeObserver が無い環境のため）
    setTimeout(() => this.stage?.applyView(), 50);
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
      this.stage?.reset();
    }
    setTimeout(() => this.stage?.applyView(), 100);
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

    // プレビュー: 自分の実際の画面を今の設定で符号化した画像と、1 フレームのおおよそのサイズ・帯域
    const box = document.createElement('div');
    box.className = 'screenshare-preview';
    const img = document.createElement('img');
    img.className = 'screenshare-preview-img';
    img.alt = '今の設定での見え方';
    img.hidden = true;
    const info = document.createElement('p');
    info.className = 'screenshare-preview-info';
    box.append(img, info);
    if (shareBackend(navigator, disnans.screenCapture)) {
      const actions = document.createElement('div');
      actions.className = 'screenshare-preview-actions';
      actions.append(ui.button({ text: '画面を取り込み直す', icon: 'refresh-cw', variant: 'ghost', onClick: () => void this.capturePreview() }));
      box.append(actions);
    }
    containerEl.append(box);
    this.previewEls = { img, info };
    if (this.previewSource) this.refreshPreview();
    else void this.autoPreview();
  }

  /** 設定を開いたとき: 共有中ならその画面、そうでなければ 1 回だけ自動で取り込む */
  async autoPreview() {
    const els = this.previewEls;
    if (!els) return;
    if (!shareBackend(navigator, disnans.screenCapture)) {
      els.info.textContent = 'この環境では画面を取り込めないため、プレビューはありません';
      return;
    }
    if (await this.previewFromSharing()) return;
    if (this.previewAutoTried) {
      els.info.textContent = '「画面を取り込み直す」を押すと、自分の画面で今の設定の見え方を確かめられます';
      return;
    }
    this.previewAutoTried = true;
    await this.capturePreview();
  }

  /** 共有中なら、いま共有している画面をプレビューの元にする。できたら true */
  async previewFromSharing() {
    if (!this.sharing) return false;
    try {
      if (this.backend === 'web') {
        const g = await this.grab();
        if (!g) return false;
        try {
          this.setPreviewSource(g.source, g.w, g.h);
        } finally {
          g.close?.();
        }
      } else if (this.backend === 'native' && this.lastNative) {
        const cv = await imageToCanvas(this.lastNative.data, this.lastNative.mime);
        this.previewSource = cv;
      } else {
        return false;
      }
    } catch (e) {
      console.warn('[screenshare] 共有中の画面をプレビューにできません', e);
      return false;
    }
    this.refreshPreview();
    return true;
  }

  /**
   * @param {CanvasImageSource} source
   * @param {number} w
   * @param {number} h
   */
  setPreviewSource(source, w, h) {
    const size = fitSize(w, h, 1920);
    const cv = document.createElement('canvas');
    cv.width = size.w;
    cv.height = size.h;
    cv.getContext('2d')?.drawImage(source, 0, 0, size.w, size.h);
    this.previewSource = cv;
  }

  /** 自分の画面を一度だけ取り込んで、プレビューの元にする（デスクトップは画面の選択、Android は許可のダイアログが出る） */
  async capturePreview() {
    if (this.previewBusy) return;
    if (await this.previewFromSharing()) return;
    const backend = shareBackend(navigator, disnans.screenCapture);
    if (!backend || this.starting) return;
    const els = this.previewEls;
    if (els?.img.isConnected) els.info.textContent = '画面を取り込んでいます…';
    this.previewBusy = true;
    try {
      const ok = backend === 'web' ? await this.capturePreviewWeb() : await this.capturePreviewNative();
      if (!ok) {
        if (els?.img.isConnected && !this.previewSource) els.info.textContent = '「画面を取り込み直す」を押すと、自分の画面で今の設定の見え方を確かめられます';
        return;
      }
    } catch (e) {
      console.warn('[screenshare] プレビューの取り込みに失敗', e);
      if (els?.img.isConnected) els.info.textContent = `画面を取り込めませんでした（${describeError(e)}）`;
      return;
    } finally {
      this.previewBusy = false;
    }
    this.refreshPreview();
  }

  /** getDisplayMedia で 1 枚だけ取る。キャンセルされたら false */
  async capturePreviewWeb() {
    const stream = await this.pickDisplay(5);
    if (!stream) return false;
    const video = this.makeCaptureVideo(stream);
    try {
      // 最初のフレームが来るまで待つ（最大 3 秒）
      for (let i = 0; i < 30 && !video.videoWidth; i++) await sleep(100);
      await sleep(150);
      if (!video.videoWidth) throw new Error('映像が始まりません');
      this.setPreviewSource(video, video.videoWidth, video.videoHeight);
      return true;
    } finally {
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      video.remove();
    }
  }

  /** 本体のネイティブ（Android）で 1 枚だけ取る。キャンセルされたら false */
  async capturePreviewNative() {
    const sc = disnans.screenCapture;
    /** @type {(f: Disnans.ScreenCaptureFrame) => void} */
    let got = () => {};
    /** @type {Promise<Disnans.ScreenCaptureFrame | null>} */
    const first = new Promise((resolve) => {
      got = resolve;
      setTimeout(() => resolve(null), 5000);
    });
    try {
      await sc.start({ maxEdge: 1920, quality: 0.9, fps: 5, format: 'jpeg', color: 'full', keepaliveMs: 500 }, (f) => got(f));
    } catch (e) {
      if (isCancelError(e) || /cancel|denied|キャンセル/i.test(describeError(e))) return false;
      throw e;
    }
    let f;
    try {
      f = await first;
    } finally {
      // 共有を始めていなければ止める（取り込みの途中で共有を始めたら、そのまま使う）
      if (!this.sharing) await sc.stop().catch(() => {});
    }
    if (!f) throw new Error('画面が届きません');
    this.previewSource = await imageToCanvas(f.data, f.mime);
    return true;
  }

  /** 今の設定でプレビューを作り直す */
  refreshPreview() {
    const els = this.previewEls;
    const src = this.previewSource;
    if (!els || !els.img.isConnected || !src) return;
    const seq = ++this.previewSeq;
    try {
      const preset = QUALITY_PRESETS[this.settings.quality];
      const size = fitSize(src.width, src.height, preset.maxEdge);
      const cv = document.createElement('canvas');
      const out = encodeFrame(cv, src, size.w, size.h, { color: this.settings.color, quality: preset.quality, format: null });
      if (seq !== this.previewSeq) return;
      els.img.src = `data:${out.mime};base64,${out.b64}`;
      els.img.hidden = false;
      const est = estimateBandwidth(out.b64.length, this.settings.fps);
      const kind = out.mime.replace('image/', '').toUpperCase();
      els.info.textContent =
        `${size.w}×${size.h}・${kind}・1 フレーム 約 ${formatBytes(est.imageBytes)}` +
        `・${this.settings.fps} FPS で動き続けると 約 ${formatBytes(est.bytesPerSec)}/秒` +
        (est.capped ? '（上限で間引かれます）' : '');
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
