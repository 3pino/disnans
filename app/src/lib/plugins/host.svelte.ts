import { api } from '../api';
import { isAndroid } from '../config';
import { getItem, setItem } from '../storage';
import { registerSlashCommand } from '../slashCommands.svelte';
import { registerComposerAction } from '../composerActions';
import type { MessageCard } from '../protocol/MessageCard';
import type { PluginInfo } from '../protocol/PluginInfo';
import type { ServerEvent } from '../protocol/ServerEvent';
import { client } from '../stores/client.svelte';
import { ui } from '../stores/ui.svelte';
import { devFolderSupported, readDevPlugin, scanDevFolder } from './dev';
import { matchHotkey } from './hotkey';
import { manifestOf, parseManifest, PLUGIN_FILES } from './manifest';
import { PluginBase, PluginRuntime, type ViewHandle } from './runtime';
import { toPluginUser, VersionConflictError } from './sessions';
import { createUi } from './ui';
import { loadLucide, registerIcon } from '../icons.svelte';
import { API_VERSION, errorMessage, type HostServices, type Manifest, type PluginClass } from './types';

const DISABLED_KEY = 'disnans.plugins.disabled';
const DEV_DIR_KEY = 'disnans.plugins.devDir';
const DEV_POLL_MS = 1000;
const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 開発用フォルダのプラグイン1つ（サブフォルダ1つ） */
export type DevPlugin = {
  folder: string;
  stamp: string;
  manifest: Manifest | null;
  /** manifest.json の中身そのもの（配布のときはこれを送る） */
  manifestText: string | null;
  main: string | null;
  styles: string | null;
  /** icon.svg（任意） */
  icon: string | null;
  /** manifest が読めない、main.js がない、など */
  error: string | null;
};

/** 設定の一覧に出す1件 */
export type PluginEntry = {
  /** プラグイン ID（manifest が読めない開発中のものはフォルダ名） */
  id: string;
  manifest: Manifest | null;
  /** 配布済みのもの */
  server: PluginInfo | null;
  /** 開発用フォルダのもの（あれば、こちらを使う） */
  dev: DevPlugin | null;
  /** この端末でオンか */
  enabled: boolean;
  /** 今動いているか */
  loaded: boolean;
  /** 読み込みの失敗など */
  error: string | null;
  /** 設定タブがあるか */
  hasSettings: boolean;
  /** プラグインのアイコンの名前（icon.svg → manifest.icon → puzzle） */
  icon: string;
};

/** プラグインのアイコン（icon.svg）を登録する名前 */
export function pluginIconName(id: string): string {
  return `plugin:${id}`;
}

/** 既定のアイコン */
const DEFAULT_PLUGIN_ICON = 'puzzle';

/** 動いているプラグイン1つ */
type Loaded = {
  runtime: PluginRuntime;
  /** 何を読み込んだか（変わったら読み込み直す） */
  sig: string;
  style: HTMLStyleElement | null;
};

/** 読み込むべきもの */
type Wanted = { sig: string; manifest: Manifest; load: () => Promise<{ main: string; styles: string | null }> };

function loadDisabled(): string[] {
  try {
    const v = JSON.parse(getItem(DISABLED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** main.js（ES モジュール）を Blob URL から import する */
async function importModule(id: string, code: string): Promise<{ default?: unknown }> {
  // DevTools で見分けやすいように名前を付ける
  const blob = new Blob([code, `\n//# sourceURL=disnans-plugin://${id}/main.js\n`], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return (await import(/* @vite-ignore */ url)) as { default?: unknown };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * プラグインのホスト。配布済み（サーバー）と開発中（開発用フォルダ）のプラグインを読み込み・外す。
 * 端末ごとのオンオフと、読み込みのエラーもここで持つ。
 */
class PluginHost {
  /** 配布済みのもの（サーバーの一覧） */
  server = $state<PluginInfo[]>([]);
  serverError = $state<string | null>(null);
  /** 開発用フォルダのもの */
  dev = $state<DevPlugin[]>([]);
  devDir = $state(getItem(DEV_DIR_KEY) ?? '');
  devError = $state<string | null>(null);
  /** この端末でオフにしたもの */
  disabled = $state<string[]>(loadDisabled());
  /** 読み込みのエラー（ID ごと） */
  errors = $state<Record<string, string>>({});
  /** 動いているものや登録物が変わったら増やす（loaded はリアクティブでないので、これで知らせる） */
  private rev = $state(0);

  private loaded = new Map<string, Loaded>();
  private started = false;
  private devTimer: ReturnType<typeof setInterval> | null = null;
  private devBusy = false;
  /** reconcile を順番に走らせる */
  private queue: Promise<void> = Promise.resolve();

  readonly services: HostServices = {
    app: {
      get me() {
        const me = client.me;
        return me ? toPluginUser(me) : { id: '', login_name: '', display_name: '不明なユーザー', avatar_url: null };
      },
      get users() {
        return client.userList.map(toPluginUser);
      },
      user: (id) => {
        const u = client.user(id);
        return u ? toPluginUser(u) : undefined;
      },
      nameOf: (id) => client.nameOf(id),
      get isMobile() {
        return ui.isMobile;
      },
      get theme() {
        if (ui.theme !== 'system') return ui.theme;
        return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
      },
    },
    api: {
      createSession: (body) => api.createSession(body),
      getSession: (id) => api.session(id),
      updateSession: (id, body) => api.updateSession(id, body),
      notify: (id, body) => api.pluginNotify(id, body),
    },
    send: (ev) => void client.send(ev),
    registerSlashCommand,
    registerComposerAction,
    openPanel: (plugin, view, sessionId) => ui.openPluginView(plugin, view, sessionId),
    closePanel: (plugin) => {
      if (ui.panel?.kind === 'plugin' && ui.panel.plugin === plugin) ui.closePanel();
    },
    toast: (text, kind) => ui.toast(text, kind),
    storage: { get: (k) => getItem(k), set: (k, v) => setItem(k, v) },
    pluginIcon: (id) => this.pluginIcon(id),
    registerIcon: (name, svg) => registerIcon(name, svg),
    changed: () => this.rev++,
  };

  // ---- 開始 ----

  /** 接続を始めたあとに1回呼ぶ。最初の hello を待ってから読み込む */
  start(): void {
    if (this.started) return;
    this.started = true;
    const host: Disnans.Host = Object.freeze({
      apiVersion: API_VERSION,
      Plugin: PluginBase,
      ui: createUi({ toast: (t, k) => ui.toast(t, k), confirm: (o) => ui.confirm(o) }),
      VersionConflictError,
    });
    (window as unknown as { disnans: Disnans.Host }).disnans = host;

    client.subscribe((ev) => this.onEvent(ev));
    window.addEventListener('keydown', (e) => this.onKeydown(e));
    // すでに hello を受け取っていたら（HMR など）そのまま始める
    if (client.ready) this.onHello();
  }

  private helloSeen = false;

  private onHello(): void {
    // 再接続のたびに一覧を取り直す（切れている間の配布・削除を拾う）
    void this.refreshServer();
    if (!this.helloSeen) {
      this.helloSeen = true;
      this.restartDevPolling();
    }
  }

  private onEvent(ev: ServerEvent): void {
    switch (ev.type) {
      case 'hello':
        this.onHello();
        break;
      case 'plugin.updated': {
        const i = this.server.findIndex((p) => p.id === ev.plugin.id);
        if (i >= 0) this.server[i] = ev.plugin;
        else this.server = [...this.server, ev.plugin].sort((a, b) => a.id.localeCompare(b.id));
        this.reconcile();
        break;
      }
      case 'plugin.removed':
        this.server = this.server.filter((p) => p.id !== ev.plugin_id);
        this.reconcile();
        break;
      case 'session.updated':
        for (const l of this.loaded.values()) l.runtime.sessions.applyUpdate(ev.session);
        break;
      case 'session.event':
        for (const l of this.loaded.values()) l.runtime.sessions.dispatchEvent(ev.session_id, ev.name, ev.payload, ev.from);
        break;
      case 'message.deleted': {
        // カードのメッセージが消えるとセッションも消える。開いている view を閉じ、キャッシュを捨てる
        const dropped = new Set<string>();
        for (const l of this.loaded.values()) for (const id of l.runtime.dropSessionsByMessage(ev.message_id)) dropped.add(id);
        const p = ui.panel;
        if (p?.kind === 'plugin' && dropped.has(p.sessionId)) ui.closePanel();
        break;
      }
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    // ショートカットはデスクトップだけ
    if (ui.isMobile || isAndroid() || e.repeat || e.isComposing) return;
    for (const l of this.loaded.values()) {
      for (const { cmd, hotkey } of l.runtime.commands) {
        if (hotkey && matchHotkey(hotkey, e)) {
          e.preventDefault();
          l.runtime.runCommand(cmd);
          return;
        }
      }
    }
  }

  async refreshServer(): Promise<void> {
    try {
      this.server = await api.plugins();
      this.serverError = null;
    } catch (e) {
      this.serverError = `プラグインの一覧を読めませんでした: ${errorMessage(e)}`;
      return;
    }
    this.reconcile();
  }

  // ---- 一覧 ----

  /** 設定の一覧（配布済み・開発中をまとめたもの）。ID 順 */
  get entries(): PluginEntry[] {
    void this.rev;
    const map = new Map<string, PluginEntry>();
    const get = (id: string): PluginEntry => {
      let e = map.get(id);
      if (!e) {
        const l = this.loaded.get(id);
        e = {
          id,
          manifest: null,
          server: null,
          dev: null,
          enabled: !this.disabled.includes(id),
          loaded: !!l,
          error: this.errors[id] ?? (l && l.runtime.errors.length > 0 ? l.runtime.errors.join('\n') : null),
          hasSettings: !!l && l.runtime.settingTabs.length > 0,
          icon: DEFAULT_PLUGIN_ICON,
        };
        map.set(id, e);
      }
      return e;
    };
    for (const p of this.server) {
      const e = get(p.id);
      e.server = p;
      e.manifest = manifestOf(p);
    }
    for (const d of this.dev) {
      const e = get(d.manifest?.id ?? d.folder);
      e.dev = d;
      if (d.manifest) e.manifest = d.manifest;
      if (d.error && !e.error) e.error = d.error;
    }
    for (const e of map.values()) e.icon = this.iconOf(e.id, e.manifest);
    return [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  // ---- アイコン ----

  /** icon.svg を登録したもの（ID ごと）。key は何を読んだか（変わったら読み直す） */
  private icons = new Map<string, { key: string; off: (() => void) | null }>();

  private iconOf(id: string, manifest: Manifest | null): string {
    if (this.icons.get(id)?.off) return pluginIconName(id);
    return manifest?.icon || DEFAULT_PLUGIN_ICON;
  }

  /**
   * プラグインのアイコンの名前（icon.svg → manifest.icon → puzzle）。リアクティブ。
   * 動いていない（オフ・ない）プラグインでも、一覧にあればそのアイコン
   */
  pluginIcon(id: string): string {
    void this.rev;
    const dev = this.dev.find((d) => d.manifest?.id === id);
    const manifest = dev?.manifest ?? this.loaded.get(id)?.runtime.manifest ?? null;
    if (manifest) return this.iconOf(id, manifest);
    const server = this.server.find((p) => p.id === id);
    return this.iconOf(id, server ? manifestOf(server) : null);
  }

  /** icon.svg を読み、アイコンとして登録する（一覧が変わるたびに呼ぶ）。開発中のものを優先する */
  private syncIcons(): void {
    const want = new Map<string, { key: string; get: () => Promise<string> }>();
    for (const p of this.server) {
      if (p.has_icon) want.set(p.id, { key: `server:${p.hash}`, get: () => api.pluginFile(p.id, 'icon.svg', p.hash) });
    }
    for (const d of this.dev) {
      const id = d.manifest?.id;
      if (!id) continue;
      const svg = d.icon;
      if (svg === null) want.delete(id);
      else want.set(id, { key: `dev:${d.folder}:${d.stamp}`, get: async () => svg });
    }
    for (const [id, cur] of [...this.icons]) {
      if (want.get(id)?.key === cur.key) continue;
      cur.off?.();
      this.icons.delete(id);
      this.rev++;
    }
    for (const [id, w] of want) {
      if (this.icons.has(id)) continue;
      const slot: { key: string; off: (() => void) | null } = { key: w.key, off: null };
      this.icons.set(id, slot);
      w.get().then(
        (svg) => {
          if (this.icons.get(id) !== slot) return;
          slot.off = registerIcon(pluginIconName(id), svg);
          this.rev++;
        },
        (e: unknown) => console.warn(`[plugin:${id}] icon.svg を読めません`, e),
      ).catch((e: unknown) => console.warn(`[plugin:${id}] icon.svg を読めません`, e));
    }
  }

  /** 動いている（読み込み済みの）プラグイン。リアクティブ */
  runtime(id: string): PluginRuntime | null {
    void this.rev;
    return this.loaded.get(id)?.runtime ?? null;
  }

  isEnabled(id: string): boolean {
    return !this.disabled.includes(id);
  }

  setEnabled(id: string, on: boolean): void {
    this.disabled = on ? this.disabled.filter((x) => x !== id) : [...new Set([...this.disabled, id])];
    setItem(DISABLED_KEY, this.disabled.length > 0 ? JSON.stringify(this.disabled) : null);
    // オンにし直したら、前に失敗したものも読み直す
    if (on) this.dropError(id);
    this.reconcile();
  }

  // ---- 読み込み・外す ----

  /** 今あるべき状態に合わせて、読み込み・読み込み直し・外すを行う（順番に走らせる） */
  reconcile(): Promise<void> {
    if (!this.helloSeen) return this.queue;
    this.syncIcons();
    this.queue = this.queue.then(() => this.reconcileNow()).catch((e) => console.error('[plugins]', e));
    return this.queue;
  }

  private wanted(): Map<string, Wanted> {
    const out = new Map<string, Wanted>();
    for (const p of this.server) {
      if (this.disabled.includes(p.id)) continue;
      out.set(p.id, {
        sig: `server:${p.hash}`,
        manifest: manifestOf(p),
        load: async () => ({
          main: await api.pluginFile(p.id, 'main.js', p.hash),
          styles: p.files.includes('styles.css') ? await api.pluginFile(p.id, 'styles.css', p.hash) : null,
        }),
      });
    }
    // 同じ ID なら開発中のものを優先する
    for (const d of this.dev) {
      const m = d.manifest;
      if (!m || d.error || d.main === null || this.disabled.includes(m.id)) continue;
      const main = d.main;
      out.set(m.id, { sig: `dev:${d.folder}:${d.stamp}`, manifest: m, load: async () => ({ main, styles: d.styles }) });
    }
    return out;
  }

  private async reconcileNow(): Promise<void> {
    const wanted = this.wanted();
    for (const id of [...this.loaded.keys()]) {
      if (!wanted.has(id)) {
        this.unload(id);
        this.dropError(id);
      }
    }
    // オフにした・消えたものの古いエラーは消す
    for (const id of Object.keys(this.errors)) {
      if (!wanted.has(id) && !this.loaded.has(id)) this.dropError(id);
    }
    for (const [id, w] of wanted) {
      const cur = this.loaded.get(id);
      if (cur?.sig === w.sig) continue;
      // 失敗したものを毎回読み直さないように、エラーも sig で覚える
      if (!cur && this.failedSig.get(id) === w.sig) continue;
      await this.load(id, w);
    }
  }

  private failedSig = new Map<string, string>();

  private dropError(id: string): void {
    this.failedSig.delete(id);
    if (!(id in this.errors)) return;
    const next = { ...this.errors };
    delete next[id];
    this.errors = next;
  }

  private fail(id: string, sig: string, text: string): void {
    console.error(`[plugin:${id}] ${text}`);
    this.failedSig.set(id, sig);
    this.errors = { ...this.errors, [id]: text };
  }

  /** 読み込む（すでにあれば外してから）。失敗はエラーとして持ち、本体は動き続ける */
  private async load(id: string, w: Wanted): Promise<void> {
    // ホットリロード: 開いていた view は、読み込み直したあとに開き直す
    const panel = ui.panel?.kind === 'plugin' && ui.panel.plugin === id ? ui.panel : null;
    this.unload(id);
    this.dropError(id);

    if (w.manifest.minApiVersion > API_VERSION) {
      this.fail(id, w.sig, `本体のホスト API（v${API_VERSION}）が古いため読み込めません（v${w.manifest.minApiVersion} 以上が必要）。アプリを更新してください`);
      return;
    }

    // プラグインはアイコンを名前（Lucide）で使うことが多いので、先に読み込み始める
    void loadLucide();
    let files: { main: string; styles: string | null };
    let mod: { default?: unknown };
    try {
      files = await w.load();
      mod = await importModule(id, files.main);
    } catch (e) {
      this.fail(id, w.sig, `main.js を読み込めません: ${errorMessage(e)}`);
      return;
    }
    // 待っている間に別の読み込みが済んでいたら、そちらを使う
    if (this.loaded.has(id)) return;

    let style: HTMLStyleElement | null = null;
    if (files.styles) {
      style = document.createElement('style');
      style.dataset.plugin = id;
      style.textContent = files.styles;
      document.head.append(style);
    }
    const runtime = new PluginRuntime(Object.freeze({ ...w.manifest }), this.services);
    this.loaded.set(id, { runtime, sig: w.sig, style });
    try {
      await runtime.start(mod.default as PluginClass);
    } catch (e) {
      this.unload(id);
      this.fail(id, w.sig, `読み込みでエラー: ${errorMessage(e)}`);
      return;
    }
    this.rev++;
    if (panel && runtime.views.has(panel.view) && !ui.panel) ui.openPluginView(panel.plugin, panel.view, panel.sessionId);
  }

  private unload(id: string): void {
    const l = this.loaded.get(id);
    if (!l) return;
    this.loaded.delete(id);
    l.runtime.stop();
    l.style?.remove();
    this.rev++;
  }

  // ---- カード・view ----

  /** カードをタップして開ける view（なければ null）。リアクティブ */
  cardView(pluginId: string): string | null {
    return this.runtime(pluginId)?.defaultViewType() ?? null;
  }

  /** カードの描画を登録しているか。リアクティブ */
  hasCardRenderer(pluginId: string): boolean {
    return !!this.runtime(pluginId)?.cardRenderer;
  }

  /** 設定タブ。リアクティブ */
  settingTabs(pluginId: string): Disnans.SettingTab[] {
    return [...(this.runtime(pluginId)?.settingTabs ?? [])];
  }

  openCard(card: MessageCard): boolean {
    const view = this.cardView(card.plugin);
    if (!view) return false;
    ui.openPluginView(card.plugin, view, card.session_id);
    return true;
  }

  /** パネルに view を描く（PluginPanel から呼ぶ） */
  mountView(pluginId: string, view: string, sessionId: string, el: HTMLElement): Promise<ViewHandle> {
    const r = this.loaded.get(pluginId)?.runtime;
    if (!r) return Promise.reject(new Error('プラグインが読み込まれていません'));
    return r.mountView(view, sessionId, el);
  }

  // ---- 配布・削除 ----

  /** 開発中のものを配布する */
  async publishDev(d: DevPlugin): Promise<PluginInfo> {
    if (!d.manifest || d.manifestText === null || d.main === null) throw new Error(d.error ?? 'manifest.json と main.js が必要です');
    const files: { name: string; data: Blob }[] = [
      { name: 'manifest.json', data: new Blob([d.manifestText], { type: 'application/json' }) },
      { name: 'main.js', data: new Blob([d.main], { type: 'text/javascript' }) },
    ];
    if (d.styles !== null) files.push({ name: 'styles.css', data: new Blob([d.styles], { type: 'text/css' }) });
    if (d.icon !== null) files.push({ name: 'icon.svg', data: new Blob([d.icon], { type: 'image/svg+xml' }) });
    return this.publish(files);
  }

  /** 選んだファイルを配布する（ブラウザー版） */
  async publishFiles(list: File[]): Promise<PluginInfo> {
    const names = new Set<string>(PLUGIN_FILES);
    const files: { name: string; data: Blob }[] = [];
    for (const f of list) {
      if (!names.has(f.name)) throw new Error(`配布できないファイルです（${f.name}）。manifest.json / main.js / styles.css / icon.svg だけです`);
      files.push({ name: f.name, data: f });
    }
    if (!files.some((f) => f.name === 'manifest.json') || !files.some((f) => f.name === 'main.js')) {
      throw new Error('manifest.json と main.js を選んでください');
    }
    return this.publish(files);
  }

  private async publish(files: { name: string; data: Blob }[]): Promise<PluginInfo> {
    const info = await api.publishPlugin(files);
    // plugin.updated も届くが、先に反映しておく
    this.onEvent({ type: 'plugin.updated', plugin: info });
    return info;
  }

  async remove(id: string): Promise<void> {
    await api.deletePlugin(id);
    this.onEvent({ type: 'plugin.removed', plugin_id: id });
  }

  // ---- 開発用フォルダ ----

  setDevDir(dir: string): void {
    this.devDir = dir.trim();
    setItem(DEV_DIR_KEY, this.devDir || null);
    this.dev = [];
    this.devError = null;
    this.restartDevPolling();
    this.reconcile();
  }

  private restartDevPolling(): void {
    if (this.devTimer) clearInterval(this.devTimer);
    this.devTimer = null;
    if (!devFolderSupported() || !this.devDir) return;
    void this.pollDev();
    this.devTimer = setInterval(() => void this.pollDev(), DEV_POLL_MS);
  }

  /** 開発用フォルダを見て、変わったものだけ読み直す（ホットリロード） */
  private async pollDev(): Promise<void> {
    if (this.devBusy) return;
    this.devBusy = true;
    const dir = this.devDir;
    try {
      const stats = await scanDevFolder(dir);
      if (dir !== this.devDir) return;
      this.devError = null;
      const prev = new Map(this.dev.map((d) => [d.folder, d]));
      let changed = stats.length !== this.dev.length;
      const next: DevPlugin[] = [];
      for (const s of stats) {
        const old = prev.get(s.folder);
        if (old && old.stamp === s.stamp) {
          next.push(old);
          continue;
        }
        changed = true;
        next.push(await this.readDev(dir, s.folder, s.stamp));
      }
      if (changed && dir === this.devDir) {
        this.dev = next;
        this.reconcile();
      }
    } catch (e) {
      if (dir === this.devDir) this.devError = errorMessage(e);
    } finally {
      this.devBusy = false;
    }
  }

  private async readDev(dir: string, folder: string, stamp: string): Promise<DevPlugin> {
    // 読めなかったときも scan の stamp を覚え、変わるまで読み直さない
    const d: DevPlugin = { folder, stamp, manifest: null, manifestText: null, main: null, styles: null, icon: null, error: null };
    try {
      const f = await readDevPlugin(dir, folder);
      d.main = f.main;
      d.styles = f.styles;
      d.icon = f.icon;
      d.manifestText = f.manifest;
      if (f.manifest === null) throw new Error('manifest.json がありません');
      d.manifest = parseManifest(f.manifest);
      if (f.main === null) throw new Error('main.js がありません');
    } catch (e) {
      d.error = errorMessage(e);
    }
    return d;
  }
}

export const pluginHost = new PluginHost();
