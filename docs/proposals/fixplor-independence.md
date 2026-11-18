# fixplor の切り離しと、エクスプローラーのプラグイン化

状態: 方針（決定）。段 1〜6 完了（API 20 で内蔵のエクスプローラーを削除し、Disnans から `explorer-kit` の依存を外した）。段 4 の一部（`Shell` の骨組み・設定の枠組み・Tauri 側の共有）が残り。Disnans の「ファイル」は同梱の fixplor プラグインで動く。fixplor 側の全画面の対応（`layout: 'full'`）は fixplor 0.1.1 で入る。決めたことと、まだ決めていないことは末尾。FEEDBACKS の「ファイルエクスプローラーを別のアプリとして切り出したい」に紐づく。

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

## いまの形（v0.2.79）

| パッケージ・リポジトリ | 中身 | 使う側 |
|---|---|---|
| `@3pino/design-system` | CSS のトークンと部品の見た目 | Disnans・ui-kit-web・explorer-kit・fixplor |
| `@3pino/ui-kit-web` | Svelte の UI 部品（Button・Menu・Modal・NavBar・SettingRow・SortableList ほか）・アイコンの登録簿 | 同上 |
| `@3pino/app-kit-web` | アプリの土台（platform・storage・トースト・確認・戻る・更新・OS のドロップ・設定の項目） | Disnans・fixplor |
| `@3pino/viewer-kit-web` | 拡大表示・画像・PDF・サムネイル | Disnans・fixplor |
| `@3pino/explorer-kit` | エクスプローラーの画面・決まり・状態（置き場所と本体の口ごしに動く） | Disnans・fixplor |
| fixplor プラグイン（`plugins/fixplor`、タグ `plugin-fixplor-vX.Y.Z`） | 上の部品を束ねた Disnans のプラグイン（置き場所は `this.files`）。Svelte ごと 1 つの `main.js` に同梱（約 50KB gz） | Disnans（同梱） |
| Disnans | 置き場所は「サーバーの共有フォルダ」。本体の機能（通知・確認・拡大表示ほか）をプラグイン API 19 で渡す。fixplor プラグインを `app/core-plugins.lock.json` で固定して同梱 | |
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
| 1 | `explorer-kit` から Disnans の言葉・形を無くす（v0.3.0）。`attachments` は「保護されたフォルダ」のような中立の概念に、ドラッグの MIME も中立にする。動作は変えない | 完了（explorer-kit v0.3.0） |
| 2 | 画面の流れの試験を `explorer-kit` に移す（置き場所はメモリ上の偽物）。Disnans と fixplor の側には、薄い接続の確認だけを残す | 完了 |
| 3 | fixplor に WebDAV の置き場所を足す（Disnans の `/dav/` と、Basic 認証の一般の WebDAV の両方。下） | 完了（fixplor: Rust の WebDAV・Basic 認証と keyring・fixdav 中継。証明書の指紋の固定は未実装） |
| 4 | アプリの土台を共有パッケージへ出す（下）。fixplor の手書きのコピーをなくす | ほぼ完了: `ui` 分割、`@3pino/app-kit-web` v0.2.0（core・shell・更新・OS のドロップ・設定の項目）、`@3pino/viewer-kit-web` v0.1.0（拡大表示・画像・PDF）。fixplor は app-kit-web・viewer-kit-web を使用中。残り: `Shell` の骨組み・設定の枠組み・Tauri 側の共有（設計メモのみ） |
| 5 | プラグイン API を足し、fixplor のプラグインを作り、Disnans の組み込みのエクスプローラーと並べて、同じに動くことを確かめる | 完了（API 19。fixplor 0.1.0 を `plugin-fixplor-v0.1.0` で配布。実ホストの検査は fixplor の `check:host`（xvfb）と、Disnans の `nav-bar-check`。実機の確認は FEEDBACKS） |
| 6 | 組み込みのエクスプローラーを標準のプラグインに置き換え、`explorer-kit` のリポジトリを fixplor に統合する | 内蔵の削除は完了（API 20。「ファイル」は fixplor だけ。Disnans から `explorer-kit` の依存を外した）。残り: `explorer-kit` のリポジトリを fixplor に統合する（fixplor 側の作業）。実機の確認（[core-plugins.md](core-plugins.md)） |

## WebDAV の置き場所（段 3）

- 実装は Rust（`reqwest`）。WebView の `fetch` では `/dav/` に CORS がなく使えない。
- `ExplorerApi` の list・write・mkdir・move・copy・upload・size は、PROPFIND・PUT・MKCOL・MOVE・COPY に対応させる。失敗の種類は、`FsError.code` の組（`exists`・`parent_missing` など）に写す。黙って上書きしない（ETag と `If-Match`、`Overwrite` の明示）。ETag をサーバーが出すかは、実装の最初に確かめる。
- **削除**: WebDAV に「ゴミ箱」はなく、Disnans の `/dav/` でも `DELETE` は完全な削除。fixplor は「完全な削除を一切しない」という方針を**取りやめ**、**完全に削除する前には、必ずポップアップで確認する**ことにする。ゴミ箱のある置き場所（このデバイス）はこれまでどおりゴミ箱へ送り、ない置き場所では、置き場所の能力（`caps.trash`）を偽にして、確認の文を「完全に削除します。元に戻せません」に変える。Disnans のゴミ箱（REST）を使うのは、Disnans 固有のコードになるので、fixplor には入れない（プラグインの仕事）。
- **認証**: Disnans の `/dav/` は Tailscale の識別だけで、Basic はない。一般の WebDAV 用に、Basic 認証と資格情報の保管（OS のキーチェーン。`keyring` の依存）を**段 3 に入れる**。新しい依存（`reqwest`・`rustls`・`keyring`・試験用の `wiremock`）は、段 3 の実装の前に、最終の一覧を見せて承認を取る。
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

## プラグイン化に足りないこと（段 5。API 19 で入れた）

（以下は設計時の整理。実装の結果は `docs/plugins/*` と SDK の `index.d.ts`。「ファイルの選択」「リンクの開き」は口を入れた。ナビバーへの入り方は、設計を変えて、コマンドとして登録し、利用者がナビバーの設定で足す方式にした。「ファイル」の入口は、プラグインのナビの項目（コマンド）で、全画面の view（`layout: 'full'`、API 20）として開く。）

`this.files` は、`list`・`stat`・`read`・`write`・`mkdir`・`remove`・`move`・`copy`・`onChange` を持っていて、`ExplorerApi` の大部分を賄える。足りないのは次のようなもの。

- Disnans のゴミ箱（一覧・戻す・完全に消す）・サイズ・アップロードの進み具合。
- 拡大表示・ダウンロード・クリップボードなど、ホストの機能。
- **Disnans の画面からエクスプローラーを指す入口**（チャットのファイルのリンクからそのパスを開く・作成画面で共有フォルダのファイルを選ぶ・添付の索引・メッセージの検索）。**fixplor プラグインの機能として入れる**。ホストには、リンクなどの「開く先」をプラグインが引き受ける口と、プラグインが選ぶ画面（ファイルの選択）を呼ぶ口を足す。いまは約 17 ファイルにまたがるので、口ごとに順に移す。
- **メインのナビゲーションにビューとして入ること**。これも **fixplor プラグインの機能**。`View` の仕組みは既にあるので、ナビバーへの入り方（アイコン・バッジ・戻る操作・選択の状態）を、本体の画面と同じ扱いにする口を足す。

## 決めたこと

- **一般の WebDAV（Basic 認証・資格情報の保管）は段 3 に入れる。**
- **完全な削除を一切しないという方針は取りやめる。** 完全に削除する前には、ポップアップで確認を取る（上の「削除」）。fixplor の `docs/design.md` の「消すのはゴミ箱だけ」は、これに合わせて書き換える。
- **Disnans の画面からエクスプローラーを指す入口と、メインのナビゲーションへの入り方は、fixplor プラグインの機能として入れる。** 本体には、そのための口だけを足す（段 5）。

## 標準のプラグインの配り方（決定。v0.2.77 で実装）

アプリの更新のたびに、**そのとき決めた fixplor プラグインのタグを同梱する**（実装済み。固定は `app/core-plugins.lock.json`、取り込みは `app/scripts/fetch-core-plugins.mjs`（ビルド・開発の前に自動で動き、sha256 と `minApiVersion` を検査））。

- fixplor のリポジトリが、タグごとにプラグイン（`manifest.json`・`main.js`・`styles.css`・`icon.svg`）を成果物として公開する。Disnans のリリースは、**どのタグを同梱するか**を 1 か所のファイルに固定して、ビルドの時に取り込む（`explorer-kit` のタグ指定と同じ考え方）。
- 同梱するので、オフラインでも使え、ホストの API の版と常に合う（Disnans のビルドで、プラグインの `minApiVersion` が本体の `API_VERSION` 以下であることを検査する）。
- 欠点: fixplor プラグインだけの修正でも、Disnans のリリースが要る。必要になったら、レジストリから、より新しい版を配る道を後から足せる（同梱版は、サーバーに無いときの初期版になる）。
- 決める前に確かめること: Android の APK の大きさと、プラグインのビルド時間、同梱版と配布版が `id` で衝突したときの優先（[core-plugins.md](core-plugins.md) では、コアが優先）。

## まだ決めていないこと

1. fixplor プラグインだけを新しくしたいとき、アプリのリリースなしで配る道（レジストリから、より新しい版を配る）を足すか。
2. `explorer-kit` を fixplor に統合する時の形（npm workspace）。（内蔵のコードの削除は API 20 で済んだ）

## リスク

- 共有パッケージが増えるほど、タグとロックファイルの更新が増える（リポジトリごとの CI も）。
- Svelte のバージョンの揃え（peer）と、Disnans の内部（`Symbol('events')` に頼る処理）。
- プラグインの Svelte の実行環境が、ホストと別になる問題は、[core-plugins.md](core-plugins.md) の方式に従う。
- 試験は、移すのであって、重複させない。
