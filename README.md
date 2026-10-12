# disnans

小さな SNS。チャットとスレッド、写真やファイルの共有ができます。

- Tailscale の中だけで動きます。インターネットには公開しません。ログインも Tailscale のアカウントで自動的に行われます。
- **サーバーは自宅の PC で動かします。** データは手元に置かれます
- 対応: Android / Windows / Linux

## インストール（参加する人）

### 1. Tailscale に参加する

1. [Tailscale](https://tailscale.com/download) をインストールし、自分のアカウントでログインする
2. サーバーの管理者から届く「ノード共有」の招待を受け入れる

これで準備は完了です。disnans 用のアカウントは、初めて接続したときに自動で作られます。

### 2. アプリを入れる

[最新のリリース](https://github.com/3pino/disnans/releases/latest)から、端末に合ったファイルをダウンロードします。

| 端末 | ファイル | 入れ方 |
|---|---|---|
| Android | `disnans_*_android-arm64.apk` | ダウンロードした APK を開く。「この提供元のアプリを許可」の確認が出たら許可する |
| Windows | `disnans_*_x64-setup.exe` | 実行してインストールする。「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」 |
| Linux（Ubuntu / Debian） | `disnans_*_amd64.deb` | `sudo apt install ./disnans_*_amd64.deb` |
| Linux（その他） | `disnans_*_amd64.AppImage` | `chmod +x` で実行権限を付けて起動する |

### 3. サーバーに接続する

アプリを起動し、管理者から教わったサーバーのアドレス（例: `100.x.x.x:8080`）を入力します。`http://` は省略できます。

### 通知

- 「設定」→「サンプル通知を送信」で、通知が届くか確かめられます。
- **Android**: 初回の起動時に通知の許可を求められます。アプリを閉じていても通知が届くよう、裏でサーバーとつなぎ続けます（「通知を受け取っています」という通知が常に表示されますが、オフにして構いません）。
- **Linux のトレイ**: システムトレイのアイコンに `libayatana-appindicator3-1` が要ります（`.deb` は依存として入れます。AppImage などでは `sudo apt install libayatana-appindicator3-1`。GNOME ではトレイを出す拡張機能「AppIndicator and KStatusNotifierItem Support」も要ります）。

### 通話

「みんなで1つの通話に、いつでも出入りできる」アプリ本体の機能です。画面の上部に通話のバーが出て（どのタブでも）、「＋」メニューの「通話に参加」や `/vc-join` で参加します。参加者を長押し（PC は右クリック）すると、その人を通話から外せます。設定は「設定」→「通話」にあります。

- **Linux**: `gstreamer1.0-plugins-good`、`gstreamer1.0-plugins-bad`、`gstreamer1.0-pulseaudio`（PipeWire の環境なら `gstreamer1.0-pipewire` も）が要ります（`.deb` は推奨パッケージとして入れます）。

### Linux の診断ログ

通話のフリーズなどを調べるときは、先にトレイの「終了」でアプリを完全に終了し、リポジトリで次を実行します。

```sh
scripts/log-linux.sh                             # deb で入れた disnans-app
scripts/log-linux.sh /path/to/disnans.AppImage    # AppImage の場合
```

GTK・GStreamer・Rust のログを `${XDG_STATE_HOME:-$HOME/.local/state}/disnans/logs/` に保存して起動します（保存先は起動時に表示）。ターミナルを閉じても記録は続き、ファイルはその利用者だけが読める権限で作ります。JavaScript の Console はこのログに保存されません。普段の起動設定は変わりません。

`DISNANS_LOG_DIR` で保存先、`GST_DEBUG` で詳細度（既定は `3`）を指定できます。ログは自動で削除しないので、不要なものは手動で整理してください。共有前に端末名・パスなどの個人情報を確認してください。

### アップデート

アプリの「設定」→「アップデートを確認」から更新できます。

## サーバーを動かす（管理者）

必要なもの: Rust（stable）、Tailscale

```sh
cargo build --release -p disnans-server
DISNANS_BIND=<Tailscale の IP>:8080 DISNANS_DATA_DIR=/var/lib/disnans ./target/release/disnans-server
```

- Tailscale の IP は `tailscale ip -4` で確認できます
- 友達を招待するには、Tailscale の管理画面でサーバー端末を[ノード共有](https://tailscale.com/kb/1084/sharing)します。友達は自分の無料アカウントのままで接続できます
- 環境変数や注意点は [crates/server/README.md](crates/server/README.md) を参照してください

  1. 管理画面（login.tailscale.com）の Machines で、server の「…」メニューから Share… を選びます。
  2. 招待リンクを作るか、友だちのメールアドレスに送ります。
  3. 友だちは自分の Tailscale アカウントで招待を受けます。その人がそのアカウントでログインしている端末なら、どれからでも サーバーPC が見えるようになります。
  4. 友だちはアプリで、 サーバーPC を入力します。サーバーは Tailscale のアカウントで相手を見分けるので、共有で入った人も今までどおりログインできます。
  5. Access Controls の設定を書き換えます。
    ```jsonc
    {
      "hosts": {
        "server": "100.x.x.x"
      },
      "acls": [
        // 自分（tailnet のメンバー）はこれまでどおり全部
        { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] },

        // 共有で入った人は、disnans の 8080 だけ
        { "action": "accept", "src": ["autogroup:shared"], "dst": ["server:8080"] }
      ]
    }
    ```

### 常駐させる（systemd）

`~/.config/systemd/user/disnans.service`:

```ini
[Unit]
Description=disnans server
After=network-online.target

[Service]
ExecStart=%h/repos/disnans/target/release/disnans-server
Environment=DISNANS_BIND=100.x.y.z:8080
Environment=DISNANS_DATA_DIR=%h/.local/share/disnans
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now disnans
loginctl enable-linger $USER   # ログアウトしても動かし続ける
```

起動時に Tailscale の IP がまだ割り当てられていないと失敗しますが、`Restart=on-failure` で再試行されます。

## 開発

```sh
DISNANS_DEV=1 cargo run -p disnans-server   # サーバー（開発モード）
cd app && npm install && npm run dev        # クライアント
```

ブラウザで `http://localhost:5173/?dev_user=alice` と `?dev_user=bob` を別々のタブで開くと、2人での会話を試せます。

デスクトップ版では、配布版でも `Ctrl+Shift+I` で開発者ツールを開けます。

### CLI（開発中）

Rust の共通クライアント基盤と、読み取り用 CLI を追加しています。現時点では設定・自分の情報・メインチャットの履歴を扱い、投稿・新着の監視・TUI はまだ使えません。Windows/Linux のデスクトップ GUI は CLI と接続先・下書きファイルを共有します。旧設定・下書きは読戻し確認後に移行し、移行や保存の失敗は通知します。GUI の通信、Android・ブラウザー開発版の保存先は従来のままです。配布インストーラへの同梱と実機確認は後続の段階です。

別ターミナルで開発サーバーを起動したうえで、次を実行します。

```sh
cargo run -p disnans-cli -- --server http://127.0.0.1:8080 --dev-user alice me --json
cargo run -p disnans-cli -- --server http://127.0.0.1:8080 --dev-user alice messages --json
```

`--dev-user` は開発サーバー専用です。本番では省略し、GUI と同じ Tailscale のサーバーへ接続します。接続先は `config set-server <URL>` で保存でき、`--server` は一時指定です。GUI で接続先の外部変更を検出しても、確認なしに別サーバーへ接続しません。JSON 出力には個人データが含まれるため、共有時は内容を確認してください。

詳しくは [CLI の説明](crates/cli/README.md)、[CLI/TUI 要件](SPEC_cli_tui.md)、[共通基盤と移行の境界](docs/CLIENT_ARCHITECTURE.md) を参照してください。

| ドキュメント | 内容 |
|---|---|
| [SPEC.md](SPEC.md) | 要件定義 |
| [docs/API.md](docs/API.md) | REST / WebSocket の仕様 |
| [crates/shared](crates/shared) | API の型（`cargo test -p disnans-shared` で TypeScript の型を `app/src/lib/protocol/` に生成） |

### リリース

1. `app/src-tauri/tauri.conf.json` の `version` を上げてコミットする
2. `git tag v<version> && git push origin master v<version>`

GitHub Actions が Android / Windows / Linux 版をビルドし、Releases に公開します。署名の鍵は GitHub の Secrets と管理者の `~/.config/disnans-keys/` にあります（**鍵はなくさないこと**。Android の鍵をなくすと、全員がアンインストールして入れ直す必要があります）。
