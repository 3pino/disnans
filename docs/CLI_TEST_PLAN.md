# CLI / GUI 結合テスト計画（ステップ1）

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
- GUI が使っていた localStorage の接続先/下書きを一時共通ファイルへ移行し、保存検証に成功してから切替える。失敗時は旧値を保持する。
- GUI と CLI/TUI が同一下書きを別々に更新した場合、後から保存した内容が優先される。逐次保存と同時書込みでファイルが壊れない。
- Linux と Windows で共有ファイルの配置・権限、CLI の設定読込、インストール後の起動を確認する。実機 UI/TUI の見た目と操作感は利用者に最終確認を依頼する。

## CI・配布検証（別段階）

- Linux は既存の `cargo test --workspace` が新しい core/CLI と結合テストも実行するため、追加のテストステップは不要。Windows は新しい `client-windows` ジョブで core/CLI の clippy と `cargo test -p disnans-client-core -p disnans-cli --locked` を実行し、パス・終了コード・子プロセス終了も検証する。
- Windows CI はクロスプラットフォームのプロセス/設定境界を確認する。インストーラからの PATH 起動・復旧、NSIS upgrade/uninstall は実機またはパッケージ検証として別途行う。
- Windows NSIS / Linux `.deb` への CLI 同梱、PATH 追加・復旧、アップグレード、アンインストール検証はステップ5で行う。AppImage は PATH 自動登録を前提にしない。
