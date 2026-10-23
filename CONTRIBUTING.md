# 開発の手引き

disnans の開発・リリースの手順です。利用・運用の説明は [README.md](README.md) にあります。

## 開発環境

```sh
DISNANS_DEV=1 cargo run -p disnans-server   # サーバー（開発モード）
cd app && npm install && npm run dev        # クライアント
```

ブラウザで `http://localhost:5173/?dev_user=alice` と `?dev_user=bob` を別々のタブで開くと、2人での会話を試せます。

デスクトップ版では、配布版でも `Ctrl+Shift+I` で開発者ツールを開けます。

## CLI

Rust の共通クライアント基盤と、読み取り用 CLI を追加しています。旧設定・下書きは読戻し確認後に移行し、移行や保存の失敗は通知します。GUI の通信、Android・ブラウザー開発版の保存先は従来のままです。Windows の `.exe` と Linux の `.deb` には CLI を同梱しています（インストールの説明は上の「アプリを入れる」を参照）。

別ターミナルで開発サーバーを起動したうえで、次を実行します。

```sh
cargo run -p disnans-cli -- --server http://127.0.0.1:8080 --dev-user alice me --json
cargo run -p disnans-cli -- --server http://127.0.0.1:8080 --dev-user alice messages --json
```

`app/src-tauri` の `cargo test` / `clippy` を直接動かすには、先に CLI の配置物（`app/src-tauri/binaries/`、Git に入らない）が要ります。ビルドスクリプトがその存在を確かめるためです。

```sh
node scripts/prepare-cli.mjs --stub   # 空のプレースホルダ（テストと clippy 用。インストーラには使えない）
node scripts/prepare-cli.mjs          # 本物の CLI を release で作って置く
```

`npm run tauri dev` と `tauri build` は、本物の CLI を自動で置きます。

`--dev-user` は開発サーバー専用です。本番では省略し、GUI と同じ Tailscale のサーバーへ接続します。接続先は `config set-server <URL>` で保存でき、`--server` は一時指定です。GUI で接続先の外部変更を検出しても、確認なしに別サーバーへ接続しません。JSON 出力には個人データが含まれるため、共有時は内容を確認してください。

詳しくは [CLI の説明](crates/cli/README.md)、[共通基盤の境界](crates/client-core/README.md) を参照してください。未対応の項目・既知の問題・進行中の作業は [FEEDBACKS.md](FEEDBACKS.md) にまとめています。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [FEEDBACKS.md](FEEDBACKS.md) | 未対応の項目・既知の問題・進行中の作業 |
| [docs/API.md](docs/API.md) | REST / WebSocket の仕様 |
| [crates/shared](crates/shared) | API の型（`cargo test -p disnans-shared` で TypeScript の型を `app/src/lib/protocol/` に生成） |

## リリース

1. ルートの `Cargo.toml`（workspace の `version`）と `app/src-tauri/tauri.conf.json` の `version` を同じ値に上げ、`cargo update -w --offline` と `cargo update -w --manifest-path app/src-tauri/Cargo.toml --offline` でロックを更新してコミットする
2. `wip` ブランチへ push し、CI が成功して `master` に反映されたことを確かめる
3. `git tag v<version> && git push origin v<version>`

GitHub Actions が Android / Windows / Linux 版とサーバーをビルドし、Releases に公開します。Windows と Linux の成果物は、公開の前に同梱の CLI（PATH への追加と削除、`.deb` の `/usr/bin/disnans`）を確かめてから公開されます。GUI と CLI/TUI は同じ版で配布します。署名の鍵は GitHub の Secrets と管理者の `~/.config/disnans-keys/` にあります（**鍵はなくさないこと**。Android の鍵をなくすと、全員がアンインストールして入れ直す必要があります）。
