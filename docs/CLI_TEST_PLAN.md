# CLI / GUI 結合テスト計画（ステップ1・2）

## 目的と範囲

開発モードの一時サーバーに対して、CLI のプロセス境界（引数、標準出力/標準エラー、JSON、終了コード）と GUI/CLI が共有する接続先設定を検証する。実装中の CLI コマンド・設定ファイルの公開仕様に合わせてテストを確定する。ここでは WebSocket の送受信、`watch`、送信結果が不明な場合の再接続、TUI、GUI の自動操作、配布物への同梱は先行実装しない。

## 隔離ルール

- テストごとに `tempfile::TempDir` を作り、サーバーの DB/ファイル、CLI の設定ファイル、必要なら GUI の設定をその配下に置く。
- サーバーは `disnans_server::build(Config { dev: true, data_dir: tempdir, ... })` で構築し、`127.0.0.1:0` の listener から実際の割り当てポートを得る。`into_make_service_with_connect_info::<SocketAddr>()` で serve する。
- `DISNANS_DEV` などのプロセス全体の環境変数をテストから変更しない。開発モードはテストサーバーの `Config` にだけ設定する。
- CLI は `CARGO_BIN_EXE_disnans` を `std::process::Command` から起動する。CLI へは一時サーバー URL、dev user、分離した config/data home だけを渡す。ホストの `data/`、標準ユーザー設定、ネットワーク上の本番サーバーを参照しない。
- 各テスト終了時にサーバータスクを abort/await し、TempDir を破棄する。失敗時もクリーンアップする。

## ステップ1で追加する検証

1. `me`: 一時サーバーに対して指定した dev user の情報を取得し、成功終了・JSONとして解釈可能な出力を確認する。
2. `messages`: 空履歴と投入済み履歴を JSON で取得し、`--limit` と `--before` のページングが機能することを確認する。
3. `config set-server` と `config show`: 別々の CLI プロセスで接続先を保存・再読込できることを確認する。設定ファイルの内部形式は公開仕様が定まるまで固定しない。
4. `--server`: 明示した接続先で `me` を取得し、破損した/開けない共有ストレージに触れないことを確認する。
5. エラー境界: 不正な接続先で非 0 終了し、診断が stderr に出て stdout を汚さないことを確認する。

すべての CLI 起動は別プロセスとして行い、引数・環境・標準出力・標準エラー・終了コードを検査する。ユーザー本文や一時ディレクトリの絶対パスなど不安定な情報に依存した期待値は避ける。

## 後続ステップの検証項目

- CLI の投稿が GUI の WebSocket 更新に反映し、GUI の投稿も CLI が履歴取得で確認できる。
- 接続断の再接続後に履歴を再取得する。送信後に応答が失われたケースは「成否不明」とし、自動再送・二重投稿がない。

### ステップ2: GUI デスクトップ共有ストレージ移行

- Tauri 起動時、共有ファイルから接続先を読み、移行/読戻しが完了してからメモリ上の接続先を更新し、WebSocket を開始する。読込が保留中の間は接続を開始しない。
- localStorage の接続先/下書きは共有ファイルに import-if-missing し、読戻しで確認できた場合だけ旧下書きを消す。既存値または clear tombstone を優先し、失敗時は localStorage の値を保持する。下書き読込が失敗し復元可能な旧値もない場合は、空の下書きと誤認せずエラー表示にする。
- 共有キーは `server` と `draft(serverUrl, userId, place)`。異なるサーバー/ユーザー/場所の下書きが混ざらないことを確認する。
- 下書きの非同期読込に generation/current-key 検査を適用し、古い読込が編集中の入力やサーバー切替後の下書きを上書きしないことを確認する。保存・送信・clear は操作開始時に捕捉したキーを使い、未完了の初期読込で空下書きを保存しない。
- ブラウザー/Android は Tauri invoke を使わず既存 localStorage に留める。prefs の REST 保存、call/notifier の WebSocket/プラグイン通信は移行対象にしない。
- Vitest は fresh module と mock invoke/storage port を使い、desktop initializer の非同期読込・設定適用、IPC 状態、draft adapter の組合せを検証する。これらは storage/config の境界テストであり、`App.svelte` を mount して実際の `client.start()`/通信開始を検査するものではない。
- `Composer` の DOM mount、入力操作、遅延 draft read が画面へ反映される挙動はこの統合テストでは直接検査しない。AST/source-text 契約テストや見た目の検査も行わない。

- GUI と CLI/TUI が同一下書きを別々に更新した場合、後から保存した内容が優先される。逐次保存と同時書込みでファイルが壊れない。
- Linux と Windows で共有ファイルの配置・権限、CLI の設定読込、インストール後の起動を確認する。実機 UI/TUI の見た目と操作感は利用者に最終確認を依頼する。

### ステップ3: CLI send / watch

試験は `crates/cli/tests/send_watch.rs`。実サーバー（開発モード・一時データ）と、障害を注入する fake WebSocket サーバーを使う。すべての子プロセスは一時ディレクトリに隔離し、10 秒で強制終了する。

- 実サーバー: `send` の成功は確認済みの message.id を標準出力に 1 行で書き、`messages --json` で本文が見える。`--json` は `message_id` と `client_id` を持つ。`--stdin` は複数行を保ち、末尾の改行を 1 個だけ除く。`--silent` も受理される。
- 入力エラー: 空本文、10001 文字、TEXT と `--stdin` の併用、本文がない（stdin が空/null）は終了コード 2 で、何も送らない。10000 文字ちょうどは送れる。
- 接続拒否（送信前・`watch` の初回）は 3。`watch` の初回接続で HTTP 401 は 1。
- `watch --json` は `stream.connected`（generation 1）のあと、別プロセスの送信を `message.created` として 1 件だけ出す（履歴は再送しない）。Unix では SIGINT で 130 で終わる。標準出力の読み手がいなくなったら 0 で終わる。
- fake サーバーで、送信後の切断・ack 無し（隠し環境変数 `DISNANS_CLI_ACK_TIMEOUT_MS` で短縮）・`internal` など不明なエラーは 4。確実な拒否コード（`empty_message`、`body_too_long` など 7 種）は 1。別の client_id または client_id なしのエラーは、この送信の確定判断に使われず ack 待ちのタイムアウトで 4。どの場合も `message.send` が fake に 1 件だけ届き、再接続しない（自動再送なし）。
- fake サーバーで、切断後の再接続は `stream.gap`（理由付き）を挟んで generation 2 の `stream.connected` を出す。
- fake サーバーで、再接続が 401 で拒否されると `watch` は stderr に診断を出して 1 で終わる。出力を待ち続けず、有界の時間で終了する。
- 送信の ack 待ちの時間は `DISNANS_CLI_ACK_TIMEOUT_MS` で短くして試験する。不正な値は CLI が終了コード 2 で拒む。
- 保証外: TTY の標準入力（pty が必要なため自動試験にしない。stdin が null/閉じられた場合は試験する）、Windows の Ctrl-C（SIGINT 試験は Unix のみ）、wss、実機のネットワーク断、idle timeout（90 秒のため対象外）、GUI の WebSocket 表示との連携、見た目・端末表示の確認。

## CI・配布検証（別段階）

- Linux は既存の `cargo test --workspace` が新しい core/CLI と結合テストも実行するため、追加のテストステップは不要。Windows は新しい `client-windows` ジョブで core/CLI の clippy と `cargo test -p disnans-client-core -p disnans-cli --locked` を実行し、パス・終了コード・子プロセス終了も検証する。
- `app-linux` と新しい `app-windows` は Tauri の native Rust テストを実行し、DTO と隔離サブプロセス内の storage command を検証する。実 GUI の描画・入力操作・Tailscale 認証・インストーラ動作はこのテストでは保証しない。
- Windows CI はクロスプラットフォームのプロセス/設定境界を確認する。インストーラからの PATH 起動・復旧、NSIS upgrade/uninstall は実機またはパッケージ検証として別途行う。
- Windows NSIS / Linux `.deb` への CLI 同梱、PATH 追加・復旧、アップグレード、アンインストール検証はステップ5で行う。AppImage は PATH 自動登録を前提にしない。
