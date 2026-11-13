import type { CallMember } from '../protocol/CallMember';
import type { ServerEvent } from '../protocol/ServerEvent';
import { EV_AUDIO } from './pure';
import { ScreenShareStore } from './screen/store.svelte';
import { EmitQueue } from './emitQueue';
import { CallExtensions } from './extensions.svelte';
import { CallOutputs } from './outputs';
import { NativeCallEngine } from './nativeEngine';
import { WebCallEngine } from './webEngine';
import type {
  BarButton,
  BarButtonDef,
  CallDataEvent,
  CallDeps,
  CallEngine,
  CallHost,
  CallPanelDef,
  CallParticipant,
  PeerView,
} from './types';

export type { BarButton, BarButtonDef, CallDataEvent, CallDeps, CallPanelDef, CallPanelEntry, CallParticipant } from './types';

// 通話（みんな共通の1部屋）の状態機械。参加者の一覧・kick・音声の中継はサーバー（call.* イベント）が受け持つ。
// ここは状態（参加・ミュート・参加者・話している人）と、プラグイン・画面共有への窓口を持つ。
// 音声とシグナリングはエンジンに任せる（CallEngine。デバイスごとに 1 つを、作るときに選ぶ）:
//   Web: webEngine.ts（WebAudio と call.*）／ Android: nativeEngine.ts（ネイティブが所有。状態を写すだけ）。
// 画面は participants などを読むだけで、画面に触れない。

/** プラグインが使えるイベント名。audio は本体の音声が使う */
const RESERVED_EVENTS = new Set([EV_AUDIO]);

export class CallStore implements CallHost {
  // ---- 画面が読む状態（リアクティブ） ----
  /** サーバーが知っている通話の参加者（自分を含む） */
  members = $state.raw<CallMember[]>([]);
  joined = $state(false);
  /** 参加を送ったあと、サーバーの参加者一覧に自分が載ったか（載るまでは「参加中…」。自分のアイコンは出さない） */
  listed = $state(false);
  /** 通話に参加しているあいだ、チャットの接続が切れているか（取りこぼし中） */
  linkDown = $state(false);
  joining = $state(false);
  muted = $state(false);
  /** 相手の声を全部消している（スピーカーミュート）。消しているあいだは、ミュートも入っている（不変条件） */
  deafened = $state(false);
  /** スピーカーミュートを入れたときに、ミュートも一緒に入れた（外すときに一緒に外す）。自分で先に入れていたら false */
  muteByDeafen = false;
  /** 選べる出力先 */
  outputs = $state.raw<Disnans.AudioOutput[]>([]);
  /** 自分の接続の ID（参加していなければ空） */
  peerId = '';
  peerView = $state.raw<Record<string, PeerView>>({});
  selfSpeaking = $state(false);

  private readonly engine: CallEngine;
  private readonly extensions = new CallExtensions((e) => this.engine.reportCallbackError(e));
  private readonly emitQueue = new EmitQueue();
  private readonly output: CallOutputs = new CallOutputs(this);
  private changeSig = '';

  /** 通話に属する画面・カメラ共有。プラグインの有無や画面のマウントには依存しない。 */
  readonly screen: ScreenShareStore | null;

  constructor(readonly deps: CallDeps) {
    this.engine = deps.native ? new NativeCallEngine(this, deps.native) : new WebCallEngine(this);
    this.screen = deps.screen ? new ScreenShareStore({ ...deps.screen, call: this }) : null;
  }

  get settings(): CallDeps['settings']['value'] {
    return this.deps.settings.value;
  }
  get outputControl(): CallOutputs {
    return this.output;
  }

  // ---- 読み取り ----

  /** ネイティブ所有の通話か（このデバイスでは、参加・音はネイティブが行う） */
  get nativeOwned(): boolean {
    return this.engine.nativeOwned;
  }

  get myPeer(): string {
    return this.peerId;
  }

  /** 自分以外の参加者 */
  get others(): CallMember[] {
    return this.members.filter((m) => m.peer !== this.peerId);
  }

  get barButtons(): BarButton[] {
    return this.extensions.barButtons;
  }

  /** 上部のバー用。通話の全画面だけに出すボタンは除く */
  get topBarButtons(): BarButton[] {
    return this.barButtons.filter((b) => b.location !== 'view');
  }

  get panels() {
    return this.extensions.panels;
  }

  /** 通話のバーを出すか（参加中、またはだれかがいる） */
  get visible(): boolean {
    return this.joined || this.joining || this.others.length > 0;
  }

  /** 参加を送ったが、まだサーバーの一覧に載っていない */
  get pending(): boolean {
    return this.joined && !this.listed;
  }

  /** 参加者。参加中なら自分が先頭 */
  get participants(): CallParticipant[] {
    const out: CallParticipant[] = [];
    // 自分は、サーバーの一覧に載ってから（入れていないのに自分を出さない）。接続中（joining）は出さない
    if (this.listed && this.joined) {
      out.push({
        peer: this.peerId,
        userId: this.deps.meId(),
        self: true,
        muted: this.muted,
        deafened: this.deafened,
        connected: this.joined,
        speaking: this.selfSpeaking && !this.muted,
        localMuted: false,
        device: this.deps.deviceKind(),
      });
    }
    for (const m of this.others) {
      const v = this.peerView[m.peer];
      out.push({
        peer: m.peer,
        userId: m.user_id,
        self: false,
        muted: m.status.muted,
        deafened: m.status.deafened,
        connected: true,
        speaking: (v?.speaking ?? false) && !m.status.muted && !v?.localMuted,
        localMuted: v?.localMuted ?? false,
        device: m.status.device,
      });
    }
    return out;
  }

  /** WebSocket でまだ送り出せていないバイト数。映像を送るプラグインは、多いあいだ次のフレームを待つ */
  get bufferedAmount(): number {
    return this.engine.bufferedAmount;
  }

  // ---- エンジンへの窓口 ----

  /** 起動のとき1回。ネイティブの回復中・参加中の通話を、画面が採用する（読むだけ。参加も開始もしない） */
  adoptNative(): Promise<void> {
    return this.engine.adopt();
  }
  /** 接続先が変わった（設定の読み込み・変更）。ネイティブの通話だけが、必要なら止める */
  onServerChanged(): void {
    this.engine.onServerChanged();
  }
  /** client.subscribe から受け取る */
  onServerEvent(ev: ServerEvent): void {
    this.engine.onServerEvent(ev);
  }
  /** チャットの接続が切れた・戻った（client.subscribeLink） */
  onLink(up: boolean): void {
    this.engine.onLink(up);
  }
  join(): Promise<void> {
    return this.engine.join();
  }
  /** 抜ける。sendLeave が false なのは、サーバーに外されたとき */
  leave(sendLeave = true, reason = 'user'): void {
    this.screen?.stop();
    this.engine.leave(sendLeave, reason);
  }
  toggleMute(): void {
    if (this.notJoined()) return;
    this.engine.toggleMute();
  }
  toggleDeafen(): void {
    if (this.notJoined()) return;
    this.engine.toggleDeafen();
  }
  /** 相手1人を、自分の側だけで消音する／戻す */
  toggleLocalMute(peer: string): void {
    this.engine.toggleLocalMute(peer);
  }
  applyMicVolume(): void {
    this.engine.applyMicVolume();
  }
  applyOutVolume(): void {
    this.engine.applyOutVolume();
  }
  tick(): void {
    this.engine.tick();
  }

  /** 参加者を通話から外す（確認のあと、サーバーに頼む。外された人には call.kicked が届く） */
  async kick(peer: string): Promise<void> {
    const m = this.others.find((x) => x.peer === peer);
    // 一覧に載る前は、サーバーは自分を参加者と見ていない（not_in_call になる）
    if (!this.joined || !this.listed || !m) return;
    const name = this.deps.nameOf(m.user_id);
    const ok = await this.deps.confirm({
      title: `${name}さんを通話から外しますか？`,
      body: '相手の通話は切れます。相手はまた参加できます。',
      okLabel: '外す',
      danger: true,
    });
    if (!ok || !this.joined) return;
    this.engine.kick(peer);
  }

  private notJoined(): boolean {
    if (this.joined) return false;
    this.deps.toast('通話に参加していません', 'error');
    return true;
  }

  // ---- 音の出力先 ----

  refreshOutputs(): Promise<void> {
    return this.output.refresh();
  }
  chooseOutput(id: string): Promise<void> {
    return this.output.choose(id);
  }
  cycleOutput(): Promise<void> {
    return this.output.cycle();
  }

  // ---- 拡張 API（プラグインから: disnans.call） ----

  /** 通話の参加者全員に、データを送る（サーバー経由。保存しない）。通話に参加していなければ例外 */
  emit(name: string, payload: unknown): void {
    if (!this.joined) throw new Error('通話に参加していません');
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) throw new Error('イベント名は 1〜64 文字にしてください');
    if (RESERVED_EVENTS.has(name)) throw new Error(`イベント名 ${name} は本体が使います`);
    // 一覧に載るまでは積んでおく（載ったら順に送る）
    if (!this.listed) {
      this.emitQueue.push(name, payload);
      return;
    }
    this.engine.emit(name, payload);
  }

  /** 参加者が emit したデータを受け取る。戻り値の関数で外す */
  onEvent(name: string, cb: (e: CallDataEvent) => void): Disnans.Cleanup {
    return this.extensions.onEvent(name, cb);
  }
  onChange(cb: () => void): Disnans.Cleanup {
    return this.extensions.onChange(cb);
  }
  /** 通話のバーにボタンを足す。返り値で更新・削除 */
  addBarButton(def: BarButtonDef): { update(patch: Partial<BarButtonDef>): void; remove(): void } {
    return this.extensions.addBarButton(def);
  }
  /** 通話の画面（全画面の通話タブ）に、プラグインの領域を足す */
  addPanel(def: CallPanelDef): Disnans.CallPanel {
    return this.extensions.addPanel(def);
  }
  /** 通話の画面が、領域の要素を文書に入れた・外した（CallView から呼ぶ） */
  panelMounted(id: number, mounted: boolean): void {
    this.extensions.panelMounted(id, mounted);
  }

  // ---- エンジンから（CallHost） ----

  flushEmits(): void {
    this.emitQueue.flush((name, payload) => this.engine.emit(name, payload));
  }
  dropEmits(): void {
    this.emitQueue.drop();
  }
  dispatch(name: string, event: CallDataEvent): void {
    this.screen?.onEvent(name, event);
    this.extensions.deliver(name, event);
  }
  stopScreen(): void {
    this.screen?.stop();
  }

  /** 状態が変わった: 話している表示・通知・画面共有・購読者を更新する */
  refresh(): void {
    this.engine.syncView();
    this.engine.updateNotification();
    this.screen?.onCallChange();
    const sig = JSON.stringify([this.joined, this.joining, this.participants.map((p) => [p.peer, p.userId, p.muted, p.deafened, p.connected, p.localMuted, p.speaking, p.device])]);
    if (sig === this.changeSig) return;
    this.changeSig = sig;
    this.extensions.notifyChange();
  }
}
