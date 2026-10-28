# 開発の手引き

disnans の開発・リリースの手順です。利用・運用の説明は [README.md](README.md) にあります。

## 開発環境

```sh
DISNANS_DEV=1 cargo run -p disnans-server   # サーバー（開発モード）
cd app && npm install && npm run tauri:dev # クライアント（Tauri のウィンドウ。vite dev は自動で起動する）
```

製品として動くのは Tauri 版（Windows・Linux・Android）だけです。`vite dev` を通常のブラウザーで開いて使う経路は、製品としては対応しません（`npm run dev` は Tauri の接続先と、テストの Chromium から読むためのものです）。Linux で `tauri dev` を動かすには WebKitGTK・GStreamer などの開発用パッケージが要ります（一覧は `.github/workflows/ci.yml` の apt の行）。

デスクトップ版では、配布版でも `Ctrl+Shift+I` で開発者ツールを開けます。

## CLI

Rust の共通クライアント基盤と、読み取り用 CLI を追加しています。旧設定・下書きは読戻し確認後に移行し、移行や保存の失敗は通知します。GUI の通信と Android の保存先は従来のままです。Windows の `.exe` と Linux の `.deb` には CLI を同梱しています（インストールの説明は上の「アプリを入れる」を参照）。

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

## テスト

| 対象 | コマンド |
|---|---|
| クライアント(型・Svelte) | `cd app && npm run check` |
| クライアントの単体テスト | `cd app && npx vitest run` |
| Rust | `cargo test --workspace` |
| Chromium での DOM 測定・タッチ操作(手動) | `app/scripts/touch-check.mjs`。`npm run dev` で vite を起動し(既定は 5173)、`CHROME_BIN=<Chromium か headless_shell のパス> DISNANS_URL=http://127.0.0.1:5173 node scripts/touch-check.mjs`(`app` の中で実行)。Tauri の IPC(`window.__TAURI_INTERNALS__` と `__DISNANS_PLATFORM__`)を `scripts/touch-fixture.mjs` が CDP で読み込み前に差し込み、共有フォルダの一覧は仮のサーバーから返す。サーバー・Tauri は要らない。ソースを編集中の `npm run dev` は再読み込みされて不安定になるので、固定して測るときは `npx vite build --outDir /tmp/tc-dist` のあと `npx vite preview --outDir /tmp/tc-dist --port 5198` を `DISNANS_URL` に使う。最後に、fixture に無い IPC を本体が呼んでいないことも確かめる。メニューや「…」の位置・タップ・長押しを矩形とイベントで確かめる(見た目は目で確かめる)。fixture に無い IPC を本体が呼ぶようになったら、`touch-fixture.mjs` の `handlers` に足す(`TOUCH_DEBUG=1` で未対応のコマンドを表示) |
| 文書のリンク・アンカー | `node scripts/check-docs.mjs` |

## ドキュメント

文書の一覧は [docs/README.md](docs/README.md)(目次はここだけ)。未対応の項目・既知の問題・進行中の作業は [FEEDBACKS.md](FEEDBACKS.md)。API の型は [crates/shared](crates/shared)(`cargo test -p disnans-shared` で TypeScript の型を `app/src/lib/protocol/` に生成)。

書き方の決まり:

- 設計・提案の文書は、冒頭に 1 行で状態を書く: `状態: 確定(実装済み)` / `状態: 設計案(未実装)` / `状態: 保留`。確定と案を同じ文書に混ぜない(案は `docs/proposals/`)
- 「まだ…」「未実装」の一覧は FEEDBACKS.md にだけ置く。版や日付付きの履歴は書かない(git が持つ)
- 「端末」は使わない。クライアントの機械は「デバイス」、コマンドを打つ画面は「ターミナル」
- 「ふつう」「かんたん」「ちょっと」など曖昧な言い方は避け、具体的に書く
- 句読点と括弧は全角(、。（）)で統一する
- 1 ファイルは 300 行までを目安にする。超えたら分ける
- 文書を足したら `docs/README.md` の目次に載せ、`node scripts/check-docs.mjs` を通す

## リリース

1. ルートの `Cargo.toml`（workspace の `version`）と `app/src-tauri/tauri.conf.json` の `version` を同じ値に上げ、`cargo update -w --offline` と `cargo update -w --manifest-path app/src-tauri/Cargo.toml --offline` でロックを更新してコミットする
2. `wip` ブランチへ push し、CI が成功して `master` に反映されたことを確かめる
3. `git tag v<version> && git push origin v<version>`

GitHub Actions が Android / Windows / Linux 版とサーバーをビルドし、Releases に公開します。Windows と Linux の成果物は、公開の前に同梱の CLI（PATH への追加と削除、`.deb` の `/usr/bin/disnans`）を確かめてから公開されます。GUI と CLI/TUI は同じ版で配布します。署名の鍵は GitHub の Secrets と管理者の `~/.config/disnans-keys/` にあります（**鍵はなくさないこと**。Android の鍵をなくすと、全員がアンインストールして入れ直す必要があります）。
