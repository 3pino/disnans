import { tick } from 'svelte';
import MessageCircle from '@lucide/svelte/icons/message-circle';
import Settings from '@lucide/svelte/icons/settings';
import TextCursorInput from '@lucide/svelte/icons/text-cursor-input';
import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
import Command from '@lucide/svelte/icons/command';
import Search from '@lucide/svelte/icons/search';
import SunMoon from '@lucide/svelte/icons/sun-moon';
import ChevronsDown from '@lucide/svelte/icons/chevrons-down';
import BookmarkCheck from '@lucide/svelte/icons/bookmark-check';
import FolderOpen from '@lucide/svelte/icons/folder-open';
import {
  APP_COMMAND_PREFIX,
  commandForKey,
  commandList,
  registerCommand,
  runCommand,
  setSlashAliasSource,
  type AppCommand,
  type CommandVia,
} from './commands.svelte';
import { isAndroid } from './platform';
import { NAV_FILES_ID } from './navBar';
import { prefs } from './stores/prefs.svelte';
import { cameraRequest } from './stores/cameraRequest.svelte';
import { attachPanel } from './stores/attachPanel.svelte';
import Camera from '@lucide/svelte/icons/camera';
import Paperclip from '@lucide/svelte/icons/paperclip';
import { ui } from './stores/ui.svelte';
import { callCommands } from './call/commands';
import { startCall } from './call/instance.svelte';
import { jumpToFirstUnread, jumpToNextUnread } from './unreadNav';
import { explorerSelection } from './stores/explorerSelection.svelte';
import SquareX from '@lucide/svelte/icons/square-x';

/** コマンドパレットを開くコマンド（設定の説明にも使う） */
export const PALETTE_COMMAND_ID = `${APP_COMMAND_PREFIX}command-palette`;

/** 共有フォルダの選択モードを解除するコマンド（既定は Esc） */
export const EXPLORER_CLEAR_SELECTION_ID = `${APP_COMMAND_PREFIX}explorer-clear-selection`;

/** コマンドパレット・ホットキーの記録の状態 */
class CommandHost {
  /** コマンドパレットを開いているか */
  paletteOpen = $state(false);
  /** 設定でホットキーを記録している間は、ホットキーを効かせない */
  recording = $state(false);
  private started = false;

  /** ホットキーを使えるか（Android では使わない。コマンドパレットは Android でも開ける） */
  get hotkeysAvailable(): boolean {
    return !isAndroid();
  }

  /** 接続を始めたあとに1回呼ぶ。設定の読み込み・本体のコマンドの登録・ホットキーの受け付けを始める */
  start(): void {
    if (this.started) return;
    this.started = true;
    prefs.start();
    // スラッシュコマンドの別名は設定から引く（コマンドの登録より前に決めておく）
    setSlashAliasSource(() => prefs.slashNames);
    for (const c of builtinCommands(this)) registerCommand(c);
    // 通話: サーバーのイベントを受け始め、コマンドと「＋」メニューの項目を登録する
    startCall();
    for (const c of callCommands()) registerCommand(c);
    window.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  /** コマンドを実行する。失敗はトーストで知らせる */
  async run(cmd: AppCommand, via: Exclude<CommandVia, 'slash'>): Promise<void> {
    try {
      await runCommand(cmd, { args: '', via });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.hotkeysAvailable || this.recording || e.repeat || e.isComposing || e.defaultPrevented) return;
    const cmd = commandForKey(commandList(), prefs.hotkeys, e, { typing: isTyping(e.target) });
    if (!cmd) return;
    e.preventDefault();
    void this.run(cmd, 'hotkey');
  }
}

/** 文字を打てる場所にフォーカスがあるか */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(target.type);
  return false;
}

/** メインチャットを出す（設定やモバイルのスレッドの一覧から戻る） */
async function showChat(): Promise<void> {
  ui.showMain();
  await tick();
}

/** 本体のコマンド。スラッシュコマンドにはしない（入力欄から呼ぶものではないので） */
function builtinCommands(host: CommandHost): AppCommand[] {
  const id = (name: string) => APP_COMMAND_PREFIX + name;
  return [
    {
      id: PALETTE_COMMAND_ID,
      name: 'コマンドパレットを開く',
      icon: Command,
      // Ctrl+P に加えて F2 でも開ける
      defaultHotkey: ['Mod+P', 'F2'],
      // Android でも開ける（ナビゲーションバーの「コマンドパレットを開く」から）
      run: () => {
        host.paletteOpen = !host.paletteOpen;
      },
    },
    {
      id: EXPLORER_CLEAR_SELECTION_ID,
      name: '共有フォルダの選択モードを解除',
      icon: SquareX,
      defaultHotkey: 'Escape',
      // 選択モードの間だけ。拡大表示・ダイアログ・メニューが開いていれば、そちらの Esc（閉じる）に任せる
      when: () => explorerSelection.showing && !ui.lightbox && !ui.confirmReq && !document.querySelector('[aria-modal="true"], [role="menu"]'),
      run: () => explorerSelection.clear(),
    },
    {
      id: NAV_FILES_ID,
      name: '共有フォルダを開く',
      icon: FolderOpen,
      description: '共有フォルダの中身を見る',
      run: () => ui.openFiles(),
    },
    {
      id: id('take-photo'),
      name: '写真を撮る',
      icon: Camera,
      description: 'カメラで写真を撮って、チャットに添付する',
      run: async () => {
        await showChat();
        cameraRequest.request();
      },
    },
    {
      id: id('add-files'),
      name: 'ファイルを追加',
      icon: Paperclip,
      description: '入力欄の添付パネルを開く（カメラ・画像・ファイル・最近の画像）',
      run: async () => {
        await showChat();
        attachPanel.show();
      },
    },
    {
      id: id('open-chat'),
      name: 'チャットを開く',
      icon: MessageCircle,
      run: () => showChat(),
    },
    {
      id: id('search'),
      name: 'メッセージを検索',
      icon: Search,
      // Ctrl+F。入力欄にいても開ける
      defaultHotkey: 'Mod+F',
      run: () => ui.openSearch(),
    },
    {
      id: id('open-settings'),
      name: '設定を開く',
      icon: Settings,
      defaultHotkey: 'Mod+,',
      run: () => ui.openSettings(),
    },
    {
      id: id('focus-input'),
      name: '入力欄にフォーカス',
      icon: TextCursorInput,
      run: async () => {
        await showChat();
        document.querySelector<HTMLTextAreaElement>('#main-chat .message-input-textarea')?.focus();
      },
    },
    {
      id: id('close-panel'),
      name: 'パネルを閉じる',
      icon: PanelRightClose,
      run: () => ui.closePanel(),
    },
    {
      id: id('jump-to-latest'),
      name: '最新のメッセージへ移動',
      icon: ArrowDownToLine,
      run: async () => {
        await showChat();
        const el = document.querySelector<HTMLElement>('#main-chat .message-list-scroller');
        el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      },
    },
    {
      id: id('next-unread'),
      name: '未読へ移動',
      icon: ChevronsDown,
      defaultHotkey: 'Alt+Shift+ArrowDown',
      run: () => {
        if (!jumpToNextUnread()) ui.toast('未読はありません', 'info');
      },
    },
    {
      id: id('first-unread'),
      name: 'この画面の最初の未読へ移動',
      icon: BookmarkCheck,
      run: () => jumpToFirstUnread(),
    },
    {
      id: id('toggle-theme'),
      name: 'ライト・ダークを切り替える',
      icon: SunMoon,
      run: () => {
        const dark =
          ui.theme === 'system' ? window.matchMedia('(prefers-color-scheme: dark)').matches : ui.theme === 'dark';
        prefs.setTheme(dark ? 'light' : 'dark');
      },
    },
  ];
}

export const commandHost = new CommandHost();
