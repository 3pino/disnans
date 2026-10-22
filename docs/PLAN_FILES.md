# 添付ファイルのファイルシステム化（設計案）

状態: 第 1 段・第 2 段（共有フォルダへの書き込み、バックアップ）と、第 3 段の添付の作り直し（別名・`attachments/` の書き込み・削除）を実装済み。Windows の制約は記憶ベースなので、実機で確かめる（末尾の「要確認」）。

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

## 3. attachments/ の中身（第 3 段の設計。決定済み）

添付の本体は今までどおり ID（`data/files/<ID>`）。`attachments/` の名前は ID ではなく、添付ごとに持つ**別名**（`files.file_name`）。

### 別名

- 別名は**アップロードの時に 1 回だけ決める**。後から自動では変わらない（ユーザーが名前を変えたときだけ変わる）。
- 一意: 生きている（削除されていない）添付の中で、大文字小文字を区別せず一意。投稿の有無は問わない（投稿前のものも含めて重ならない）。比較のキーは Rust の `to_lowercase()`（`files.alias_key`）。DB の部分一意インデックス（`WHERE deleted_at IS NULL`）で保証する。
- 同名があれば Windows 流に `name (2).ext`、`name (3).ext`…（幹は 180 文字まで、全体は `sanitize_file_name` の上限内）。
- 名前に `[` `]` `|` は使えない（リンクの書き方と衝突するため。括弧 `()` は使える）。アップロードの名前は、禁止の文字を `_` に直す（`attachment_names::clean`）。`attachments/` へ PUT・改名・コピーで禁止の文字を含む名前は 403。
- 今の「全部に ID 末尾 8 文字を付ける」表示は廃止する。

### 既存データの移行（マイグレーション 0015）

- `0015_attachment_names.sql` は列を足すだけ（`alias_key TEXT`、`library INTEGER NOT NULL DEFAULT 0`、`deleted_at INTEGER`）。既存の行の値は変えない。
- 別名の割り当ては起動時に Rust で行う（`attachment_names::backfill`）。理由: キーは Unicode の小文字化で作る必要があり（SQL の `lower()` は ASCII だけ）、マイグレーションの SQL だけでは一致させられないため。
- 冪等: `alias_key IS NULL` の行だけを処理し、1 つのトランザクションで行う。失敗したら起動を止める（DB は変えない）。
- 順番: 投稿された行はメッセージの投稿時刻の古い順（同じ時刻は ID 順）、次に投稿されていない行を作成時刻の順。最初のものはそのまま、後のものに ` (2)`…。
- 投稿されていない既存の行は、`attachments/` には出ない（下の「投稿前のアップロード」）。

### 投稿前のアップロード

- `POST /api/files` で作った行は、メッセージに付くまで `attachments/` に出ない。別名は作成時に決める（投稿されない行も別名を持つ。24 時間で消える）。
- 投稿されずに消えるのは `library = 0` で、`message_id` が無い行だけ（今と同じ）。

### 投稿されていない添付（library）

- `attachments/` の中に直接作ったもの（WebDAV の PUT・COPY、REST の PUT・copy）は `library = 1` の行になり、すぐ `attachments/` に出る。投稿されないと消えない。
- 誰でもメッセージに付けられる（付けたら `message_id` が入り、以後は普通の添付）。
- 投稿の時刻は、投稿されたら投稿の時刻、されていなければ作成の時刻（並びに使う）。

### 移動・コピー・名前の変更（共有フォルダとの境界）

| 操作 | 結果 |
|---|---|
| `attachments/` の中で名前を変える（MOVE、REST の move） | 別名だけ変わる（ID と中身は同じ）。記録は残さない |
| `attachments/` から共有フォルダへ（COPY） | 中身をコピーした新しいファイルになる |
| `attachments/` から共有フォルダへ（MOVE） | 不可（403）。コピーしてから消す |
| 共有フォルダから `attachments/` へ（COPY、PUT） | 新しい添付（新しい ID、`library = 1`） |
| 共有フォルダから `attachments/` へ（MOVE） | 不可（403）。コピーする |
| `attachments/` の中でコピー | 新しい ID の添付（`library = 1`） |

- 宛先が既にあれば `exists`（WebDAV は Overwrite ヘッダーの既定 T のまま）。`overwrite: true` のときは、宛先の添付を消してから入れる（`attachments/` の中でも同じ規則）。
- 上書きで消された添付は、下の「削除」と同じ扱いになる。

### 中身の書き換え（PUT・上書きコピー）

- `attachments/<名前>` への PUT（同じ名前がある）は、**同じ ID** の中身を差し替える。メッセージは同じ ID を指すので、新しい中身が見える。
- 中身は、アップロードと同じ変換（画像は WebP、サムネイル）を通してから差し替える。サイズ・種類・幅・高さ・サムネイルの有無も更新する。
- 差し替えは一時ファイルに書いてから rename する（バックアップのハードリンクを守るため、既存の実体は書き換えない）。
- 名前がなければ新しい添付（`library = 1`）として作る。

### 削除

- `attachments/` からの削除は誰でもできる。
- 投稿されていた添付（`message_id` あり）: 行は残し（`deleted_at` を入れる）、本体とサムネイルは消す。メッセージには添付として残り、`deleted: true` と最後の別名が見える。`GET /api/files/{id}` は `410 Gone`（`deleted`）。
- 投稿されていない添付（`library = 1`、`message_id` なし）: 行ごと消す（だれも参照しないため）。
- メッセージを消したときは今と同じ（行と本体が消える）。

### 本文のリンク（`disnans:file/<ID>`）

- 本文の Markdown `[名前](disnans:file/<ID>)` と `![](disnans:file/<ID>)` を、添付の正式な参照にする。
- サーバーは本文を今までどおり、そのまま保存する。追加の検査は無い（ID の存在も見ない）。
- 参照先の取得は `GET /api/files/{id}`（今と同じ。メッセージへの所属は見ない）。削除済みは `410`。表示は helper-2 が行う。

### 通知

- `attachments/` の中が変わるたびに `files.changed`（`path` は `attachments/<別名>`）を全員に送る: 作成・差し替え・名前の変更（元と先の 2 件）・削除・投稿（`attachments/` に現れる）・メッセージの削除（消える）。

### API の形（API.md に記載）

- `Attachment` に `deleted: boolean` を足す（既定 false）。`file_name` は今の別名。
- `SharedEntry` に `file_id`（`attachments/` の項目だけ。添付の ID）を足す。`message_id` は投稿されたものだけ。

### 制限

- 大文字小文字の比較は Unicode の `to_lowercase()`。Windows（NTFS）の比較と一致しない特殊な文字がありうる（実機で確かめる）。
- 投稿されずに 24 時間で消える行の名前は、その間だけ予約される。

## 3b. 本文のリンク（決定済み）

### 書き方（ユーザーが書くもの）

- リンク: `[別名](パス)` と `[[パス|別名]]`（別名は省略できて `[[パス]]`）。
- 埋め込み: 先頭に `!` を付ける: `![別名](パス)` と `![[パス]]`。リンクではなく、画像・動画などをその場に表示する。
- パスは共有フォルダの中のパス（`attachments/photo.png`、`docs/a.pdf`）。

### サーバーが解析する範囲（これだけ）

サーバーは本文の中の「パスの位置」だけを見る。位置は次の 2 つ（`!` の有無は問わない）:
1. `[文字](` の直後から、括弧の入れ子を数えて、対にならない `)` まで（`view::markdown` の `link_at` と同じ。`photo (2).png` は書ける）。
2. `[[` の直後から、次の `|` または `]]` まで。

パスが `attachments/` で始まるものだけを対象にする（ほかの共有フォルダのパスは文字のまま）。対象は、`attachments/` の中の名前（区切りは含まない）。

- 送信・編集のとき: パスの位置の `attachments/<名前>` を、その添付の ID に置き換えて保存する: `disnans:file/<ID>`。名前は大文字小文字を区別せず、生きている添付から引く。見つからない・削除済み・名前に `[` `]` `|` や改行・制御文字を含む・区切りを含む・括弧が対にならないものは `400 invalid_link`（そもそも添付の名前にはこれらが無い）。
- 表示（取得・ブロードキャスト・編集の応答）のとき: パスの位置の `disnans:file/<ID>` を、その添付の**今の名前**に戻す: `attachments/<今の名前>`。削除された添付は、消される直前の名前（`file_name`）に戻す。
- 保存の表記は ID、表示と編集の表記は今のパス。ユーザーが書いた `[[...]]` や `![...]` の形はそのまま残る（書き換えるのはパスの部分だけ）。
- 本文の `disnans:file/<ID>` を直接書いた場合も、そのまま有効（表示では今のパスになる）。

### 方式の比較（推奨は 1）

1. **本文の中の ID に置き換えて保存、表示で今の名前に戻す（推奨）**。本文が一つの真実で、編集の往復（表示のパス → 保存の ID）で壊れない。改名しても、保存されたリンクは ID なので切れない。
2. 本文はパスのまま、`refs: [{path, file_id}]` の対応表を別に持つ。対応表は本文の位置と結び付かず、編集のたびに作り直す必要があり、表示で「どのパスを今の名前に直すか」を文字列の一致で探すことになるため、同じ文字列がリンク以外にあると誤って置き換える。採らない。

### 注意点

- 検索（本文の部分一致）は、保存された ID で検索する。ファイル名では見つからない。対応（ファイル名も検索する）は必要になったら検討する。
- パスの位置の判定は単純な文字列の走査で、Markdown の全体の解析はしない（コードブロックの中のリンクも対象になる）。
- 名前の変更で、古い表示（クライアントに残っている本文）は古い名前のままになる。サーバーの再取得で直る。

### 担当

- サーバー: 上の解析（`links.rs`）と、送信・編集・取得での変換。
- クライアント（`view::markdown`、helper-3）: `[[...]]` と `![...]` の解析、埋め込みの表示。
- GUI（helper-2）: 埋め込みの表示と、リンクを押したときの取得。表示の本文の `attachments/<名前>` から ID を引くには、一覧 `GET /api/shared/attachments`（`SharedEntry.file_id`）を使う。取得は `GET /api/files/{id}`。

## 4. 共有フォルダの保存先と容量

- 保存先: `data/shared/`（実ファイル）。DB には持たない（メタデータはファイルシステムから）。
- 容量の上限は無い。
- `attachments/` の実体は今の `data/files/` のまま（二重に持たない）。
- バックアップ（決定済み）: `data/backup/` に、DB・共有フォルダ・添付の実体を組で残す。共有フォルダ・添付・アバター・プラグインはハードリンク（中身は書き換えない）で、20 組まで。自動更新の直前と、1 日 1 回。詳細は `crates/server/README.md`。
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
- **第 3 段**: プラグイン SDK と REST、CLI。添付の作り直し（別名・`attachments/` の書き込み・削除。上の 3 節、実装済み）。

## ユーザーに決めてほしいこと

1. 50MB の上限を Windows 側で上げてもらうか（レジストリ変更）。
2. HTTPS にする（Tailscale の証明書の準備）ことで良いか。

## 要確認

- Windows の BasicAuthLevel、FileSizeLimitInBytes の既定値、非標準ポートの扱い、Tailscale 証明書での WebClient の挙動（実機で確かめる）。
- Serve のヘッダー名と、タグ付きノードでの挙動（実機で確かめる）。
- `dav-server` の現行版と、features を絞ったときの依存の数。
