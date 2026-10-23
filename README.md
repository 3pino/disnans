# disnans

小さな SNS。チャットと、写真やファイルの共有ができます。

- Tailscale の中だけで動きます。インターネットには公開しません。ログインも Tailscale のアカウントで自動的に行われます。
- **サーバーは自宅の PC で動かします。** データは手元に置かれます
- 対応: Android / Windows / Linux

## インストール（参加する人）

### 1. Tailscale に参加する

1. [Tailscale](https://tailscale.com/download) をインストールし、自分のアカウントでログインする
2. サーバーの管理者から届く「ノード共有」の招待を受け入れる

これで準備は完了です。disnans 用のアカウントは、初めて接続したときに自動で作られます。

### 2. アプリを入れる

[最新のリリース](https://github.com/3pino/disnans/releases/latest)から、デバイスに合ったファイルをダウンロードします。

| デバイス | ファイル | 入れ方 |
|---|---|---|
| Android | `disnans_*_android-arm64.apk` | ダウンロードした APK を開く。「この提供元のアプリを許可」の確認が出たら許可する |
| Windows | `disnans_*_x64-setup.exe` | 実行してインストールする。「Windows によって PC が保護されました」と出たら「詳細情報」→「実行」 |
| Linux（Ubuntu / Debian） | `disnans_*_amd64.deb` | `sudo apt install ./disnans_*_amd64.deb` |
| Linux（その他） | `disnans_*_amd64.AppImage` | `chmod +x` で実行権限を付けて起動する |

Windows の `.exe` と Linux の `.deb` を入れると、CLI の `disnans` も使えるようになります。

- **Windows**: インストール時にユーザーの PATH へ入れます。新しく開いたターミナルで `disnans` と打てます。アンインストールでは、インストーラが追加した分だけを PATH から外します（他の PATH は変えません）。
  - PATH が長すぎるときは、インストーラは PATH を一切変えません（安全のため。CLI のフォルダは入ります）。目安はおおむね 800 文字からで、インストーラのビルドによって異なります。その場合は `%LOCALAPPDATA%\disnans` を手で PATH に追加してください。
- **Linux（`.deb`）**: `/usr/bin/disnans` に入ります。
- **AppImage**: CLI の PATH 登録は行いません。CLI を使うなら `.deb` か Windows の `.exe` を入れてください。

### 3. サーバーに接続する

アプリを起動し、管理者から教わったサーバーのアドレス（例: `100.x.x.x:8080`）を入力します。`http://` は省略できます。

### 通知

- 「設定」→「サンプル通知を送信」で、通知が届くか確かめられます。
- メインチャットに投稿されると、投稿者以外の全員に通知が届きます。「サイレント送信」（送信ボタンを上へなぞって送る）では通知しません。
- **Android**: 初回の起動時に通知の許可を求められます。アプリを閉じていても通知が届くよう、裏でサーバーとつなぎ続けます（「通知を受け取っています」という通知が常に表示されますが、オフにして構いません）。
- **Linux のトレイ**: システムトレイのアイコンに `libayatana-appindicator3-1` が要ります（`.deb` は依存として入れます。AppImage などでは `sudo apt install libayatana-appindicator3-1`。GNOME ではトレイを出す拡張機能「AppIndicator and KStatusNotifierItem Support」も要ります）。

### 通話

画面の上部に通話のバーが出て、「＋」メニューの「通話に参加」や `/vc-join` で参加します。参加者を長押し（PC は右クリック）すると、その人を通話から外せます。設定は「設定」→「通話」にあります。

- **Linux**: `gstreamer1.0-plugins-good`、`gstreamer1.0-plugins-bad`、`gstreamer1.0-pulseaudio`（PipeWire の環境なら `gstreamer1.0-pipewire` も）が要ります（`.deb` は推奨パッケージとして入れます）。
- **Linux の既知の問題（未解決）**: 通話中、自分のマイクの音が遅れることがあります（Windows では出ません）。内容・試した対策・回避策は [FEEDBACKS.md](FEEDBACKS.md) を参照してください。

### Linux の診断ログ

通話のフリーズなどを調べるときは、先にトレイの「終了」でアプリを完全に終了し、リポジトリで次を実行します。

```sh
scripts/log-linux.sh                             # deb で入れた disnans-app
scripts/log-linux.sh /path/to/disnans.AppImage    # AppImage の場合
```

GTK・GStreamer・Rust のログを `${XDG_STATE_HOME:-$HOME/.local/state}/disnans/logs/` に保存して起動します（保存先は起動時に表示）。ターミナルを閉じても記録は続き、ファイルはその利用者だけが読める権限で作ります。JavaScript の Console はこのログに保存されません。普段の起動設定は変わりません。

`DISNANS_LOG_DIR` で保存先、`GST_DEBUG` で詳細度（既定は `3`）を指定できます。ログは自動で削除しないので、不要なものは手動で整理してください。共有前にマシン名・パスなどの個人情報を確認してください。

### アップデート

アプリの「設定」→「アップデートを確認」から更新できます。

## サーバーを動かす（管理者）

必要なもの: Rust（stable）、Tailscale

```sh
cargo build --release -p disnans-server
DISNANS_BIND=<Tailscale の IP>:8080 DISNANS_DATA_DIR=/var/lib/disnans ./target/release/disnans-server
```

- Tailscale の IP は `tailscale ip -4` で確認できます
- 友達を招待するには、Tailscale の管理画面でサーバー機を[ノード共有](https://tailscale.com/kb/1084/sharing)します。友達は自分の無料アカウントのままで接続できます
- 環境変数や注意点は [crates/server/README.md](crates/server/README.md) を参照してください

  1. 管理画面（login.tailscale.com）の Machines で、server の「…」メニューから Share… を選びます。
  2. 招待リンクを作るか、友だちのメールアドレスに送ります。
  3. 友だちは自分の Tailscale アカウントで招待を受けます。その人がそのアカウントでログインしているデバイスなら、どれからでも サーバーPC が見えるようになります。
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

## 共有フォルダ（ファイラーから開く）

添付ファイルと共有フォルダは、エクスプローラーやファイルマネージャーからネットワークドライブとしても開けます（WebDAV）。アドレスはサーバーの管理者に確認してください。形式は次のとおりです。設定の詳細・認証・制限は [サーバーの説明](crates/server/README.md#共有フォルダwebdav) を参照してください。

- Windows: `\\<サーバーの Tailscale 名>@SSL@<ポート>\dav`
- Linux: `davs://<サーバーの Tailscale 名>:<ポート>/dav`

## 開発

開発・テスト・リリースの手順は [CONTRIBUTING.md](CONTRIBUTING.md) にあります。未対応の項目・既知の問題は [FEEDBACKS.md](FEEDBACKS.md) にまとめています。
