# 添付ファイルのファイルシステム化（設計案）

状態: 設計のみ。コードはまだ無い。Windows の制約は記憶ベースなので、実装前に実機で確かめる（末尾の「要確認」）。

## 方針

- サーバーが WebDAV を話し、エクスプローラー（Windows）やファイルマネージャー（Linux）からネットワークドライブとしてつなぐ。
- 各ユーザーに「ホーム」がある。ホームの中には消せない `attachments/`（今の添付ファイルを見せる仮想フォルダ）と、自由に操作できる領域がある。
- プラグインからも同じ操作ができる（SDK の `disnans.files`）。
- CLI/TUI からも扱える（`disnans files`）。

## 1. 認証

- Tailscale の whois は接続元 IP で決まるので、WebDAV でもそのまま使える（HTTP の認証方式に依存しない）。
- 問題は Windows の WebClient（WebDAV のミニリダイレクター）側の制約:
  - 既定では、Basic 認証は HTTPS でだけ送る（`BasicAuthLevel`）。平文の HTTP で使うにはレジストリの変更が要る。→ **採用案: HTTPS にする**。Tailscale の証明書（`tailscale cert`、MagicDNS・HTTPS 有効時。公的に信頼される証明書）を使えば、レジストリを触らずに済む。Basic 認証は要らない（whois で決める）ので、認証欄は空でもよいか、ダミーの値で通すかを Windows 側で確かめる。
  - ファイルサイズの上限は既定で約 50MB（`FileSizeLimitInBytes`）。これ以上の書き込みはレジストリの変更が要る。→ 第 1 段では「50MB を超えるファイルは Web UI / CLI から」と案内する。
  - ポートは 443 が安全（非標準のポートは URL に書く必要がある）。Tailscale Serve で 443 → 内部の 8080 に中継する案が手軽。
- Linux（gvfs の dav/davs、davfs2）は HTTP・HTTPS とも問題なし。

## 2. URL とホームの範囲

- URL: `https://<ホスト>/dav/`。ユーザーは自分のホームだけ見える（`/dav/` 直下が自分のホーム）。
- 他人のホームや共有フォルダは第 1 段では無し。第 2 段で「共有フォルダ」（指定したユーザーとの共有）を検討。
- 別ユーザーのパスにアクセスしたら 404（存在を隠す）。

## 3. attachments/ の中身

- ホーム直下の `attachments/` は、DB のメッセージの添付を見せる読み取り専用の仮想フォルダ。
- 並び: `attachments/<年>/<月>/<チャンネル>/<ファイル名>`（チャンネルはメイン、スレッドは無い）。
- 見えるものは「自分が見られるチャンネルの添付すべて」（今の API と同じ権限）。自分が上げたものだけにはしない。
- ファイル名の衝突: `<元のファイル名>` の後ろに短い ID を付ける（`photo (01H...).png`）。
- 元メッセージとの対応: 1 ファイルに対して 1 エントリ。投稿が消えたら、そのエントリも消える。
- 削除・改名・移動・作成は仮想フォルダの中では拒否（405 または 403）。PUT・MKCOL・MOVE・DELETE は `attachments/` 配下で拒否する。

## 4. 自由領域の保存先と容量

- 保存先: `data/homes/<user_id>/`（実ファイル）。DB には持たない（メタデータはファイルシステムから）。
- 容量の上限: ユーザーごと（既定案 1 GB。`DISNANS_HOME_QUOTA` で変更）。超えたら 507 Insufficient Storage。
- バックアップ: 今の `deploy.sh` は DB しか複製しない。`data/homes/` も含めるか決める必要がある（大きくなるので、別の仕組みが要る）。
- `attachments/` の実体は今の `data/files/` のまま（二重に持たない）。

## 5. WebDAV の実装

- 必要なメソッド: OPTIONS, PROPFIND, GET/HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK。
- Windows は書き込みに LOCK/UNLOCK が要る。LOCK を持たないと読み取り専用になる。
- 候補: `dav-server` クレート（hyper 1 系、`FileSystem` と `DavLockSystem` の trait を実装する。LOCK はメモリ上の実装で足りる）。axum 0.8 が使う http/hyper 1 系と合う。依存の大きさと、default-features を切れるかは実際に確かめる（warp 連携などの機能は要らない）。
- 代替: 自前で PROPFIND（XML）と数種類のメソッドを書く。依存は増えないが、Windows の挙動に合わせる手間が大きい。

## 6. プラグインからのアクセス

- SDK の案: `disnans.files.list(path)`、`read(path)`、`write(path, data)`、`mkdir(path)`、`remove(path)`、`move(from, to)`。パスはホームからの相対（`attachments/` は読み取りだけ）。
- 権限: マニフェストで宣言する（`"permissions": ["files"]`）。宣言していないプラグインは呼べない。ユーザーには導入時に知らせる（既存の仕組みに合わせる）。
- REST: `GET/PUT/DELETE /api/files/*path`（WebDAV と同じ中身を別の入口で見せる）。
- プラグインの API 版（apiVersion）を上げる必要がある。

## 7. CLI/TUI

- `disnans files ls [path]`、`disnans files get <path> [-o file]`、`disnans files put <file> <path>`。
- client-core の REST 経由。TUI は後回し。

## 8. 段階分け

- **第 1 段**: 読み取り専用の `attachments/` だけを WebDAV で見せる（書き込みは無い）。HTTPS と Tailscale 証明書の確認、Windows の実機確認。
- **第 2 段**: 自由領域（作成・移動・削除・アップロード）、容量の上限、バックアップ方針。
- **第 3 段**: プラグイン SDK と REST、CLI。
- 共有フォルダは第 4 段以降で検討。

## ユーザーに決めてほしいこと

1. 容量の上限（既定 1 GB で良いか）と、50MB の上限を Windows 側で上げてもらうか（レジストリ変更）。
2. 自由領域は本当に必要か（第 1 段は `attachments/` だけで良いか）。
3. 他人との共有（共有フォルダ）を将来やるか。
4. 自由領域のバックアップ（容量が増えたときの扱い）。
5. HTTPS にする（Tailscale の証明書の準備）ことで良いか。

## 要確認

- Windows の BasicAuthLevel、FileSizeLimitInBytes の既定値、非標準ポートの扱い、Tailscale 証明書での WebClient の挙動（実機で確かめる）。
- `dav-server` の現行版と、default-features を切ったときの依存の数。
