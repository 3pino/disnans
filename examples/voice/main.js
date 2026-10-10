// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * ボイスチャット: 「いつでも出たり入ったりできる」みんな共通の音声通話（部屋は1つ、音声のみ）。
 *
 * できること:
 * 1. 参加すると、同じ部屋にいる全員と WebRTC で直接つながる（メッシュ。10人ほどまで。Tailscale 内なので STUN/TURN は基本不要）
 * 2. 画面の上部（ヘッダーの下）のステータス欄に、いま通話にいる人のアイコンが出る（参加していない人にも見える）。しゃべっている人は枠が光る
 * 3. ミュート、退出、相手のアイコンを押すと自分の側でだけその人を消音
 * 4. コマンド（パレット・`/vc-join` `/vc-leave` `/vc-mute` `/vc-deafen` `/vc-output`・ショートカット）と「＋」メニューからも操作できる
 * 5. Android では、通話中の通知に「ミュート」「スピーカーミュート」「切断」のボタンが出る（アプリが裏にいても押せる。押すと「…解除」に変わり、本文に人数が出る）
 * 6. スピーカーミュート（相手の声を全部自分の側だけで消す）、音の出力先の切り替え（Android: 受話口・スピーカー・イヤホン・Bluetooth、デスクトップ: 出力デバイス）
 * 7. マイクと相手の音量を、端末のボリュームとは別に調整できる（設定タブ。端末ごとに保存。同期されない）
 *
 * しくみ:
 * - 在室の管理とシグナリング（offer / answer / ICE）は、すべて this.broadcast / this.onBroadcast（API v3）で行う。
 *   サーバーには何も保存しない。参加者は 3 秒ごとに在室を知らせ（ハートビート）、12 秒途絶えた人は落ちたと見なして外す
 * - 常時表示は this.addStatusBarItem()（API v3）、画面を切っても通話を続けるのは this.holdBackground()（API v3。Android）。通知のボタンと文言の更新は holdBackground の actions / onAction / update（API v4）
 * - 同じ相手と同時に offer を出し合わないよう、peer ID が小さいほうだけが offer を出す
 *
 * - WebRTC を使えない環境（Linux のディストリ版 WebKitGTK など）は、その相手とのあいだだけ、音声をサーバーの broadcast に流す（リレー）。
 *   16kHz モノラルの PCM を 50ms ずつ送り（無音は送らない）、受け取った側がジッターバッファを通して鳴らす。
 *   在室の知らせの rtc で WebRTC を使えるか伝え合い、双方が使えるペアは今までどおり WebRTC だけで話す
 * - 出力先の切り替えは disnans.audio（API v5）。マイクの音量は WebAudio の GainNode、相手の音量は <audio> の volume
 *
 * 設定画面を開く this.openSettings()（API v6）は、あるときだけ使う（古いホストでは設定ボタンと /vc-settings を出さない）
 *
 * 使っている API: audio / addCommand / addComposerAction / addSettingTab / loadData / saveData / registerInterval /
 *   broadcast / onBroadcast / addStatusBarItem / holdBackground / ui.* / openSettings（v6・任意）
 */

const { Plugin, ui, audio } = disnans;

// ---- 定数 ----

/** 在室を知らせる間隔と、途絶えたと見なす長さ（ミリ秒） */
const HEARTBEAT_MS = 3000;
const EXPIRE_MS = 12000;
/** つながらないまま待つ長さ。超えたらやり直す */
const CONNECT_TIMEOUT_MS = 20000;
/** 音量を見る間隔 */
const LEVEL_MS = 100;
/** しゃべっていると見なす音量（0〜1 の RMS）と、そのあと光らせ続ける長さ */
const SPEAK_THRESHOLD = 0.02;
const SPEAK_HOLD_MS = 350;

/** サーバー経由（リレー）の音声: 16kHz・モノラル・Int16 の PCM を 50ms ずつ。WebRTC を使えない相手とのあいだだけで使う */
const RELAY_RATE = 16000;
const RELAY_FRAME = 800;
/** 受け取った音を鳴らし始めるまでためる長さと、これ以上たまったら捨てる長さ（秒） */
const RELAY_LEAD = 0.12;
const RELAY_MAX_LEAD = 0.6;
/** 無音を送らない。しゃべり終わってからも送り続ける長さ（ミリ秒）と、無音と見なす音量（RMS） */
const RELAY_HOLD_MS = 500;
const RELAY_SILENCE = 0.004;

/** broadcast のイベント名 */
const EV_AUDIO = 'audio';
const EV_PRESENCE = 'presence';
const EV_LEAVE = 'leave';
const EV_SIGNAL = 'signal';

/** マイクの音量（倍率）の範囲と、相手の音量（0〜1）の範囲 */
const MIC_VOLUME_MAX = 2;
const OUT_VOLUME_MAX = 1;
/** 出力先の一覧を取り直す間隔（tick の回数。LEVEL_MS 刻み） */
const OUTPUTS_REFRESH_TICKS = 50;

/**
 * 設定。端末ごとに保存する（loadData / saveData は端末のローカルで、同期されない）
 * @typedef {object} Settings
 * @property {string} stun
 * @property {boolean} joinMuted
 * @property {number} micVolume マイクの音量。1 が等倍
 * @property {number} outVolume 相手の音量。0〜1
 * @property {string} inputId マイクの機器 ID（空なら既定。デスクトップ）
 * @property {{ id: string, kind: string, label: string } | null} output 選んだ出力先
 */
/** @type {Settings} */
const DEFAULT_SETTINGS = { stun: '', joinMuted: false, micVolume: 1, outVolume: 1, inputId: '', output: null };

/**
 * @typedef {object} Entry 通話にいる1つの接続（同じ人が2台で入れば2つ）
 * @property {string} id peer ID
 * @property {Disnans.User} user
 * @property {boolean} muted 相手がミュートしているか
 * @property {number} lastSeen
 * @property {RTCPeerConnection | null} pc
 * @property {number} pcStartedAt
 * @property {RTCIceCandidateInit[]} pendingIce 相手の remoteDescription が決まる前に届いた ICE
 * @property {MediaStream | null} stream
 * @property {boolean} rtc 相手が WebRTC を使えるか（在室の知らせで分かる）
 * @property {RelayIn | null} relay サーバー経由で受け取る音（相手か自分が WebRTC を使えないとき）
 * @property {HTMLAudioElement | null} audio
 * @property {(() => void) | null} audioDetach audio.attach の解除
 * @property {Meter | null} meter
 * @property {boolean} localMuted 自分の側だけで消音している
 * @property {boolean} connected 音声がつながったか
 * @property {number} nextCallAt この時刻までは offer を出し直さない（失敗が続いても連打しない）
 */

/**
 * @typedef {object} RelayIn
 * @property {GainNode} gain
 * @property {Meter | null} meter
 * @property {{ next: number }} st
 */

/**
 * @typedef {object} Meter
 * @property {AnalyserNode} analyser
 * @property {Uint8Array} buf
 * @property {number} lastLoud
 * @property {boolean} speaking
 */

// ---- 小さな道具 ----

function randomId() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {string} tag
 * @param {string} [cls]
 * @param {string} [text]
 */
function h(tag, cls, text) {
  const el = /** @type {any} */ (document.createElement(tag));
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * 音量の値を範囲に収める。数でなければ既定値
 * @param {unknown} v
 * @param {number} max
 * @param {number} fallback
 */
export function clampVolume(v, max, fallback = 1) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(0, v));
}

/**
 * 前に選んだ出力先を、いまの一覧から探す。ID が変わることがあるので、同じ種類・名前も見る
 * @param {Disnans.AudioOutput[]} outputs
 * @param {{ id: string, kind: string, label: string } | null} saved
 * @returns {Disnans.AudioOutput | null}
 */
export function pickOutput(outputs, saved) {
  if (!saved) return null;
  return (
    outputs.find((o) => o.id === saved.id) ??
    outputs.find((o) => o.kind === saved.kind && o.label === saved.label) ??
    (saved.kind !== 'other' ? (outputs.find((o) => o.kind === saved.kind) ?? null) : null)
  );
}

// ---- リレー音声の純粋な部分（テストしやすいように分けてある） ----

/** この環境で WebRTC を使えるか */
function hasRtc() {
  return typeof RTCPeerConnection !== 'undefined';
}

/** 入力の音（srcRate）を dstRate に直す（線形補間。チャンクをまたいでも続きから） */
export class Resampler {
  /**
   * @param {number} srcRate
   * @param {number} dstRate
   */
  constructor(srcRate, dstRate = RELAY_RATE) {
    this.ratio = srcRate / dstRate;
    this.pos = 0;
    this.prev = 0;
  }

  /**
   * @param {Float32Array} input
   * @returns {Float32Array}
   */
  push(input) {
    const len = input.length;
    /** @type {number[]} */
    const out = [];
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
  /** @param {number} size */
  constructor(size = RELAY_FRAME) {
    this.size = size;
    this.buf = new Float32Array(size);
    this.n = 0;
  }

  /**
   * @param {Float32Array} input
   * @returns {Float32Array[]}
   */
  push(input) {
    /** @type {Float32Array[]} */
    const frames = [];
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

/** @param {Float32Array} f */
export function floatToInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** @param {Int16Array} p */
export function int16ToFloat(p) {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = p[i] / (p[i] < 0 ? 0x8000 : 0x7fff);
  return out;
}

/** @param {Int16Array} p */
export function pcmToBase64(p) {
  const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(bin);
}

/**
 * 壊れた入力や、長さが合わない入力は null
 * @param {unknown} b64
 * @returns {Int16Array | null}
 */
export function base64ToPcm(b64) {
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

/** @param {Float32Array} f */
export function rms(f) {
  if (f.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  return Math.sqrt(sum / f.length);
}

/**
 * 受け取った1塊を、いつ鳴らすか決める（ジッターバッファ）。st.next は次に鳴らす時刻。
 * 間に合わなかった（空になった）ときは lead 秒ためてから鳴らし直し、先に溜まりすぎたら捨てる（null）
 * @param {{ next: number }} st
 * @param {number} now
 * @param {number} dur 塊の長さ（秒）
 */
export function scheduleFrame(st, now, dur, lead = RELAY_LEAD, maxLead = RELAY_MAX_LEAD) {
  if (st.next < now + 0.02) st.next = now + lead;
  else if (st.next - now > maxLead) return null;
  const at = st.next;
  st.next += dur;
  return at;
}

/** @param {AnalyserNode} analyser */
function makeMeter(analyser) {
  analyser.fftSize = 512;
  return { analyser, buf: new Uint8Array(analyser.fftSize), lastLoud: 0, speaking: false };
}

/**
 * 音量を見て、しゃべっているかを更新する。変わったら true
 * @param {Meter} m
 * @param {number} now
 * @param {boolean} silent 無条件で黙っていることにする（ミュート中など）
 */
function updateMeter(m, now, silent) {
  let loud = false;
  if (!silent) {
    m.analyser.getByteTimeDomainData(/** @type {Uint8Array<ArrayBuffer>} */ (m.buf));
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) {
      const v = (m.buf[i] - 128) / 128;
      sum += v * v;
    }
    loud = Math.sqrt(sum / m.buf.length) > SPEAK_THRESHOLD;
  }
  if (loud) m.lastLoud = now;
  const speaking = !silent && now - m.lastLoud < SPEAK_HOLD_MS;
  const changed = speaking !== m.speaking;
  m.speaking = speaking;
  return changed;
}

/**
 * @param {string} id
 * @param {Disnans.User} user
 * @param {number} now
 * @returns {Entry}
 */
function makeEntry(id, user, now) {
  return {
    id,
    user,
    muted: false,
    rtc: true,
    relay: null,
    lastSeen: now,
    pc: null,
    pcStartedAt: 0,
    pendingIce: [],
    stream: null,
    audio: null,
    audioDetach: null,
    meter: null,
    localMuted: false,
    connected: false,
    nextCallAt: 0,
  };
}

/** @param {unknown} e */
function errName(e) {
  return e instanceof Error ? e.name : '';
}

// ---- プラグイン ----

export default class VoicePlugin extends Plugin {
  /** @type {Settings} */
  settings = { ...DEFAULT_SETTINGS };
  /** 通話にいる、自分以外の接続（参加していなくても、在室の表示のために覚える） @type {Map<string, Entry>} */
  entries = new Map();
  joined = false;
  joining = false;
  peerId = '';
  muted = false;
  /** 相手の声を全部消している（スピーカーミュート） */
  deafened = false;
  /** @type {MediaStream | null} マイクそのもの */
  localStream = null;
  /** @type {MediaStream | null} 相手に送る音（マイクの音量を通したもの。通せなければマイクそのもの） */
  sendStream = null;
  /** @type {GainNode | null} */
  micGain = null;
  /** @type {Disnans.AudioOutput[]} 選べる出力先 */
  outputs = [];
  /** @type {GainNode | null} マイクの音を取り出す元（音量を通したあと） */
  captureSrc = null;
  /** @type {{ stop(): void } | null} */
  capture = null;
  /** @type {Resampler | null} */
  resampler = null;
  framer = new Framer();
  relaySeq = 0;
  relayLoudAt = 0;
  outputsBusy = false;
  outputsTick = 0;
  /** @type {AudioContext | null} */
  ctx = null;
  /** @type {(() => void) | null} */
  ctxDetach = null;
  /** @type {Meter | null} */
  localMeter = null;
  /** @type {{ terminate(): void } | null} */
  worker = null;
  /** @type {Disnans.BackgroundHandle | null} 解除の関数。update() で通知を差し替える */
  background = null;
  /** 最後に通知へ渡した内容（同じなら更新しない） */
  notifyKey = '';
  beatAt = 0;
  /** @type {string} */
  structureSig = '';
  /** @type {HTMLElement | null} */
  bar = null;

  async onload() {
    this.settings = await this.loadSettings();

    this.bar = this.addStatusBarItem();
    this.render();

    this.onBroadcast(EV_PRESENCE, (p, from) => this.onPresence(p, from));
    this.onBroadcast(EV_LEAVE, (p) => this.onLeave(p));
    this.onBroadcast(EV_AUDIO, (p) => this.onRelayAudio(p));
    this.onBroadcast(EV_SIGNAL, (p, from) => void this.onSignal(p, from));

    // 参加していない間は、落ちた人を外すだけ。参加中は Worker のタイマーが同じ tick を呼ぶ
    this.registerInterval(window.setInterval(() => this.tick(), 1000));

    this.addIcon('voice-wave', '<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><path d="M12 8v5M9.5 10v1.5M14.5 9.5v2.5"/>');

    this.addCommand({
      id: 'join',
      name: 'ボイスチャットに参加する',
      icon: 'phone',
      slash: 'vc-join',
      description: 'ボイスチャットに参加する',
      run: () => this.join(),
    });
    this.addCommand({
      id: 'leave',
      name: 'ボイスチャットから抜ける',
      icon: 'phone-off',
      slash: 'vc-leave',
      description: 'ボイスチャットから抜ける',
      run: () => this.leave(),
    });
    this.addCommand({
      id: 'mute',
      name: 'ボイスチャットのミュートを切り替える',
      icon: 'mic-off',
      hotkey: 'Mod+Shift+M',
      slash: 'vc-mute',
      description: 'マイクのミュートを切り替える',
      run: () => this.toggleMute(),
    });
    this.addCommand({
      id: 'deafen',
      name: 'スピーカーミュートを切り替える',
      icon: 'volume-x',
      slash: 'vc-deafen',
      description: '相手の声を全部消す（自分の側だけ）',
      run: () => this.toggleDeafen(),
    });
    this.addCommand({
      id: 'output',
      name: '音の出力先を切り替える',
      icon: 'headphones',
      slash: 'vc-output',
      description: '受話口・スピーカー・イヤホンなど、次の出力先に切り替える',
      run: () => void this.cycleOutput(),
    });
    // 設定画面を開くコマンドは、開けるホストのときだけ出す
    if (this.canOpenSettings()) {
      this.addCommand({
        id: 'settings',
        name: 'ボイスチャットの設定を開く',
        icon: 'settings',
        slash: 'vc-settings',
        description: 'ボイスチャットの設定を開く',
        run: () => this.openPluginSettings(),
      });
    }
    this.addComposerAction({
      id: 'join',
      label: 'ボイスチャットに参加',
      icon: 'headphones',
      run: () => this.join(),
    });
    this.addSettingTab({ display: (el) => this.displaySettings(el) });
  }

  onunload() {
    // 登録したものは自動で片付く。通話だけは自分で閉じる（相手に退出を知らせる）
    this.leave();
  }

  // ---- 設定 ----

  async loadSettings() {
    const saved = /** @type {Record<string, unknown> | null} */ (await this.loadData());
    const s = { ...DEFAULT_SETTINGS };
    if (saved && typeof saved === 'object') {
      if (typeof saved.stun === 'string') s.stun = saved.stun;
      if (typeof saved.joinMuted === 'boolean') s.joinMuted = saved.joinMuted;
      s.micVolume = clampVolume(saved.micVolume, MIC_VOLUME_MAX, 1);
      s.outVolume = clampVolume(saved.outVolume, OUT_VOLUME_MAX, 1);
      if (typeof saved.inputId === 'string') s.inputId = saved.inputId;
      const o = /** @type {Record<string, unknown> | null} */ (saved.output);
      if (o && typeof o.id === 'string' && typeof o.kind === 'string' && typeof o.label === 'string') {
        s.output = { id: o.id, kind: o.kind, label: o.label };
      }
    }
    return s;
  }

  /**
   * @template {keyof Settings} K
   * @param {K} key
   * @param {Settings[K]} value
   */
  async setSetting(key, value) {
    this.settings[key] = value;
    await this.saveData(this.settings);
  }

  /** 設定画面を開けるか（API v6 の openSettings があるか。古いホストでは false） */
  canOpenSettings() {
    return typeof (/** @type {{ openSettings?: unknown }} */ (/** @type {unknown} */ (this)).openSettings) === 'function';
  }

  /** このプラグインの設定画面を開く。開けないホストでは何もしない */
  openPluginSettings() {
    const self = /** @type {{ openSettings?: () => void }} */ (/** @type {unknown} */ (this));
    if (typeof self.openSettings === 'function') self.openSettings();
  }

  /** @param {HTMLElement} containerEl */
  displaySettings(containerEl) {
    ui.setting(containerEl, {
      name: '参加したときミュートにする',
      icon: 'mic-off',
      control: ui.toggle({
        label: '参加したときミュートにする',
        value: this.settings.joinMuted,
        onChange: (v) => void this.setSetting('joinMuted', v),
      }),
    });
    this.displayAudioSettings(containerEl);
    ui.setting(containerEl, {
      name: 'STUN サーバー（任意）',
      icon: 'server',
      control: ui.input({
        value: this.settings.stun,
        placeholder: 'stun:…',
        onChange: (v) => void this.setSetting('stun', v.trim()),
      }),
    });
  }

  /** @param {HTMLElement} containerEl */
  displayAudioSettings(containerEl) {
    ui.setting(containerEl, {
      name: 'マイクの音量',
      icon: 'mic',
      control: this.volumeSlider(this.settings.micVolume, MIC_VOLUME_MAX, (v) => {
        this.settings.micVolume = v;
        this.applyMicVolume();
      }),
    });
    ui.setting(containerEl, {
      name: '相手の音量',
      icon: 'volume-2',
      control: this.volumeSlider(this.settings.outVolume, OUT_VOLUME_MAX, (v) => {
        this.settings.outVolume = v;
        this.applyOutVolume();
      }),
    });
    // 機器の一覧は、開いたときに取る（使えない環境では行ごと出さない）
    const outRow = ui.setting(containerEl, { name: '音の出力先', icon: 'headphones' });
    outRow.hidden = true;
    void this.refreshOutputs().then(() => {
      if (this.outputs.length === 0) return;
      outRow.hidden = false;
      const sel = this.outputSelect();
      sel.onchange = () => void this.chooseOutput(sel.value);
      outRow.append(sel);
    });
    const inRow = ui.setting(containerEl, {
      name: 'マイク',
      icon: 'mic',
    });
    inRow.hidden = true;
    void (audio?.listInputs() ?? Promise.resolve([])).then((list) => {
      if (list.length === 0) return;
      inRow.hidden = false;
      const sel = h('select', 'input voice-select');
      sel.setAttribute('aria-label', 'マイク');
      sel.append(new Option('既定', ''));
      for (const d of list) sel.append(new Option(d.label, d.id));
      sel.value = list.some((d) => d.id === this.settings.inputId) ? this.settings.inputId : '';
      sel.onchange = () => void this.setSetting('inputId', sel.value);
      inRow.append(sel);
    });
  }

  /**
   * 音量のスライダー（0〜max。パーセントで表示）。動かしている間は反映だけして、離したときに保存する
   * @param {number} value
   * @param {number} max
   * @param {(v: number) => void} apply
   */
  volumeSlider(value, max, apply) {
    const wrap = h('div', 'voice-slider');
    const input = h('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(Math.round(max * 100));
    input.step = '5';
    input.value = String(Math.round(value * 100));
    input.setAttribute('aria-label', '音量');
    const label = h('span', 'voice-slider-value', `${input.value}%`);
    input.oninput = () => {
      label.textContent = `${input.value}%`;
      apply(Number(input.value) / 100);
    };
    input.onchange = () => void this.saveData(this.settings);
    wrap.append(input, label);
    return wrap;
  }

  // ---- 参加・退出 ----

  async join() {
    if (this.joined || this.joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      ui.toast('この環境ではマイクを使えません（アプリ版で使ってください）', 'error');
      return;
    }
    this.joining = true;
    this.render();
    try {
      /** @type {MediaStream} */
      let stream;
      try {
        stream = await this.openMic();
      } catch (e) {
        const name = errName(e);
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          ui.toast('マイクの使用が許可されていません。端末の設定で許可してください', 'error');
        } else if (name === 'NotFoundError') {
          ui.toast('マイクが見つかりません', 'error');
        } else {
          ui.toast(`マイクを開けませんでした: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
        return;
      }
      // マイクの許可を得たあとで常駐を始める（Android 14 以降は許可前だと失敗する）
      try {
        this.notifyKey = '';
        this.background = await this.holdBackground({
          microphone: true,
          ...this.notificationContent(),
          // アプリが裏にいても届く。届かないとき、切断は本体が通知を止める（dismiss）
          onAction: (id) => {
            if (id === 'mute') this.toggleMute();
            else if (id === 'deafen') this.toggleDeafen();
            else if (id === 'hangup') this.leave();
          },
        });
        this.notifyKey = JSON.stringify(this.notificationContent());
      } catch (e) {
        console.error('[voice] 常駐を始められませんでした', e);
        ui.toast('画面を消すと通話が切れることがあります', 'info');
      }

      this.localStream = stream;
      this.ctx = new AudioContext();
      void this.ctx.resume().catch(() => {});
      this.ctxDetach = audio?.attach(this.ctx) ?? null;
      this.localMeter = makeMeter(this.ctx.createAnalyser());
      await this.setupSend(stream, this.ctx, this.localMeter);

      this.peerId = randomId();
      this.muted = this.settings.joinMuted;
      this.applyMute();
      this.joined = true;
      void this.restoreOutput();
      this.startWorker();
      this.sendPresence();
      this.beatAt = performance.now();
    } finally {
      this.joining = false;
      this.render();
    }
  }

  leave() {
    if (!this.joined && !this.localStream) return;
    if (this.joined) this.broadcast(EV_LEAVE, { peer: this.peerId });
    this.joined = false;
    this.deafened = false;
    this.outputs = [];
    this.stopWorker();
    for (const e of this.entries.values()) this.closePeer(e);
    // 参加していない間も、いま通話にいる人の表示は続ける（落ちた人は tick が外す）
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.sendStream = null;
    this.micGain = null;
    this.captureSrc = null;
    this.stopCapture();
    this.localMeter = null;
    this.ctxDetach?.();
    this.ctxDetach = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.background?.();
    this.background = null;
    this.render();
  }

  /**
   * マイクを開く。選んだ機器が使えなければ既定の機器で開き直す
   * @returns {Promise<MediaStream>}
   */
  async openMic() {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const id = this.settings.inputId;
    if (id) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: id } }, video: false });
      } catch (e) {
        if (errName(e) !== 'OverconstrainedError' && errName(e) !== 'NotFoundError') throw e;
      }
    }
    return await navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }

  /**
   * マイク → 音量（GainNode）→ 送る音、と通す。通せないとき（AudioContext が動かない環境）は、マイクをそのまま送る
   * @param {MediaStream} stream
   * @param {AudioContext} ctx
   * @param {Meter} meter
   */
  async setupSend(stream, ctx, meter) {
    this.sendStream = stream;
    this.micGain = null;
    this.captureSrc = null;
    try {
      await ctx.resume();
      if (ctx.state !== 'running' || !ctx.createGain || !ctx.createMediaStreamDestination) throw new Error('AudioContext が動いていません');
      const gain = ctx.createGain();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(stream).connect(gain);
      gain.connect(dest);
      gain.connect(meter.analyser);
      this.micGain = gain;
      this.captureSrc = gain;
      this.sendStream = dest.stream;
      this.applyMicVolume();
    } catch (e) {
      console.warn('[voice] マイクの音量を調整できません。そのまま送ります', e);
      const src = ctx.createMediaStreamSource(stream);
      src.connect(meter.analyser);
      this.captureSrc = /** @type {any} */ (src);
    }
  }

  applyMicVolume() {
    if (this.micGain) this.micGain.gain.value = this.settings.micVolume;
  }

  applyOutVolume() {
    for (const e of this.entries.values()) this.applyEntryAudio(e);
  }

  /** 相手1人分の音（WebRTC の <audio> とリレーの GainNode）に、音量・消音を反映する */
  applyEntryAudio(/** @type {Entry} */ e) {
    const silent = e.localMuted || this.deafened;
    if (e.audio) {
      e.audio.muted = silent;
      e.audio.volume = this.settings.outVolume;
    }
    if (e.relay) e.relay.gain.gain.value = silent ? 0 : this.settings.outVolume;
  }

  toggleDeafen() {
    if (!this.joined) {
      ui.toast('ボイスチャットに参加していません', 'error');
      return;
    }
    this.deafened = !this.deafened;
    for (const e of this.entries.values()) this.applyEntryAudio(e);
    this.render();
  }

  // ---- 音の出力先 ----

  /** 選べる出力先を取り直す。変わっていたら再描画する */
  async refreshOutputs() {
    if (!audio || this.outputsBusy) return;
    this.outputsBusy = true;
    try {
      const list = await audio.listOutputs();
      if (JSON.stringify(list) !== JSON.stringify(this.outputs)) {
        this.outputs = list;
        this.render();
      }
    } catch (e) {
      console.warn('[voice] 出力先の一覧を取れません', e);
    } finally {
      this.outputsBusy = false;
    }
  }

  /** 参加したとき、前に選んだ出力先に戻す（なければ本体の既定: イヤホンがあればそれ、なければスピーカー） */
  async restoreOutput() {
    await this.refreshOutputs();
    const want = pickOutput(this.outputs, this.settings.output);
    if (want && !want.selected) await this.applyOutput(want);
  }

  /** @param {Disnans.AudioOutput} o */
  async applyOutput(o) {
    if (!audio) return false;
    const ok = await audio.setOutput(o.id).catch(() => false);
    if (ok) await this.refreshOutputs();
    return ok;
  }

  /** @param {string} id */
  async chooseOutput(id) {
    const o = this.outputs.find((x) => x.id === id);
    if (!o) return;
    if (!(await this.applyOutput(o))) {
      ui.toast('出力先を切り替えられませんでした', 'error');
      return;
    }
    await this.setSetting('output', { id: o.id, kind: o.kind, label: o.label });
  }

  /** 次の出力先へ（コマンド用） */
  async cycleOutput() {
    if (!this.joined) {
      ui.toast('ボイスチャットに参加していません', 'error');
      return;
    }
    await this.refreshOutputs();
    if (this.outputs.length < 2) {
      ui.toast('切り替えられる出力先がありません', 'info');
      return;
    }
    const i = this.outputs.findIndex((o) => o.selected);
    const next = this.outputs[(i + 1) % this.outputs.length];
    await this.chooseOutput(next.id);
    ui.toast(`出力先: ${next.label}`, 'info');
  }

  /** @param {HTMLSelectElement} [reuse] */
  outputSelect(reuse) {
    const sel = reuse ?? h('select', 'input voice-select');
    sel.setAttribute('aria-label', '音の出力先');
    sel.replaceChildren(...this.outputs.map((o) => new Option(o.label, o.id)));
    sel.value = this.outputs.find((o) => o.selected)?.id ?? '';
    return sel;
  }

  toggleMute() {
    if (!this.joined) {
      ui.toast('ボイスチャットに参加していません', 'error');
      return;
    }
    this.muted = !this.muted;
    this.applyMute();
    this.sendPresence();
    this.render();
  }

  applyMute() {
    // 送る音（マイクの音量を通したもの）と、マイクそのものの両方を止める
    this.sendStream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = !this.muted));
  }

  // ---- タイマー ----

  /** タイマーは Worker で回す（画面が裏に回ってもメインスレッドのタイマーのように間引かれにくい） */
  startWorker() {
    this.stopWorker();
    try {
      const code = `setInterval(() => postMessage(0), ${LEVEL_MS});`;
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const w = new Worker(url);
      URL.revokeObjectURL(url);
      w.onmessage = () => this.tick();
      this.worker = w;
    } catch (e) {
      // Worker が使えなければ、ふつうのタイマーで代わりにする
      console.warn('[voice] Worker を使えません', e);
      const id = window.setInterval(() => this.tick(), LEVEL_MS);
      this.worker = /** @type {any} */ ({ terminate: () => window.clearInterval(id) });
    }
  }

  stopWorker() {
    this.worker?.terminate();
    this.worker = null;
  }

  tick() {
    const now = performance.now();
    let changed = false;

    // 落ちた人を外す。つながらないままの接続はやり直す
    for (const e of [...this.entries.values()]) {
      if (now - e.lastSeen > EXPIRE_MS) {
        this.closePeer(e);
        this.entries.delete(e.id);
        changed = true;
      } else if (this.joined && e.pc && !e.connected && now - e.pcStartedAt > CONNECT_TIMEOUT_MS) {
        this.closePc(e);
      }
    }

    if (this.joined) {
      if (now - this.beatAt >= HEARTBEAT_MS) {
        this.beatAt = now;
        this.sendPresence();
      }
      if (++this.outputsTick >= OUTPUTS_REFRESH_TICKS) {
        this.outputsTick = 0;
        void this.refreshOutputs();
      }
      // 足りない接続を張る。リレーで話す相手は、つながっていることにする
      for (const e of this.entries.values()) {
        this.maybeCall(e);
        if (this.usesRelay(e) && !e.connected) {
          e.connected = true;
          changed = true;
        }
      }
      if (this.needRelay()) this.ensureCapture();
      // 音量
      if (this.localMeter && updateMeter(this.localMeter, now, this.muted)) changed = true;
      for (const e of this.entries.values()) {
        const m = e.meter ?? e.relay?.meter;
        if (m && updateMeter(m, now, e.muted || e.localMuted)) changed = true;
      }
    }

    if (changed) this.render();
  }

  // ---- 在室 ----

  sendPresence() {
    this.broadcast(EV_PRESENCE, { peer: this.peerId, muted: this.muted, rtc: hasRtc() });
  }

  /**
   * @param {unknown} payload
   * @param {Disnans.User} from
   */
  onPresence(payload, from) {
    const p = /** @type {{ peer?: unknown, muted?: unknown, rtc?: unknown } | null} */ (payload);
    if (!p || typeof p.peer !== 'string' || p.peer === this.peerId) return;
    const now = performance.now();
    let e = this.entries.get(p.peer);
    const isNew = !e;
    if (!e) {
      e = makeEntry(p.peer, from, now);
      this.entries.set(p.peer, e);
    }
    e.user = from;
    e.lastSeen = now;
    e.muted = p.muted === true;
    e.rtc = p.rtc !== false;
    if (this.joined && this.usesRelay(e)) e.connected = true;
    // 新しい人には、すぐ自分の在室を知らせる（その人は全員の在室を待たずに済む）
    if (isNew && this.joined) this.sendPresence();
    if (this.joined) this.maybeCall(e);
    this.render();
  }

  /** @param {unknown} payload */
  onLeave(payload) {
    const p = /** @type {{ peer?: unknown } | null} */ (payload);
    if (!p || typeof p.peer !== 'string') return;
    const e = this.entries.get(p.peer);
    if (!e) return;
    this.closePeer(e);
    this.entries.delete(p.peer);
    this.render();
  }

  // ---- リレー（WebRTC を使えない相手との音声。サーバーの broadcast を通す） ----

  /** この相手とは WebRTC ではなくリレーで話す（どちらかが WebRTC を使えない） */
  usesRelay(/** @type {Entry} */ e) {
    return !hasRtc() || !e.rtc;
  }

  /** 自分の声をリレーで送る必要があるか（1人でもリレーの相手がいる） */
  needRelay() {
    for (const e of this.entries.values()) if (this.usesRelay(e)) return true;
    return false;
  }

  /** マイクの音を取り出して 16kHz に直し、送る。AudioWorklet が使えなければ ScriptProcessor */
  ensureCapture() {
    const ctx = this.ctx;
    const src = this.captureSrc;
    if (this.capture || !ctx || !src) return;
    this.resampler = new Resampler(ctx.sampleRate);
    this.framer = new Framer();
    /** @type {{ stop(): void }} */
    const handle = { stop() {} };
    this.capture = handle;
    /** @param {Float32Array} chunk */
    const onChunk = (chunk) => this.onCapture(chunk);
    // 音を出さずに動かし続けるための出口
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const useScriptProcessor = () => {
      if (this.capture !== handle) return;
      try {
        const node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (ev) => onChunk(new Float32Array(ev.inputBuffer.getChannelData(0)));
        src.connect(node);
        node.connect(sink);
        handle.stop = () => {
          node.onaudioprocess = null;
          node.disconnect();
          sink.disconnect();
        };
      } catch (err) {
        console.error('[voice] マイクの音を取り出せません。リレーで送れません', err);
      }
    };
    try {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet なし');
      const code =
        "class C extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('voice-capture',C)";
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      ctx.audioWorklet
        .addModule(url)
        .then(() => {
          if (this.capture !== handle) return;
          const node = new AudioWorkletNode(ctx, 'voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
          node.port.onmessage = (ev) => onChunk(ev.data);
          src.connect(node);
          node.connect(sink);
          handle.stop = () => {
            node.port.onmessage = null;
            node.disconnect();
            sink.disconnect();
          };
        })
        .catch((err) => {
          console.warn('[voice] AudioWorklet を使えません。ScriptProcessor で代わりにします', err);
          useScriptProcessor();
        })
        .finally(() => URL.revokeObjectURL(url));
    } catch {
      useScriptProcessor();
    }
  }

  stopCapture() {
    try {
      this.capture?.stop();
    } catch {
      /* すでに外れている */
    }
    this.capture = null;
    this.resampler = null;
  }

  /** @param {Float32Array} chunk マイクの音（AudioContext の周波数） */
  onCapture(chunk) {
    if (!this.joined || !this.resampler || !this.needRelay()) return;
    const volume = this.micGain ? 1 : this.settings.micVolume;
    const out = this.resampler.push(chunk);
    for (const frame of this.framer.push(out)) {
      if (this.muted) continue;
      if (volume !== 1) for (let i = 0; i < frame.length; i++) frame[i] *= volume;
      const now = performance.now();
      if (rms(frame) > RELAY_SILENCE) this.relayLoudAt = now;
      else if (now - this.relayLoudAt > RELAY_HOLD_MS) continue;
      this.broadcast(EV_AUDIO, { peer: this.peerId, seq: this.relaySeq++, pcm: pcmToBase64(floatToInt16(frame)) });
    }
  }

  /** @param {unknown} payload */
  onRelayAudio(payload) {
    const p = /** @type {{ peer?: unknown, pcm?: unknown } | null} */ (payload);
    const ctx = this.ctx;
    if (!this.joined || !ctx || !p || typeof p.peer !== 'string' || p.peer === this.peerId) return;
    const e = this.entries.get(p.peer);
    // 双方が WebRTC を使えるなら、そちらで聞こえている
    if (!e || !this.usesRelay(e) || e.muted || e.localMuted || this.deafened) return;
    const pcm = base64ToPcm(p.pcm);
    if (!pcm) return;
    try {
      if (!e.relay) {
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        gain.connect(ctx.destination);
        gain.connect(analyser);
        e.relay = { gain, meter: makeMeter(analyser), st: { next: 0 } };
        this.applyEntryAudio(e);
      }
      const buf = ctx.createBuffer(1, pcm.length, RELAY_RATE);
      buf.getChannelData(0).set(int16ToFloat(pcm));
      const at = scheduleFrame(e.relay.st, ctx.currentTime, pcm.length / RELAY_RATE);
      if (at === null) return;
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(e.relay.gain);
      node.start(at);
    } catch (err) {
      console.warn('[voice] リレーの音を鳴らせません', err);
    }
  }

  // ---- WebRTC ----

  rtcConfig() {
    /** @type {RTCConfiguration} */
    const config = { iceServers: [] };
    const stun = this.settings.stun.trim();
    if (stun) config.iceServers = [{ urls: stun }];
    return config;
  }

  /** @param {Entry} e */
  makePc(e) {
    this.closePc(e);
    const pc = new RTCPeerConnection(this.rtcConfig());
    e.pc = pc;
    e.pcStartedAt = performance.now();
    e.pendingIce = [];
    e.connected = false;
    const peer = e.id;
    const send = this.sendStream ?? this.localStream;
    for (const t of send?.getTracks() ?? []) pc.addTrack(t, /** @type {MediaStream} */ (send));
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signal(peer, { kind: 'ice', candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      if (e.pc !== pc) return;
      this.attachRemote(e, ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.onconnectionstatechange = () => {
      if (e.pc !== pc) return;
      e.connected = pc.connectionState === 'connected';
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.closePc(e);
      this.render();
    };
    return pc;
  }

  /** 自分の peer ID が小さい相手にだけ offer を出す */
  /** @param {Entry} e */
  maybeCall(e) {
    if (!this.joined || !this.localStream || e.pc || this.peerId >= e.id || this.usesRelay(e)) return;
    if (performance.now() < e.nextCallAt) return;
    void this.call(e);
  }

  /** @param {Entry} e */
  async call(e) {
    const pc = this.makePc(e);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.signal(e.id, { kind: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp });
    } catch (err) {
      console.error('[voice] offer を作れませんでした', err);
      this.closePc(e);
    }
  }

  /**
   * @param {string} to
   * @param {Record<string, unknown>} body
   */
  signal(to, body) {
    this.broadcast(EV_SIGNAL, { from: this.peerId, to, ...body });
  }

  /**
   * @param {unknown} payload
   * @param {Disnans.User} user
   */
  async onSignal(payload, user) {
    const p = /** @type {{ from?: unknown, to?: unknown, kind?: unknown, sdp?: unknown, candidate?: unknown } | null} */ (payload);
    if (!this.joined || !hasRtc() || !p || p.to !== this.peerId || typeof p.from !== 'string') return;
    let e = this.entries.get(p.from);
    if (!e) {
      // 在室より先に届いた。在室として覚えておく（次のハートビートで更新される）
      e = makeEntry(p.from, user, performance.now());
      this.entries.set(p.from, e);
    }
    try {
      if (p.kind === 'offer' && typeof p.sdp === 'string') {
        // 新しい offer は、古い接続を置き換える（相手が入り直した・やり直した）
        const pc = this.makePc(e);
        await pc.setRemoteDescription({ type: 'offer', sdp: p.sdp });
        await this.flushIce(e, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.signal(e.id, { kind: 'answer', sdp: pc.localDescription?.sdp ?? answer.sdp });
      } else if (p.kind === 'answer' && typeof p.sdp === 'string' && e.pc) {
        const pc = e.pc;
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: 'answer', sdp: p.sdp });
        await this.flushIce(e, pc);
      } else if (p.kind === 'ice' && p.candidate && typeof p.candidate === 'object') {
        const cand = /** @type {RTCIceCandidateInit} */ (p.candidate);
        if (e.pc && e.pc.remoteDescription) await e.pc.addIceCandidate(cand);
        else e.pendingIce.push(cand);
      }
    } catch (err) {
      console.error('[voice] シグナリングで例外', err);
    }
    this.render();
  }

  /**
   * @param {Entry} e
   * @param {RTCPeerConnection} pc
   */
  async flushIce(e, pc) {
    const list = e.pendingIce;
    e.pendingIce = [];
    for (const c of list) {
      try {
        await pc.addIceCandidate(c);
      } catch (err) {
        console.warn('[voice] ICE を追加できません', err);
      }
    }
  }

  /**
   * @param {Entry} e
   * @param {MediaStream} stream
   */
  attachRemote(e, stream) {
    e.stream = stream;
    if (!e.audio) {
      const audio = new Audio();
      audio.autoplay = true;
      e.audio = audio;
    }
    e.audio.srcObject = stream;
    this.applyEntryAudio(e);
    e.audioDetach ??= audio?.attach(e.audio) ?? null;
    void e.audio.play().catch((err) => console.warn('[voice] 再生できません', err));
    if (this.ctx) {
      try {
        e.meter = makeMeter(this.ctx.createAnalyser());
        this.ctx.createMediaStreamSource(stream).connect(e.meter.analyser);
      } catch (err) {
        console.warn('[voice] 音量を見られません', err);
      }
    }
  }

  /** @param {Entry} e */
  closePc(e) {
    const pc = e.pc;
    if (pc) e.nextCallAt = performance.now() + 3000;
    e.pc = null;
    e.connected = false;
    e.pendingIce = [];
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* すでに閉じている */
      }
    }
    e.audioDetach?.();
    e.audioDetach = null;
    if (e.audio) {
      e.audio.srcObject = null;
      e.audio = null;
    }
    e.stream = null;
    e.meter = null;
  }

  /** @param {Entry} e */
  closePeer(e) {
    this.closePc(e);
    e.relay = null;
  }

  // ---- 画面（ステータス欄） ----

  /** 通話中の通知の文言とボタン（Android）。人数は自分を含む */
  notificationContent() {
    const count = 1 + [...this.entries.values()].length;
    const states = [this.muted ? 'ミュート中' : '通話中'];
    if (this.deafened) states.push('スピーカーミュート中');
    return {
      title: 'ボイスチャット',
      text: `${states.join('・')} ・ ${count}人`,
      actions: [
        { id: 'mute', title: this.muted ? 'ミュート解除' : 'ミュート' },
        { id: 'deafen', title: this.deafened ? 'スピーカー解除' : 'スピーカーミュート' },
        { id: 'hangup', title: '切断', dismiss: true },
      ],
    };
  }

  /** 人数やミュートが変わったら、通知を差し替える */
  updateNotification() {
    if (!this.background) return;
    const content = this.notificationContent();
    const key = JSON.stringify(content);
    if (key === this.notifyKey) return;
    this.notifyKey = key;
    this.background.update(content);
  }

  /** 構造が変わったときだけ作り直し、しゃべっている表示は class だけ付け替える */
  render() {
    if (!this.bar) return;
    const entries = [...this.entries.values()].sort((a, b) => (a.user.id + a.id).localeCompare(b.user.id + b.id));
    const showMe = this.joined || this.joining;
    const sig = JSON.stringify([
      this.joined,
      this.joining,
      this.muted,
      this.deafened,
      this.outputs,
      this.app.me.id,
      entries.map((e) => [e.id, e.user.display_name, e.user.avatar_url, e.muted, e.localMuted, e.connected, e.rtc]),
    ]);
    if (sig !== this.structureSig) {
      this.structureSig = sig;
      this.buildBar(entries, showMe);
      this.updateNotification();
    }
    this.bar.querySelector('[data-peer="me"]')?.classList.toggle('voice-speaking', !!this.localMeter?.speaking && !this.muted);
    for (const e of entries) {
      this.bar
        .querySelector(`[data-peer="${e.id}"]`)
        ?.classList.toggle('voice-speaking', !!(e.meter ?? e.relay?.meter)?.speaking && !e.muted && !e.localMuted);
    }
  }

  /**
   * @param {Entry[]} entries
   * @param {boolean} showMe
   */
  buildBar(entries, showMe) {
    const bar = this.bar;
    if (!bar) return;
    if (entries.length === 0 && !showMe) {
      bar.replaceChildren();
      return;
    }
    const root = h('div', 'voice-bar');
    const label = h('span', this.joined ? 'voice-label voice-label-live' : 'voice-label');
    label.append(ui.icon('voice-wave', { size: 16 }), document.createTextNode(this.joined ? '通話中' : '通話'));
    root.append(label);

    const people = h('div', 'voice-people');
    if (showMe) people.append(this.personEl('me', this.app.me, { muted: this.muted, connecting: this.joining, self: true }));
    for (const e of entries) {
      people.append(this.personEl(e.id, e.user, { muted: e.muted, localMuted: e.localMuted, connecting: this.joined && !e.connected, entry: e }));
    }
    root.append(people);

    const controls = h('div', 'voice-controls');
    if (this.joined) {
      const mute = ui.button({
        icon: this.muted ? 'mic-off' : 'mic',
        label: this.muted ? 'ミュートを解除' : 'ミュート',
        variant: 'ghost',
        onClick: () => this.toggleMute(),
      });
      mute.classList.toggle('voice-active', this.muted);
      mute.title = this.muted ? 'ミュートを解除' : 'ミュート';
      const deafen = ui.button({
        icon: this.deafened ? 'volume-x' : 'volume-2',
        label: this.deafened ? 'スピーカーミュートを解除' : 'スピーカーミュート',
        variant: 'ghost',
        onClick: () => this.toggleDeafen(),
      });
      deafen.classList.toggle('voice-active', this.deafened);
      deafen.title = this.deafened ? 'スピーカーミュートを解除' : 'スピーカーミュート（相手の声を全部消す）';
      controls.append(mute, deafen);
      // 出力先の変更は設定画面へ（バーには出さない）
      if (this.canOpenSettings()) {
        const settings = ui.button({ icon: 'settings', label: 'ボイスチャットの設定', variant: 'ghost', onClick: () => this.openPluginSettings() });
        settings.title = 'ボイスチャットの設定';
        controls.append(settings);
      }
      // 退出は右端に、危険色で置く
      const leave = ui.button({ icon: 'phone-off', label: '通話から抜ける', variant: 'ghost', onClick: () => this.leave() });
      leave.title = '通話から抜ける';
      leave.classList.add('voice-leave');
      controls.append(leave);
    } else if (!this.joining) {
      controls.append(ui.button({ text: '参加', icon: 'phone', variant: 'primary', onClick: () => void this.join() }));
    }
    root.append(controls);
    bar.replaceChildren(root);
  }

  /**
   * @param {string} key
   * @param {Disnans.User} user
   * @param {{ muted?: boolean, localMuted?: boolean, connecting?: boolean, self?: boolean, entry?: Entry }} o
   */
  personEl(key, user, o) {
    const b = h('button');
    b.type = 'button';
    b.className = 'voice-person';
    b.dataset.peer = key;
    const name = user.display_name || '不明なユーザー';
    if (user.avatar_url) {
      const img = h('img');
      img.src = user.avatar_url;
      img.alt = '';
      img.draggable = false;
      b.append(img);
    } else {
      b.append(h('span', '', Array.from(name)[0] ?? '?'));
    }
    if (o.muted) b.classList.add('voice-muted');
    if (o.localMuted) b.classList.add('voice-local-muted');
    if (o.connecting) b.classList.add('voice-connecting');
    if (o.muted || o.localMuted) {
      const badge = h('span', 'voice-badge');
      badge.append(ui.icon(o.localMuted ? 'volume-x' : 'mic-off', { size: 9 }));
      b.append(badge);
    }
    const entry = o.entry;
    if (o.self) {
      b.title = `${name}（自分）${o.muted ? ' ・ミュート中' : ''}`;
      b.onclick = () => this.toggleMute();
    } else if (entry) {
      b.title = `${name}${entry.muted ? '（ミュート中）' : ''} ・押すと自分の側だけ${entry.localMuted ? '音を戻す' : '消音する'}`;
      b.onclick = () => {
        entry.localMuted = !entry.localMuted;
        this.applyEntryAudio(entry);
        this.render();
      };
    }
    b.setAttribute('aria-label', b.title);
    return b;
  }
}
