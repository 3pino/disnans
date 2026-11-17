# fixplor の切り離しと、エクスプローラーのプラグイン化

状態: 方針（決定）。個々の実装は未着手・一部着手。未決の点は末尾。FEEDBACKS の「ファイルエクスプローラーを別のアプリとして切り出したい」に紐づく。

## 目標と位置づけ

- **fixplor**（[3pino/fixplor](https://github.com/3pino/fixplor)）は、**ふつうのファイラー**。ネットワークドライブ（WebDAV など）を見る機能を標準で持つ。Disnans のための特別なコードは入れない。
- Disnans のサーバーは `/dav/` で WebDAV を出している（[共有フォルダの API](../api/shared-folder.md)）。fixplor から見ると、ふつうの WebDAV の置き場所の 1 つ。Disnans との連携は、その結果としてできるだけで、fixplor の中で連携を作る意図はない。
- **Disnans の中の fixplor プラグイン**は、fixplor のアプリ版の**機能縮小版**。アプリ版との違いは、Disnans のサーバーへ**自動でつながる**ことだけ。
- 見た目と操作感は、Disnans・fixplor・プラグインで同じにする。だから、アプリの土台（枠・部品・ビューア・設定の枠など）は、できるだけ共有のパッケージに移し、fixplor はそれを取り込むだけに近づける。

## 原則

1. fixplor と共有パッケージ（`explorer-kit`・`ui-kit-web` など）に、**Disnans 固有の言葉・形・コードを入れない**。Disnans 固有のことは、Disnans の側（置き場所と本体の機能を渡すところ、またはプラグイン）に置く。
2. 共有パッケージは、作る側と使う側を同じ向きにする。Disnans が共有パッケージを使う。逆（共有パッケージが Disnans を知る）はしない。
3. 共通の画面と決まりは、**2 つの口**（置き場所 `ExplorerApi` と、本体から借りる機能 `ExplorerHost`。[architecture.md](../design/architecture.md)）を通して外とやりとりする。
4. 見た目は `@3pino/design-system`（CSS）と `@3pino/ui-kit-web`（Svelte の部品）。部品の DOM 版は持たない（プラグインには、ホストが Svelte の部品を mount して渡す）。

## いまの形（v0.2.74）

| パッケージ・リポジトリ | 中身 | 使う側 |
|---|---|---|
| `@3pino/design-system` | CSS のトークンと部品の見た目 | Disnans・ui-kit-web・explorer-kit・fixplor |
| `@3pino/ui-kit-web` | Svelte の UI 部品（Button・Menu・Modal・NavBar・SettingRow・SortableList ほか）・アイコンの登録簿 | 同上 |
| `@3pino/explorer-kit` | エクスプローラーの画面・決まり・状態（置き場所と本体の口ごしに動く） | Disnans・fixplor |
| Disnans | 置き場所は「サーバーの共有フォルダ」。本体の機能（通知・確認・拡大表示ほか）を渡す | |
| fixplor | 置き場所は「このデバイス」（Rust の `fs_*`）。ファイラーの外枠 | |

## 最終の形

- **fixplor のリポジトリが唯一の元**になる。中に、エクスプローラー本体（いまの `explorer-kit`）をパッケージ（npm workspace）として持ち、そこから 2 つを作る。
  - アプリ版（置き場所: このデバイスと、WebDAV などのネットワークドライブ）
  - Disnans のプラグイン（置き場所: プラグイン API の `this.files`。自動でつながる）
- Disnans は、**ビルドの時には何も取り込まない**。fixplor のプラグインを、標準のプラグインとして読み込む。`explorer-kit` のリポジトリは無くなる。
- 標準のプラグインの配り方・Svelte の実行環境の持ち方・本体との境界は、[core-plugins.md](core-plugins.md) の決定（アプリに同梱・本体と同時に更新・Svelte のままプラグイン用にビルド）に従う。ただし、作る場所が Disnans のリポジトリではなく、fixplor のリポジトリになる点が違う。
- **いま `explorer-kit` を fixplor に統合しない**理由: Disnans がビルド時に `explorer-kit` を git の依存として取り込んでいて、npm は、リポジトリの一部のフォルダだけを依存にできない。Disnans の組み込みのエクスプローラーをプラグインに置き換えるまでの、橋渡しとして残す。

## 段階

| 段 | すること | 状態 |
|---|---|---|
| 1 | `explorer-kit` から Disnans の言葉・形を無くす（v0.3.0）。`attachments` は「保護されたフォルダ」のような中立の概念に、ドラッグの MIME も中立にする。動作は変えない | 進行中 |
| 2 | 画面の流れの試験を `explorer-kit` に移す（置き場所はメモリ上の偽物）。Disnans と fixplor の側には、薄い接続の確認だけを残す | 進行中 |
| 3 | fixplor に WebDAV の置き場所を足す（下） | 設計済み |
| 4 | アプリの土台を共有パッケージへ出す（下）。fixplor の手書きのコピーをなくす | 調査済み |
| 5 | プラグイン API を足し、fixplor のプラグインを作り、Disnans の組み込みのエクスプローラーと並べて、同じに動くことを確かめる | 未着手 |
| 6 | 組み込みのエクスプローラーを標準のプラグインに置き換え、`explorer-kit` のリポジトリを fixplor に統合する | 未着手 |

## WebDAV の置き場所（段 3）

- 実装は Rust（`reqwest`）。WebView の `fetch` では `/dav/` に CORS がなく使えない。
- `ExplorerApi` の list・write・mkdir・move・copy・upload・size は、PROPFIND・PUT・MKCOL・MOVE・COPY に対応させる。失敗の種類は、`FsError.code` の組（`exists`・`parent_missing` など）に写す。黙って上書きしない（ETag と `If-Match`、`Overwrite` の明示）。ETag をサーバーが出すかは、実装の最初に確かめる。
- **ゴミ箱**: WebDAV に「ゴミ箱」はなく、Disnans の `/dav/` でも `DELETE` は完全な削除。fixplor の「消すのはゴミ箱だけ」の決まりと合わないので、置き場所の能力（`caps.trash`）を偽にし、確認の文を変える。Disnans のゴミ箱（REST）を使う案は、Disnans 固有のコードになるので、fixplor には入れない（プラグイン側の仕事）。
- **認証**: Disnans の `/dav/` は Tailscale の識別だけで、Basic はない。一般の WebDAV には、Basic 認証と資格情報の保管（OS のキーチェーン。`keyring` の依存）が要る。
- **サムネイル**: `<img>` に認証を付けられないので、認証が要る置き場所では、Rust がブロブにして渡す。
- 試験は、実際の `disnans-server`（一時のデータフォルダ）に対する結合試験と、モックの両方で行う。本番には触れない。

## アプリの土台の共有（段 4）

共有の候補（調査の結果）:

- **土台の基盤**（TS のみ）: `platform`・`storage`・`localKeys`・`diagLog`・`systemBars`・ジェスチャ・ドロップ・クリップボードなど。
- **アプリの枠の部品**: トースト・確認・アクションシート・設定の枠・テーマの選択・更新の画面・`Shell` の骨組み（枠・safe-area・戻る。中身はスロット）。
- **ビューア**: Lightbox・画像・PDF・`PdfThumb`（`pdfjs` は peer）。fixplor が最初に必要とする。
- **Tauri 側**: `apk-updater`・`system-bars`・`os_drop`・`platform`（Rust のクレートとプラグインを、共有のワークスペースへ）。

共有しないもの: 設定のキー表・`config`・共有ストレージ・チャット・通話・通知・画面共有・プラグインの仕組み・サーバーとの通信。

進める順番:

1. `stores/ui.svelte.ts`（316 行。トースト・確認・Lightbox・戻る履歴・タブ・通話・設定が 1 つのクラスに入っていて、約 40 か所が使っている）を、土台の部分とチャット専用の部分に分ける。これが最大の関門。
2. 土台の基盤（TS）→ トースト・確認 → ビューア → 設定の枠 → 更新の画面 → OS のドロップ → `Shell` の骨組み（最後）。
3. 先に、`ui-kit-web` の触覚と NavBar、`explorer-kit` の種類の判定と `fileLink` の重複をなくす。

## プラグイン化に足りないこと（段 5）

`this.files` は、`list`・`stat`・`read`・`write`・`mkdir`・`remove`・`move`・`copy`・`onChange` を持っていて、`ExplorerApi` の大部分を賄える。足りないのは次のようなもの。

- ゴミ箱（一覧・戻す・完全に消す）・サイズ・アップロードの進み具合。
- 拡大表示・ダウンロード・クリップボードなど、ホストの機能。
- Disnans の画面からエクスプローラーを指す入口（チャットのファイルのリンクからそのパスを開く・作成画面で共有フォルダのファイルを選ぶ・添付の索引・メッセージの検索）。いまは約 17 ファイルにまたがる。
- メインのナビゲーションにビューとして入ること。

## 決めてほしいこと（未決）

1. 一般の WebDAV（Basic と、`keyring` などの新しい依存）を、段 3 に入れるか。
2. `/dav/` の `DELETE` が完全な削除であることを、fixplor の画面でどう見せるか（確認の文・無効化）。
3. プラグインの標準の配り方（アプリへの同梱と、レジストリでの更新）と、ホストの API の版の合わせ方。
4. 段 5 で足すホストの API の範囲。

## リスク

- 共有パッケージが増えるほど、タグとロックファイルの更新が増える（リポジトリごとの CI も）。
- Svelte のバージョンの揃え（peer）と、Disnans の内部（`Symbol('events')` に頼る処理）。
- プラグインの Svelte の実行環境が、ホストと別になる問題は、[core-plugins.md](core-plugins.md) の方式に従う。
- 試験は、移すのであって、重複させない。
