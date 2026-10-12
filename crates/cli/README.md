# disnans CLI（実装途中）

`disnans` は Linux / Windows 向けの CLI/TUI クライアント。現段階は**読み取り（`me` / `messages`）とメインチャットの `send` / `watch`**で、まだリリース版アプリには同梱していません。全体の方針は [`SPEC_cli_tui.md`](../../SPEC_cli_tui.md) を参照してください。

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
```

- `--server <URL>` は `me` / `messages` で一時的に接続先を上書きし、共通設定ファイルを**読み書きしません**。接続先が未設定のとき、`--server` なしの通信コマンドは明示的に失敗します。`config show` は保存済みの値を表示します。
- `--dev-user <ログイン名>` は **DISNANS_DEV=1 の開発サーバー用**。保存しません。本番サーバーの認証は Tailscale の接続元 IP による whois です。
- `messages` はメインチャットを古い順に返し、既定50件、最大200件。`--before` はそのメッセージ ID より古い履歴を読みます。現在の人間向け表示は日時を Unix ミリ秒で表示し、メンバー一覧の表示名を使います。ユーザー一覧にない投稿者は ID を表示します。JSON には `disnans-shared` の `Message[]` をそのまま出します。
- `--json` は1呼び出しで1つの JSON 値を標準出力に出します。診断は標準エラーに分離します。人間向け出力は本文等の制御文字を安全に表示します。JSON でも制御文字はエスケープしますが、読み直したデータは元の値です。
- Windows/Linux のデスクトップ GUI は同じ接続先・下書きファイルを使用します。CLI の `config set-server` は GUI の次回起動で反映され、起動中はフォーカス復帰時に変更を通知します。入力を保存できない間は再読み込みせず、確認なしに接続先を切り替えません。ブラウザー開発版・Android の保存は従来の localStorage のままです。
- `send [TEXT | --stdin] [--silent] [--json]`: メインチャットにだけ投稿する。本文を TEXT 引数で渡すと、プロセス一覧やシェル履歴に残ります。**機密や長文・複数行は `--stdin` を使ってください。** `--stdin` を明示したときだけ EOF まで読み（TEXT との併用・端末入力・不正な UTF-8・空本文・10000文字超は 2）、末尾の改行1個だけ除いて内部改行は保持する。成功時は確認済みの `message.id` を標準出力へ（`--json` は `{"client_id","message_id"}`）、標準エラーは空。サーバーが保存前に拒否したと分かる場合は 1。接続・TLS・DNS・接続待ちの失敗は 3。**送信後に結果が分からない場合（確認前の切断・タイムアウト・保存前後を判別できないサーバーエラー・Ctrl-C）は 4**で、`client_id` を表示し（Ctrl-C で中断した場合も同様）、**自動再送しません**。`disnans messages` で確認してから再実行してください。
- `watch [--json]`: メインチャットの `message.created` / `message.updated` / `message.deleted` だけを標準出力へ1イベント1行で出す（`--json` は NDJSON: `{"type":…,"generation":N,…}`）。`stream.connected` / `stream.gap` は接続の区切りで、**切断中のイベントや過去分は復元しません**。`stream.gap` は切断の通知で、**次の `stream.connected`（世代 2 以降）までのイベントは失われうる**ため、`disnans messages` での再取得は **`stream.connected`（世代 2 以降）の後**に行ってください（購読は再取得前に再開済みなので、重複は `id` で取り除けます）。`reason` が `lagged` の `stream.gap` は購読が生きたまま取りこぼした場合で、すぐ再取得できます。人向け表示では区切りを標準エラーへ出します。最初の接続失敗は再試行せず 3（認証拒否などは 1）、一度成功した後は自動で再接続し続けますが、再接続時に認証拒否（HTTP 401/403）になると標準エラーに理由を出して 1 で終了します。Ctrl-C で接続を閉じて 130、標準出力が閉じられたら 0。`watch` は既読にしません。人向け表示の投稿者は ID です。
- 終了コード: `0` 成功、`1` サーバー/保存/応答のエラー、`2` 引数・本文・接続先未設定、`3` 接続/タイムアウト、`4` 送信後の成否不明、`130` 中断（`watch` と送信前のみ）。
- `tui` / スレッド操作 / 返信・添付付き投稿は未実装です。オプションやサブコマンドとして公開しません。

## 開発と検証

ワークスペースのルートで `cargo test -p disnans-cli`、`cargo clippy -p disnans-cli --all-targets -- -D warnings`。実際の読み取りは、Tailscale 接続または開発モードの**一時データディレクトリ**を使うサーバーで検証してください。リポジトリの本番データと思われる `data/` は使いません。

## テスト・診断用の環境変数

`DISNANS_CLI_ACK_TIMEOUT_MS`（1〜60000 の整数、ミリ秒。既定 15000）は `send` の確認待ちの時間を変える**テスト・診断用**の設定です。範囲外・数値以外は終了コード 2 になります。通常の利用では設定しないでください。
