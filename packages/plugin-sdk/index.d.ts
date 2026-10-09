/**
 * disnans プラグインの型定義（ホスト API バージョン 1）。
 *
 * プラグインの main.js は ES モジュールで、`Plugin` を継承したクラスを `export default` する。
 * ホスト API はグローバルの `disnans` から取る（`import` は使わない）。
 *
 * ```js
 * // @ts-check
 * /// <reference path="../../packages/plugin-sdk/index.d.ts" />
 * const { Plugin } = disnans;
 * export default class extends Plugin {
 *   onload() { ... }
 * }
 * ```
 *
 * 詳しい作り方は docs/PLUGINS.md を参照。
 */

export {};

declare global {
  const disnans: Disnans.Host;

  namespace Disnans {
    // ---- 基本の型 ----

    type User = {
      id: string;
      login_name: string;
      display_name: string;
      avatar_url: string | null;
    };

    type Manifest = {
      id: string;
      name: string;
      version: string;
      description: string;
      author: string;
      minApiVersion: number;
    };

    /** 後始末の関数 */
    type Cleanup = () => void;

    // ---- グローバルの disnans ----

    interface Host {
      /** ホスト API のバージョン（いまは 1） */
      readonly apiVersion: number;
      /** 継承して使う */
      readonly Plugin: typeof Plugin;
      /** 本体と同じ見た目の部品 */
      readonly ui: Ui;
      /** Session.update が他の人の更新とぶつかったときのエラー（`instanceof` で見分ける） */
      readonly VersionConflictError: typeof VersionConflictError;
    }

    /** Session.update が他の人の更新とぶつかったときのエラー */
    class VersionConflictError extends Error {
      constructor(message?: string);
    }

    /** 本体の状態（読み取り専用。常に最新） */
    interface App {
      readonly me: User;
      readonly users: User[];
      user(id: string): User | undefined;
      /** 表示名。いなければ「不明なユーザー」 */
      nameOf(id: string): string;
      readonly isMobile: boolean;
      /** 現在のテーマ */
      readonly theme: 'light' | 'dark';
    }

    // ---- Plugin ----

    abstract class Plugin {
      readonly app: App;
      readonly manifest: Manifest;
      readonly sessions: Sessions;

      /** 読み込んだときに呼ばれる。ここで add* / register* する */
      onload(): void | Promise<void>;
      /** 外すときに呼ばれる。add* / register* で登録したものは自動で片付くので、それ以外の後始末だけ書く */
      onunload(): void;

      /** 入力欄の `/name` コマンドを足す（補完に出る） */
      addSlashCommand(cmd: SlashCommand): void;
      /** 入力欄の「＋」メニューに項目を足す */
      addComposerAction(action: ComposerAction): void;
      /** キーボードショートカット（デスクトップ） */
      addCommand(cmd: Command): void;
      /** 設定画面にプラグインの欄を出す */
      addSettingTab(tab: SettingTab): void;

      /**
       * view の種類を登録する。type にプラグイン ID と同じ名前を使うと、カードをタップしたときにその view で開く。
       * 型引数 S でセッションの state の型を指定できる。
       */
      registerView<S = unknown>(type: string, factory: (session: Session<S>) => View): void;
      /** パネル（モバイルでは全画面）に view を開く */
      openView<S = unknown>(type: string, session: Session<S>): void;
      /** カードの見た目を独自に描く。省略すると本体の標準のカード */
      registerCardRenderer(render: CardRenderer): void;

      /** 外すときに呼ぶ後始末を登録する */
      register(cleanup: Cleanup): void;
      /** DOM のイベントを登録し、外すときに自動で外す */
      registerDomEvent<K extends keyof WindowEventMap>(
        el: Window,
        type: K,
        cb: (ev: WindowEventMap[K]) => void,
      ): void;
      registerDomEvent<K extends keyof DocumentEventMap>(
        el: Document,
        type: K,
        cb: (ev: DocumentEventMap[K]) => void,
      ): void;
      registerDomEvent<K extends keyof HTMLElementEventMap>(
        el: HTMLElement,
        type: K,
        cb: (ev: HTMLElementEventMap[K]) => void,
      ): void;
      /** setInterval を登録し、外すときに自動で止める（`window.setInterval` の戻り値を渡す） */
      registerInterval(id: number): number;

      /** その端末に保存したプラグインのデータを読む（なければ null） */
      loadData<T = unknown>(): Promise<T | null>;
      /** その端末にプラグインのデータを保存する（JSON にできる値） */
      saveData(data: unknown): Promise<void>;

      /** 通知を送る。session を渡すと、通知から開いたときにそのカードの場所を開く */
      notify(userIds: string[], text: string, opts?: { session?: Session<any> }): Promise<void>;
    }

    // ---- 入力欄 ----

    type SlashCommand = {
      /** `/` に続く名前（英小文字・数字・ハイフン） */
      name: string;
      /** 補完に出る説明 */
      description: string;
      /** 引数の書き方のヒント（例: "[個数]d[面数]"） */
      args?: string;
      /** 引数の候補を出す（任意）。input はコマンド名のあとに打った文字列（先頭の空白は除く） */
      suggestArgs?: (input: string) => Suggestion[];
      /**
       * 送信したときに呼ばれる。メッセージとしては送られない。
       * 例外を投げる（Promise が reject される）と、本体がエラーのトーストを出す。
       */
      run(ctx: SlashContext): void | Promise<void>;
    };

    type Suggestion = {
      /** 選んだときに入る文字列 */
      value: string;
      /** 候補の表示（省略すると value） */
      label?: string;
      description?: string;
    };

    type SlashContext = {
      /** コマンド名のあとの文字列（前後の空白は除く。なければ空文字列） */
      args: string;
      /** 入力したのがスレッドならその ID、メインチャットなら null */
      threadId: string | null;
    };

    type ComposerAction = {
      id: string;
      label: string;
      /** SVG 文字列（24x24、stroke="currentColor" 推奨）。省略するとプラグインの既定のアイコン */
      icon?: string;
      run(ctx: { threadId: string | null }): void | Promise<void>;
    };

    type Command = {
      id: string;
      name: string;
      /** 例: "Mod+Shift+D"（Mod は Ctrl。macOS では Cmd） */
      hotkey?: string;
      run(): void | Promise<void>;
    };

    // ---- 設定 ----

    type SettingTab = {
      /** 設定画面に描く。表示のたびに空の containerEl で呼ばれる */
      display(containerEl: HTMLElement): void;
      /** 閉じたときに呼ばれる（任意） */
      hide?(): void;
    };

    // ---- view ----

    interface View {
      /** 開いたときに呼ばれる。containerEl に描く */
      onOpen(containerEl: HTMLElement): void | Promise<void>;
      /** 閉じたとき（プラグインを外すときも）に呼ばれる。onChange などの購読はここで外す */
      onClose?(): void;
      /** パネルの上部に出す題名（省略するとプラグイン名） */
      title?: string;
    }

    type CardRenderer = (el: HTMLElement, card: CardData) => void;

    type CardData = {
      sessionId: string;
      title: string;
      text: string;
    };

    // ---- セッション ----

    type Card = { title: string; text: string };

    interface Sessions {
      /** セッションを作り、カードをチャットに流す */
      create<S = unknown>(opts: { state: S; card: Card; threadId?: string | null }): Promise<Session<S>>;
      /** セッションを読む（同じ ID なら同じオブジェクトを返す） */
      get<S = unknown>(id: string): Promise<Session<S>>;
    }

    interface Session<S = unknown> {
      readonly id: string;
      readonly plugin: string;
      readonly createdBy: string;
      readonly messageId: string;
      /** 最新の state（他の人の更新も反映される） */
      readonly state: S;
      readonly version: number;
      readonly card: Card;

      /**
       * state（とカード）を保存する。読み込んだときから他の人が更新していたら
       * VersionConflictError で失敗する。そのときは state / version がすでに最新になっているので、
       * 最新の state で考え直して再試行する。
       * 成功すると state / version / card が新しいものになり、onChange も呼ばれる。
       */
      update(state: S, opts?: { card?: Card }): Promise<void>;
      /** 他の人（または自分）が更新したときに呼ばれる */
      onChange(cb: (session: Session<S>) => void): Cleanup;
      /** 保存しない一時的なイベントを、ほかのメンバーに送る */
      emit(name: string, payload?: unknown): void;
      /** 一時的なイベントを受け取る */
      on(name: string, cb: (payload: unknown, from: User) => void): Cleanup;
    }

    // ---- UI 部品 ----

    interface Ui {
      /** 本体と同じ見た目のボタン（`.btn`） */
      button(opts: {
        text: string;
        variant?: 'default' | 'primary' | 'danger';
        onClick?: () => void;
        disabled?: boolean;
      }): HTMLButtonElement;
      /** トグルスイッチ */
      toggle(opts: { value: boolean; onChange?: (value: boolean) => void; label?: string }): HTMLElement;
      /** 1行の入力欄（`.input`） */
      input(opts?: { value?: string; placeholder?: string; onChange?: (value: string) => void }): HTMLInputElement;
      /** 設定の1行（名前・説明と、右側の操作）を containerEl の末尾に足して返す */
      setting(containerEl: HTMLElement, opts: { name: string; description?: string; control?: HTMLElement }): HTMLElement;
      /** トースト */
      toast(text: string, kind?: 'info' | 'error'): void;
      /** 確認ダイアログ。OK なら true */
      confirm(opts: { title: string; body?: string; okLabel?: string; danger?: boolean }): Promise<boolean>;
    }
  }
}
