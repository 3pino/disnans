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

## REST

| メソッド | パス | 内容 | レスポンス |
|---|---|---|---|
| GET | `/api/me` | 自分 | `User` |
| PATCH | `/api/me` | 表示名の変更（body: `UpdateMe`） | `User` |
| PUT | `/api/me/avatar` | アバターの設定（multipart、フィールド名 `file`） | `User` |
| DELETE | `/api/me/avatar` | 自分で設定したアバターを消し、Tailscale のプロフィール画像に戻す | `User` |
| GET | `/api/me/read` | 自分の既読の位置と未読数（メインチャットが先頭、続いてすべてのスレッド） | `ReadMarker[]` |
| PUT | `/api/me/read` | 既読の位置を進める（body: `MarkRead`） | `ReadMarker` |
| GET | `/api/me/prefs` | 自分の設定（ショートカット・Enter キーの動作など。まだなければ `{}`） | JSON オブジェクト |
| PUT | `/api/me/prefs` | 自分の設定をまるごと置き換える（body: JSON オブジェクト） | JSON オブジェクト |
| GET | `/api/users` | メンバー一覧 | `User[]` |
| GET | `/api/avatars/{id}` | 自分で設定したアバターの画像（WebP） | バイナリ |
| GET | `/api/messages?thread_id=&before=&limit=` | メッセージ履歴 | `Message[]` |
| GET | `/api/threads` | スレッド一覧 | `Thread[]` |
| GET | `/api/threads/{id}` | スレッド1件 | `Thread` |
| PATCH | `/api/threads/{id}` | タイトル・アーカイブを変える（body: `UpdateThread` = `{ title?, archived? }`。指定した項目だけ変わる）。**スレッドを立てた人だけ**（他人は `403 forbidden`）。`title` は前後の空白を除いて100文字まで（`title_too_long`）、空文字なら消す | `Thread` |
| PUT | `/api/threads/{id}/tags` | タグをまるごと置き換える（body: `SetThreadTags` = `{ tags: ThreadTag[] }`）。**誰でもできる** | `Thread` |
| GET | `/api/thread-tags` | すでに使われているタグと、使っているスレッドの数（多い順） | `ThreadTagUsage[]` |
| POST | `/api/files` | ファイルのアップロード（multipart、フィールド名 `file`） | `Attachment` |
| GET | `/api/files/{id}` | ファイル本体 | バイナリ |
| GET | `/api/files/{id}/thumb` | サムネイル（WebP） | バイナリ |
| POST | `/api/notify/sample` | 自分にサンプルの `notify` を送る（通知の動作確認用）。送り先は、リクエストと同じ IP アドレス（端末）からの接続だけ | `204` |
| GET | `/api/plugins` | 自分に見えるプラグイン・テーマの一覧（みんなのものと自分だけのもの。ID 順） | `PluginInfo[]` |
| POST | `/api/plugins` | プラグイン・テーマの配布・更新（multipart、フィールド名 `file` を複数、`visibility`） | `PluginInfo` |
| DELETE | `/api/plugins/{id}` | プラグイン・テーマの削除 | `204` |
| GET | `/api/plugins/{id}/files/{name}` | 配布されたファイル（`manifest.json` / `main.js` / `styles.css` / `theme.css` / `icon.svg`） | ファイル本体 |
| POST | `/api/plugins/{id}/notify` | プラグインから通知を送る（body: `PluginNotify`） | `204` |
| POST | `/api/plugins/{id}/messages` | プラグインがボットとしてメッセージを投稿する（body: `PluginPostMessage` = `{ thread_id?, body, name?, notify? }`）。`author_id` は呼び出した人で、`bot: { plugin, name }` が付く。`name` は前後の空白を除いて40文字まで（省略するとプラグインの名前）。本文の検査は通常のメッセージと同じ。プラグインがない（見えない）と `404`、スレッドがないと `404 thread_not_found`。配信は通常の投稿と同じ（`message.created`）。通知は `notify: true` のときだけ送る（v6。省略は `false` で、通知は一切送らない）。`true` なら通常の宛先（メンション・スレッドの参加者）に加えて投稿した本人にも送り、文言はボットの名前で作る（`{名前} からのメッセージ`、`{名前} さんからのメンション` など）。ボットのメッセージの編集は `bot_not_editable` | `Message` |
| POST | `/api/sessions` | セッションを作り、カードを流す（body: `CreateSession`） | `Session` |
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
- ユーザーごとに1つの JSON オブジェクトを保存し、同じユーザーの端末どうしで共有する。中身はクライアントが決める（サーバーは形と大きさだけを確かめる）
  - いまの中身: `hotkeys`（コマンド ID → `"Mod+Shift+D"` 形式のショートカット。空文字列は「なし」、項目がなければ既定）、`enterKeys`（`enter` / `shift` / `ctrl` / `alt` → `"send"` / `"newline"` / `"none"`）
- オブジェクトでなければ `400 invalid_prefs`、JSON にして 64 KB を超えたら `413 prefs_too_large`
- 保存したら、そのユーザーのすべての接続に `prefs.updated` を送る（保存した端末にも届く）

### メッセージ履歴
- `thread_id` を省略するとメインチャット、指定するとそのスレッドの返信（起点のメッセージは含まない）
- `before`（メッセージ ID）より古いものを、新しい順に最大 `limit` 件（既定 50、最大 200）取り、**古い順に並べて**返す

### 既読の位置と未読数
- 場所（メインチャットかスレッド1つ）ごとに、ユーザーの「ここまで読んだ位置」（メッセージ ID）を保存する。ID（ULID）の文字列の大小で前後を比べ、位置以下の ID のメッセージを既読とみなす
- `unread_count` は、位置より新しい他人のメッセージの数（自分のメッセージと削除されたメッセージは数えない）
- 一度も既読にしていない場所の位置は、アカウントを作った時刻の位置（実在するメッセージの ID ではない）。それより前のメッセージは未読にしない
- マイグレーション 0008 を当てた時点のメッセージは、全員について既読にする
- `PUT` は位置を進めるだけで、戻さない（古い ID なら何もせず、いまの位置を返す）
  - `message_id` が ULID の形でなければ `400 invalid_message_id`、スレッドがなければ `404 not_found`
  - 位置が進んだら、自分のすべての接続（送った端末を含む）に `read.updated` を送る
- スレッドの起点を削除すると、そのスレッドの位置も消える

### スレッドのタイトル・タグ・アーカイブ
- `ThreadInfo`（`Message.thread` と `Thread.info`）に `created_by`（スレッドを立てた人）・`title`（なければ `null`）・`tags`（表示の順）・`archived` が入る。`created_by` は、`thread.create` を送った人、または `start_thread: true` で送った人
- `ThreadTag` は `{ label, icon }`。`label` は前後の空白を除いて1〜24文字（絵文字も可）、`icon` は Lucide のアイコン名（英小文字・数字・ハイフン、48文字まで）か `null`。同じ（label, icon）の重複は1つにまとめる。10個まで（`too_many_tags`）。不正なら `400 invalid_tag`
- 変更すると、起点のメッセージの `message.updated` と `thread.updated` を全員に配信する
- アーカイブされたスレッドにも、ふつうに返信できる（一覧での見せ方をクライアントが変えるだけ）
- マイグレーション 0010: `threads` に `created_by` / `title` / `archived`、`thread_tags` テーブルを追加（既存のスレッドの `created_by` は起点の投稿者）

### 返信
- `message.send` の `reply_to`（省略は `null`）に返信先のメッセージ ID を入れる。返信先は**同じ場所**（`thread_id` が同じ。スレッドの中なら、そのスレッドの起点のメッセージも可）のメッセージだけ。なければ `reply_not_found`、場所が違うと `reply_other_place`
- `Message.reply_to` に返信先の ID、`Message.reply_preview` に要約（`author_id`・本文の冒頭100文字・`has_attachments`・`bot`）が入る。返信先が削除されると `reply_preview` は `null` になり、`reply_to` は残る（外部キーなし。クライアントは「削除されたメッセージ」と表示する）。要約は読み込みのたびにその時点の内容で作る（編集に追従する）
- 返信先の作者に通知を送る（`{名前} さんが返信`。自分自身・すでにメンション等で通知する人には送らない）

### スレッド一覧
- スレッドに種類はない。クエリ文字列は受け取らない（付いていても無視する）
- 最後に動きがあった順（`last_reply_at`、なければ起点の `created_at`）の降順

### ファイル
- 上限なし（サーバー側でストリーミングして保存する）
- 静止画（JPEG / PNG / WebP など）は WebP（品質 85、長辺最大 800px（`DISNANS_IMAGE_MAX_EDGE` で変更））に変換し、EXIF を削除する（回転は反映する）。元画像は残さない
- 長辺 480px のサムネイルを作る
- アニメーション GIF / WebP は変換せずそのまま保存する
- 投稿されていないファイルは、一定時間（24時間）後に削除してよい

### プラグイン・テーマ（SPEC 9.2, 9.6, 9.10）
- ファイルは `<data_dir>/plugins/<id>/` に置く。みんなのものは誰でも配布・更新・削除できる
- 種類（`PluginInfo.type`）は manifest の `type` で決まる: `plugin`（省略時）か `theme`
- 配布: multipart のフィールド `file` にファイルを入れる
  - プラグイン: `manifest.json`・`main.js`（必須）と `styles.css`・`icon.svg`（任意）
  - テーマ: `manifest.json`・`theme.css`（必須）と `icon.svg`（任意）
  - ファイル名はパスの最後の部分で判別する（`dice/main.js` も可）。上の5つ以外のファイル名や、種類に合わないファイル（テーマの `main.js`、プラグインの `theme.css` など）は `400 invalid_file_name`、同じファイルが2つあれば `400 duplicate_file`、必須のファイルがなければ `400 missing_file`
  - テキストのフィールド `visibility` で範囲を選ぶ: `public`（みんなに配布。省略時）か `private`（自分だけ）。それ以外は `400 invalid_visibility`
  - 合計 5 MB まで。超えたら `413 plugin_too_large`
  - manifest（camelCase）: `id`（英小文字・数字・ハイフンの 2〜32 文字。不正なら `400 invalid_plugin_id`）、`type`（`plugin` か `theme`。省略すると `plugin`）、`name`・`version`（必須）、`description`・`author`（省略すると空文字）、`minApiVersion`（省略すると 1）、`icon`（任意。Lucide のアイコン名で、英小文字・数字・ハイフンの 64 文字まで。空なら省略と同じ）。読めない・足りないときは `400 invalid_manifest`
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

### セッションとカード（SPEC 9.5）
- 作成: プラグインが配布済みかは問わない（開発中のプラグインでも使える）。`plugin` の形式だけ確かめる
  - カードのメッセージ（本文は空文字、`card` 付き）を `thread_id` のスレッド（`null` ならメインチャット）に作り、`message.created` を全員に配信する（スレッドなら `thread.updated` も）。通知は出さない
  - スレッドがなければ `404 thread_not_found`
- `state` は任意の JSON。JSON にして 1 MB まで（超えたら `413 state_too_large`）。カードの `title` は 200 文字、`text` は 2000 文字まで（`400 invalid_card`）
- 更新: `version` が現在の値と一致しなければ `409 version_conflict`。成功すると `version` が 1 増え、`session.updated` を全員に配信する
  - `card` を指定するとカードも書き換え、`message.updated` も配信する（新しいメッセージは流さない。`edited_at` も変えない）
- カードのメッセージ
  - 編集はできない（`400 card_not_editable`）
  - 削除は作成者だけ。削除するとセッションも消える
  - リアクションやスレッドはふつうのメッセージと同じ
- だれでも読み書きできる（友達同士の前提。チート対策はしない）

### プラグインからの通知
- `user_ids` の各ユーザーに `notify` を送る。自分宛ても送る。存在しないユーザーは無視し、重複は1回にまとめる
- `title` はプラグインの `name`（配布されていなければ ID）。`body` は 1〜500 文字（`400 invalid_body`）
- `session_id` を指定すると、そのカードのメッセージの `message_id` / `thread_id` を `notify` に入れる。セッションがなければ `404 not_found`

## WebSocket

`ClientEvent` / `ServerEvent` を JSON テキストフレームでやりとりする。

- 接続直後にサーバーが `hello` を送る
- メッセージの作成・更新・削除、リアクション、スレッドの変化は**全員に**配信する
- `message.created` の `client_id` は、送信者本人の接続にだけ入れる
- `notify` は対象者にだけ送る
  - メンションされた（`<@user_id>`）
  - 自分が起点のスレッド、または自分が返信したスレッドに、他人が返信した
  - 自分のメッセージに、他人が返信した（`reply_to`）
  - `POST /api/notify/sample` で自分に送った（`sample: true`。クライアントは表示中でもシステム通知を出す）
- `notify` はそのユーザーのすべての接続に送る。Android アプリは WebView とは別に、通知用の常駐サービスからも接続する
- `message.send` の `silent: true`（省略は `false`）は、通知を一切送らない（配信は普通の投稿と同じ）
- スレッドは `thread.create`（既存のメッセージを起点にする）か、`message.send` の `start_thread: true`（送信と同時に起点にする）で作る。スレッドの中の返信からは作れない
- 編集・削除は本人のメッセージだけ。スレッドの起点を削除すると、スレッドの返信もすべて削除する
- プラグインの配布・更新・削除（`plugin.updated` / `plugin.removed`）と、セッションの更新（`session.updated`）は全員に配信する（自分だけのプラグイン・テーマのイベントは持ち主にだけ）
- `session.emit` は保存せず、送信した接続以外の全員（同じユーザーの別の接続を含む）に `session.event` として中継する。`from` は送信者のユーザー ID
  - セッションがなければ `not_found`。`name` は 1〜64 文字（`invalid_event_name`）、`payload` は JSON にして 64 KB まで（`payload_too_large`）
- 通話（みんな共通の1部屋。SPEC 9.11）。参加者はサーバーがメモリ上で持つ（接続ごと。保存しない）
  - `call.join { peer, status }` で参加する（`peer` は参加者が決める英数字・`-`・`_` の 1〜64 文字、`status` は `muted` `deafened` `rtc` `device`）。同じ接続で呼び直すと置き換わる。別の接続がすでに使っている `peer` は `peer_in_use`
  - `call.update { status }`（ミュートなどの更新）、`call.leave`（抜ける。接続が切れても自動で抜ける）
  - 参加・退出・更新のたびに `call.state { members }` を**全員に**配る。接続した直後も、通話中なら送る
  - `call.kick { peer }` で参加者を外す（参加者だけが送れる。自分は外せない: `invalid_kick`、いない人: `peer_not_found`）。外された接続に `call.kicked { by }` を送り、一覧から外して `call.state` を配る
  - `call.emit { name, payload }` は、参加者だけが送れ、ほかの参加者全員に `call.event { peer, from, name, payload }` として中継する（保存しない。`peer` は送った接続の ID でサーバーが付ける）。参加していなければ `not_in_call`。`name` と `payload` の制限は `session.emit` と同じ。使っている `name` は `signal`（WebRTC のシグナリング）と `audio`（WebRTC を使えない相手向けの音声）
- `prefs.updated` は、`PUT /api/me/prefs` で設定が変わったとき、そのユーザーのすべての接続にだけ送る
- `read.updated` は、`PUT /api/me/read` で既読の位置が進んだとき、そのユーザーのすべての接続にだけ送る（`unread_count` はその時点の値）
- 失敗したら、送信者に `error` を返す
