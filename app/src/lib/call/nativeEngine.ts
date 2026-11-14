import type { ServerEvent } from '../protocol/ServerEvent';
import { canonicalServerUrl } from '../config';
import { mirrorOf, type NativeCallPort, type NativeControlPatch, type NativeError, type NativeRelay, type NativeSettings, type NativeSnapshot } from './native';
import { NativeCallSession } from './nativeSession';
import { EV_AUDIO, joinStateOf } from './pure';

import type { CallEngine, CallHost, PeerView } from './types';

/** プラグインが使えないイベント名。audio は本体の音声が使う */
const RESERVED_EVENTS = new Set([EV_AUDIO]);

/** 音量などを動かしている途中に、ネイティブへ送るまでの間隔（ms） */
const SETTINGS_COALESCE_MS = 50;

/** 接続先が同じか（末尾の / などの書き方の違いは同じとみなす） */
function sameServer(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  try {
    return canonicalServerUrl(a) === canonicalServerUrl(b);
  } catch {
    return false;
  }
}

/** 固定の短い code（英小文字と _ のみ。それ以外は unknown） */
function safeCode(c: unknown): string {
  return typeof c === 'string' && /^[a-z_]{1,32}$/.test(c) ? c : 'unknown';
}

/**
 * Android: ネイティブが参加・音・kick・再接続を持つ。ここは頼む（start / control / kick / emit）と、
 * ネイティブの状態を画面へ写す（判断は持たない。不変条件はネイティブが守る）。
 */
export class NativeCallEngine implements CallEngine {
  readonly nativeOwned = true;
  private readonly session: NativeCallSession;
  /** サーバーの一覧（チャットの接続が見た room の状態。参加していないあいだの表示に使う） */
  private roomMembers: import('../protocol/CallMember').CallMember[] = [];
  private bytes = 0;
  private lastError = '';
  private settingsTimer: ReturnType<typeof setTimeout> | null = null;
  /** 採用・参加の読み込み中か。読み込み中に来た接続先の知らせを覚える */
  private booting = false;
  private changedWhileBooting = false;
  /** ネイティブへ送っていて、まだ返事の来ていない操作（ミュート・スピーカーミュート） */
  private intents = new Map<'muted' | 'deafened', { value: boolean; n: number }>();
  private intentSeq = 0;

  constructor(private readonly h: CallHost, port: NativeCallPort) {
    this.session = new NativeCallSession(port, {
      onSnapshot: (s) => this.apply(s),
      onRelay: (r) => this.onRelay(r),
      onStartFailed: (code) => this.onStartFailed(code),
      onStartUnknown: (code) => h.deps.toast(`通話の状態を確かめられません（コード: ${code}）。通話が続いていれば「通話から抜ける」で止めてください`, 'error'),
      onStopped: () => this.resetView(),
      onStopFailed: () => h.deps.toast('通話を終えられませんでした。もう一度お試しください', 'error'),
    });
    // 動かしている途中の音量は、少しまとめて送る。保存したときは、すぐ送る
    h.deps.settings.onChange?.((kind) => this.syncSettings(kind === 'save'));
  }

  /** 起動のとき1回。ネイティブの回復中・参加中の通話を、画面が採用する（読むだけ。参加も開始もしない） */
  async adopt(): Promise<void> {
    this.beginBoot();
    try {
      await this.session.adopt().catch(() => console.warn('[call] ネイティブの通話の状態を読めませんでした'));
    } finally {
      // 読み込みの前後に接続先が変わっていても、採用のあとに一度だけ確かめる（以後は、変わったときの知らせに任せる）
      this.checkAfterBoot();
    }
  }

  /** 読み込み（採用・参加）の始まり。このあいだに来た接続先の知らせを覚える（まだ通話が無いので、その場では比べない） */
  private beginBoot(): void {
    this.booting = true;
    this.changedWhileBooting = false;
  }

  /**
   * 読み込み（採用・参加）が終わった時点で、採用した通話の接続先と今の接続先を一度だけ比べる。
   * 読み込み中に接続先の変更の知らせが来ていたなら、結果が空（明示的に外した）でも比べる。
   * 知らせが無い空の値は、まだ整っていない値として比べない（同じ接続先の初期化で止めないため）。
   * 状態の更新のたびには比べない（止めようとして失敗が続くのを避ける）。
   */
  private checkAfterBoot(): void {
    const changed = this.changedWhileBooting;
    this.booting = false;
    this.changedWhileBooting = false;
    if (!this.session.active) return;
    if (!changed && (this.h.deps.serverUrl?.() ?? '') === '') return;
    this.onServerChanged();
  }

  /**
   * 接続先が変わった（設定の読み込み・変更）。採用・参加したときの接続先と同じなら何もしない（読み込みで同じ値が入っても止めない）。
   * 違う（空にした・別のサーバーにした）なら、いまの論理セッションだけを止める。新しいサーバーへは自動で入らない
   */
  onServerChanged(): void {
    const s = this.session;
    if (!s.active) {
      // 読み込みの途中なら、知らせを覚えておく（読み込みが終わったあとに比べる）
      if (this.booting) this.changedWhileBooting = true;
      return;
    }
    const captured = s.serverUrl;
    if (captured === null) return;
    if (sameServer(captured, this.h.deps.serverUrl?.() ?? '')) return;
    // 「抜けました」は、ネイティブが停止を受け付けたあとにだけ出す（失敗のときは、失敗の一度だけ出す）
    void this.leaveNative('server-change').then((ok) => {
      if (ok) this.h.deps.toast('接続先が変わったので、通話から抜けました', 'info');
    });
  }

  onServerEvent(ev: ServerEvent): void {
    // 参加・音・kick・再接続はネイティブが行う。チャットの接続からは、参加していないときの一覧だけ使う
    if (ev.type !== 'call.state') return;
    this.roomMembers = ev.members;
    if (!this.h.joined && !this.h.joining) this.h.members = ev.members;
    this.h.refresh();
  }

  /** ネイティブ所有の通話は、チャットの接続が切れても（再接続を含め）止めない。表示はネイティブの linkUp に従う */
  onLink(): void {}

  /** ネイティブへ参加を頼む。画面は、ネイティブが受け付けた状態（joining）と、確かめた参加（joined）に従う */
  async join(): Promise<void> {
    const h = this.h;
    const s = this.session;
    if (h.joined || h.joining || s.active) return;
    const me = h.deps.meId();
    if (!me) {
      h.deps.toast('サーバーに接続できてから参加してください', 'error');
      return;
    }
    h.joining = true;
    h.refresh();
    this.beginBoot();
    try {
      await s.start({
        serverUrl: h.deps.serverUrl?.() ?? '',
        expectedUserId: me,
        devUser: h.deps.devUser?.() ?? null,
        status: { ...joinStateOf(h.settings.joinMode), device: h.deps.deviceKind() },
        settings: this.settings(),
        localMuted: [],
      });
      // 読み込みで回復中の通話を採用していたら、その接続先と今の接続先を一度だけ確かめる
      this.checkAfterBoot();
    } finally {
      this.booting = false;
      if (!s.active && h.joining) {
        h.joining = false;
        h.refresh();
      }
    }
  }

  leave(_sendLeave: boolean, reason: string): void {
    void this.leaveNative(reason);
  }

  /** 止める。受け付けられたら true（失敗・すでに止めている最中は false。失敗の知らせは停止の側が出す） */
  private leaveNative(reason: string): Promise<boolean> {
    this.h.stopScreen();
    const s = this.session;
    if (!(s.active || this.h.joined || this.h.joining)) return Promise.resolve(false);
    // 停止の完了（ack）まで画面は残す。受け付けたら onStopped で空にする
    return s.stop(reason);
  }

  /** 送っているあいだの、その項目の目標の値（無ければ画面の値） */
  private intent(key: 'muted' | 'deafened', shown: boolean): boolean {
    return this.intents.get(key)?.value ?? shown;
  }

  /** 操作を送る。送り終わるまでの押しは、この値を基にする（同じ値を二度送らない） */
  private sendIntent(key: 'muted' | 'deafened', value: boolean, patch: NativeControlPatch): void {
    const n = ++this.intentSeq;
    this.intents.set(key, { value, n });
    void this.session.control(patch).finally(() => {
      if (this.intents.get(key)?.n === n) this.intents.delete(key);
    });
  }

  /** 変えるのはネイティブ（スピーカーミュートとの関係も、そこで決まる）。送っているあいだの押しは、送った値を基にする */
  toggleMute(): void {
    const next = !this.intent('muted', this.h.muted);
    this.sendIntent('muted', next, { muted: next });
  }

  toggleDeafen(): void {
    const next = !this.intent('deafened', this.h.deafened);
    this.sendIntent('deafened', next, { deafened: next });
  }

  toggleLocalMute(peer: string): void {
    if (!this.h.others.some((m) => m.peer === peer)) return;
    void this.session.control({ peerMute: { peer, muted: !(this.h.peerView[peer]?.localMuted ?? false) } });
  }

  kick(peer: string): void {
    void this.session.kick(peer);
  }

  emit(name: string, payload: unknown): void {
    void this.session.emit(name, payload);
  }

  get bufferedAmount(): number {
    return this.bytes;
  }

  /** ネイティブの通話を止めた（画面を空にする）。一覧は、チャットの接続が見たサーバーの状態に戻す */
  private resetView(): void {
    const h = this.h;
    h.dropEmits();
    h.joined = false;
    h.joining = false;
    h.listed = false;
    h.linkDown = false;
    h.muted = false;
    h.deafened = false;
    h.muteByDeafen = false;
    h.peerId = '';
    h.peerView = {};
    h.selfSpeaking = false;
    h.members = this.roomMembers;
    this.bytes = 0;
    h.refresh();
  }

  /** ネイティブの状態を画面へ写す（判断は持たない。不変条件はネイティブが守る） */
  private apply(snap: NativeSnapshot): void {
    const h = this.h;
    const m = mirrorOf(snap);
    const wasListed = h.listed;
    h.joined = m.joined;
    h.joining = m.joining;
    h.listed = m.listed;
    h.linkDown = m.linkDown;
    h.muted = m.muted;
    h.deafened = m.deafened;
    h.muteByDeafen = snap.muteByDeafen;
    h.peerId = m.peer;
    this.bytes = snap.bufferedBytes;
    h.members = m.joined || m.joining ? snap.members : this.roomMembers;
    const view: Record<string, PeerView> = {};
    for (const mem of h.members) {
      if (mem.peer === m.peer) continue;
      view[mem.peer] = { speaking: !!m.speaking[mem.peer], localMuted: m.localMuted.has(mem.peer) };
    }
    h.peerView = view;
    // ネイティブは、自分の声を peer ではなく空の鍵 "" で出す（NativeCallCore.level の peerId == null）
    h.selfSpeaking = !!m.speaking[''];
    if (!m.joined && !m.joining) h.dropEmits();
    else if (!wasListed && h.listed) h.flushEmits();
    this.reportError(snap.error);
    h.refresh();
  }

  /** 同じエラーは一度だけ知らせる。文章（ネイティブの説明）は出さず、固定の短いコードだけを使う */
  private reportError(e: NativeError | null): void {
    const code = e ? safeCode(e.code) : '';
    const key = e ? `${code}|${e.by ?? ''}` : '';
    if (key === this.lastError) return;
    this.lastError = key;
    if (!e) return;
    if (code === 'kicked') this.h.deps.toast(`${this.h.deps.nameOf(e.by ?? '')}さんに通話から外されました`, 'info');
    else this.h.deps.toast(`通話でエラーが起きました（コード: ${code}）`, 'error');
  }

  /** 参加できなかった。原因は固定の短いコードだけを出す */
  private onStartFailed(code: string): void {
    this.h.joining = false;
    this.h.refresh();
    this.h.deps.toast(`通話に参加できませんでした（コード: ${code}）`, 'error');
  }

  /** ネイティブから、非音声の中継（プラグインの emit）が届いた */
  private onRelay(r: NativeRelay): void {
    if (RESERVED_EVENTS.has(r.name)) return;
    this.h.dispatch(r.name, { peer: r.peer, userId: r.from, payload: r.payload });
  }

  private settings(): NativeSettings {
    const s = this.h.settings;
    return {
      micVolume: s.micVolume,
      outVolume: s.outVolume,
      limiter: s.limiter,
      limitDb: s.limitDb,
      rawInput: false,
      outputId: s.output?.id ?? null,
    };
  }

  /**
   * 音量・上限などが変わったら、ネイティブへ送る（参加中だけ）。保存したときはすぐ、動かしている途中は約 50ms まとめる。
   * 送る値は、そのときの最新の設定（途中の値は捨てる）
   */
  private syncSettings(immediate: boolean): void {
    if (this.settingsTimer !== null) {
      clearTimeout(this.settingsTimer);
      this.settingsTimer = null;
    }
    if (immediate) {
      this.session.setSettings(this.settings());
      return;
    }
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = null;
      this.session.setSettings(this.settings());
    }, SETTINGS_COALESCE_MS);
  }

  // 音声・出力先・通知・話している表示は、ネイティブが持つ（状態から直接入る）
  applyMicVolume(): void {}
  applyOutVolume(): void {}
  tick(): void {}
  async restoreOutputs(): Promise<void> {}
  syncView(): void {}
  updateNotification(): void {}
  /** 文章（例外の内容）は出さない（ネイティブ所有の通話では、内容を診断に残さない） */
  reportCallbackError(_e: unknown): void {
    console.error('[call] プラグインのコールバックで例外');
  }
}
