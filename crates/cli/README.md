# disnans CLI（実装途中）

`disnans` は Linux / Windows 向けの CLI/TUI クライアント。現段階は**読み取りコマンドの土台のみ**で、まだリリース版アプリには同梱していません。全体の方針は [`SPEC_cli_tui.md`](../../SPEC_cli_tui.md) を参照してください。

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
```

- `--server <URL>` は `me` / `messages` で一時的に接続先を上書きし、共通設定ファイルを**読み書きしません**。接続先が未設定のとき、`--server` なしの通信コマンドは明示的に失敗します。`config show` は保存済みの値を表示します。
- `--dev-user <ログイン名>` は **DISNANS_DEV=1 の開発サーバー用**。保存しません。本番サーバーの認証は Tailscale の接続元 IP による whois です。
- `messages` はメインチャットを古い順に返し、既定50件、最大200件。`--before` はそのメッセージ ID より古い履歴を読みます。現在の人間向け表示は日時を Unix ミリ秒で表示し、メンバー一覧の表示名を使います。ユーザー一覧にない投稿者は ID を表示します。JSON には `disnans-shared` の `Message[]` をそのまま出します。
- `--json` は1呼び出しで1つの JSON 値を標準出力に出します。診断は標準エラーに分離します。人間向け出力は本文等の制御文字を安全に表示します。JSON でも制御文字はエスケープしますが、読み直したデータは元の値です。
- 接続先・下書きの共通ファイルは将来 GUI と共用する予定ですが、**現段階の GUI はまだ従来の localStorage を使用**します。CLI の `config set-server` の値は GUI にまだ反映されません。
- 終了コード: `0` 成功、`1` サーバー/保存/応答のエラー、`2` 引数・接続先未設定、`3` 接続/タイムアウト。送信の成否不明に使う `4` は `send` 実装時に追加します。
- `send` / `watch` / `tui` / スレッド操作は未実装です。オプションやサブコマンドとして公開しません。

## 開発と検証

ワークスペースのルートで `cargo test -p disnans-cli`、`cargo clippy -p disnans-cli --all-targets -- -D warnings`。実際の読み取りは、Tailscale 接続または開発モードの**一時データディレクトリ**を使うサーバーで検証してください。リポジトリの本番データと思われる `data/` は使いません。
