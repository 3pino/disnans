# disnans-server

disnans のサーバー（axum + SQLite）。API は [`docs/API.md`](../../docs/API.md) を参照。

## 環境変数

| 変数 | 既定値 | 内容 |
|---|---|---|
| `DISNANS_BIND` | `127.0.0.1:8080` | 待ち受けるアドレス。本番では Tailscale の IP（`100.x.y.z:8080`）にする |
| `DISNANS_DATA_DIR` | `./data` | DB（`disnans.db`）、アップロードされたファイル（`files/`）、配布されたプラグイン（`plugins/`）の置き場所 |
| `DISNANS_DEV` | なし | `1` で開発モード（whois を使わない。下記） |
| `DISNANS_IMAGE_MAX_EDGE` | `800` | 保存する静止画の長辺の最大ピクセル数（これより大きい画像は縮小する） |
| `DISNANS_TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock`（なければ snap 版の `/var/snap/tailscale/common/socket/tailscaled.sock`） | tailscaled の LocalAPI のソケット |
| `DISNANS_LOCAL_BIND` | なし | ループバックの待ち受け（例 `127.0.0.1:8080`）。Tailscale Serve 経由の接続用。ループバック以外は起動時に拒否 |
| `DISNANS_AUTO_UPDATE` | なし | `1` で自動更新を有効にする（下記。Linux x86_64 だけ） |
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

1. サーバー機で Tailscale を動かし、参加者にノード共有する（これが招待になる）
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

## 共有フォルダ（WebDAV）

`/dav/` で、共有フォルダを WebDAV として見せる（エクスプローラーやファイルマネージャーからネットワークドライブとしてつなぐ）。設計は [`docs/PLAN_FILES.md`](../../docs/PLAN_FILES.md)。

- 第 1 段は読み取り専用。直下に `attachments/` があり、投稿された添付がそのまま並ぶ（同名は `名前 (ID).拡張子`）。
- 許可するメソッド: OPTIONS, PROPFIND, GET, HEAD, LOCK, UNLOCK。PUT・DELETE・MKCOL・MOVE・COPY・PROPPATCH は 405。
- 認証は `/api` と同じ（whois。Tailscale Serve 経由なら Serve のヘッダーを、接続元がループバックのときだけ信じる）。
- Serve の例: `tailscale serve --https=443 --set-path /dav http://127.0.0.1:8080/dav`（`DISNANS_LOCAL_BIND=127.0.0.1:8080` が要る）。
- CORS は `/api` だけに付ける（`/dav` の OPTIONS は WebDAV の `DAV:` と `Allow` を返す必要があるため）。

## 自動更新

`DISNANS_AUTO_UPDATE=1` のときだけ動く（既定は無効。開発やテストでは動かない）。Linux x86_64 だけ対応。

- 起動の 1 分後と、その後 10 分ごとに、GitHub の最新リリース（`https://api.github.com/repos/3pino/disnans/releases/latest`。トークン不要、User-Agent を送る。未認証の上限 60 回/時に対して 6 回/時）を見る。取得先は本番では固定で、環境変数では変えられない。
- 自分の版（`CARGO_PKG_VERSION`）より新しい版で、プレリリースでないときだけ進む。下げない。
- 資産 `disnans-server_linux-x64` と `disnans-server_linux-x64.sha256` を取る。sha256 が合わなければ入れない。
- 実行ファイルと同じディレクトリの一時ファイルに書き、実行権限を付け、`--version` が `disnans-server <版>` と答えるか確かめる。答えなければ入れない。
- 今のバイナリを `disnans-server.prev` に残してから、`rename` で原子的に置き換える。
- 置き換えたら、WebSocket の接続を閉じ、HTTP の接続を穏やかに止め、**終了コード 75** で終わる。
- **前提**: systemd のユニットが `Restart=on-failure`（既定の `scripts/deploy.sh` の書き方）であること。非 0 の終了で systemd が起動し直す。`SuccessExitStatus=75` や `RestartPreventExitStatus=75` を入れないこと。`Restart=always` でも動く。
- **通話は再起動で一瞬切れる**。通話中でも入れ替える（ユーザーの決定）。再起動は数秒程度。
- 失敗（通信・sha256 の不一致・`--version` の不一致など）はログに警告を出すだけで、次の周期に再試行する。同じ版で 3 回失敗したら、その版は再起動まで諦める。
- ログ（`disnans_server::update` ほか）: 有効化、入れ替えた版、失敗の理由。

確認の手順（本番の前に）: 次の版を入れ替えたあと、`disnans-server.prev` が残っていること、`journalctl --user -u disnans` で「再起動のため終了コード 75」と起動し直しが見えることを確かめる。元に戻すときは `.prev` を元の名前に戻す。

## 構成

| ファイル | 内容 |
|---|---|
| `src/main.rs` | 起動（ログ、待ち受け、終了処理） |
| `src/lib.rs` | アプリの組み立て（テストからも使う） |
| `src/config.rs` | 環境変数 |
| `src/auth.rs` / `src/tailscale.rs` | 認証ミドルウェア、LocalAPI の whois |
| `src/routes/` | REST のハンドラー |
| `src/ws.rs` / `src/hub.rs` | WebSocket と、接続への配信 |
| `src/chat.rs` | メッセージ・リアクションの操作 |
| `src/notify.rs` | 通知（`Notifier` で送り方を抽象化。今は WebSocket だけ） |
| `src/files.rs` / `src/image_proc.rs` | ファイルの保存、画像の WebP 変換、未投稿ファイルの掃除 |
| `src/plugins.rs` | プラグインの配布・更新・削除（manifest の検証、ファイルの入れ替え、アナウンス） |
| `src/sessions.rs` | プラグインのセッションとカード、一時的なイベントの中継、プラグインからの通知 |
| `src/store/` | DB の読み書き |
| `migrations/` | SQLite のスキーマ（起動時に自動で適用） |
