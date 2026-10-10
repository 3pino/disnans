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
};

export const DEFAULT_CALL_SETTINGS: CallSettingsData = { joinMuted: false, micVolume: 1, outVolume: 1, inputId: '', output: null };

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
