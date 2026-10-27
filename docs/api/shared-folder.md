# disnans API: 共有フォルダ（REST と WebDAV）

全員で共有する 1 つのフォルダ（`data/shared/`）。REST（`/api/shared`）と WebDAV（`/dav/`）は同じ中身で、規則も同じ。ユーザー別の領域や所有者ごとの制限、容量上限は設けない。`attachments/` は仮想フォルダで、実体は `data/files/` に ID 名で保存する（二重にコピーしない）。
接続のしかた・認証ヘッダー・Tailscale Serve・バックアップは [server README](../../crates/server/README.md)。認証とエラーの形は [rest.md](rest.md)。プラグインからは [plugins/runtime.md](../plugins/runtime.md) の `files`。

## 共通の規則

- パスは共有フォルダからの相対（`docs/a.txt`）。区切りごとに名前を検査する: `..`・区切り文字・Windows で使えない文字（`: * ? " < > |`）・予約名（CON・NUL・COM1 など）・末尾の `.` や空白・`.disnans-` で始まる名前は拒否（`403`）
- 直下の `attachments/` は添付の一覧（投稿された添付と、直接作った添付が並ぶ。`file_id` と `mime` が入り、投稿されたものは `message_id` も入る）。
  - `attachments/<名前>` への PUT は、同じ名前があればその添付（同じ ID）の中身を差し替え、なければ新しい添付にする。変換（画像は WebP、サムネイル）は通常のアップロードと同じ
  - 名前の変更（`move`、`attachments/` の中だけ）は ID と中身が同じまま。宛先が同じ名前なら `409 exists`（`overwrite: true` なら、宛先の添付を消して入れる）
  - 削除（`DELETE`）は誰でもできる（[rest.md](rest.md) の「削除された添付」）
  - `attachments/` と共有フォルダの間の移動は `403`（コピーを使う）。コピーは可（共有 → `attachments/` は新しい添付になる）
  - フォルダの作成・フォルダの削除・`attachments` そのものの移動は `403`
  - 同じ名前のフォルダは `attachments/` の中には作れない（中はファイルだけ）
- 書き込みは一時ファイルに書いてから差し替える（上書きでも既存の実体は書き換えない）
- シンボリックリンクは辿らず、一覧にも出さない
- 変更（作成・上書き・移動・コピー・削除）は、WebDAV でも REST でも `files.changed`（`{ path }`、変わった項目の相対パス）を全員に配信する。フォルダの一覧はその親を読み直す
- 失敗の `code`: `not_found`（404）、`forbidden`（403）、`exists`（409、同名がある）、`parent_missing`（409）、`too_large` / `insufficient_storage`、`deleted`（410、削除された添付）
- WebDAV の `DELETE /dav/` と `DELETE /dav/attachments` は `403`（フォルダごと消させない）

## REST（`/api/shared`）

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/api/shared` | 直下の一覧（`SharedListing`） |
| GET | `/api/shared/{パス}` | フォルダなら一覧、ファイルなら中身（`Range` 可、ファイルの種類は拡張子で決まる） |
| PUT | `/api/shared/{パス}` | 本文をそのパスのファイルにする（作成・上書き。本文は任意の大きさ）。親のフォルダがなければ `409 parent_missing`。結果は `SharedEntry` |
| DELETE | `/api/shared/{パス}` | 削除（フォルダは中身ごと）。`204` |
| POST | `/api/shared` | フォルダの作成・移動・コピー。body は `SharedOp`: `{ op: "mkdir", path }` / `{ op: "move", from, to, overwrite? }` / `{ op: "copy", from, to, overwrite? }`（`overwrite` は省略で `false`）。結果は `SharedEntry` |

## WebDAV（`/dav/`）

- 許可するメソッド: OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK。PROPPATCH は 405
- `attachments/` フォルダそのものの削除・改名は 403（中のファイルの操作はできる）。ルートの削除も拒否する
- 中身の差し替え・名前の変更・削除ができる（`attachments/` と共有フォルダの間の移動は不可、コピーは可）。添付の別名は、アップロードのときに決まり、同名は `名前 (2).拡張子`。名前に `[` `]` `|` は使えない。実体は `data/files/<ID>` で、別名は DB に保存する
- 書き込みは一時ファイル（`.disnans-tmp-*`）に書いてから rename する。上書きでも既存の実体の中身は書き換えない（バックアップのハードリンクを守るため）
- 認証は `/api` と同じ（whois）。CORS は `/api` だけに付ける（`/dav` の OPTIONS は WebDAV の `DAV:` と `Allow` を返す必要があるため）
