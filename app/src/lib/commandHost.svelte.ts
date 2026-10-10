import { tick } from 'svelte';
import MessageCircle from '@lucide/svelte/icons/message-circle';
import MessagesSquare from '@lucide/svelte/icons/messages-square';
import Settings from '@lucide/svelte/icons/settings';
import TextCursorInput from '@lucide/svelte/icons/text-cursor-input';
import PanelRightClose from '@lucide/svelte/icons/panel-right-close';
import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
import Command from '@lucide/svelte/icons/command';
import SunMoon from '@lucide/svelte/icons/sun-moon';
import ChevronsDown from '@lucide/svelte/icons/chevrons-down';
import ChevronsUp from '@lucide/svelte/icons/chevrons-up';
import BookmarkCheck from '@lucide/svelte/icons/bookmark-check';
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
import { isAndroid } from './config';
import { prefs } from './stores/prefs.svelte';
import { ui } from './stores/ui.svelte';
import { callCommands, registerCallComposerAction } from './call/commands';
import { startCall } from './call/instance.svelte';
import { jumpToFirstUnread, jumpToNextUnread, jumpToPrevUnread } from './unreadNav';

/** コマンドパレットを開くコマンド（設定の説明にも使う） */
export const PALETTE_COMMAND_ID = `${APP_COMMAND_PREFIX}command-palette`;

/** コマンドパレット・ホットキーの記録の状態 */
class CommandHost {
  /** コマンドパレットを開いているか */
  paletteOpen = $state(false);
  /** 設定でホットキーを記録している間は、ホットキーを効かせない */
  recording = $state(false);
  private started = false;

  /** パレットとホットキーを使えるか（Android では使わない） */
  get available(): boolean {
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
    registerCallComposerAction();
    window.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  /** いま開いているスレッド（なければ null） */
  get threadId(): string | null {
    return ui.panel?.kind === 'thread' ? ui.panel.id : null;
  }

  /** コマンドを実行する。失敗はトーストで知らせる */
  async run(cmd: AppCommand, via: Exclude<CommandVia, 'slash'>): Promise<void> {
    try {
      await runCommand(cmd, { args: '', threadId: this.threadId, via });
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.available || this.recording || e.repeat || e.isComposing || e.defaultPrevented) return;
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
  ui.tab = 'chat';
  if (ui.isMobile) ui.closePanel();
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
      // Ctrl+P（macOS では Cmd+P）に加えて F2 でも開ける
      defaultHotkey: ['Mod+P', 'F2'],
      run: () => {
        if (host.available) host.paletteOpen = !host.paletteOpen;
      },
    },
    {
      id: id('open-chat'),
      name: 'チャットを開く',
      icon: MessageCircle,
      run: () => showChat(),
    },
    {
      id: id('open-threads'),
      name: 'スレッドの一覧を開く',
      icon: MessagesSquare,
      run: async () => {
        if (ui.isMobile) {
          ui.closePanel();
          ui.tab = 'threads';
          return;
        }
        // デスクトップでは横に出ているので、一覧の先頭にフォーカスする
        await showChat();
        document.querySelector<HTMLElement>('#sidebar .thread-list-item')?.focus();
      },
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
        // スレッドを開いていればその入力欄、なければメインチャットの入力欄
        const inPanel = ui.panel?.kind === 'thread';
        if (!inPanel) await showChat();
        const sel = inPanel ? '.shell-thread-panel .message-input-textarea' : '#main-chat .message-input-textarea';
        document.querySelector<HTMLTextAreaElement>(sel)?.focus();
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
        // スレッドを開いていればそのスレッド、なければメインチャット
        const inPanel = ui.panel?.kind === 'thread';
        if (!inPanel) await showChat();
        const el = document.querySelector<HTMLElement>(
          inPanel ? '.shell-thread-panel .message-list-scroller' : '#main-chat .message-list-scroller',
        );
        el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      },
    },
    {
      id: id('next-unread'),
      name: '次の未読へ移動',
      icon: ChevronsDown,
      defaultHotkey: 'Alt+Shift+ArrowDown',
      run: () => {
        if (!jumpToNextUnread()) ui.toast('未読はありません', 'info');
      },
    },
    {
      id: id('prev-unread'),
      name: '前の未読へ移動',
      icon: ChevronsUp,
      defaultHotkey: 'Alt+Shift+ArrowUp',
      run: () => {
        if (!jumpToPrevUnread()) ui.toast('未読はありません', 'info');
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
        ui.setTheme(dark ? 'light' : 'dark');
      },
    },
  ];
}

export const commandHost = new CommandHost();
