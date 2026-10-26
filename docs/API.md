# disnans API

型の定義は `crates/shared/src/lib.rs`（TypeScript 版は `app/src/lib/protocol/`、自動生成）。
すべてのパスは `/api` から始まる。JSON のフィールド名は snake_case。
時刻は Unix ミリ秒、ID は ULID 文字列。

## 認証

- 接続元の IP アドレスから、tailscaled の LocalAPI（`/localapi/v0/whois?addr=<ip>:<port>`）でユーザーを特定する
- 初めて見る Tailscale ユーザー（`LoginName` で識別）は自動でアカウントを作る
- 開発モード（環境変数 `DISNANS_DEV=1`）では whois を使わず、`X-Dev-User: <login_name>` ヘッダー、
  またはクエリ `?dev_user=<login_name>`（WebSocket 用）でユーザーを指定する。どちらもなければ `dev@local`
- 認証できない場合は `401` と `ApiError`

## エラー

失敗時は 4xx / 5xx と `ApiError { code, message }` を返す。

## 診断（認証なし）

### `GET /api/health`

障害の切り分けに使う。認証なしで答える（Tailscale の経路の確認にも使える）。
応答は次の値だけ。利用者や接続元の情報は含まない。

```json
{ "ok": true, "version": "0.2.43", "uptime_secs": 12345, "db": { "ok": true, "ms": 0 }, "ws_connections": 3 }
```

- `ok` と `db.ok` が `false` のとき、HTTP は `503`（DB に `SELECT 1` が届かない）
- `db.ms` は `SELECT 1` の所要ミリ秒、`ws_connections` は接続中の WebSocket の数

## REST

| メソッド | パス | 内容 | レスポンス |
|---|---|---|---|
| GET | `/api/me` | 自分 | `User` |
| PATCH | `/api/me` | 表示名の変更（body: `UpdateMe`） | `User` |
| PUT | `/api/me/avatar` | アバターの設定（multipart、フィールド名 `file`） | `User` |
| DELETE | `/api/me/avatar` | 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す | `User` |
| GET | `/api/me/read` | 自分の既読の位置と未読数（メインチャットの 1 件を配列で返す） | `ReadMarker[]` |
| PUT | `/api/me/read` | 既読の位置を進める（body: `MarkRead`） | `ReadMarker` |
| GET | `/api/me/prefs` | 自分の設定（ホットキー・Enter キーの動作など。まだなければ `{}`） | JSON オブジェクト |
| PUT | `/api/me/prefs` | 自分の設定をまるごと置き換える（body: JSON オブジェクト） | JSON オブジェクト |
| GET | `/api/me/devices` | 自分のデバイスの一覧（`device_id`, `name`, `created_at`, `last_seen_at`, `has_prefs`。新しい順） | `[DeviceInfo]` |
| PUT | `/api/me/devices/{device_id}` | デバイスを登録する・名前を変える（body: `{ "name": "…" }`）。台数の上限なし | `DeviceInfo` |
| DELETE | `/api/me/devices/{device_id}` | デバイスと、その設定を消す | `204`（なければ `404`） |
| GET | `/api/me/devices/{device_id}/prefs` | このデバイスの設定。未保存・デバイスがなければ `404` | `{ "prefs": {…}, "updated_at": n }` |
| PUT | `/api/me/devices/{device_id}/prefs` | このデバイスの設定をまるごと置き換える（body: `{ "prefs": {…} }`）。デバイスを登録していなければ `404` | `{ "prefs": {…}, "updated_at": n }` |

デバイス ID はクライアントが作る（1〜64 文字、英数字とハイフン。認証ではなく、自分のデバイスだけに使う）。デバイスの一覧・設定の変更は他のデバイスにイベントで知らせない。設定の大きさは `/api/me/prefs` と同じ上限（64 KB）。
| GET | `/api/users` | メンバー一覧 | `User[]` |
| GET | `/api/avatars/{id}` | 自分で設定したアバターの画像（WebP） | バイナリ |
| GET | `/api/messages?before=&limit=` | メッセージ履歴 | `Message[]` |
| POST | `/api/files` | ファイルのアップロード（multipart、フィールド名 `file`） | `Attachment` |
| GET | `/api/files/{id}` | ファイル本体（削除された添付は `410`、code `deleted`） | バイナリ |
| GET | `/api/files/{id}/thumb` | サムネイル（WebP） | バイナリ |
| DELETE | `/api/files/{id}` | 投稿前のアップロードを取り消す。本人の、どの本文にも投稿されていない添付だけ（ほかの人のもの・投稿済み・`attachments/` のライブラリは `403`、無ければ `404`） | `204` |
| GET | `/api/shared` | 共有フォルダの直下の一覧 | `SharedListing` |
| GET | `/api/shared/{パス}` | フォルダなら一覧、ファイルなら中身（`Range` 可、ファイルの種類は拡張子で決まる） | `SharedListing` / バイナリ |
| PUT | `/api/shared/{パス}` | 本文をそのパスのファイルにする（作成・上書き。本文は任意の大きさ）。親のフォルダがなければ `409 parent_missing` | `SharedEntry` |
| DELETE | `/api/shared/{パス}` | 削除（フォルダは中身ごと） | `204` |
| POST | `/api/shared` | フォルダの作成・移動・コピー（body: `SharedOp` = `{ op: "mkdir", path }` / `{ op: "move", from, to, overwrite? }` / `{ op: "copy", from, to, overwrite? }`。`overwrite` は省略で `false`）。結果の項目を返す | `SharedEntry` |
| POST | `/api/notify/sample` | 自分にサンプルの `notify` を送る（通知の動作確認用）。送り先は、リクエストと同じ IP アドレス（デバイス）からの接続だけ | `204` |
| GET | `/api/plugins` | 自分に見えるプラグイン・テーマの一覧（みんなのものと自分だけのもの。ID 順） | `PluginInfo[]` |
| POST | `/api/plugins` | プラグイン・テーマの配布・更新（multipart、フィールド名 `file` を複数、`visibility`） | `PluginInfo` |
| DELETE | `/api/plugins/{id}` | プラグイン・テーマの削除 | `204` |
| GET | `/api/plugins/{id}/files/{name}` | 配布されたファイル（`manifest.json` / `main.js` / `styles.css` / `theme.css` / `icon.svg`） | ファイル本体 |
| POST | `/api/plugins/{id}/notify` | プラグインから通知を送る（body: `PluginNotify`） | `204` |
| POST | `/api/plugins/{id}/messages` | プラグインがボットとしてメッセージを投稿する（body: `PluginPostMessage` = `{ body, name?, notify? }`）。`author_id` は呼び出した人で、`bot: { plugin, name }` が付く。`name` は前後の空白を除いて40文字まで（省略するとプラグインの名前）。本文の検査は通常のメッセージと同じ。プラグインがない（見えない）と `404`。配信は通常の投稿と同じ（`message.created`）。通知は `notify: true` のときだけ送る（v6。省略は `false` で、通知は一切送らない）。`true` なら通常の宛先（メンション・返信）と、投稿が届く全員に送り、タイトルはボットの名前で作る（投稿した本人にもボットの名前で1件送る。メンションは `{ボットの名前} mentioned you`、返信は `{ボットの名前} replied to you`）。ボットのメッセージの編集は `bot_not_editable` | `Message` |
| POST | `/api/sessions` | セッションを作り、カードを流す（body: `CreateSession` = `{ plugin, state, card }`） | `Session` |
| GET | `/api/sessions/{id}` | セッション1件 | `Session` |
| PUT | `/api/sessions/{id}` | セッションの更新（body: `UpdateSession`） | `Session` |
| GET | `/api/ws` | WebSocket | — |

### アバター
- `User.avatar_url` は、自分で設定していれば `/api/avatars/{id}`（**サーバーからの相対パス**。クライアントはサーバーの URL を前に付ける）、
  なければ Tailscale のプロフィール画像の URL（絶対 URL）、どちらもなければ `null`
- 設定: 静止画・アニメーション（最初のフレーム）を読み、中央を正方形に切り抜いて 256px（小さければそのまま）の WebP にする
  - 画像として読めなければ `400 invalid_image`、`file` がなければ `400 missing_file`、20 MB を超えたら `413 avatar_too_large`
  - 設定し直すたびに `{id}` が変わる（前の画像は消す）ので、`/api/avatars/{id}` は `Cache-Control: private, max-age=31536000, immutable`
- 設定・削除で表示が変わったら、全員に `user.updated` を配信する（設定していないときの削除は何もしない）
- Tailscale のプロフィール画像は、ログインのたびに最新の URL を覚えておく。自分で設定しているあいだは表示に使わない（`user.updated` も流さない）。削除するとその最新の URL に戻る

### 設定（prefs）

保存先の分類とクライアントの `{ raw, view }` の扱いは [設計](DESIGN.md#設定の保存先) を参照。REST は元の JSON オブジェクトを返す（Tauri 内部の応答とは異なる）。デバイス台数の上限は設けない（ID の形式・名前の長さ・設定サイズの検査は行う）。

- ユーザーごとに1つの JSON オブジェクトを保存し、同じユーザーのデバイスどうしで共有する。中身はクライアントが決める（サーバーは形と大きさだけを確かめる）
  - いまの中身: `hotkeys`（コマンド ID → `"Mod+Shift+D"` 形式のホットキーの配列。空の配列は「なし」、項目がなければ既定。古い1つだけの文字列も読める）、`slashNames`（コマンド ID → スラッシュコマンドの別名。項目がなければ元の名前）、`enterKeys`（`enter` / `shift` / `ctrl` / `alt` → `"send"` / `"newline"` / `"none"`）
- オブジェクトでなければ `400 invalid_prefs`、JSON にして 64 KB を超えたら `413 prefs_too_large`
- 保存したら、そのユーザーのすべての接続に `prefs.updated` を送る（保存したデバイスにも届く）

### メッセージ履歴
- メインチャットの履歴だけを返す。`thread_id` は廃止した（付けても無視する）
- `before`（メッセージ ID）より古いものを、新しい順に最大 `limit` 件（既定 50、最大 200）取り、**古い順に並べて**返す

### メッセージの検索
- `GET /api/messages/search?q=&before=&limit=` で、本文を全文検索する。メインチャットが対象で、**新しい順**に返す（`Message[]`。並べ替えは `before` と同じく ID で行う）
- `q` は空白で区切った語をすべて含むものを探す（AND）。大文字・小文字は区別しない。前後の空白は除く。空なら `[]`。200 文字を超えたら `400 query_too_long`
- 索引は SQLite の FTS5（trigram）。3 文字以上の語はこの索引で引き、2 文字以下の語を含むときは `LIKE` で探す（件数が多いと遅くなる）
- 削除済みのメッセージは出ない
- 本文の中身だけを見る。メンションは `<@ID>` のまま入っているので、表示名では探せない
- `limit` と `before` の決め方は、メッセージ履歴と同じ（既定 50、最大 200）

### 既読の位置と未読数
- メインチャットの、ユーザーの「ここまで読んだ位置」（メッセージ ID）を保存する。ID（ULID）の文字列の大小で前後を比べ、位置以下の ID のメッセージを既読とみなす
- `unread_count` は、位置より新しい他人のメッセージの数（自分のメッセージと削除されたメッセージは数えない）
- 一度も既読にしていない場所の位置は、アカウントを作った時刻の位置（実在するメッセージの ID ではない）。それより前のメッセージは未読にしない
- マイグレーション 0008 を当てた時点のメッセージは、全員について既読にする
- `PUT` は位置を進めるだけで、戻さない（古い ID なら何もせず、いまの位置を返す）
  - `message_id` が ULID の形でなければ `400 invalid_message_id`
  - 位置が進んだら、自分のすべての接続（送ったデバイスを含む）に `read.updated` を送る
- マイグレーション 0012 でスレッドを廃止した。スレッドの既読の位置は消し、メインチャットの位置は残す

### 返信
- `message.send` の `reply_to`（省略は `null`）に返信先のメッセージ ID を入れる。返信先はメインチャットのメッセージだけ。なければ `reply_not_found`
- `Message.reply_to` に返信先の ID、`Message.reply_preview` に要約（`author_id`・本文の冒頭100文字・`has_attachments`・`bot`）が入る。返信先が削除されると `reply_preview` は `null` になり、`reply_to` は残る（外部キーなし。クライアントは「削除されたメッセージ」と表示する）。要約は読み込みのたびにその時点の内容で作る（編集に追従する）
- 返信先の作者に通知を送る（タイトルは `{名前} replied to you`。自分自身・すでにメンション等で通知する人には送らない）
- マイグレーション 0012 で、スレッドの返信はメインチャットに移し、返信先が空だったものは起点への返信（`reply_to`）にした

### ファイル
- 上限なし（サーバー側でストリーミングして保存する）
- 静止画（JPEG / PNG / WebP など）は WebP（品質 85、長辺最大 800px（`DISNANS_IMAGE_MAX_EDGE` で変更））に変換し、EXIF を削除する（回転は反映する）。元画像は残さない
- 長辺 480px のサムネイルを作る
- アニメーション GIF / WebP は変換せずそのまま保存する
- 投稿されていないファイルは、一定時間（24時間）後に削除してよい
- 添付の別名（`attachments/` での名前、`Attachment.file_name`）は、アップロードの時に 1 回だけ決まる。同じ名前（大文字小文字を区別しない）が生きている添付にあれば `name (2).ext`、`name (3).ext`…（Windows 流）。後から自動では変わらない。別名は生きている添付の中で一意。名前に `[` `]` `|` は使えない（アップロードでは `_` に直す。`attachments/` への書き込みでは `403`）。既存の `[` `]` `|` を含む名前は起動時に一度だけ直す（直す前に DB を `data/backup/` に残す）
- 本文のリンク: 書き方は `[別名](attachments/名前)`・`[[attachments/名前|別名]]`（別名は省略可で `[[attachments/名前]]`）。先頭に `!` を付けた `![別名](パス)`・`![[パス]]` は埋め込み。パスは共有フォルダの中のパス。
  - 添付は本文が真実: メッセージの添付は、本文の中のリンク（`![[attachments/名前]]` など）で表す。`Message.attachments` は本文のリンクから導く（本文の順）。本文からリンクを消すと、そのメッセージから外れる（ファイルは `attachments/` に残る）。リンクを付け直すと同じ ID が戻る
  - 名前だけの `[[名前]]` / `![[名前]]`（パスに `/` を含まない）は、`attachments/` の中の名前（大文字小文字を区別しない）として読む。`attachments/` に無ければ、ただの文字（共有のパス）として残る。同じ名前が共有フォルダの直下にもあれば `400 ambiguous_link`（`attachments/名前` と書けば解決する）
  - サーバーが見るのはパスの位置だけ（`[文字](` の後は、括弧の入れ子を数えて、対にならない `)` まで。`[[` の後は、`|` か `]]` まで。`[文字]` の文字は空でなく `[` を含まない。`view::markdown` と同じ読み方）。コードのフェンス（```）とインラインのコード（`` `…` ``）の中、`\` でエスケープされた記号は、パスの位置として読まない。フェンスは引用（`>`）とリストの項目の中でも、`view::markdown` と同じ区切りで読む。`attachments/` で始まるものだけを対象にし、そのほかのパスは文字のまま
  - 送信・編集の本文では、パスを添付の ID（`disnans:file/<ID>`）に置き換えて保存する。見つからない・削除済み・書けない名前（`[` `]` `|` や改行・制御文字を含む、区切りを含む、括弧が対にならない）は `400 invalid_link`。リンクできるのは、投稿された添付・`attachments/` の中の添付・送信者自身の未投稿のアップロードだけ（ほかの利用者の未投稿は不可）。未投稿を本文に書くと、その送信（または編集）で投稿扱いになる。本文に直接書いた `disnans:file/<ID>` も同じ規則で検査する。名前が衝突するときは別名（`name (2).ext`）になる
  - 送信の `attachment_ids`（旧クライアント）は残す。サーバーが本文の末尾に `![[disnans:file/<ID>]]` を足して保存する（本文が空なら改行を入れない）。本文の長さは送られた本文で検査する（足したリンクは数えない）。編集では本文だけを見る（空の本文は `empty_message`）
  - 取得・ブロードキャスト・編集の応答の本文では、ID を今の名前に戻す（`attachments/<今の名前>`）。削除された添付は消される直前の名前。改名しても本文のリンクは切れない
  - 検索は保存された本文（ID の形）に対して行うので、ファイル名では見つからない
- 一つの添付は、複数のメッセージの本文から参照できる。`files.message_id` は最初に投稿したメッセージ（その本文が消えるまで）。どの本文からも参照されなくなった添付は `attachments/` に残る（投稿済みの生きた添付）。メッセージを消したときは、ほかの本文が参照していない添付を消す（従来どおり）。消された添付（印）は、どの本文からも外れたときに行ごと消える
- 添付の作成日時（WebDAV の `creationdate` と `modified`）は、最初に投稿された時刻（そのメッセージの作成時刻）。投稿前のアップロードは、アップロードの時刻。リンクを外しても変わらない
- 本文の添付の参照は `disnans:file/<ID>`。取得は `GET /api/files/{id}`（メッセージへの所属は見ない）。本文全体のリンクを書き換えるのではなく、保存した参照先 ID から今の別名を引く。`attachments/` 以外はパス参照のままなので、改名・移動でリンクが切れることを許容する
- クライアントの Markdown 描画と本文検索の制限は残っている（ファイル名では本文検索できない）
- 削除された添付: `attachments/` から消されると、投稿されていた添付は本体が消え、そのリンクのあるメッセージの `Attachment` に `deleted: true` が付く（`file_name` は消される直前の別名。`size` などは残る）。`GET /api/files/{id}` は `410`（code `deleted`）
- 投稿されていない直接の添付（`attachments/` の中に作ったもの）は、消されるまで残る（24時間の掃除の対象外）。だれでもメッセージに付けられる

### 共有フォルダ（`/api/shared`）

WebDAV（`/dav/`）と同じ中身・同じ規則。全員で共有する 1 つのフォルダ（`data/shared/`）。ユーザー別の領域や所有者ごとの制限、容量上限は設けない。`attachments/` は仮想フォルダで、実体は `data/files/` に ID 名で保存する。二重にコピーしない。接続とバックアップは [server README](../crates/server/README.md) を参照。

- パスは共有フォルダからの相対（`docs/a.txt`）。区切りごとに名前を検査する: `..`・区切り文字・Windows で使えない文字（`: * ? " < > |`）・予約名（CON・NUL・COM1 など）・末尾の `.` や空白・`.disnans-` で始まる名前は拒否（`403`）
- 直下の `attachments/` は添付の一覧（投稿された添付と、直接作った添付が並ぶ。`file_id` と `mime` が入り、投稿されたものは `message_id` も入る）。
  - `attachments/<名前>` への PUT は、同じ名前があればその添付（同じ ID）の中身を差し替え、なければ新しい添付にする。変換（画像は WebP、サムネイル）は通常のアップロードと同じ
  - 名前の変更（`move`、`attachments/` の中だけ）は ID と中身が同じまま。宛先が同じ名前なら `409 exists`（`overwrite: true` なら、宛先の添付を消して入れる）
  - 削除（`DELETE`）は誰でもできる（上の「削除された添付」）
  - `attachments/` と共有フォルダの間の移動は `403`（コピーを使う）。コピーは可（共有 → `attachments/` は新しい添付になる）
  - フォルダの作成・フォルダの削除・`attachments` そのものの移動は `403`
  - 同じ名前のフォルダは `attachments/` の中には作れない（中はファイルだけ）
- 書き込みは一時ファイルに書いてから差し替える（上書きでも既存の実体は書き換えない）
- シンボリックリンクは辿らず、一覧にも出さない
- 変更（作成・上書き・移動・コピー・削除）は、WebDAV でも REST でも `files.changed`（`{ path }`、変わった項目の相対パス）を全員に配信する。フォルダの一覧はその親を読み直す
- 失敗の `code`: `not_found`（404）、`forbidden`（403）、`exists`（409、同名がある）、`parent_missing`（409）、`too_large` / `insufficient_storage`、`deleted`（410、削除された添付）
- WebDAV の `DELETE /dav/` と `DELETE /dav/attachments` は `403`（フォルダごと消させない）

### プラグイン・テーマ
- ファイルは `<data_dir>/plugins/<id>/` に置く。みんなのものは誰でも配布・更新・削除できる
- 種類（`PluginInfo.type`）は manifest の `type` で決まる: `plugin`（省略時）か `theme`
- 配布: multipart のフィールド `file` にファイルを入れる
  - プラグイン: `manifest.json`・`main.js`（必須）と `styles.css`・`icon.svg`（任意）
  - テーマ: `manifest.json`・`theme.css`（必須）と `icon.svg`（任意）
  - ファイル名はパスの最後の部分で判別する（`dice/main.js` も可）。上の5つ以外のファイル名や、種類に合わないファイル（テーマの `main.js`、プラグインの `theme.css` など）は `400 invalid_file_name`、同じファイルが2つあれば `400 duplicate_file`、必須のファイルがなければ `400 missing_file`
  - テキストのフィールド `visibility` で範囲を選ぶ: `public`（みんなに配布。省略時）か `private`（自分だけ）。それ以外は `400 invalid_visibility`
  - 合計 5 MB まで。超えたら `413 plugin_too_large`
  - manifest（camelCase）: `apiVersion`（任意。このプラグインを作った本体の版。1 以上の整数。`0` は `400 invalid_manifest`。`PluginInfo.api_version` に入り、なければ `null`。本体は版が違うと警告する）、`id`（英小文字・数字・ハイフンの 2〜32 文字。不正なら `400 invalid_plugin_id`）、`type`（`plugin` か `theme`。省略すると `plugin`）、`name`・`version`（必須）、`description`・`author`（省略すると空文字）、`minApiVersion`（省略すると 1）、`icon`（任意。Lucide のアイコン名で、英小文字・数字・ハイフンの 64 文字まで。空なら省略と同じ）。読めない・足りないときは `400 invalid_manifest`
  - `PluginInfo.icon` は manifest の `icon`（なければ `null`）
  - `icon.svg` は 64 KB まで、UTF-8 で `<svg` を含むこと。満たさなければ `400 invalid_icon`。あれば `PluginInfo.has_icon` が `true`
  - 同じ `id` なら上書きする（含まれなかったファイルは消える。種類・範囲も今回の値になる）。新しいファイルを一時ディレクトリに書いてから入れ替えるので、失敗しても前のものが残る
  - ほかの人の自分だけのものと同じ `id` は `409 plugin_id_taken`（`id` はプラグインとテーマ、みんなのものと自分だけのものを通して一意）
  - `hash` はファイル名と中身の SHA-256（16進）
- 範囲（`PluginInfo.visibility` / `owner`）
  - `public`: 全員の一覧に出る。`owner` は `null`
  - `private`: 持ち主（配布した人。`owner`）の一覧にだけ出る。ほかの人には、ファイルの取得も削除も `404`（ないものと同じ）
  - 持ち主は配布し直して範囲を変えられる。みんなのものを `private` で配布し直すと、配布した人のものになる
- 削除: ファイルと一覧から消す。セッションとカードは残す（同じ ID で配布し直せば、また開ける）
- ファイルの取得: `Content-Type` は `application/json` / `application/javascript; charset=utf-8` / `text/css`（`styles.css` / `theme.css`） / `image/svg+xml`、`Cache-Control: no-cache`。クライアントは `?v=<hash>` を付けて取る
  - `icon.svg` には `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` を付ける（直接開かれてもスクリプトを動かさない）
- 配布・更新・削除のたびに `plugin.updated` / `plugin.removed` を配信する。チャットにメッセージは流さない
  - みんなのものは全員に。自分だけのものは持ち主のすべての接続にだけ
  - みんなのものを `private` で配布し直したときは、持ち主に `plugin.updated`、ほかの全員に `plugin.removed`
- セッションの作成は、プラグインの範囲を問わない。自分だけのプラグインのカードもほかの人に見えるが、ほかの人のクライアントにはそのプラグインがないので標準のカードになる

### セッションとカード
- 作成: プラグインが配布済みかは問わない（開発中のプラグインでも使える）。`plugin` の形式だけ確かめる
  - カードのメッセージ（本文は空文字、`card` 付き）をメインチャットに作り、`message.created` を全員に配信する。通知は出さない
  - `thread_id` は廃止した。付けても無視する
- `state` は任意の JSON。JSON にして 1 MB まで（超えたら `413 state_too_large`）。カードの `title` は 200 文字、`text` は 2000 文字まで（`400 invalid_card`）
- 更新: `version` が現在の値と一致しなければ `409 version_conflict`。成功すると `version` が 1 増え、`session.updated` を全員に配信する
  - `card` を指定するとカードも書き換え、`message.updated` も配信する（新しいメッセージは流さない。`edited_at` も変えない）
- カードのメッセージ
  - 編集はできない（`400 card_not_editable`）
  - 削除は作成者だけ。削除するとセッションも消える
  - リアクションはふつうのメッセージと同じ
- だれでも読み書きできる（友達同士の前提。チート対策はしない）

### プラグインからの通知
- `user_ids` の各ユーザーに `notify` を送る。自分宛ても送る。存在しないユーザーは無視し、重複は1回にまとめる
- `title` はプラグインの `name`（配布されていなければ ID）。`body` は 1〜500 文字（`400 invalid_body`）
- `session_id` を指定すると、そのカードのメッセージの `message_id` を `notify` に入れる。セッションがなければ `404 not_found`

## WebSocket

`ClientEvent` / `ServerEvent` を JSON テキストフレームでやりとりする。

- 接続直後にサーバーが `hello` を送る
- メッセージの作成・更新・削除、リアクションは**全員に**配信する
- `message.created` の `client_id` は、送信者本人の接続にだけ入れる
- `notify` は対象者にだけ送る
  - メンションされた（`<@user_id>`。タイトルは `{名前} mentioned you`）
  - メインチャットの投稿は、**投稿者以外の全員**（タイトルは送り主の名前だけ。メンション・返信に当たる人には、それぞれの文言を優先して1回だけ送る）。ボットの投稿（`notify: true`）も同じく全員に送り、タイトルはボットの名前。投稿者本人にもボットの名前で1件だけ送る。この一般の通知は再送（接続し直したときの送り直し）の対象にしない
  - 自分のメッセージに、他人が返信した（`reply_to`）
  - `POST /api/notify/sample` で自分に送った（`sample: true`。クライアントは表示中でもシステム通知を出す）
- `notify` はそのユーザーのすべての接続に送る。Android アプリは WebView とは別に、通知用の常駐サービスからも接続する
- システム通知を押すと、どの環境でもウィンドウを前面に出してチャットを表示する（Android・Web と同じ動作）。デスクトップ（Tauri の Windows・Linux）は Rust が出し、押すとウィンドウを前面に出してから、フロントに知らせる（アプリが動いているあいだだけ。終了していれば何もしない）。Android は常駐サービスが出す
- `message.send` の `silent: true`（省略は `false`）は、通知を一切送らない（配信は普通の投稿と同じ）
- 編集・削除は本人のメッセージだけ
- 古いクライアントの `message.send` に付いている `thread_id` / `start_thread` は無視し、メインチャットに入れる。`thread.create` は知らない形として `invalid_event` で断る
- プラグインの配布・更新・削除（`plugin.updated` / `plugin.removed`）と、セッションの更新（`session.updated`）は全員に配信する（自分だけのプラグイン・テーマのイベントは持ち主にだけ）
- セッションを開いている人（プレゼンス）。メモリだけで持ち、保存しない
  - `session.open { session_id }` で開く、`session.close { session_id }` で閉じる。接続が切れたときは自動で閉じる。同じ人の複数のデバイスは1人として数える
  - 開いたら、そのセッションを開いている接続（開いたばかりの接続を含む）全員に `session.presence { session_id, user_ids }` を送る。`user_ids` は開いている人のユーザー ID（重複なし・並びは ID 順）。開いた直後の一覧も同じイベントで返る。閉じた・切れたときも、残っている人の接続に送る（閉じた接続には送らない）
  - 送り先はそのセッションを開いている接続だけ。`session_id` が存在しなければ `not_found`
- `session.emit` は保存せず、送信した接続以外の全員（同じユーザーの別の接続を含む）に `session.event` として中継する。`from` は送信者のユーザー ID
  - セッションがなければ `not_found`。`name` は 1〜64 文字（`invalid_event_name`）、`payload` は JSON にして 64 KB まで（`payload_too_large`）
- 通話（みんな共通の1部屋）。参加者はサーバーがメモリ上で持つ（接続ごと。保存しない）
  - `call.join { peer, status }` で参加する（`peer` は参加者が決める英数字・`-`・`_` の 1〜64 文字、`status` は `muted` `deafened` `device`）。同じ接続で呼び直すと置き換わる。別の接続がすでに使っている `peer` は `peer_in_use`
  - `call.update { status }`（ミュートなどの更新）、`call.leave`（抜ける。接続が切れても自動で抜ける）
  - 参加・退出・更新のたびに `call.state { members }` を**全員に**配る。接続した直後も、通話中なら送る
  - `call.kick { peer }` で参加者を外す（参加者だけが送れる。自分は外せない: `invalid_kick`、いない人: `peer_not_found`）。外された接続に `call.kicked { by }` を送り、一覧から外して `call.state` を配る
  - `call.emit { name, payload }` は、参加者だけが送れ、ほかの参加者全員（自分以外）に `call.event { peer, from, name, payload }` として中継する（保存しない。`peer` は送った接続の ID でサーバーが付ける）。参加していなければ `not_in_call`。`name` は 1〜64 文字（`invalid_event_name`）、`payload` は JSON にして 64 KB まで（`payload_too_large`）。`audio` は本体の音声（`{ seq, pcm }`。16kHz モノラル Int16 PCM の base64）が使い、それ以外の名前は拡張 API（`disnans.call.emit`）のデータ。送り手ごとに量を制限していて（トークンバケット: 容量 4000・毎秒 3000 回復、1回の重さは `1 + payload の KB`）、超えた分は**エラーを返さずに捨てる**。受け手の送信待ちが 32 件を超えて詰まっているときは、その受け手には切断せずに捨てる（遅れて届くより捨てたほうがよい音声・映像のため）。ただし、符号化したイベントが 1 KB 以下の小さい通知（共有中の知らせや問い合わせなど）は 512 件まで残す。状態通知まで映像と一緒に捨てないためで、こちらも上限を超えれば切断せず間引く
- `files.changed { path }` は、共有フォルダや `attachments/` の項目が変わったとき（作成・上書き・移動・コピー・削除。WebDAV と REST のどちらでも）全員に送る。`path` は変わった項目の相対パス（`docs/a.txt`、`attachments/<別名>`）。添付がメッセージに付いたとき（`attachments/` に現れる）と、メッセージを消したとき（消える）も送る。
- `prefs.updated` は、`PUT /api/me/prefs` で設定が変わったとき、そのユーザーのすべての接続にだけ送る
- `read.updated` は、`PUT /api/me/read` で既読の位置が進んだとき、そのユーザーのすべての接続にだけ送る（`unread_count` はその時点の値）
- 失敗したら、送信者に `error` を返す
