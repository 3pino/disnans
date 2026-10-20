# disnans CLI

`disnans` は Linux / Windows 向けの CLI/TUI クライアント。現段階は**読み取り（`me` / `messages`）、メインチャットの `send` / `watch`、`tui`（メインチャットのみ）**で、Windows インストーラと Linux `.deb` に同梱しています（AppImage は PATH への登録を行いません）。共通部品の境界は [`crates/client-core/README.md`](../client-core/README.md)、未対応の項目は [`FEEDBACKS.md`](../../FEEDBACKS.md) を参照してください。

## 現在使えるコマンド

```sh
disnans --help
disnans --version
disnans config set-server 100.x.y.z:8080
disnans config show
disnans config show --json
disnans me
disnans me --json
disnans messages --limit 50
disnans messages --before <メッセージID> --json
disnans send '今から行きます'
printf '%s\n' '複数行の投稿' | disnans send --stdin --json
disnans watch --json
disnans tui
disnans update --check
disnans update
```

- `--server <URL>` は `me` / `messages` で一時的に接続先を上書きし、共通設定ファイルを**読み書きしません**。接続先が未設定のとき、`--server` なしの通信コマンドは明示的に失敗します。`config show` は保存済みの値を表示します。
- `--dev-user <ログイン名>` は **DISNANS_DEV=1 の開発サーバー用**。保存しません。本番サーバーの認証は Tailscale の接続元 IP による whois です。
- `messages` はメインチャットを古い順に返し、既定50件、最大200件。`--before` はそのメッセージ ID より古い履歴を読みます。人間向け表示の日時はローカルのタイムゾーンの `2026-10-13 12:34:56` 形式です（タイムゾーンを取得できないときは UTC とし、末尾に `Z` を付けます）。メンバー一覧の表示名を使います。ユーザー一覧にない投稿者は ID を表示します。JSON には `disnans-shared` の `Message[]` をそのまま出します。
- `--json` は1呼び出しで1つの JSON 値を標準出力に出します。診断は標準エラーに分離します。人間向け出力は本文等の制御文字を安全に表示します。JSON でも制御文字はエスケープしますが、読み直したデータは元の値です。
- Windows/Linux のデスクトップ GUI は同じ接続先・下書きファイルを使用します。CLI の `config set-server` は GUI の次回起動で反映され、起動中はフォーカス復帰時に変更を通知します。入力を保存できない間は再読み込みせず、確認なしに接続先を切り替えません。ブラウザー開発版・Android の保存は従来の localStorage のままです。
- `send [TEXT | --stdin] [--silent] [--reply-to MESSAGE_ID] [--json]`: メインチャットにだけ投稿する。本文を TEXT 引数で渡すと、プロセス一覧やシェル履歴に残ります。**機密や長文・複数行は `--stdin` を使ってください。** `--stdin` を明示したときだけ EOF まで読み（TEXT との併用・ターミナル入力・不正な UTF-8・空本文・10000文字超は 2）、末尾の改行1個だけ除いて内部改行は保持する。成功時は確認済みの `message.id` を標準出力へ（`--json` は `{"client_id","message_id"}`）、標準エラーは空。サーバーが保存前に拒否したと分かる場合は 1。接続・TLS・DNS・接続待ちの失敗は 3。**送信後に結果が分からない場合（確認前の切断・タイムアウト・保存前後を判別できないサーバーエラー・Ctrl-C）は 4**で、`client_id` を表示し（Ctrl-C で中断した場合も同様）、**自動再送しません**。`disnans messages` で確認してから再実行してください。
- `plugin publish <ID> | --dir <PATH> [--private | --public] [--dry-run] [--json]` / `plugin list [--json]` / `plugin remove <ID> [--json]` / `plugin devdir [PATH | --clear] [--json]`: プラグイン・テーマの配布・一覧・削除（`POST/GET/DELETE /api/plugins`）と、開発用フォルダの表示・設定。
  - **開発用フォルダ**は GUI の設定と同一で、このマシンの GUI（Tauri）のデバイス設定 `pluginsDevDir`（`/api/me/devices/{id}/prefs`）だけが出どころです（オプション・環境変数はありません）。`plugin devdir` は今の値を表示（未設定は終了 0 で「未設定」、`--json` は `{"dir":null|"…"}`）、`plugin devdir <PATH>` は絶対パスにして保存（フォルダが無ければ 2）、`--clear` で未設定に戻します。書き込みは GET → `pluginsDevDir` だけ変えて PUT で、ほかのキーは保ちます。GUI のデバイス ID が無いときは書き込みの時だけ作り、GUI と同じようにデバイスを登録（名前は OS 名）します。読み取り（`list`・`publish`・`devdir` 表示）では作りません。
  - **GUI への反映**: GUI は起動中に設定を自動では読み直しません（起動時と設定画面を開いたときにサーバーから読みます）。CLI で変えたら、GUI の設定画面を開き直すか GUI を再起動してください。
  - `publish <ID>` は開発用フォルダ（サブフォルダ 1 つ = 1 プラグイン）の中から、**フォルダ名ではなく manifest.json の `id`** で探して配布します（見つからない・重複・開発用フォルダ未設定は終了 2）。パスで送るなら `--dir <PATH>`。
  - `list` の列は id・version・type・出どころ（`dev` / `public` / `private`）・name で、同じ id が開発中と配布済みの両方にあれば両方の行を出します（`--json` は `source` を持つ配列）。開発用フォルダが未設定なら配布済みだけを出し、stderr に注記します。
  - `publish` は `manifest.json`・`main.js`・`styles.css`・`theme.css`・`icon.svg` のうち存在するものを送り、送る前に manifest の `id` / `version` を結果に含めます（`--dry-run` なら送らず表示だけ）。範囲は `--private` / `--public` で指定し、**省略すると既存の公開状態を保ちます**（まだ無ければ public）。manifest 不備・必須ファイルなし・合計 5 MB 超は接続前に 2、サーバーの拒否（`409 plugin_id_taken` など）は 1、接続失敗は 3、送信後に結果が分からない場合は 4（自動再送しません。`plugin list` で確認）。開発用フォルダの走査は client-core の `dev_plugins` を GUI と共有しています。
- `react <MESSAGE_ID> <EMOJI> [--json]` / `unreact <MESSAGE_ID> <EMOJI>`: 自分のリアクションを付ける・外す。サーバーが同じ状態を `reaction.updated` で知らせたら成功（人間向けは「👍 を追加しました」、`--json` は `{"message_id","emoji","reaction":"added|removed"}`）。サーバーの拒否（メッセージなし・絵文字不正）は 1、接続失敗は 3、確認が取れない場合（切断・タイムアウト・Ctrl-C）は **4 で、自動再送しません**（リアクションは同じ状態にするだけなので、確認してから再実行しても害はありません）。
- `watch [--json]`: メインチャットの `message.created` / `message.updated` / `message.deleted` だけを標準出力へ1イベント1行で出す（`--json` は NDJSON: `{"type":…,"generation":N,…}`）。`stream.connected` / `stream.gap` は接続の区切りで、**切断中のイベントや過去分は復元しません**。`stream.gap` は切断の通知で、**次の `stream.connected`（世代 2 以降）までのイベントは失われうる**ため、`disnans messages` での再取得は **`stream.connected`（世代 2 以降）の後**に行ってください（購読は再取得前に再開済みなので、重複は `id` で取り除けます）。`reason` が `lagged` の `stream.gap` は購読が生きたまま取りこぼした場合で、すぐ再取得できます。人向け表示では区切りを標準エラーへ出します。最初の接続失敗は再試行せず 3（認証拒否などは 1）、一度成功した後は自動で再接続し続けますが、再接続時に認証拒否（HTTP 401/403）になると標準エラーに理由を出して 1 で終了します。Ctrl-C で接続を閉じて 130、標準出力が閉じられたら 0。`watch` は既読にしません。人向け表示の投稿者は ID です。
- 終了コード: `0` 成功、`1` サーバー/保存/応答のエラー、`2` 引数・本文・接続先未設定、`3` 接続/タイムアウト、`4` 送信後の成否不明、`130` 中断（`watch` と送信前のみ）。
- `tui`: メインチャットを読んで送るターミナル画面（P0）。ターミナル（TTY）でのみ起動し、パイプ・リダイレクトでは 2 で終了します。上から状態バー（接続中／接続済み／切断・再接続中／接続失敗）・履歴（古い順、最新に追従。PgUp/PgDn・Alt+↑↓・Ctrl+Home/End で移動し、先頭近くで古い履歴を読み足す）・複数行の入力欄・キー案内です。
  - **送信/改行**はサーバーの Enter キー設定（`/api/me/prefs` の `enterKeys`、GUI と共通。既定は Enter/Shift+Enter が改行、Ctrl+Enter/Alt+Enter が送信）に従います。設定の取得を待たずに起動し、取得できなければ既定を使います。ターミナルが Shift/Ctrl+Enter を区別できない場合に備え、**Ctrl+S（送信）・Ctrl+J（改行）は常に使えます**。入力欄の下の案内は、そのターミナルで実際に使えるキーだけを載せます。
  - **終了**は Ctrl+Q または Ctrl+C（SIGTERM/SIGHUP も同様にターミナルを復元して終了）。入力中の本文は確認なしで下書きとして保存します。Ctrl+R で履歴を再取得します。
  - **下書き**はユーザーごとに GUI と共通のファイルへ約 0.5 秒ごとに保存し、送信確定で消します（GUI と同時に編集した場合は後勝ち）。壊れた下書きは警告のみで、入力と送信は妨げません。
  - **送信結果が不明**（確認前の切断・タイムアウトなど）のときは**自動で再送せず**、入力を残して `client_id` を表示します。再度送信キーを押すと、前回が実は成功していて二重投稿になりうる旨の確認を出し、もう一度押すと新しい `client_id` で送ります。後から同じ `client_id` の投稿が届けば確定扱いにします。サーバーが拒否した場合・未送信の場合も入力は残ります。
  - 切断中は「切断・再接続中」を表示し、再接続（世代 2 以降）後と `lagged` では履歴を再取得して重複を ID で除きます。再接続できない（認証拒否など）場合は理由を表示し、終了のみ可能です。
  - サーバー由来の文字列は制御文字・双方向制御・ゼロ幅文字を `\u{…}` に変えて表示します。マウスは使いません。時刻はローカルのタイムゾーンで表示します（取得できなければ UTC で `Z` 付き）。
  - P0 では既読の更新・返信・添付・リアクション操作はしません（表示のみ）。
- `update [--check]`: GitHub Releases の最新版（GUI のアップデートと同じ `latest.json`）と比べ、新しければ更新します。`--check` は確認だけです。Linux の `.deb`（`/usr/bin/disnans`）は同じリリースの `.deb` を取得して `apt-get install` します（root でなければ `sudo` を経由するのでパスワードを聞かれることがあります）。Windows は `latest.json` のインストーラを取得して起動し、待たずに終わります。AppImage・ソースからのビルドなどは自動更新せず案内だけ出します。**取得物の署名（minisign）は検証しません**（HTTPS と GitHub のリリースを信頼します）。接続・タイムアウトの失敗は 3、それ以外のエラーは 1 または 2 です。
- `tui` の操作: `Esc` でメッセージ選択（↑↓ / `j` `k`）、選択中に `r` で絵文字を入力してリアクションを付け外し（`1`〜`5` は 👍🎉😂😮🙏 の付け外し）、`p` / Enter で返信（入力欄の上に返信先が出て、`Esc` で取消）、`Alt+S` で通知なし送信。本文は Markdown（強調・コード・引用・リスト・リンク・フェンス）をターミナルの装飾で表示します。キーとコマンド ID の対応は `src/tui/commands.rs` にあります。
- 添付付き投稿は未実装です。オプションやサブコマンドとして公開しません。

## 開発と検証

ワークスペースのルートで `cargo test -p disnans-cli`、`cargo clippy -p disnans-cli --all-targets -- -D warnings`。実際の読み取りは、Tailscale 接続または開発モードの**一時データディレクトリ**を使うサーバーで検証してください。リポジトリの本番データと思われる `data/` は使いません。

## テスト・診断用の環境変数

`DISNANS_CLI_ACK_TIMEOUT_MS`（1〜60000 の整数、ミリ秒。既定 15000）は `send` の確認待ちの時間を変える**テスト・診断用**の設定です。範囲外・数値以外は終了コード 2 になります。通常の利用では設定しないでください。
