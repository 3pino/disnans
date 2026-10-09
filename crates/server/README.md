# disnans-server

disnans のサーバー（axum + SQLite）。API は [`docs/API.md`](../../docs/API.md) を参照。

## 環境変数

| 変数 | 既定値 | 内容 |
|---|---|---|
| `DISNANS_BIND` | `127.0.0.1:8080` | 待ち受けるアドレス。本番では Tailscale の IP（`100.x.y.z:8080`）にする |
| `DISNANS_DATA_DIR` | `./data` | DB（`disnans.db`）、アップロードされたファイル（`files/`）、配布されたプラグイン（`plugins/`）の置き場所 |
| `DISNANS_DEV` | なし | `1` で開発モード（whois を使わない。下記） |
| `DISNANS_TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock`（なければ snap 版の `/var/snap/tailscale/common/socket/tailscaled.sock`） | tailscaled の LocalAPI のソケット |
| `RUST_LOG` | `info,disnans_server=debug` | ログの出し方（`tracing-subscriber` の書式） |

## 開発

```sh
DISNANS_DEV=1 cargo run -p disnans-server
```

開発モードでは Tailscale を使わず、リクエストごとにユーザーを指定する。

- ヘッダー `X-Dev-User: alice@example`
- クエリ `?dev_user=alice@example`（ブラウザの WebSocket はヘッダーを付けられないため）
- どちらもなければ `dev@local`

初めて見るユーザーは自動で作られる。

```sh
curl -H 'X-Dev-User: alice@example' http://127.0.0.1:8080/api/me
```

CORS はすべてのオリジンを許可している（開発中のフロントエンドや Tauri の WebView はサーバーと別のオリジンになるため）。

テスト:

```sh
cargo test -p disnans-server
```

## 本番（Tailscale）

1. サーバー端末で Tailscale を動かし、参加者にノード共有する（これが招待になる）
2. Tailscale の IP で待ち受けて起動する

   ```sh
   cargo build --release -p disnans-server
   DISNANS_BIND=100.x.y.z:8080 DISNANS_DATA_DIR=/var/lib/disnans ./target/release/disnans-server
   ```

3. サーバーは接続元のアドレスを tailscaled の LocalAPI（`/localapi/v0/whois`）に問い合わせ、
   Tailscale のユーザー（`LoginName`）でアカウントを特定する。初めてのユーザーは自動で作られる
   （表示名の初期値は Tailscale の表示名）

注意:

- LocalAPI のソケットに接続できるユーザーで動かすこと（whois は読み取りだけの操作なので、
  通常は一般ユーザーでも使える。`401` / `500` になるときはソケットのパスと権限を確認する）
- `DISNANS_DEV=1` は絶対に付けないこと（誰でも任意のユーザーになれてしまう）
- Tailscale の IP 以外（`0.0.0.0` など）で待ち受けないこと。whois で特定できない接続は `401` になるが、
  インターネットに公開する想定はない
- バックアップは `DISNANS_DATA_DIR` を丸ごと取ればよい（SQLite は WAL モード。止めてから取るのが確実）

## 構成

| ファイル | 内容 |
|---|---|
| `src/main.rs` | 起動（ログ、待ち受け、終了処理） |
| `src/lib.rs` | アプリの組み立て（テストからも使う） |
| `src/config.rs` | 環境変数 |
| `src/auth.rs` / `src/tailscale.rs` | 認証ミドルウェア、LocalAPI の whois |
| `src/routes/` | REST のハンドラー |
| `src/ws.rs` / `src/hub.rs` | WebSocket と、接続への配信 |
| `src/chat.rs` | メッセージ・スレッド・リアクションの操作 |
| `src/notify.rs` | 通知（`Notifier` で送り方を抽象化。今は WebSocket だけ） |
| `src/files.rs` / `src/image_proc.rs` | ファイルの保存、画像の WebP 変換、未投稿ファイルの掃除 |
| `src/plugins.rs` | プラグインの配布・更新・削除（manifest の検証、ファイルの入れ替え、アナウンス） |
| `src/sessions.rs` | プラグインのセッションとカード、一時的なイベントの中継、プラグインからの通知 |
| `src/store/` | DB の読み書き |
| `migrations/` | SQLite のスキーマ（起動時に自動で適用） |
