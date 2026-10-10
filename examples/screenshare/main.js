// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * 画面共有: 通話の拡張の実例（API v8 の disnans.call）。
 *
 * できること:
 * 1. 通話のバーの [画面を共有] を押すと getDisplayMedia で画面を選び、縮小した JPEG を一定間隔で
 *    call.emit（サーバー中継）に流す。もう一度押すと止まる。OS 側で止めた・通話から抜けたときも止まる
 * 2. 誰かが共有を始めると、ステータス欄に [○○の画面を見る] が出る。押すと全画面の表示が開き、
 *    共有者が複数なら上のタブで切り替えられる。[原寸]・[全画面]・[閉じる]（Esc でも閉じる）。
 *    共有者が止めた・通話から抜けたら自動で消える
 * 3. getDisplayMedia が無い環境（Android の WebView、Linux の WebKitGTK など）では共有ボタンを出さず、見るだけにする
 *
 * 映像も WebRTC ではなくサーバー経由（友達は別ネットワークで、P2P がつながらないため）。
 * サーバーは送り手ごとに「容量 400・毎秒 300 回復・1 回の重さ = 1 + payload の KB」で流量を制限し、超えた分を黙って捨てる
 * （crates/server/src/calls.rs）。音声が毎秒 40 ほど使うので、映像は毎秒 160 KB（重さ）までに収める。
 * payload は JSON なので JPEG を base64 にして送る（4/3 倍になる）。1 回の上限 64 KB を超えるフレームは分割して送り、受け手が組み立てる。
 *
 * 使っている API（→ docs/PLUGINS.md）:
 * - call.addButton / update / onChange / onEvent / emit / participants / joined
 * - addStatusBarItem ............ 見る入口と、自分が共有中の表示
 * - addSettingTab / loadData / saveData ... 画質と更新頻度の設定
 * - registerInterval / registerDomEvent / register ... 見張りのタイマー、Esc キー、後片付け
 * - ui.setting / segmented / button / icon / toast
 *
 * 純粋な関数（分割・組み立て・調整）は、テストのためにここから export している（main.js の default だけがプラグイン）。
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
 * 画質の段階。budgetKBps は 1 秒に送ってよい重さ（サーバーの重さと同じ単位。1 + payload の KB）。
 * サーバーの回復が毎秒 300 で、音声が 40 ほどなので、いちばん高くても 160 にしておく
 * @typedef {{ label: string; maxEdge: number; quality: number; budgetKBps: number }} QualityPreset
 * @type {Readonly<Record<string, QualityPreset>>}
 */
export const QUALITY_PRESETS = Object.freeze({
  low: { label: '低', maxEdge: 960, quality: 0.5, budgetKBps: 60 },
  standard: { label: '標準', maxEdge: 1280, quality: 0.6, budgetKBps: 100 },
  high: { label: '高', maxEdge: 1600, quality: 0.7, budgetKBps: 160 },
});

/** 更新頻度（1 秒あたりの上限）の選択肢 */
const FPS_OPTIONS = [2, 3, 5];

/**
 * 設定（その端末にだけ保存する）。
 * @typedef {object} ShareSettings
 * @property {number} fps         1 秒あたりのフレーム数の上限
 * @property {string} quality     QUALITY_PRESETS のキー
 */
/** @type {Readonly<ShareSettings>} */
const DEFAULT_SETTINGS = Object.freeze({ fps: 3, quality: 'standard' });

// ---- 純粋な関数（テストする） ----

/**
 * 画面の取得（getDisplayMedia）が使える環境か。Android の WebView や Linux の WebKitGTK では無い。
 * @param {{ mediaDevices?: { getDisplayMedia?: unknown } } | undefined | null} nav
 */
export function canShareScreen(nav) {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function';
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
 * @returns {{ quality: number; scale: number }}
 */
export function tuneQuality(cur, bytes, preset) {
  const limit = preset.budgetKBps * 1024 * 0.6;
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
 * 保存した設定から、使える値だけを拾う。
 * @param {unknown} saved
 * @returns {ShareSettings}
 */
export function parseSettings(saved) {
  const s = { ...DEFAULT_SETTINGS };
  if (saved && typeof saved === 'object') {
    const o = /** @type {Record<string, unknown>} */ (saved);
    if (typeof o.fps === 'number' && FPS_OPTIONS.includes(o.fps)) s.fps = o.fps;
    if (typeof o.quality === 'string' && Object.hasOwn(QUALITY_PRESETS, o.quality)) s.quality = o.quality;
  }
  return s;
}

// ---- 受け取る側 ----

/**
 * 共有している人 1 人分。
 * @typedef {object} Sharer
 * @property {string} peer
 * @property {Disnans.User} user
 * @property {FrameAssembler} assembler
 * @property {string | null} frame    最新のフレーム（base64 の JPEG）
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
  /** 共有を始める操作の途中（getDisplayMedia の許可待ち）の二重実行を防ぐ */
  starting = false;

  // 見る側
  /** @type {Map<string, Sharer>} */
  sharers = new Map();
  /** 閲覧表示で選んでいる共有者（なければ閉じている） */
  viewing = /** @type {string | null} */ (null);
  zoomActual = false;
  /** @type {HTMLElement | null} */
  overlay = null;
  /** @type {HTMLElement} */
  statusEl = /** @type {HTMLElement} */ (/** @type {unknown} */ (null));
  /** @type {Disnans.CallButton | null} */
  button = null;

  async onload() {
    this.call = disnans.call;
    this.settings = parseSettings(await this.loadData());
    this.resetTuning();

    // 共有ボタン。取得できない環境では出さない（見るだけ）
    if (canShareScreen(navigator)) {
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
    // 外すときは共有を止め、表示を片付ける（相手には止まったことを知らせる）
    this.register(() => {
      this.stopShare(true);
      this.closeViewer();
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
  }

  async toggleShare() {
    if (this.sharing) this.stopShare(true);
    else await this.startShare();
  }

  async startShare() {
    if (this.sharing || this.starting) return;
    if (!canShareScreen(navigator)) {
      ui.toast('この環境では画面を共有できません（見ることはできます）', 'error');
      return;
    }
    if (!this.call.joined) {
      ui.toast('通話に参加していません', 'error');
      return;
    }
    this.starting = true;
    /** @type {MediaStream} */
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: this.settings.fps, max: 10 } },
        audio: false,
      });
    } catch (e) {
      this.starting = false;
      // 選択画面でキャンセルしたとき（NotAllowedError）は知らせなくてよい
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) ui.toast('画面を取得できませんでした', 'error');
      return;
    }
    this.starting = false;
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
    this.sharing = true;
    this.lastDiffData = null;
    this.lastSentAt = 0;
    this.audienceKey = '';
    this.resetTuning();
    // OS の「共有を停止」ボタンなどで止められたとき
    for (const t of stream.getVideoTracks()) t.addEventListener('ended', () => this.stopShare(true));

    this.button?.update({ label: '共有を止める', icon: 'monitor-off', active: true });
    this.sendState(true);
    this.renderStatus();
    this.timer = setTimeout(() => this.frameTick(), 0);
  }

  /**
   * 共有を止める。
   * @param {boolean} notify 相手に止まったことを知らせる（通話から抜けたあとは送れないので false）
   */
  stopShare(notify) {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const was = this.sharing;
    this.sharing = false;
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
    cv.width = size.w;
    cv.height = size.h;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('canvas を使えません');
    ctx.drawImage(video, 0, 0, size.w, size.h);
    const url = cv.toDataURL('image/jpeg', this.tuned.quality);
    const b64 = url.slice(url.indexOf(',') + 1);

    const chunks = splitFrame(this.frameId++, b64);
    for (const c of chunks) this.call.emit(EVENT_FRAME, c);
    this.lastSentAt = now;
    if (now - this.lastHeartbeat >= HEARTBEAT_MS) this.sendState(true);

    this.tuned = tuneQuality(this.tuned, b64.length, preset);
    return nextInterval({
      fps: this.settings.fps,
      weight: frameWeight(b64.length, chunks.length),
      budgetKBps: preset.budgetKBps,
    });
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
      s = { peer, user, assembler: new FrameAssembler(), frame: null, lastSeen: Date.now() };
      this.sharers.set(peer, s);
      ui.toast(`${user.display_name} が画面共有を始めました`);
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
    s.frame = data;
    if (this.viewing === e.peer) this.showFrame();
  }

  /** @param {string} peer */
  removeSharer(peer) {
    if (!this.sharers.delete(peer)) return;
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
  }

  // ---- 表示 ----

  /** ステータス欄: 自分が共有中なら止めるボタン、誰かが共有中なら見るボタン */
  renderStatus() {
    const el = this.statusEl;
    if (!el) return;
    el.replaceChildren();
    if (this.sharing) {
      el.append(
        ui.button({ text: '共有中（止める）', icon: 'monitor-off', variant: 'danger', onClick: () => this.stopShare(true) }),
      );
    }
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
    }
    this.selectSharer(peer);
  }

  /** @param {string} peer */
  selectSharer(peer) {
    this.viewing = peer;
    this.renderViewer();
  }

  closeViewer() {
    this.viewing = null;
    if (document.fullscreenElement && document.fullscreenElement === this.overlay) void document.exitFullscreen().catch(() => {});
    this.overlay?.remove();
    this.overlay = null;
  }

  /** 閲覧表示を作り直す（共有者の増減・切り替え・拡大の切り替えのとき） */
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
    bar.append(
      tabs,
      ui.button({
        icon: this.zoomActual ? 'minimize-2' : 'maximize-2',
        label: this.zoomActual ? '画面に合わせる' : '原寸で見る',
        variant: 'ghost',
        onClick: () => {
          this.zoomActual = !this.zoomActual;
          this.renderViewer();
        },
      }),
      ui.button({ icon: 'expand', label: '全画面', variant: 'ghost', onClick: () => this.toggleFullscreen() }),
      ui.button({ icon: 'x', label: '閉じる', variant: 'ghost', onClick: () => this.closeViewer() }),
    );

    const stage = document.createElement('div');
    stage.className = 'screenshare-stage' + (this.zoomActual ? ' screenshare-stage-actual' : '');
    overlay.replaceChildren(bar, stage);
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
      stage.replaceChildren(img);
    }
    img.src = `data:image/jpeg;base64,${s.frame}`;
  }

  toggleFullscreen() {
    const overlay = this.overlay;
    if (!overlay) return;
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void overlay.requestFullscreen?.().catch(() => ui.toast('この環境では全画面にできません', 'error'));
    } catch {
      ui.toast('この環境では全画面にできません', 'error');
    }
  }

  // ---- 設定 ----

  /** @param {HTMLElement} containerEl */
  displaySettings(containerEl) {
    const presetOptions = Object.entries(QUALITY_PRESETS).map(([value, p]) => ({ value, label: p.label }));
    ui.setting(containerEl, {
      name: '画質',
      description: '低いほど軽く、細かい文字は読みにくくなります（通信量の上限を超えそうなら自動で下がります）',
      icon: 'image',
      control: ui.segmented({
        label: '画質',
        value: this.settings.quality,
        options: presetOptions,
        onChange: (v) => void this.setSetting('quality', v),
      }),
    });
    ui.setting(containerEl, {
      name: '更新頻度',
      description: '1 秒あたりの最大フレーム数。画面が変わらないときは送りません',
      icon: 'gauge',
      control: ui.segmented({
        label: '更新頻度',
        value: String(this.settings.fps),
        options: FPS_OPTIONS.map((n) => ({ value: String(n), label: `${n} fps` })),
        onChange: (v) => void this.setSetting('fps', Number(v)),
      }),
    });
  }

  /**
   * @template {keyof ShareSettings} K
   * @param {K} key
   * @param {ShareSettings[K]} value
   */
  async setSetting(key, value) {
    this.settings = parseSettings({ ...this.settings, [key]: value });
    this.resetTuning();
    await this.saveData(this.settings);
  }
}
