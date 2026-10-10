import { parseHotkey } from './hotkey';
import { SLASH_NAME_RE } from '../slashCommands.svelte';
import { SessionsImpl, type SessionImpl } from './sessions';
import { errorMessage, type Cleanup, type HostServices, type Manifest, type PluginClass } from './types';

/** パネルの上部（題名・アイコン）。null は既定（プラグイン名・プラグインのアイコン）、空文字列は出さない */
export type ViewHeader = { title: string | null; icon: string | null };

/** パネルに開いている view 1つ分 */
export type ViewHandle = {
  readonly view: Disnans.View;
  readonly session: SessionImpl;
  /** 閉じる（onClose を呼ぶ）。何度呼んでもよい */
  close(): void;
  readonly closed: boolean;
};

// ---- Plugin の基底クラス ----

/** インスタンスごとのホストの文脈。new の直前に constructing に入れておき、基底クラスのコンストラクターで受け取る */
const runtimes = new WeakMap<object, PluginRuntime>();
let constructing: PluginRuntime | null = null;

function rt(p: object): PluginRuntime {
  const r = runtimes.get(p);
  if (!r) throw new Error('このプラグインは本体に読み込まれていません');
  return r;
}

/** disnans.Plugin。プラグインはこれを継承する */
export class PluginBase implements Disnans.Plugin {
  constructor() {
    const r = constructing;
    if (!r) throw new Error('Plugin のインスタンスは本体が作ります（new しないでください）');
    runtimes.set(this, r);
  }

  get app(): Disnans.App {
    return rt(this).services.app;
  }
  get manifest(): Disnans.Manifest {
    return rt(this).manifest;
  }
  get sessions(): Disnans.Sessions {
    return rt(this).sessions;
  }

  onload(): void | Promise<void> {}
  onunload(): void {}

  addSlashCommand(cmd: Disnans.SlashCommand): void {
    rt(this).addSlashCommand(cmd);
  }
  addComposerAction(action: Disnans.ComposerAction): void {
    rt(this).addComposerAction(action);
  }
  addCommand(cmd: Disnans.Command): void {
    rt(this).addCommand(cmd);
  }
  addSettingTab(tab: Disnans.SettingTab): void {
    rt(this).addSettingTab(tab);
  }
  addIcon(name: string, svg: string): void {
    rt(this).addIcon(name, svg);
  }
  registerView<S = unknown>(type: string, factory: (session: Disnans.Session<S>) => Disnans.View): void {
    rt(this).registerView(type, factory as (session: Disnans.Session<unknown>) => Disnans.View);
  }
  openView<S = unknown>(type: string, session: Disnans.Session<S>): void {
    rt(this).openView(type, session.id);
  }
  openSettings(): void {
    rt(this).openSettings();
  }
  registerCardRenderer(render: Disnans.CardRenderer): void {
    rt(this).registerCardRenderer(render);
  }
  register(cleanup: Cleanup): void {
    rt(this).register(cleanup);
  }
  registerDomEvent(el: Window | Document | HTMLElement, type: string, cb: (ev: Event) => void): void {
    rt(this).registerDomEvent(el, type, cb);
  }
  registerInterval(id: number): number {
    rt(this).register(() => window.clearInterval(id));
    return id;
  }
  loadData<T = unknown>(): Promise<T | null> {
    return Promise.resolve(rt(this).loadData() as T | null);
  }
  saveData(data: unknown): Promise<void> {
    rt(this).saveData(data);
    return Promise.resolve();
  }
  notify(userIds: string[], text: string, opts?: { session?: Disnans.Session<any> }): Promise<void> {
    return rt(this).notify(userIds, text, opts?.session?.id ?? null);
  }
  postMessage(opts: { body: string; threadId?: string | null; name?: string; notify?: boolean }): Promise<void> {
    return rt(this).postMessage(opts);
  }
  broadcast(name: string, payload?: unknown): void {
    rt(this).broadcast(name, payload);
  }
  onBroadcast(name: string, cb: (payload: unknown, from: Disnans.User) => void): Cleanup {
    return rt(this).onBroadcast(name, cb);
  }
  addStatusBarItem(): HTMLElement {
    return rt(this).addStatusBarItem();
  }
  holdBackground(opts?: Disnans.BackgroundOptions): Promise<Disnans.BackgroundHandle> {
    return rt(this).holdBackground(opts ?? {});
  }
}

// ---- 読み込み1回分 ----

/**
 * プラグインを1回読み込んだもの。登録物をすべて覚えておき、stop() でまとめて片付ける。
 * 読み込み直し（更新・ホットリロード）のたびに新しく作る。
 */
export class PluginRuntime {
  instance: Disnans.Plugin | null = null;
  readonly sessions: SessionsImpl;
  readonly views = new Map<string, (session: Disnans.Session<unknown>) => Disnans.View>();
  cardRenderer: Disnans.CardRenderer | null = null;
  readonly settingTabs: Disnans.SettingTab[] = [];
  stopped = false;
  /** 読み込めたが、一部の登録に失敗したなど（一覧に出す） */
  readonly errors: string[] = [];

  private cleanups: Cleanup[] = [];
  private broadcastListeners = new Map<string, Set<(payload: unknown, from: Disnans.User) => void>>();
  private openViews = new Set<ViewHandle>();

  constructor(
    readonly manifest: Manifest,
    readonly services: HostServices,
  ) {
    this.sessions = new SessionsImpl(manifest.id, services);
  }

  get id(): string {
    return this.manifest.id;
  }

  private log(...args: unknown[]): void {
    console.error(`[plugin:${this.id}]`, ...args);
  }

  /** new して onload を呼ぶ。例外はそのまま投げる（呼び出し側で stop() する） */
  async start(Cls: PluginClass): Promise<void> {
    if (typeof Cls !== 'function') throw new Error('main.js が Plugin を継承したクラスを export default していません');
    let inst: Disnans.Plugin;
    constructing = this;
    try {
      inst = new Cls();
    } finally {
      constructing = null;
    }
    if (!(inst instanceof PluginBase)) throw new Error('main.js の export default が disnans.Plugin を継承していません');
    this.instance = inst;
    await inst.onload();
  }

  /** 外す: onunload → 登録物の片付け → 開いている view の onClose */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.instance) {
      try {
        this.instance.onunload();
      } catch (e) {
        this.log('onunload で例外', e);
      }
    }
    for (const fn of this.cleanups.reverse()) {
      try {
        fn();
      } catch (e) {
        this.log('後始末で例外', e);
      }
    }
    this.cleanups = [];
    this.views.clear();
    this.cardRenderer = null;
    this.settingTabs.length = 0;
    for (const h of [...this.openViews]) h.close();
    this.services.closePanel(this.id);
    this.sessions.dispose();
    this.broadcastListeners.clear();
    this.services.changed();
  }

  // ---- 登録 ----

  register(cleanup: Cleanup): void {
    if (this.stopped) {
      // 外したあとに登録されたら、すぐ片付ける
      try {
        cleanup();
      } catch (e) {
        this.log('後始末で例外', e);
      }
      return;
    }
    this.cleanups.push(cleanup);
  }

  private addError(text: string): void {
    this.log(text);
    this.errors.push(text);
    this.services.changed();
  }

  addSlashCommand(cmd: Disnans.SlashCommand): void {
    if (this.stopped) return;
    const services = this.services;
    const id = this.id;
    let off: Cleanup;
    try {
      off = this.services.registerSlashCommand({
        name: cmd.name,
        description: cmd.description,
        args: cmd.args,
        suggestArgs: cmd.suggestArgs
          ? (input) => {
              try {
                return cmd.suggestArgs?.(input) ?? [];
              } catch (e) {
                this.log(`/${cmd.name} の候補で例外`, e);
                return [];
              }
            }
          : undefined,
        // run の例外は本体（入力欄）がトーストで知らせる
        run: ({ args, threadId }) => cmd.run({ args: args.trim(), threadId }),
        // 省くとプラグインのアイコン（icon.svg はあとから読めることがあるので、そのつど引く）
        get icon() {
          return cmd.icon || services.pluginIcon(id);
        },
        source: this.manifest.name,
      });
    } catch (e) {
      // 名前が正しくないなど。プラグインは動かし続け、一覧にエラーとして出す
      this.addError(`/${cmd.name} を登録できません: ${errorMessage(e)}`);
      return;
    }
    this.register(off);
  }

  addComposerAction(action: Disnans.ComposerAction): void {
    if (this.stopped) return;
    const services = this.services;
    const id = this.id;
    const off = this.services.registerComposerAction({
      // 本体や他のプラグインとぶつからないように、プラグイン ID を前に付ける
      id: `plugin:${this.id}:${action.id}`,
      label: action.label,
      // 省くとプラグインのアイコン。icon.svg はあとから読めることがあるので、表示のたびに引く
      get icon() {
        return action.icon || services.pluginIcon(id);
      },
      // run の例外は本体（入力欄）がトーストで知らせる
      run: ({ threadId }) => action.run({ threadId }),
      source: this.manifest.name,
    });
    this.register(off);
  }

  addCommand(cmd: Disnans.Command): void {
    if (this.stopped) return;
    const services = this.services;
    const id = this.id;
    let hotkey = cmd.hotkey || undefined;
    if (hotkey && !parseHotkey(hotkey)) {
      // ホットキーなしで登録する（利用者が設定で付けられる）
      this.addError(`コマンド「${cmd.name}」のホットキー「${hotkey}」を読めません`);
      hotkey = undefined;
    }
    let slash = cmd.slash || undefined;
    if (slash && !SLASH_NAME_RE.test(slash)) {
      // スラッシュコマンドにはせずに登録する（パレット・ホットキーからは使える）
      this.addError(`/${slash} を登録できません: コマンド名には英小文字・数字・ハイフンだけを使えます`);
      slash = undefined;
    }
    let off: Cleanup;
    try {
      off = services.registerCommand({
        // ホットキーの設定はこの ID で保存する。ほかのプラグインとぶつからないように、プラグイン ID を前に付ける
        id: `${id}:${cmd.id}`,
        name: cmd.name,
        // 省くとプラグインのアイコン（icon.svg はあとから読めることがあるので、そのつど引く）
        get icon() {
          return cmd.icon || services.pluginIcon(id);
        },
        defaultHotkey: hotkey,
        slash,
        description: cmd.description,
        args: cmd.args,
        suggestArgs: cmd.suggestArgs
          ? (input) => {
              try {
                return cmd.suggestArgs?.(input) ?? [];
              } catch (e) {
                this.log(`コマンド「${cmd.name}」の候補で例外`, e);
                return [];
              }
            }
          : undefined,
        source: this.manifest.name,
        // run の例外は本体（入力欄・ホットキー・パレット）がトーストで知らせる
        run: ({ args, threadId, via }) => cmd.run({ args: args.trim(), threadId, via }),
      });
    } catch (e) {
      this.addError(`コマンド「${cmd.name}」を登録できません: ${errorMessage(e)}`);
      return;
    }
    this.register(off);
  }

  addSettingTab(tab: Disnans.SettingTab): void {
    if (this.stopped) return;
    this.settingTabs.push(tab);
    this.register(() => {
      const i = this.settingTabs.indexOf(tab);
      if (i >= 0) this.settingTabs.splice(i, 1);
    });
    this.services.changed();
  }

  addIcon(name: string, svg: string): void {
    if (this.stopped) return;
    let off: Cleanup;
    try {
      off = this.services.registerIcon(String(name), String(svg));
    } catch (e) {
      // SVG が読めないなど。プラグインは動かし続け、一覧にエラーとして出す
      this.addError(`アイコン「${name}」を登録できません: ${errorMessage(e)}`);
      return;
    }
    this.register(off);
  }

  registerView(type: string, factory: (session: Disnans.Session<unknown>) => Disnans.View): void {
    if (this.stopped) return;
    this.views.set(type, factory);
    this.register(() => {
      if (this.views.get(type) === factory) this.views.delete(type);
    });
    this.services.changed();
  }

  registerCardRenderer(render: Disnans.CardRenderer): void {
    if (this.stopped) return;
    this.cardRenderer = render;
    this.register(() => {
      if (this.cardRenderer === render) this.cardRenderer = null;
    });
    this.services.changed();
  }

  registerDomEvent(el: Window | Document | HTMLElement, type: string, cb: (ev: Event) => void): void {
    if (this.stopped) return;
    el.addEventListener(type, cb);
    this.register(() => el.removeEventListener(type, cb));
  }

  // ---- プラグイン全体の一時的なイベント ----

  broadcast(name: string, payload?: unknown): void {
    if (this.stopped) return;
    this.services.send({ type: 'plugin.emit', plugin: this.id, name, payload: payload ?? null });
  }

  onBroadcast(name: string, cb: (payload: unknown, from: Disnans.User) => void): Cleanup {
    let set = this.broadcastListeners.get(name);
    if (!set) {
      set = new Set();
      this.broadcastListeners.set(name, set);
    }
    const listeners = set;
    listeners.add(cb);
    const off = () => void listeners.delete(cb);
    this.register(off);
    return off;
  }

  /** plugin.event を受け取ったとき */
  dispatchBroadcast(name: string, payload: unknown, fromId: string): void {
    if (this.stopped) return;
    const set = this.broadcastListeners.get(name);
    if (!set) return;
    const from = this.services.app.user(fromId) ?? {
      id: fromId,
      login_name: '',
      display_name: '不明なユーザー',
      avatar_url: null,
    };
    for (const cb of [...set]) {
      try {
        cb(payload, from);
      } catch (e) {
        this.log(`onBroadcast('${name}') で例外`, e);
      }
    }
  }

  // ---- ステータス欄・常駐 ----

  addStatusBarItem(): HTMLElement {
    const el = document.createElement('div');
    if (this.stopped) return el;
    this.register(this.services.registerStatusItem(this.id, el));
    return el;
  }

  async holdBackground(opts: Disnans.BackgroundOptions): Promise<Disnans.BackgroundHandle> {
    if (this.stopped) return Object.assign(() => {}, { update: () => {} });
    const request: Disnans.BackgroundOptions = { ...opts, title: opts.title ?? this.manifest.name };
    if (opts.onAction) {
      // プラグインの例外が本体に漏れないように、止まったあとは呼ばず、例外はログにする
      request.onAction = (id) => {
        if (this.stopped) return;
        try {
          opts.onAction?.(id);
        } catch (e) {
          this.log(`holdBackground の onAction('${id}') で例外`, e);
        }
      };
    }
    const handle = await this.services.holdBackground(request);
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      handle();
    };
    this.register(once);
    return Object.assign(once, {
      update: (patch: Disnans.BackgroundUpdate) => {
        if (!done && !this.stopped) handle.update?.(patch);
      },
    });
  }

  // ---- view ----

  /** カードをタップしたときに開く view の type（プラグイン ID と同じもの → 最初に登録されたもの） */
  defaultViewType(): string | null {
    if (this.views.has(this.id)) return this.id;
    const first = this.views.keys().next();
    return first.done ? null : first.value;
  }

  openView(type: string, sessionId: string): void {
    if (this.stopped) return;
    if (!this.views.has(type)) throw new Error(`view「${type}」は登録されていません`);
    this.services.openPanel(this.id, type, sessionId);
  }

  /** このプラグインの設定画面を開く（API v6） */
  openSettings(): void {
    if (this.stopped) return;
    this.services.openSettings(this.id);
  }

  /**
   * パネルの containerEl に view を描く（PluginPanel から呼ぶ）。
   * 閉じるときは返した handle の close() を呼ぶ。
   * onHeader は、パネルの上部（題名・アイコン）が決まったとき・view が変えたときに呼ぶ
   */
  async mountView(
    type: string,
    sessionId: string,
    containerEl: HTMLElement,
    onHeader?: (header: ViewHeader) => void,
  ): Promise<ViewHandle> {
    if (this.stopped) throw new Error('プラグインは外されています');
    const session = (await this.sessions.get(sessionId)) as SessionImpl;
    const factory = this.views.get(type);
    if (!factory) throw new Error(`view「${type}」は登録されていません`);
    if (this.stopped) throw new Error('プラグインは外されています');
    const view = factory(session);
    let closed = false;
    const handle: ViewHandle = {
      view,
      session,
      get closed() {
        return closed;
      },
      close: () => {
        if (closed) return;
        closed = true;
        this.openViews.delete(handle);
        try {
          view.onClose?.();
        } catch (e) {
          this.log('view の onClose で例外', e);
        }
      },
    };
    this.openViews.add(handle);
    // 題名・アイコン: setTitle / setIcon で変えたもの → view.title / view.icon → 既定（null）
    let title: string | null | undefined;
    let icon: string | null | undefined;
    const header = (): ViewHeader => ({
      title: title !== undefined ? title : typeof view.title === 'string' ? view.title : null,
      icon: icon !== undefined ? icon : typeof view.icon === 'string' ? view.icon : null,
    });
    const notify = () => {
      if (closed) return;
      try {
        onHeader?.(header());
      } catch (e) {
        this.log('パネルの上部の更新で例外', e);
      }
    };
    const panel: Disnans.ViewPanel = {
      setTitle: (t) => {
        title = t === null ? undefined : String(t);
        notify();
      },
      setIcon: (i) => {
        icon = i === null ? undefined : String(i);
        notify();
      },
    };
    notify();
    try {
      await view.onOpen(containerEl, panel);
    } catch (e) {
      handle.close();
      throw e;
    }
    return handle;
  }

  /** カードのメッセージが消えた: そのセッションの view を閉じ、キャッシュを捨てる */
  dropSessionsByMessage(messageId: string): string[] {
    for (const h of [...this.openViews]) if (h.session.messageId === messageId) h.close();
    return this.sessions.dropByMessage(messageId);
  }

  // ---- カード ----

  /** カードを描く。描けたら true（例外は握りつぶして標準の見た目に戻す） */
  renderCard(el: HTMLElement, card: Disnans.CardData): boolean {
    const render = this.cardRenderer;
    if (!render || this.stopped) return false;
    try {
      render(el, card);
      return true;
    } catch (e) {
      this.log('カードの描画で例外', e);
      return false;
    }
  }

  // ---- データ ----

  private get dataKey(): string {
    return `disnans.plugin.${this.id}.data`;
  }

  loadData(): unknown {
    const raw = this.services.storage.get(this.dataKey);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  saveData(data: unknown): void {
    const json = data === undefined ? null : JSON.stringify(data);
    this.services.storage.set(this.dataKey, json ?? null);
  }

  notify(userIds: string[], text: string, sessionId: string | null): Promise<void> {
    return this.services.api.notify(this.id, { user_ids: userIds, body: text, session_id: sessionId });
  }

  postMessage(opts: { body: string; threadId?: string | null; name?: string; notify?: boolean }): Promise<void> {
    return this.services.api.postMessage(this.id, {
      thread_id: opts.threadId ?? null,
      body: opts.body,
      name: opts.name ?? null,
      notify: opts.notify ?? false,
    });
  }
}
