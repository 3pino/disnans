/// <reference path="../../../../packages/plugin-sdk/index.d.ts" />
// ホスト API の型は SDK の型定義（packages/plugin-sdk/index.d.ts）を正とし、ここで本体の実装と突き合わせる

import type { ClientEvent } from '../protocol/ClientEvent';
import type { CreateSession } from '../protocol/CreateSession';
import type { PluginNotify } from '../protocol/PluginNotify';
import type { PluginPostMessage } from '../protocol/PluginPostMessage';
import type { Session as SessionData } from '../protocol/Session';
import type { UpdateSession } from '../protocol/UpdateSession';
import type { SlashCommandDef } from '../slashCommands.svelte';
import type { ComposerAction } from '../composerActions';
import type { AppCommand } from '../commands.svelte';
import type { MessageAction } from '../messageActions.svelte';
import type { Message } from '../protocol/Message';
import type { TimelineEntry, TimelineHandle, TimelineSpec } from '../stores/timelinePanel.svelte';

/** ホスト API のバージョン。index.d.ts を変えたら上げる */
export const API_VERSION = 9;

export type Manifest = Disnans.Manifest;
export type Cleanup = Disnans.Cleanup;

/** プラグインの main.js が default export するクラス */
export type PluginClass = new () => Disnans.Plugin;

/** 本体のスラッシュコマンド・「＋」メニューの項目（登録先の型をそのまま使う） */
export type HostSlashCommand = SlashCommandDef;
export type HostComposerAction = ComposerAction;
export type HostCommand = AppCommand;
export type HostMessageAction = MessageAction;
export type HostTimelineEntry = TimelineEntry;
export type HostTimelineSpec = TimelineSpec;
export type HostTimelineHandle = TimelineHandle;

/**
 * プラグインの実行に必要な本体の機能。
 * テストで差し替えられるように、本体の store を直接 import せずにここから使う。
 */
export interface HostServices {
  app: Disnans.App;
  api: {
    createSession(body: CreateSession): Promise<SessionData>;
    getSession(id: string): Promise<SessionData>;
    updateSession(id: string, body: UpdateSession): Promise<SessionData>;
    notify(pluginId: string, body: PluginNotify): Promise<void>;
    postMessage(pluginId: string, body: PluginPostMessage): Promise<void>;
  };
  send(ev: ClientEvent): void;
  registerSlashCommand(def: HostSlashCommand): Cleanup;
  registerComposerAction(action: HostComposerAction): Cleanup;
  /** コマンド（ホットキー・パレット・スラッシュコマンド）を登録する（lib/commands.svelte.ts） */
  registerCommand(cmd: HostCommand): Cleanup;
  /** メッセージの操作（長押しのメニュー・ホバーのツールバー）に項目を足す（API v9）。返り値の関数で外す */
  registerMessageAction(action: HostMessageAction): Cleanup;
  /** 読み込み済みのメッセージを ID で探す（なければ undefined。API v9 の openTimeline の messageIds で使う） */
  findMessage(id: string): Message | undefined;
  /** メッセージの集合をパネルに開く（API v9） */
  openTimeline(spec: HostTimelineSpec): HostTimelineHandle;
  /** パネルに view を開く */
  openPanel(pluginId: string, view: string, sessionId: string): void;
  /** そのプラグインの設定画面を開く（API v6。ui.openPluginSettings） */
  openSettings(pluginId: string): void;
  /** 開いているパネルを閉じる（そのプラグインの view が開いていれば） */
  closePanel(pluginId: string): void;
  toast(text: string, kind?: 'info' | 'error'): void;
  /** 端末に保存する（lib/storage.ts） */
  storage: {
    get(key: string): string | null;
    set(key: string, value: string | null): void;
  };
  /** プラグインのアイコンの名前（icon.svg → manifest.icon → puzzle）。リアクティブ */
  pluginIcon(pluginId: string): string;
  /** アイコンを登録する（lib/icons.svelte.ts の registerIcon）。返り値の関数で外す */
  registerIcon(name: string, svg: string): Cleanup;
  /** 常時表示のステータス欄（画面上部の枠。components/TopBarSlot.svelte）に要素を出す。返り値の関数で外す */
  registerStatusItem(pluginId: string, el: HTMLElement): Cleanup;
  /** 画面を切っても動き続けるための常駐（Android のフォアグラウンドサービス）。返り値の関数で解除する。ほかの環境では何もしない */
  holdBackground(opts: Disnans.BackgroundOptions): Promise<Disnans.BackgroundHandle>;
  /** 登録物（view・カードの描画・設定タブなど）が変わったときに呼ぶ */
  changed(): void;
}

/** 409 の判定に使う（api.ts の HttpError と同じ形） */
export function isVersionConflict(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { status?: unknown }).status === 409 &&
    (e as { code?: unknown }).code === 'version_conflict'
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
