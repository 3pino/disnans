// Android の通話（ネイティブ所有）の、JS 側の窓口。論理セッションの token で、古い開始・停止・出来事を区別する。
// 画面（CallStore）へは、受け付けた snapshot と中継のイベントだけを渡す。マイクや接続は持たない。
// 停止は、ネイティブの停止の完了（ack）で初めて終わったことにする。失敗したら状態を読み直し、生きていれば表示を残す。

import { isLive, newSessionToken, NativeGate, type NativeCallPort, type NativeControlPatch, type NativeRelay, type NativeSettings, type NativeSnapshot, type NativeStartArgs } from './native';

export type NativeSessionHooks = {
  /** ネイティブの状態（世代と通し番号で新しいと判定されたもの） */
  onSnapshot(s: NativeSnapshot): void;
  /** いまの論理セッションの、非音声の中継 */
  onRelay(r: NativeRelay): void;
  /** 参加を頼んだが、確かめた結果ネイティブは参加していない（コードは固定の短い文字列） */
  onStartFailed(code: string): void;
  /** 頼んだ開始の結果が分からない（ネイティブが生きているかもしれない）。画面は残し、止める手段を見せる */
  onStartUnknown(code: string): void;
  /** 停止が完了した（ネイティブが受け付けた）。画面を空にする */
  onStopped(): void;
  /** 停止が完了しなかった。通話はまだ生きている可能性があるので、画面に残す */
  onStopFailed(): void;
};

/** 開始の引数のうち、token と JS が持つ値以外（session は内部で付ける） */
export type NativeStartInput = Omit<NativeStartArgs, 'session'>;

/** 停止した論理セッションの記録の上限（古いものから捨てる） */
const RETIRED_MAX = 16;

/** 例外・拒否の値から、固定の短いコードだけを取り出す（文章や URL は出さない） */
export function errorCode(e: unknown): string {
  const c = typeof e === 'string' ? e : (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]{1,32}$/.test(c) ? c : 'unknown';
}

/** JS の中だけで使う、コードつきの失敗 */
function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export class NativeCallSession {
  private readonly gate = new NativeGate();
  /** いまの論理セッション（開始を頼む前から持つ。止めて確定したら null） */
  private token: string | null = null;
  /** 停止を頼んだ論理セッション（ack まで。ack の前に始めることも、別の状態に入り直すこともしない） */
  private stopToken: string | null = null;
  /** ネイティブへ開始・採用を伝えた（停止は、ネイティブに伝えたものにだけ送る） */
  private issued = false;
  /** ネイティブが生きていると確かめた（開始の応答、または生きている状態） */
  private accepted = false;
  private captured: string | null = null;
  /** 止めたあとで、ネイティブの生きている論理セッション（読み直し・採用の前に止めた場合）。採用の時に止める */
  private stopAfterBoot: string | null = null;
  private readonly retired: string[] = [];
  private bootOk = false;
  private bootstrap: Promise<boolean> | null = null;
  private attaching: Promise<void> | null = null;
  private unlisten: (() => void) | null = null;
  private disposed = false;
  private settingsInFlight = false;
  private settingsNext: Partial<NativeSettings> | null = null;

  constructor(
    private readonly port: NativeCallPort,
    private readonly hooks: NativeSessionHooks,
  ) {}

  /** 論理セッションの token（無ければ null） */
  get session(): string | null {
    return this.token;
  }

  /** 頼んだ開始が返事を返さなかった（生きているかもしれない）。確かめられるまで token を残し、止める手段を残す */
  private unknown = false;

  /** 参加・参加の途中・止める途中のいずれか（新しい開始はできない） */
  get active(): boolean {
    return this.token !== null;
  }

  /** 停止を頼んで、まだ完了していない */
  get stopping(): boolean {
    return this.stopToken !== null;
  }

  /** 採用・開始した論理セッションの、接続先（比べるために使う。不明なら null） */
  get serverUrl(): string | null {
    return this.token === null ? null : this.captured;
  }

  /** 購読を先に始める（snapshot より前）。何度呼んでもよい。破棄されたら、遅れて届いた購読は直ちに外す */
  attach(): Promise<void> {
    this.attaching ??= this.port
      .listen((ev) => {
        if (this.disposed) return;
        if (ev.kind === 'state') this.apply(ev.snapshot);
        else this.onRelay(ev);
      })
      .then((off) => {
        if (this.disposed) off();
        else this.unlisten = off;
      })
      .catch((e) => {
        this.attaching = null;
        throw coded(errorCode(e));
      });
    return this.attaching;
  }

  /** 起動のとき1回。読むだけ（ネイティブのサービスを始めない）。回復中・参加中なら採用する */
  async adopt(): Promise<void> {
    await this.ensureBootstrap();
  }

  /**
   * 参加を頼む。token は await の前に作る（その token の開始・停止だけを確かに区別する）。
   * 読み込みが終わるまで開始は頼まない（回復中の通話を、もう一度始めないため）。
   */
  async start(input: NativeStartInput): Promise<void> {
    if (this.token !== null) return;
    const t = newSessionToken();
    this.token = t;
    this.issued = false;
    this.accepted = false;
    this.unknown = false;
    this.captured = input.serverUrl;
    try {
      const ok = await this.ensureBootstrap();
      // 読むあいだに、回復中の通話を採用した・止めた場合は、新しく頼まない
      if (this.token !== t) return;
      if (!ok) throw coded('state_unknown');
      this.issued = true;
      const s = await this.port.start({ ...input, session: t });
      if (this.token !== t || this.stopToken === t) return;
      this.accepted = true;
      this.apply(s);
    } catch (e) {
      if (this.token !== t || this.stopToken === t) return;
      const code = errorCode(e);
      // 頼んでいない（読み込みの失敗など）なら、ネイティブは何もしていない
      if (!this.issued) {
        this.clearToken(t);
        this.hooks.onStartFailed(code);
        return;
      }
      // 頼んだあとの失敗: ネイティブは参加を続けているかもしれない。読み直して確かめてから決める（頼み直さない）
      await this.reconcileStart(t, code);
    }
  }

  /**
   * 頼んだ開始が返事を返さなかったあとの確かめ。読むだけ。
   * 同じ論理セッションが生きていれば採用したまま見せる。確かめられずに読めなければ token を残す（通話を隠さない）。
   * 確かに参加していないと分かったときだけ、token を消す。
   */
  private async reconcileStart(t: string, code: string): Promise<void> {
    let s: NativeSnapshot;
    try {
      s = await this.port.snapshot();
    } catch (e) {
      if (this.token !== t || this.stopToken === t) return;
      this.unknown = true;
      this.hooks.onStartUnknown(errorCode(e));
      return;
    }
    if (this.token !== t || this.stopToken === t) return;
    if (!this.gate.acceptRead(s)) {
      // より新しい状態を見たあとの古い読み直し: 確かめられない
      this.unknown = true;
      this.hooks.onStartUnknown(code);
      return;
    }
    const live = isLive(s.phase);
    if (s.session === t && live) {
      this.accepted = true;
      this.unknown = false;
      this.hooks.onSnapshot(s);
      return;
    }
    // ここまでで、この論理セッションが生きているとは確かめられない
    this.clearToken(t);
    if (live && s.session !== null && !this.retired.includes(s.session)) {
      this.takeOver(s);
      this.hooks.onSnapshot(s);
      return;
    }
    this.hooks.onSnapshot(s);
    this.hooks.onStartFailed(code);
  }

  /**
   * 止める。ネイティブへ停止を伝えていないなら、何も送らず直ちに画面を空にする。
   * 伝えていたら、ネイティブの完了（ack）を待つ。失敗したら状態を読み直し、生きていれば残す。
   */
  /**
   * 止める。受け付けられた（ネイティブへ伝えなくてよい・ack があった）なら true。失敗・止めている最中なら false。
   */
  async stop(reason: string): Promise<boolean> {
    const t = this.token;
    if (t === null) return false;
    if (this.stopToken !== null) return false; // 停止は、いま頼んだものだけ（二重に送らない）
    if (!this.issued) {
      this.clearToken(t);
      // 読み込み中なら、後で見つかる回復中の通話を、この停止で止める
      if (this.bootstrap) this.stopAfterBoot = reason;
      this.hooks.onStopped();
      return true;
    }
    this.stopToken = t;
    try {
      await this.port.stop(t, reason);
      if (this.stopToken === t) {
        this.stopToken = null;
        this.clearToken(t);
        this.hooks.onStopped();
      }
      return true;
    } catch (e) {
      if (this.stopToken !== t) return false;
      this.stopToken = null;
      console.warn(`[call] ネイティブの停止を確かめられませんでした（${errorCode(e)}）`);
      this.hooks.onStopFailed();
      await this.reread();
      return false;
    }
  }

  async control(patch: NativeControlPatch): Promise<void> {
    const t = this.token;
    if (t === null) return;
    await this.port.control(t, patch).catch(() => console.warn('[call] ネイティブへ操作を送れませんでした'));
  }

  /**
   * 音量・上限などの設定。送っているあいだに来た分は、最後の値にまとめて、続けて1回だけ送る（同時に1つ）。
   * ミュートや退出のような操作は、ここを通さない（すぐに送る）
   */
  setSettings(patch: Partial<NativeSettings>): void {
    this.settingsNext = { ...this.settingsNext, ...patch };
    if (!this.settingsInFlight) void this.pumpSettings();
  }

  async kick(peer: string): Promise<void> {
    const t = this.token;
    if (t === null) return;
    await this.port.kick(t, peer).catch(() => console.warn('[call] ネイティブで外せませんでした'));
  }

  async emit(name: string, payload: unknown): Promise<void> {
    const t = this.token;
    if (t === null) return;
    await this.port.emit(t, name, payload).catch(() => console.warn('[call] ネイティブへ送れませんでした'));
  }

  /** 破棄（購読を外す）。遅れて届く購読も、外す・捨てる。ネイティブの通話は止めない */
  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlisten = null;
  }

  private async pumpSettings(): Promise<void> {
    const t = this.token;
    const patch = this.settingsNext;
    this.settingsNext = null;
    if (t === null || this.stopToken !== null || patch === null) return;
    this.settingsInFlight = true;
    try {
      await this.port.control(t, { settings: patch }).catch(() => console.warn('[call] ネイティブへ設定を送れませんでした'));
    } finally {
      this.settingsInFlight = false;
    }
    if (this.settingsNext !== null) void this.pumpSettings();
  }

  /** 読み込み（一度だけ。失敗したら次の開始・採用で読み直す） */
  private ensureBootstrap(): Promise<boolean> {
    if (this.bootOk) return Promise.resolve(true);
    this.bootstrap ??= this.runBootstrap().finally(() => {
      this.bootstrap = null;
    });
    return this.bootstrap;
  }

  private async runBootstrap(): Promise<boolean> {
    try {
      await this.attach();
      const s = await this.port.snapshot();
      this.bootOk = true;
      this.apply(s);
      return true;
    } catch (e) {
      console.warn(`[call] ネイティブの通話の状態を読めませんでした（${errorCode(e)}）`);
      return false;
    } finally {
      // 読み込みで採用されたときは、採用の時点で使われている。見つからなければ、止める対象は無い
      this.stopAfterBoot = null;
    }
  }

  /** 停止を頼んだあと、確かめるために状態を読み直す（生きていれば残し、止まっていれば終える） */
  private async reread(): Promise<void> {
    try {
      this.apply(await this.port.snapshot());
    } catch (e) {
      console.warn(`[call] ネイティブの通話の状態を読めませんでした（${errorCode(e)}）`);
    }
  }

  /** ネイティブの状態。世代と通し番号で新しいものだけ見る。どの論理セッションに当たるかで扱いを決める */
  private apply(s: NativeSnapshot): void {
    if (!this.gate.accept(s)) return;
    const live = isLive(s.phase);
    const t = this.token;

    // 何も持っていない: 生きている通話なら採用する（止めていなければ）。止まっていれば画面を空のままにする
    if (t === null) {
      if (live && s.session !== null && !this.retired.includes(s.session)) {
        this.takeOver(s);
        if (this.stopAfterBoot !== null) {
          const reason = this.stopAfterBoot;
          this.stopAfterBoot = null;
          this.hooks.onSnapshot(s);
          void this.stop(reason);
          return;
        }
        this.hooks.onSnapshot(s);
      } else if (!live) {
        this.hooks.onSnapshot(s);
      }
      return;
    }

    // 停止を頼んでいる: 同じ論理セッションの状態だけ見る。止まったことが確かめられたら終える。生きていれば表示は残す
    if (this.stopToken !== null) {
      if (s.session === t) {
        if (live) this.hooks.onSnapshot(s);
        else this.finish(s);
      }
      return;
    }

    if (s.session === t) {
      if (live) {
        this.accepted = true;
        this.unknown = false;
        this.hooks.onSnapshot(s);
      } else if (this.accepted || this.unknown) {
        // ネイティブが、この論理セッションを終えた
        this.finish(s);
      }
      // まだ受け付けられていない開始より前の「止まっている」状態は、開始を消さないので無視する
      return;
    }

    // 別の論理セッション（または無し）の状態
    if (live && s.session !== null && !this.retired.includes(s.session)) {
      // より新しい権威ある状態: 回復中の通話を採用する。受け付けられていない自分の開始は、自分の token で止める
      if (this.issued && !this.accepted) {
        this.retire(t);
        void this.port.stop(t, 'superseded').catch(() => console.warn('[call] 古い開始を止められませんでした'));
      }
      this.takeOver(s);
      this.hooks.onSnapshot(s);
      return;
    }
    // 頼んだ開始の結果が分からないままでも、新しい確かな状態で「生きていない」と分かれば、終える
    if ((this.accepted || this.unknown) && !live) this.finish(s);
  }

  private takeOver(s: NativeSnapshot): void {
    if (s.session === null) return;
    this.token = s.session;
    this.issued = true;
    this.accepted = true;
    this.captured = s.serverUrl;
    this.stopToken = null;
  }

  /** ネイティブが止まったと確かめた（状態として）。画面を空にする */
  private finish(s: NativeSnapshot): void {
    const t = this.token;
    if (t !== null) this.clearToken(t);
    this.stopToken = null;
    this.hooks.onSnapshot(s);
  }

  private clearToken(t: string): void {
    this.retire(t);
    this.token = null;
    this.issued = false;
    this.accepted = false;
    this.unknown = false;
    this.captured = null;
    if (this.stopToken === t) this.stopToken = null;
  }

  private retire(t: string): void {
    if (this.retired.includes(t)) return;
    this.retired.push(t);
    if (this.retired.length > RETIRED_MAX) this.retired.shift();
  }

  private onRelay(r: NativeRelay): void {
    if (this.token === null || r.session !== this.token) return;
    if (!this.gate.accept(r)) return;
    this.hooks.onRelay(r);
  }
}
