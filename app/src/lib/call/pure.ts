// 通話の純粋な処理（DOM・ストアに触れないもの）。テストしやすいように store.svelte.ts から分けてある

import type { CallStatus } from '../protocol/CallStatus';

// ---- 定数 ----

/** 音量を見る間隔 */
export const LEVEL_MS = 100;
/** しゃべっていると見なす音量（0〜1 の RMS）と、そのあと光らせ続ける長さ */
export const SPEAK_THRESHOLD = 0.02;
export const SPEAK_HOLD_MS = 350;

/** サーバー経由（リレー）の音声: 16kHz・モノラル・Int16 の PCM を 50ms ずつ。通話の音声はすべてこれで流す */
export const RELAY_RATE = 16000;
export const RELAY_FRAME = 800;
/** 受け取った音を鳴らし始めるまでためる長さと、これ以上たまったら捨てる長さ（秒） */
export const RELAY_LEAD = 0.12;
export const RELAY_MAX_LEAD = 0.6;
/** 無音を送らない。しゃべり終わってからも送り続ける長さ（ミリ秒）と、無音と見なす音量（RMS） */
export const RELAY_HOLD_MS = 500;
export const RELAY_SILENCE = 0.004;

/** call.emit のイベント名 */
export const EV_AUDIO = 'audio';

/**
 * 受け取った音の上限（リミッター）。上限は dBFS で、これを超える音だけを抑える（通常の声はそのまま通す）。
 * 先読み（ルックアヘッド）の分だけ音が遅れるが、大きい音が来る前から下げ始めるので、急な落下音も上限を超えない。
 */
export const LIMIT_DB_MIN = -18;
export const LIMIT_DB_MAX = -3;
export const LIMIT_DB_DEFAULT = -6;
/** 先読みの長さ・下げ始めの速さ（アタック）・戻りの時定数（リリース）。ミリ秒 */
export const LIMIT_LOOKAHEAD_MS = 5;
export const LIMIT_ATTACK_MS = 3;
export const LIMIT_RELEASE_MS = 150;

/** マイクの音量（倍率）の範囲と、相手の音量（0〜1）の範囲 */
export const MIC_VOLUME_MAX = 2;
export const OUT_VOLUME_MAX = 1;
/** 出力先の一覧を取り直す間隔（tick の回数。LEVEL_MS 刻み） */
export const OUTPUTS_REFRESH_TICKS = 50;

// ---- 設定 ----

export type SavedOutput = { id: string; kind: string; label: string };

/** 通話の設定。端末ごとに保存する（同期されない） */
export type CallSettingsData = {
  joinMuted: boolean;
  /** マイクの音量。1 が等倍 */
  micVolume: number;
  /** 相手の音量。0〜1 */
  outVolume: number;
  /** マイクの機器 ID（空なら既定。デスクトップ） */
  inputId: string;
  /** 選んだ出力先 */
  output: SavedOutput | null;
  /** 受け取った大きい音を抑える（既定は入） */
  limiter: boolean;
  /** 抑える上限（dBFS。LIMIT_DB_MIN〜LIMIT_DB_MAX） */
  limitDb: number;
};

export const DEFAULT_CALL_SETTINGS: CallSettingsData = {
  joinMuted: false,
  micVolume: 1,
  outVolume: 1,
  inputId: '',
  output: null,
  limiter: true,
  limitDb: LIMIT_DB_DEFAULT,
};

/** 上限（dBFS）を範囲に収める。数でなければ既定値 */
export function clampLimitDb(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return LIMIT_DB_DEFAULT;
  return Math.min(LIMIT_DB_MAX, Math.max(LIMIT_DB_MIN, v));
}

const LIMIT_STRENGTH_DB = { weak: -3, medium: -6, strong: -12 } as const;
export type LimiterStrength = 'none' | keyof typeof LIMIT_STRENGTH_DB;

/** 保存形式は変えず、表示だけを4段階にまとめる。中間の保存値は近い段階で表示する */
export function limiterStrength(s: Pick<CallSettingsData, 'limiter' | 'limitDb'>): LimiterStrength {
  if (!s.limiter) return 'none';
  const db = clampLimitDb(s.limitDb);
  if (db > (LIMIT_STRENGTH_DB.weak + LIMIT_STRENGTH_DB.medium) / 2) return 'weak';
  if (db > (LIMIT_STRENGTH_DB.medium + LIMIT_STRENGTH_DB.strong) / 2) return 'medium';
  return 'strong';
}

/** 「なし」は以前の上限を残してオフにする。それ以外は上限とオンを一緒に保存する */
export function limiterStrengthPatch(v: LimiterStrength): Pick<CallSettingsData, 'limiter'> & Partial<Pick<CallSettingsData, 'limitDb'>> {
  return v === 'none' ? { limiter: false } : { limiter: true, limitDb: LIMIT_STRENGTH_DB[v] };
}

/** dB を振幅の倍率に直す（-6 dB ≒ 0.501） */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** 音量の値を範囲に収める。数でなければ既定値 */
export function clampVolume(v: unknown, max: number, fallback = 1): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(0, v));
}

/** 保存した設定を読む。壊れた値・足りない値は既定値にする */
export function parseCallSettings(saved: unknown): CallSettingsData {
  const s: CallSettingsData = { ...DEFAULT_CALL_SETTINGS };
  if (!saved || typeof saved !== 'object') return s;
  const r = saved as Record<string, unknown>;
  if (typeof r.joinMuted === 'boolean') s.joinMuted = r.joinMuted;
  s.micVolume = clampVolume(r.micVolume, MIC_VOLUME_MAX, 1);
  s.outVolume = clampVolume(r.outVolume, OUT_VOLUME_MAX, 1);
  if (typeof r.inputId === 'string') s.inputId = r.inputId;
  if (typeof r.limiter === 'boolean') s.limiter = r.limiter;
  s.limitDb = clampLimitDb(r.limitDb);
  const o = r.output as Record<string, unknown> | null | undefined;
  if (o && typeof o.id === 'string' && typeof o.kind === 'string' && typeof o.label === 'string') {
    s.output = { id: o.id, kind: o.kind, label: o.label };
  }
  return s;
}

/** 前に選んだ出力先を、いまの一覧から探す。ID が変わることがあるので、同じ種類・名前も見る */
export function pickOutput(outputs: Disnans.AudioOutput[], saved: SavedOutput | null): Disnans.AudioOutput | null {
  if (!saved) return null;
  return (
    outputs.find((o) => o.id === saved.id) ??
    outputs.find((o) => o.kind === saved.kind && o.label === saved.label) ??
    (saved.kind !== 'other' ? (outputs.find((o) => o.kind === saved.kind) ?? null) : null)
  );
}

// ---- 参加者・接続の判断 ----

/** 参加者を通話の一覧に見せるときの状態アイコン（アバターの左下） */
export type StatusBadge = 'muted' | 'deafened' | 'local-muted';

export function statusBadges(status: Pick<CallStatus, 'muted' | 'deafened'>, localMuted: boolean): StatusBadge[] {
  const out: StatusBadge[] = [];
  if (status.muted) out.push('muted');
  if (status.deafened) out.push('deafened');
  if (localMuted) out.push('local-muted');
  return out;
}

/** 端末の種類の文字（サーバーからの任意の文字列）を、知っている種類だけにする */
export function normalizeDevice(v: unknown): 'smartphone' | 'tablet' | 'laptop' | 'monitor' | null {
  return v === 'smartphone' || v === 'tablet' || v === 'laptop' || v === 'monitor' ? v : null;
}

/** 通話中の通知の文言とボタン（Android）。人数は自分を含む */
export function notificationContent(s: { muted: boolean; deafened: boolean; count: number }) {
  const states = [s.muted ? 'ミュート中' : '通話中'];
  if (s.deafened) states.push('スピーカーミュート中');
  return {
    title: '通話',
    text: `${states.join('・')} ・ ${s.count}人`,
    actions: [
      { id: 'mute', title: s.muted ? 'ミュート解除' : 'ミュート' },
      { id: 'deafen', title: s.deafened ? 'スピーカー解除' : 'スピーカーミュート' },
      { id: 'hangup', title: '切断', dismiss: true },
    ],
  };
}

/** 前回と今回の参加者の peer ID の差（自分は除く） */
export function diffPeers(prev: string[], next: string[], me: string): { added: string[]; removed: string[] } {
  const a = new Set(prev);
  const b = new Set(next);
  return {
    added: next.filter((p) => p !== me && !a.has(p)),
    removed: prev.filter((p) => p !== me && !b.has(p)),
  };
}

// ---- 音量・しゃべっているか ----

/** 音量から、しゃべっているかを更新する。state を書き換え、変わったら true */
export function updateSpeaking(state: { lastLoud: number; speaking: boolean }, level: number, now: number, silent: boolean): boolean {
  const loud = !silent && level > SPEAK_THRESHOLD;
  if (loud) state.lastLoud = now;
  const speaking = !silent && now - state.lastLoud < SPEAK_HOLD_MS;
  const changed = speaking !== state.speaking;
  state.speaking = speaking;
  return changed;
}

/** 実験用の切り替え（localStorage 'disnans.micRaw' === '1'）。ふだんは false（処理を通す） */
export function micRawFlag(value: string | null): boolean {
  return value === '1';
}

/** 実験用の keep-alive の切り替え（localStorage 'disnans.noKeepAlive' === '1' で止める）。ふだんは動かす */
export function noKeepAliveFlag(value: string | null): boolean {
  return value === '1';
}

/** AudioContext の周波数の上書き（localStorage 'disnans.ctxRate'）。数値で範囲外・不正は null（既定を使う） */
export function ctxRateFlag(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= 8000 && n <= 192000 ? n : null;
}

/**
 * マイクを開くときの要求。raw は、エコー消去・雑音抑制・自動音量を切る（処理の遅れを減らせるかの実験）。
 * sampleRate や latency は要求しない（ブラウザーの既定のまま）
 */
export function micConstraints(raw: boolean): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
  const on = !raw;
  return { echoCancellation: on, noiseSuppression: on, autoGainControl: on };
}

/** 時間領域のバイト列（128 が無音）から RMS を出す */
export function byteLevel(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return buf.length === 0 ? 0 : Math.sqrt(sum / buf.length);
}

// ---- リレー音声 ----

/** 入力の音（srcRate）を dstRate に直す（線形補間。チャンクをまたいでも続きから） */
export class Resampler {
  private ratio: number;
  private pos = 0;
  private prev = 0;
  constructor(srcRate: number, dstRate = RELAY_RATE) {
    this.ratio = srcRate / dstRate;
  }

  push(input: Float32Array): Float32Array {
    const len = input.length;
    const out: number[] = [];
    let pos = this.pos;
    while (Math.floor(pos) + 1 < len) {
      const i = Math.floor(pos);
      const f = pos - i;
      const a = i < 0 ? this.prev : input[i];
      out.push(a * (1 - f) + input[i + 1] * f);
      pos += this.ratio;
    }
    if (len > 0) {
      this.pos = pos - len;
      this.prev = input[len - 1];
    }
    return Float32Array.from(out);
  }
}

/** 小さな塊を size 個ずつの塊にそろえる */
export class Framer {
  private buf: Float32Array;
  private n = 0;
  constructor(private size = RELAY_FRAME) {
    this.buf = new Float32Array(size);
  }

  push(input: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let i = 0;
    while (i < input.length) {
      const take = Math.min(this.size - this.n, input.length - i);
      this.buf.set(input.subarray(i, i + take), this.n);
      this.n += take;
      i += take;
      if (this.n === this.size) {
        frames.push(this.buf);
        this.buf = new Float32Array(this.size);
        this.n = 0;
      }
    }
    return frames;
  }
}

export function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

export function int16ToFloat(p: Int16Array): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / (p[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

export function pcmToBase64(p: Int16Array): string {
  const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(bin);
}

/** 壊れた入力や、長さが合わない入力は null */
export function base64ToPcm(b64: unknown): Int16Array | null {
  if (typeof b64 !== 'string' || b64.length > 8192) return null;
  try {
    const bin = atob(b64);
    if (bin.length === 0 || bin.length % 2 !== 0) return null;
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  } catch {
    return null;
  }
}

/**
 * 受け取った音の上限（リミッター）。先読みつきのピーク制限で、相手1人の音ごとに持つ（状態をまたいで続けて通す）。
 * 上限を超えそうな音は、先読みの分だけ前から音量を下げる（アタックは速さを制限し、急に段差を作らない）。
 * 下げきれなかった分は最後に上限でクリップして、出力は必ず上限以下になる。上限より小さい音は変えない。
 */
export class PeakLimiter {
  private readonly lookahead: number;
  /** 1サンプルで下げてよい量（ゲインの単位）。アタックの時間で 1 から 0 まで下がる速さ */
  private readonly attackStep: number;
  /** 1サンプルごとに、元の 1 へ戻す割合の残り（指数の戻り） */
  private readonly releaseCoef: number;
  private ceiling: number;
  /** いま適用しているゲイン（0〜1） */
  private gain = 1;
  /** まだ出していない、直前の L 個の入力と、その音が求めるゲインの上限 */
  private xs: Float32Array;
  private gs: Float32Array;

  constructor(sampleRate = RELAY_RATE, ceilingDb = LIMIT_DB_DEFAULT) {
    this.lookahead = Math.max(1, Math.round((LIMIT_LOOKAHEAD_MS * sampleRate) / 1000));
    this.attackStep = 1 / Math.max(1, (LIMIT_ATTACK_MS * sampleRate) / 1000);
    this.releaseCoef = Math.exp(-1 / Math.max(1, (LIMIT_RELEASE_MS * sampleRate) / 1000));
    this.ceiling = dbToLinear(clampLimitDb(ceilingDb));
    this.xs = new Float32Array(this.lookahead);
    this.gs = new Float32Array(this.lookahead).fill(1);
  }

  /** 上限を変える（次の音から効く） */
  setCeilingDb(db: number): void {
    this.ceiling = dbToLinear(clampLimitDb(db));
  }

  /** 入れた音と同じ長さの音を返す（先読みの分だけ遅れる）。続けて渡すこと */
  process(input: Float32Array): Float32Array {
    const L = this.lookahead;
    const n = input.length;
    const m = L + n;
    const x = new Float32Array(m);
    x.set(this.xs, 0);
    x.set(input, L);
    // 各サンプルが求めるゲインの上限（そのサンプルが上限を超えないための値）
    const req = new Float32Array(m);
    req.set(this.gs, 0);
    for (let i = L; i < m; i++) {
      const a = Math.abs(x[i]!);
      req[i] = a > this.ceiling ? this.ceiling / a : 1;
    }
    const out = new Float32Array(n);
    // 単調キューで、いまのサンプルから先 L 個の中の最小（＝守るべき最も小さいゲイン）を求める
    const dq = new Int32Array(m);
    let head = 0;
    let tail = 0;
    for (let j = 0; j < m; j++) {
      while (tail > head && req[dq[tail - 1]!]! >= req[j]!) tail--;
      dq[tail++] = j;
      while (dq[head]! < j - L) head++;
      if (j < L) continue;
      const i = j - L;
      const target = req[dq[head]!]!;
      if (target < this.gain) this.gain = Math.max(target, this.gain - this.attackStep);
      else this.gain = target + (this.gain - target) * this.releaseCoef;
      const y = x[i]! * this.gain;
      out[i] = y > this.ceiling ? this.ceiling : y < -this.ceiling ? -this.ceiling : y;
    }
    this.xs = x.slice(n);
    this.gs = req.slice(n);
    return out;
  }
}

/**
 * 合計の音を上限で切る最後の段（WaveShaper の曲線）。相手が重なって上限を超えたときだけ効く。
 * 曲線は入力 -1〜1 を -c〜c に収める直線の切り取り。c が 1 なら素通し。
 */
export function clipCurve(ceiling: number, size = 4096): Float32Array<ArrayBuffer> {
  const c = Math.min(1, Math.max(0, ceiling));
  const out = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (2 * i) / (size - 1) - 1;
    out[i] = Math.max(-c, Math.min(c, x));
  }
  return out;
}

export function rms(f: Float32Array): number {
  if (f.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  return Math.sqrt(sum / f.length);
}

/**
 * 受け取った1塊を、いつ鳴らすか決める（ジッターバッファ）。st.next は次に鳴らす時刻。
 * 間に合わなかった（空になった）ときは lead 秒ためてから鳴らし直し、先に溜まりすぎたら捨てる（null）
 */
export function scheduleFrame(st: { next: number }, now: number, dur: number, lead = RELAY_LEAD, maxLead = RELAY_MAX_LEAD): number | null {
  if (st.next < now + 0.02) st.next = now + lead;
  else if (st.next - now > maxLead) return null;
  const at = st.next;
  st.next += dur;
  return at;
}

/** ランダムな ID（peer ID・接続の世代 ID） */
export function randomId(): string {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
