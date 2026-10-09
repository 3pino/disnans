// @ts-check
/// <reference path="../../packages/plugin-sdk/index.d.ts" />

/*
 * ボイスチャット: 「いつでも出たり入ったりできる」みんな共通の音声通話（部屋は1つ、音声のみ）。
 *
 * できること:
 * 1. 参加すると、同じ部屋にいる全員と WebRTC で直接つながる（メッシュ。10人ほどまで。Tailscale 内なので STUN/TURN は基本不要）
 * 2. 画面の下端のステータス欄に、いま通話にいる人のアイコンが出る（参加していない人にも見える）。しゃべっている人は枠が光る
 * 3. ミュート、退出、相手のアイコンを押すと自分の側でだけその人を消音
 * 4. コマンド（パレット・`/vc-join` `/vc-leave` `/vc-mute`・ショートカット）と「＋」メニューからも操作できる
 * 5. Android では、通話中の通知に「ミュート」「切断」のボタンが出る（アプリが裏にいても押せる。ミュート中は「ミュート解除」に変わり、本文に人数が出る）
 *
 * しくみ:
 * - 在室の管理とシグナリング（offer / answer / ICE）は、すべて this.broadcast / this.onBroadcast（API v3）で行う。
 *   サーバーには何も保存しない。参加者は 3 秒ごとに在室を知らせ（ハートビート）、12 秒途絶えた人は落ちたと見なして外す
 * - 常時表示は this.addStatusBarItem()（API v3）、画面を切っても通話を続けるのは this.holdBackground()（API v3。Android）。通知のボタンと文言の更新は holdBackground の actions / onAction / update（API v4）
 * - 同じ相手と同時に offer を出し合わないよう、peer ID が小さいほうだけが offer を出す
 *
 * 使っている API: addCommand / addComposerAction / addSettingTab / loadData / saveData / registerInterval /
 *   broadcast / onBroadcast / addStatusBarItem / holdBackground / ui.*
 */

const { Plugin, ui } = disnans;

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

/** broadcast のイベント名 */
const EV_PRESENCE = 'presence';
const EV_LEAVE = 'leave';
const EV_SIGNAL = 'signal';

const DEFAULT_SETTINGS = { stun: '', joinMuted: false };

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
 * @property {HTMLAudioElement | null} audio
 * @property {Meter | null} meter
 * @property {boolean} localMuted 自分の側だけで消音している
 * @property {boolean} connected 音声がつながったか
 * @property {number} nextCallAt この時刻までは offer を出し直さない（失敗が続いても連打しない）
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
    lastSeen: now,
    pc: null,
    pcStartedAt: 0,
    pendingIce: [],
    stream: null,
    audio: null,
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
  /** @type {typeof DEFAULT_SETTINGS} */
  settings = { ...DEFAULT_SETTINGS };
  /** 通話にいる、自分以外の接続（参加していなくても、在室の表示のために覚える） @type {Map<string, Entry>} */
  entries = new Map();
  joined = false;
  joining = false;
  peerId = '';
  muted = false;
  /** @type {MediaStream | null} */
  localStream = null;
  /** @type {AudioContext | null} */
  ctx = null;
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
    }
    return s;
  }

  /**
   * @template {keyof typeof DEFAULT_SETTINGS} K
   * @param {K} key
   * @param {(typeof DEFAULT_SETTINGS)[K]} value
   */
  async setSetting(key, value) {
    this.settings[key] = value;
    await this.saveData(this.settings);
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
    ui.setting(containerEl, {
      name: 'STUN サーバー（任意）',
      description: 'Tailscale の中なら空のままで大丈夫です。つながらないときだけ、stun:stun.l.google.com:19302 のように入れます',
      icon: 'server',
      control: ui.input({
        value: this.settings.stun,
        placeholder: 'stun:…',
        onChange: (v) => void this.setSetting('stun', v.trim()),
      }),
    });
  }

  // ---- 参加・退出 ----

  async join() {
    if (this.joined || this.joining) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof RTCPeerConnection === 'undefined') {
      ui.toast('この環境ではマイクを使えません（アプリ版で使ってください）', 'error');
      return;
    }
    this.joining = true;
    this.render();
    try {
      /** @type {MediaStream} */
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
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
      this.localMeter = makeMeter(this.ctx.createAnalyser());
      this.ctx.createMediaStreamSource(stream).connect(this.localMeter.analyser);

      this.peerId = randomId();
      this.muted = this.settings.joinMuted;
      this.applyMute();
      this.joined = true;
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
    this.stopWorker();
    for (const e of this.entries.values()) this.closePeer(e);
    // 参加していない間も、いま通話にいる人の表示は続ける（落ちた人は tick が外す）
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.localMeter = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.background?.();
    this.background = null;
    this.render();
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
      // 足りない接続を張る
      for (const e of this.entries.values()) this.maybeCall(e);
      // 音量
      if (this.localMeter && updateMeter(this.localMeter, now, this.muted)) changed = true;
      for (const e of this.entries.values()) {
        if (e.meter && updateMeter(e.meter, now, e.muted || e.localMuted)) changed = true;
      }
    }

    if (changed) this.render();
  }

  // ---- 在室 ----

  sendPresence() {
    this.broadcast(EV_PRESENCE, { peer: this.peerId, muted: this.muted });
  }

  /**
   * @param {unknown} payload
   * @param {Disnans.User} from
   */
  onPresence(payload, from) {
    const p = /** @type {{ peer?: unknown, muted?: unknown } | null} */ (payload);
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
    for (const t of this.localStream?.getTracks() ?? []) pc.addTrack(t, /** @type {MediaStream} */ (this.localStream));
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
    if (!this.joined || !this.localStream || e.pc || this.peerId >= e.id) return;
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
    if (!this.joined || !p || p.to !== this.peerId || typeof p.from !== 'string') return;
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
    e.audio.muted = e.localMuted;
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
  }

  // ---- 画面（ステータス欄） ----

  /** 通話中の通知の文言とボタン（Android）。人数は自分を含む */
  notificationContent() {
    const count = 1 + [...this.entries.values()].length;
    const state = this.muted ? 'ミュート中' : '通話中';
    return {
      title: 'ボイスチャット',
      text: `${state} ・ ${count}人`,
      actions: [
        { id: 'mute', title: this.muted ? 'ミュート解除' : 'ミュート' },
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
      this.app.me.id,
      entries.map((e) => [e.id, e.user.display_name, e.user.avatar_url, e.muted, e.localMuted, e.connected]),
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
        ?.classList.toggle('voice-speaking', !!e.meter?.speaking && !e.muted && !e.localMuted);
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
      const leave = ui.button({ icon: 'phone-off', label: '通話から抜ける', variant: 'ghost', onClick: () => this.leave() });
      leave.title = '通話から抜ける';
      controls.append(mute, leave);
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
        if (entry.audio) entry.audio.muted = entry.localMuted;
        this.render();
      };
    }
    b.setAttribute('aria-label', b.title);
    return b;
  }
}
