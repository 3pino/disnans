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
| GET | `/api/users` | メンバー一覧 | `User[]` |
| GET | `/api/messages?thread_id=&before=&limit=` | メッセージ履歴 | `Message[]` |
| GET | `/api/threads` | スレッド一覧 | `Thread[]` |
| GET | `/api/threads/{id}` | スレッド1件 | `Thread` |
| POST | `/api/files` | ファイルのアップロード（multipart、フィールド名 `file`） | `Attachment` |
| GET | `/api/files/{id}` | ファイル本体 | バイナリ |
| GET | `/api/files/{id}/thumb` | サムネイル（WebP） | バイナリ |
| POST | `/api/notify/sample` | 自分にサンプルの `notify` を送る（通知の動作確認用）。送り先は、リクエストと同じ IP アドレス（端末）からの接続だけ | `204` |
| GET | `/api/plugins` | 配布されたプラグインの一覧（ID 順） | `PluginInfo[]` |
| POST | `/api/plugins` | プラグインの配布・更新（multipart、フィールド名 `file` を複数） | `PluginInfo` |
| DELETE | `/api/plugins/{id}` | プラグインの削除 | `204` |
| GET | `/api/plugins/{id}/files/{name}` | 配布されたファイル（`manifest.json` / `main.js` / `styles.css`） | ファイル本体 |
| POST | `/api/plugins/{id}/notify` | プラグインから通知を送る（body: `PluginNotify`） | `204` |
| POST | `/api/sessions` | セッションを作り、カードを流す（body: `CreateSession`） | `Session` |
| GET | `/api/sessions/{id}` | セッション1件 | `Session` |
| PUT | `/api/sessions/{id}` | セッションの更新（body: `UpdateSession`） | `Session` |
| GET | `/api/ws` | WebSocket | — |

### メッセージ履歴
- `thread_id` を省略するとメインチャット、指定するとそのスレッドの返信（起点のメッセージは含まない）
- `before`（メッセージ ID）より古いものを、新しい順に最大 `limit` 件（既定 50、最大 200）取り、**古い順に並べて**返す

### スレッド一覧
- スレッドに種類はない。クエリ文字列は受け取らない（付いていても無視する）
- 最後に動きがあった順（`last_reply_at`、なければ起点の `created_at`）の降順

### ファイル
- 上限なし（サーバー側でストリーミングして保存する）
- 静止画（JPEG / PNG / WebP など）は WebP（品質 85、長辺最大 2560px）に変換し、EXIF を削除する（回転は反映する）。元画像は残さない
- 長辺 480px のサムネイルを作る
- アニメーション GIF / WebP は変換せずそのまま保存する
- 投稿されていないファイルは、一定時間（24時間）後に削除してよい

### プラグイン（SPEC 9.2, 9.6）
- ファイルは `<data_dir>/plugins/<id>/` に置く。誰でも配布・更新・削除できる
- 配布: multipart のフィールド `file` に、ファイル名 `manifest.json`・`main.js`（必須）と `styles.css`（任意）を入れる
  - ファイル名はパスの最後の部分で判別する（`dice/main.js` も可）。それ以外のファイル名は `400 invalid_file_name`、同じファイルが2つあれば `400 duplicate_file`、必須のファイルがなければ `400 missing_file`
  - 合計 5 MB まで。超えたら `413 plugin_too_large`
  - manifest（camelCase）: `id`（英小文字・数字・ハイフンの 2〜32 文字。不正なら `400 invalid_plugin_id`）、`name`・`version`（必須）、`description`・`author`（省略すると空文字）、`minApiVersion`（省略すると 1）。読めない・足りないときは `400 invalid_manifest`
  - 同じ `id` なら上書きする（含まれなかったファイルは消える）。新しいファイルを一時ディレクトリに書いてから入れ替えるので、失敗しても前のものが残る
  - `hash` はファイル名と中身の SHA-256（16進）
- 削除: ファイルと一覧から消す。セッションとカードは残す（同じ ID で配布し直せば、また開ける）
- ファイルの取得: `Content-Type` は `application/json` / `application/javascript; charset=utf-8` / `text/css`、`Cache-Control: no-cache`。クライアントは `?v=<hash>` を付けて取る
- 配布・更新・削除のたびに、全員に `plugin.updated` / `plugin.removed` を配信し、操作した人の名前でメインチャットにメッセージを流す
  - 「プラグイン「ダイス」v1.0.0 を配布しました」
  - 「プラグイン「ダイス」を更新しました（v1.0.0 → v1.1.0）」（バージョンが同じなら「プラグイン「ダイス」v1.0.0 を更新しました」）
  - 「プラグイン「ダイス」を削除しました」

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
  - `POST /api/notify/sample` で自分に送った（`sample: true`。クライアントは表示中でもシステム通知を出す）
- `notify` はそのユーザーのすべての接続に送る。Android アプリは WebView とは別に、通知用の常駐サービスからも接続する
- スレッドは `thread.create`（既存のメッセージを起点にする）か、`message.send` の `start_thread: true`（送信と同時に起点にする）で作る。スレッドの中の返信からは作れない
- 編集・削除は本人のメッセージだけ。スレッドの起点を削除すると、スレッドの返信もすべて削除する
- プラグインの配布・更新・削除（`plugin.updated` / `plugin.removed`）と、セッションの更新（`session.updated`）は全員に配信する
- `session.emit` は保存せず、送信した接続以外の全員（同じユーザーの別の接続を含む）に `session.event` として中継する。`from` は送信者のユーザー ID
  - セッションがなければ `not_found`。`name` は 1〜64 文字（`invalid_event_name`）、`payload` は JSON にして 64 KB まで（`payload_too_large`）
- 失敗したら、送信者に `error` を返す
