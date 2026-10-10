/**
 * disnans プラグインの型定義（ホスト API バージョン 7）。
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
 * 詳しい作り方は docs/PLUGINS.md、UI 部品（disnans.ui）は docs/PLUGIN_UI.md を参照。
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
      /** Lucide のアイコン名（例: `dice-5`。英小文字・数字・ハイフン、64 文字まで）。画像にしたいときは `icon.svg` を同梱する */
      icon?: string;
    };

    /** 後始末の関数 */
    type Cleanup = () => void;

    /**
     * アイコンの名前。次の順に探す:
     * 1. 本体の独自のアイコン（`disnans-logo`: アプリのロゴ）
     * 2. addIcon で登録したもの（どのプラグインのものでも）
     * 3. Lucide のアイコン（https://lucide.dev/icons の名前。例: `dice-5`, `message-circle`）
     */
    type IconName = string;

    // ---- グローバルの disnans ----

    interface Host {
      /** ホスト API のバージョン（いまは 7） */
      readonly apiVersion: number;
      /** 継承して使う */
      readonly Plugin: typeof Plugin;
      /** 本体と同じ見た目の部品 */
      readonly ui: Ui;
      /** Session.update が他の人の更新とぶつかったときのエラー（`instanceof` で見分ける） */
      readonly VersionConflictError: typeof VersionConflictError;
      /** 音の入出力の選択（API v5）。通話のプラグイン向け。環境の違い（Android・デスクトップ）はここで隠す */
      readonly audio: Audio;
      /** 本体の通話（API v7）。画面共有などの拡張向け。通話そのもの（参加・ミュート・出力先）は本体の機能で、ここからは状態の読み取りとトラックの追加だけ */
      readonly call: Call;
    }

    /** 通話の参加者1人分（API v7）。同じ人が2台で入れば2つ */
    type CallParticipant = {
      /** 接続の ID（通話の中で一意。再参加すると変わる） */
      peer: string;
      user: User;
      /** 自分自身 */
      self: boolean;
      /** マイクをミュートしている */
      muted: boolean;
      /** スピーカーミュート（相手の声を消している）中 */
      deafened: boolean;
      /** 映像を送受信できる（WebRTC を使える）。`false` の人（Linux の WebKitGTK など）とは音声だけをサーバー経由で流しているので、トラックは届かない */
      canVideo: boolean;
      /** 音声がつながっている（自分自身は参加できていれば true） */
      connected: boolean;
      /** いましゃべっている */
      speaking: boolean;
      /** 端末の種類（`smartphone` `tablet` `laptop` `monitor`。不明なら null） */
      device: string | null;
    };

    /** 相手から届いたメディアのトラック（API v7） */
    type CallRemoteTrack = {
      /** 送ってきた参加者の接続 ID（`CallParticipant.peer`） */
      peer: string;
      user: User;
      track: MediaStreamTrack;
      stream: MediaStream;
    };

    /** 通話のバーに足すボタン（API v7） */
    type CallButtonOptions = {
      icon: IconName;
      /** 読み上げ・ツールチップの文字 */
      label: string;
      onClick: () => void;
      /** 押されている状態の見た目にする（共有中など） */
      active?: boolean;
      disabled?: boolean;
    };

    type CallButton = {
      /** 渡した項目だけ変える */
      update(patch: Partial<CallButtonOptions>): void;
      /** バーから外す */
      remove(): void;
    };

    /**
     * 本体の通話（API v7）。みんな共通の 1 部屋で、参加者の一覧・kick はサーバーが管理し、音声・映像は WebRTC でつなぐ。
     * コールバックの登録や `addTrack` などの返り値の関数は、プラグインが外されるときに自動では外れないので、
     * `this.register(...)` に渡して片付ける。
     */
    interface Call {
      /** 参加している（自分が通話にいる） */
      readonly joined: boolean;
      /**
       * この環境が映像を送受信できるか。`false` なら（WebRTC を使えない環境の）サーバー経由の音声だけで、
       * `addTrack` は例外になり、相手の映像も届かない
       */
      readonly canVideo: boolean;
      /** 参加者。参加していれば自分（`self: true`）が先頭。参加していなくても、いま通話にいる人が入る */
      readonly participants: CallParticipant[];
      /** いま届いている、音声以外（と声以外）のトラック */
      readonly remoteTracks: CallRemoteTrack[];
      /** 通話に参加する（マイクの許可などの失敗は本体がトーストで知らせる） */
      join(): Promise<void>;
      /** 通話から抜ける */
      leave(): void;
      /**
       * 映像などのトラックを通話に足す。つながっている相手へ再ネゴシエーションで届け、あとから来た人にも送る。
       * 通話に参加していないとき・`canVideo` が `false` のときは例外。戻り値の関数で外す（通話を抜けると自動で外れる）。
       * 画面共有なら `navigator.mediaDevices.getDisplayMedia()` のトラックを渡す
       */
      addTrack(track: MediaStreamTrack, stream?: MediaStream): Cleanup;
      /** `addTrack` したトラックを外す（トラックを `stop()` はしない） */
      removeTrack(track: MediaStreamTrack): void;
      /** 通話の状態が変わったとき（参加・退出・参加者の出入り・ミュート・つながった・しゃべり始めなど）。戻り値の関数で外す */
      onChange(cb: () => void): Cleanup;
      /** 相手からトラック（映像など）が届いたとき。戻り値の関数で外す */
      onTrack(cb: (t: CallRemoteTrack) => void): Cleanup;
      /** 届いていたトラックが外れた・終わった・相手が抜けたとき。戻り値の関数で外す */
      onTrackEnd(cb: (t: CallRemoteTrack) => void): Cleanup;
      /** 通話のバー（画面上部）にボタンを足す。通話に参加している間だけ表示される */
      addButton(opts: CallButtonOptions): CallButton;
    }

    /** 音の出力先（API v5） */
    type AudioOutput = {
      /** `audio.setOutput` に渡す ID（端末ごとに違う。保存するなら kind と label も覚えておくとよい） */
      id: string;
      /** 表示用の名前（「受話口」「スピーカー」「イヤホン（…）」「Bluetooth（…）」など） */
      label: string;
      /** `earpiece` `speaker` `wired` `bluetooth`（Android）、デスクトップは `other` */
      kind: string;
      /** いま使っているか */
      selected: boolean;
    };

    /** 音の入力（マイク）（API v5） */
    type AudioInput = { id: string; label: string };

    /**
     * 音の入出力の選択（API v5）。使えない環境では一覧が空になる。
     * - Android: 出力先は端末全体（通話中のみ）。受話口・スピーカー・有線イヤホン・Bluetooth から選べる。入力は選べない（空）
     * - デスクトップ・ブラウザー: `setSinkId` が使えれば、`attach` した要素の出力先を切り替える。入力は `getUserMedia({ audio: { deviceId } })` に渡す
     */
    interface Audio {
      /** 選べる出力先。Android では通話中（`holdBackground` の `microphone`）に呼ぶ */
      listOutputs(): Promise<AudioOutput[]>;
      /** 出力先を切り替える。切り替えられたら true */
      setOutput(id: string): Promise<boolean>;
      /** 選べるマイク。Android では空 */
      listInputs(): Promise<AudioInput[]>;
      /** 音を出す `<audio>` など（`AudioContext` も可）を登録する。デスクトップで、選んだ出力先に出すために使う。戻り値の関数で外す */
      attach(el: HTMLMediaElement | AudioContext): Cleanup;
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

      /** 入力欄の `/name` コマンドを足す（補完に出る）。新しく書くなら addCommand の slash を使う */
      addSlashCommand(cmd: SlashCommand): void;
      /** 入力欄の「＋」メニューに項目を足す */
      addComposerAction(action: ComposerAction): void;
      /**
       * コマンドを足す（API v2）。コマンドパレット・設定のショートカットの一覧に出て、
       * hotkey（既定のショートカット）・slash（入力欄の `/name`）からも実行できる
       */
      addCommand(cmd: Command): void;
      /** 設定画面にプラグインの欄を出す */
      addSettingTab(tab: SettingTab): void;
      /** このプラグインの設定画面を開く（API v6）。設定タブに切り替える */
      openSettings(): void;
      /**
       * アイコンを登録する。以後、アイコン名を受け取るところ（ui.icon、ComposerAction.icon など）で使える。
       * svg は `<svg>` まるごとか、中身だけ（`<path d="..."/>` など）。viewBox は 24x24 を想定し、
       * 既定は `fill="none" stroke="currentColor" stroke-width="2"`（Lucide と同じ）。外すときに自動で消える。
       * 名前はほかのプラグインとぶつからないように、プラグイン ID を前に付けるとよい（例: `dice-cup`）
       */
      addIcon(name: IconName, svg: string): void;

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

      /**
       * このプラグインの名前（`name` で変えられる）のボットとして、チャットにメッセージを投稿する（API v5）。
       * 投稿した人（author）は自分のままで、メッセージに bot の印が付く。`threadId` を省くとメインチャット。
       * 本文は普通のメッセージと同じ制限（空でなく 10,000 文字まで）。`name` は前後の空白を除いて 40 文字まで。
       * `notify: true` なら、メンションされた人・スレッドの参加者に加えて、投稿した本人にも通知する（API v6）。
       * 通知の文言はボットの名前で作る。省略（`false`）すると通知は送らない
       */
      postMessage(opts: { body: string; threadId?: string | null; name?: string; notify?: boolean }): Promise<void>;

      /**
       * このプラグインの一時的なイベントを、いまつながっているほかの人（と自分の別の端末）に送る（API v3）。
       * セッションには紐づかず、保存もしない。自分には届かない。届くのはオンラインの人だけで、遅れて来た人には届かない。
       * 宛先は選べず全員に届くので、宛先が要るときは payload に入れて受け取る側で見分ける。payload は 64 KB まで
       */
      broadcast(name: string, payload?: unknown): void;
      /** broadcast を受け取る（API v3）。外すときに自動で外れる。from は送った人 */
      onBroadcast(name: string, cb: (payload: unknown, from: User) => void): Cleanup;
      /**
       * 常時表示のステータス欄（アプリの最上部の帯。通話のバーと同じ枠）に出す要素を足して返す（API v3）。
       * 中身はプラグインが自由に描く。何も入れない（`:empty`）間は隠れる。外すときに自動で消える
       */
      addStatusBarItem(): HTMLElement;
      /**
       * 画面を消したり別のアプリに切り替えたりしても動き続けられるようにする（API v3。通話など）。
       * Android ではフォアグラウンドサービスを動かし、通知欄に「動いています」と出す。
       * デスクトップなど、ほかの環境では何もしない。戻り値の関数で解除する（外すときにも自動で解除される）。
       * `microphone` を使うときは、先にマイクの許可を得ておく（getUserMedia のあとに呼ぶ）。
       * 戻り値は解除の関数で、`update()` で通知の文言とボタンを差し替えられる（API v4）。
       * `actions` と `onAction` で通知にボタンを付けられる（API v4。Android）
       */
      holdBackground(opts?: BackgroundOptions): Promise<BackgroundHandle>;
    }

    /** 通知のボタン（API v4） */
    type BackgroundAction = {
      /** `onAction` に渡る ID */
      id: string;
      /** ボタンの文言 */
      title: string;
      /**
       * true にすると、アプリの WebView が止まっていて `onAction` を呼べないときに、
       * 通知とサービスをその場で止める（「切断」のように、必ず効かせたいボタン用）。
       * 呼べるときは `onAction` に任せる
       */
      dismiss?: boolean;
    };

    /** `holdBackground` の戻り値。関数として呼ぶと解除する */
    type BackgroundHandle = Cleanup & {
      /** 通知の文言・ボタンを差し替える（渡した項目だけ変わる）。解除したあとは何もしない（API v4） */
      update(patch: BackgroundUpdate): void;
    };

    type BackgroundUpdate = {
      title?: string;
      text?: string;
      /** 空配列にするとボタンを外す */
      actions?: BackgroundAction[];
    };

    type BackgroundOptions = {
      /** マイクを使い続ける（Android の microphone 型のサービス） */
      microphone?: boolean;
      /** 通知欄の題名（省略するとプラグイン名） */
      title?: string;
      /** 通知欄の本文 */
      text?: string;
      /** 通知欄のボタン（最大3つ。API v4。Android だけ。ほかの環境では何も出ない） */
      actions?: BackgroundAction[];
      /**
       * ボタンが押されたときに呼ばれる（アプリが裏にいても届く。API v4）。
       * 複数のプラグインが同時に頼んだときは、通知に出ている（最後に頼んだ）ものにだけ届く
       */
      onAction?: (id: string) => void;
    };

    // ---- 入力欄 ----

    type SlashCommand = {
      /** `/` に続く名前（英小文字・数字・ハイフン） */
      name: string;
      /** 補完に出る説明 */
      description: string;
      /** 補完に出すアイコン（省略するとプラグインのアイコン） */
      icon?: IconName;
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
      /** アイコン（省略するとプラグインのアイコン）。独自の SVG は addIcon で登録してから名前で指定する */
      icon?: IconName;
      run(ctx: { threadId: string | null }): void | Promise<void>;
    };

    type Command = {
      /** プラグインの中で一意な ID。利用者のショートカットの設定は `<プラグイン ID>:<id>` で保存される */
      id: string;
      /** 表示名（コマンドパレット・設定のショートカットの一覧に出る） */
      name: string;
      /** アイコン（省略するとプラグインのアイコン） */
      icon?: IconName;
      /**
       * 既定のショートカット。例: "Mod+Shift+D"（Mod は Ctrl。macOS では Cmd）。
       * 利用者は設定で変えたり外したりできる。デスクトップだけ（Android では効かない）
       */
      hotkey?: string;
      /** 入力欄の `/name` としても使えるようにする（英小文字・数字・ハイフン）。省略するとスラッシュコマンドにしない */
      slash?: string;
      /** スラッシュコマンドの補完に出す説明（省略すると name） */
      description?: string;
      /** スラッシュコマンドの引数の書き方のヒント（例: "[個数]d[面数]"） */
      args?: string;
      /** スラッシュコマンドの引数の候補を出す（任意） */
      suggestArgs?: (input: string) => Suggestion[];
      /**
       * 実行したときに呼ばれる。例外を投げる（Promise が reject される）と、本体がエラーのトーストを出す。
       * ctx は API v2 から（v1 の本体では引数なしで呼ばれる）
       */
      run(ctx: CommandContext): void | Promise<void>;
    };

    type CommandContext = {
      /** スラッシュコマンドならコマンド名のあとの文字列（前後の空白は除く）。ショートカット・パレットからは空文字列 */
      args: string;
      /** スラッシュコマンドなら入力したスレッド、ショートカット・パレットなら開いているスレッドの ID。メインチャットなら null */
      threadId: string | null;
      /** どこから実行したか */
      via: 'hotkey' | 'palette' | 'slash';
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
      /**
       * 開いたときに呼ばれる。containerEl に描く。
       * panel でパネルの上部（題名・アイコン）をあとから変えられる
       */
      onOpen(containerEl: HTMLElement, panel: ViewPanel): void | Promise<void>;
      /** 閉じたとき（プラグインを外すときも）に呼ばれる。onChange などの購読はここで外す */
      onClose?(): void;
      /** パネルの上部に出す題名（省略するとプラグイン名。空文字列なら出さない） */
      title?: string;
      /** パネルの上部に出すアイコン（省略するとプラグインのアイコン。空文字列なら出さない） */
      icon?: IconName;
    }

    /** view を出しているパネル */
    interface ViewPanel {
      /** 題名を変える。null で既定（View.title → プラグイン名）に戻す。空文字列なら出さない */
      setTitle(title: string | null): void;
      /** アイコンを変える。null で既定（View.icon → プラグインのアイコン）に戻す。空文字列なら出さない */
      setIcon(icon: IconName | null): void;
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
    // 詳しくは docs/PLUGIN_UI.md。見た目は本体のグローバルの CSS クラスで、本体の部品と同じ DOM を作る

    type ButtonOptions = {
      /** ghost は枠も背景もなく、ホバーで背景に色を付ける（`.btn.ghost`） */
      variant?: 'default' | 'primary' | 'danger' | 'ghost';
      onClick?: () => void;
      disabled?: boolean;
    } & (
      | {
          /** ボタンの文字 */
          text: string;
          /** 文字の左に出すアイコン */
          icon?: IconName;
          /** 読み上げ用の名前（省略すると text） */
          label?: string;
        }
      | {
          text?: undefined;
          /** アイコンだけのボタン（`.btn-icon-only`） */
          icon: IconName;
          /** 読み上げ用の名前（アイコンだけのときは必須） */
          label: string;
        }
    );

    type IconOptions = {
      /** 大きさ（px）。既定は 24 */
      size?: number;
      /** 足すクラス */
      class?: string;
      /** 読み上げ用の名前。省略すると飾り（aria-hidden） */
      label?: string;
    };

    type SegmentedOption = {
      value: string;
      label: string;
      icon?: IconName;
    };

    type NavBarItem = {
      id: string;
      label: string;
      icon: IconName;
      /** 右上に出す数字など（0・空文字列・null なら出さない） */
      badge?: number | string | null;
    };

    interface Ui {
      /** アイコンの <svg>（`.icon`）。Lucide の名前・`disnans-logo`・addIcon で登録した名前を使える */
      icon(name: IconName, opts?: IconOptions): SVGSVGElement;
      /** 本体と同じ見た目のボタン（`.btn`）。文字だけ・アイコン+文字・アイコンだけ（`.btn-icon-only`） */
      button(opts: ButtonOptions): HTMLButtonElement;
      /** トグルスイッチ（`.toggle`） */
      toggle(opts: { value: boolean; onChange?: (value: boolean) => void; label?: string }): HTMLElement;
      /** 1行の入力欄（`.input`） */
      input(opts?: { value?: string; placeholder?: string; onChange?: (value: string) => void }): HTMLInputElement;
      /** 横に並んだ選択肢から1つを選ぶボタン（`.segmented`）。選ぶと見た目も切り替わる */
      segmented(opts: {
        options: SegmentedOption[];
        value: string;
        onChange?: (value: string) => void;
        /** 読み上げ用の名前 */
        label?: string;
      }): HTMLElement;
      /** タブのバー（`.nav-bar`。本体の下のナビゲーションと同じ見た目）。選ぶと見た目も切り替わる */
      navbar(opts: {
        items: NavBarItem[];
        selected?: string;
        onSelect?: (id: string) => void;
        /** 読み上げ用の名前 */
        label?: string;
      }): HTMLElement;
      /** 横の区切り線（`.divider`） */
      divider(): HTMLHRElement;
      /** 設定の1行（アイコン・名前・説明と、右側の操作）を containerEl の末尾に足して返す（`.setting-row`） */
      setting(
        containerEl: HTMLElement,
        opts: { name: string; description?: string; icon?: IconName; control?: HTMLElement },
      ): HTMLElement;
      /** トースト */
      toast(text: string, kind?: 'info' | 'error'): void;
      /** 確認ダイアログ。OK なら true。okLabel の既定は「OK」、ngLabel（取り消すボタン）の既定は「キャンセル」 */
      confirm(opts: { title: string; body?: string; okLabel?: string; ngLabel?: string; danger?: boolean }): Promise<boolean>;
    }
  }
}
