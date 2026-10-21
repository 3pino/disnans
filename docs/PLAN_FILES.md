# 添付ファイルのファイルシステム化（設計案）

状態: 第 1 段（読み取り専用の `attachments/`）と第 2 段（共有フォルダへの書き込み、バックアップ）を実装済み。Windows の制約は記憶ベースなので、実機で確かめる（末尾の「要確認」）。

## 方針

- **共有フォルダは 1 つ**。サーバーの `data/shared/`（既存のデータベースと同じ扱い）。全員が同じものを見る。ユーザーごとのフォルダ・「自分の」領域・容量の上限は無い。
- サーバーが WebDAV を話し、エクスプローラー（Windows）やファイルマネージャー（Linux）からネットワークドライブとしてつなぐ。URL は `/dav/`（共有フォルダの直下）。
- `/dav/` の直下に、消せない・中身を変えられない仮想フォルダ `attachments/` がある。中身は投稿された添付ファイルを平らに並べたもの（`attachments/<ファイル名>`）。
- それ以外（`attachments/` の外）は、第 2 段で誰でも作成・移動・削除できる。
- つなぐ人は tailnet のメンバーで、disnans のユーザーであること（今の認証と同じ。whois、または Serve のヘッダー）。
- プラグインと CLI からの扱いは後の段階（6, 7）。

## 1. 認証

- Tailscale の whois は接続元 IP で決まるので、WebDAV でもそのまま使える（HTTP の認証方式に依存しない）。
- 問題は Windows の WebClient（WebDAV のミニリダイレクター）側の制約:
  - 既定では、Basic 認証は HTTPS でだけ送る（`BasicAuthLevel`）。平文の HTTP で使うにはレジストリの変更が要る。
  - ファイルサイズの上限は既定で約 50MB（`FileSizeLimitInBytes`）。これ以上の書き込みはレジストリの変更が要る。第 1 段は読み取りだけなので影響は無い（第 2 段の課題）。
  - ポートは 443 が安全（非標準のポートは URL に書く必要がある）。
- Linux（gvfs の dav/davs、davfs2）は HTTP・HTTPS とも問題なし。

### 採用: Tailscale Serve で TLS を終端する

- 本番では `tailscale serve --https=443 --set-path /dav http://127.0.0.1:<port>/dav` のように、Serve が TLS（Tailscale の証明書）を終端し、disnans へ中継する。disnans 自身は TLS を持たない。
- **接続元がループバックになる**: Serve 経由の接続元は 127.0.0.1 / ::1 なので、whois で人を決められない。そこで Serve が付ける `Tailscale-User-Login` / `Tailscale-User-Name` / `Tailscale-User-Profile-Pic` を使う（`webdav::identity::serve_profile`）。
- **信じる条件は「接続元がループバックのとき」だけ**。外から（Tailscale の IP など）来たヘッダーは、クライアントが勝手に付けられるので無視して whois を使う。
- 待ち受け: `DISNANS_BIND`（Tailscale の IP、外向け）に加えて、`DISNANS_LOCAL_BIND`（任意、例 `127.0.0.1:8080`）でループバックも待ち受ける。ループバック以外のアドレスは起動時に拒否する。
- 注意: この信頼は `/api` にも効く（Serve 経由の Web アプリも同じ認証になる）。サーバーのホストで動く他のプロセスは、ループバックに偽のヘッダーを送れるので、ホストは信頼できるものだけにする。
- 未確認: Serve がヘッダーを外からの同名のものと入れ替えること、タグ付きノード（利用者なし）のときにヘッダーが付くか（付かなければ 401）。実機で確かめる。

## 2. URL と範囲

- URL: `https://<ホスト>/dav/`。`/dav/` の直下が共有フォルダ。
- 認証は「tailnet のメンバーで、disnans のユーザーであること」。見え方はユーザーによらず同じ。

## 3. attachments/ の中身

- `/dav/attachments/` は、DB のメッセージの添付を見せる読み取り専用の仮想フォルダ。平らに並べる（年・月で分けない）。並びは投稿の順。
- 見えるもの: 投稿されたメッセージに付いた添付だけ（投稿前のアップロードは出ない）。チャンネルは無く、主チャットは全員が見るので、全員の投稿の添付が見える。
- ファイル名の衝突: 同じ名前（大文字小文字を区別しない）が複数あれば、全部に末尾 8 文字の ID を付ける（`photo (RSTVWXYZ).png`）。それでも重なれば ID 全体を使う。ファイルを消すと、残りの名前が戻ることがある。
- ファイル名は `sanitize_file_name` で安全な形にする（パスの区切り・制御文字は除く）。幹は 180 文字までに切る。
- 元メッセージとの対応: 1 ファイルに 1 エントリ。投稿（メッセージ）が消えると、そのエントリも消える（`files` の行が消える）。
- 第 1 段は読み取り専用: PROPFIND / GET / HEAD / OPTIONS と LOCK / UNLOCK だけ。PUT・MKCOL・MOVE・COPY・DELETE・PROPPATCH は 403 で拒否する。

## 4. 共有フォルダの保存先と容量

- 保存先: `data/shared/`（実ファイル）。DB には持たない（メタデータはファイルシステムから）。
- 容量の上限は無い。
- `attachments/` の実体は今の `data/files/` のまま（二重に持たない）。
- バックアップ（決定済み）: `data/backup/` に、DB・共有フォルダ・添付の実体を組で残す。共有フォルダと添付はハードリンク（中身は書き換えない）で、20 組まで。自動更新の直前と、1 日 1 回。詳細は `crates/server/README.md`。
- 書き込みの決まり: 一時ファイルに書いてから rename（上書きでも既存の実体は書き換えない）。パスの検査（`..`・区切り・Windows の禁止名・予約名）。シンボリックリンクは辿らない。

## 5a. 実装の状態

- `crates/server/src/webdav/`: `identity.rs`（Serve のヘッダー、RFC 2047 の Q 符号化を復号）、`tree.rs`（仮想フォルダの中身）、`names.rs`（名前の決まり）、`fs.rs`（dav-server の `DavFileSystem`。読み取りと、共有フォルダへの書き込み）、`mod.rs`（`/dav` のルーター、メソッドの許可）。
- `crates/server/src/backup.rs`: バックアップの組、ハードリンク、20 組の保存、定期と自動更新の直前。
- 第 2 段の書き込み: PUT（一時ファイルから rename）、MKCOL、DELETE（再帰）、MOVE、COPY（添付から共有フォルダへのコピーも可）。PROPPATCH は未対応（405）。
- dav-server 0.11（features は hyper のみ。LOCK は `MemLs`）。
- CORS は `/api` だけに付け、`/dav` の OPTIONS は dav-server が答える（`DAV: 1,2,3` と `Allow`）。
- テスト: `tests/webdav_http.rs`（PROPFIND・GET・Range・書き込みの拒否・LOCK・OPTIONS・存在しないパス）、`tests/webdav.rs`（投稿された添付だけが見える）、`tree.rs` と `identity.rs` の単体テスト。
- 未確認（実機）: Windows の WebClient での接続、Serve のヘッダーの実際の値。

## 5. WebDAV の実装

- 必要なメソッド: OPTIONS, PROPFIND, GET/HEAD, PUT, DELETE, MKCOL, MOVE, COPY, LOCK, UNLOCK。
- Windows は書き込みに LOCK/UNLOCK が要る。LOCK を持たないと読み取り専用になる。
- 採用: `dav-server` クレート（hyper 1 系）。features は最小（`memls` のみ。LOCK のメモリ実装）。ファイルシステムは自前の trait 実装で持つ（localfs は使わない）。追加する行は chief が Cargo.toml に入れる。版と feature 名は入れたあとに確認する。

## 6. プラグインからのアクセス

- SDK の案: `disnans.files.list(path)`、`read(path)`、`write(path, data)`、`mkdir(path)`、`remove(path)`、`move(from, to)`。パスは共有フォルダからの相対（`attachments/` は読み取りだけ）。
- 権限: マニフェストで宣言する（`"permissions": ["files"]`）。宣言していないプラグインは呼べない。
- REST: `GET/PUT/DELETE /api/files/*path`（WebDAV と同じ中身を別の入口で見せる）。
- プラグインの API 版（apiVersion）を上げる必要がある。

## 7. CLI/TUI

- `disnans files ls [path]`、`disnans files get <path> [-o file]`、`disnans files put <file> <path>`。
- client-core の REST 経由。TUI は後回し。

## 8. 段階分け

- **第 1 段**: 読み取り専用の `attachments/` だけを WebDAV で見せる（書き込みは無い）。Serve の確認、Windows の実機確認。
- **第 2 段**（実装済み）: 共有フォルダの中の作成・移動・削除・アップロード（`data/shared/`）、バックアップ。
- **第 3 段**: プラグイン SDK と REST、CLI。

## ユーザーに決めてほしいこと

1. 50MB の上限を Windows 側で上げてもらうか（レジストリ変更）。
2. HTTPS にする（Tailscale の証明書の準備）ことで良いか。

## 要確認

- Windows の BasicAuthLevel、FileSizeLimitInBytes の既定値、非標準ポートの扱い、Tailscale 証明書での WebClient の挙動（実機で確かめる）。
- Serve のヘッダー名と、タグ付きノードでの挙動（実機で確かめる）。
- `dav-server` の現行版と、features を絞ったときの依存の数。
