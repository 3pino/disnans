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
| GET | `/api/threads?kind=` | スレッド一覧 | `Thread[]` |
| GET | `/api/threads/{id}` | スレッド1件 | `Thread` |
| POST | `/api/files` | ファイルのアップロード（multipart、フィールド名 `file`） | `Attachment` |
| GET | `/api/files/{id}` | ファイル本体 | バイナリ |
| GET | `/api/files/{id}/thumb` | サムネイル（WebP） | バイナリ |
| GET | `/api/ws` | WebSocket | — |

### メッセージ履歴
- `thread_id` を省略するとメインチャット、指定するとそのスレッドの返信（起点のメッセージは含まない）
- `before`（メッセージ ID）より古いものを、新しい順に最大 `limit` 件（既定 50、最大 200）取り、**古い順に並べて**返す

### スレッド一覧
- `kind` は `normal` / `status`。省略時はすべて
- 最後に動きがあった順（`last_reply_at`、なければ起点の `created_at`）の降順

### ファイル
- 上限なし（サーバー側でストリーミングして保存する）
- 静止画（JPEG / PNG / WebP など）は WebP（品質 85、長辺最大 2560px）に変換し、EXIF を削除する（回転は反映する）。元画像は残さない
- 長辺 480px のサムネイルを作る
- アニメーション GIF / WebP は変換せずそのまま保存する
- 投稿されていないファイルは、一定時間（24時間）後に削除してよい

## WebSocket

`ClientEvent` / `ServerEvent` を JSON テキストフレームでやりとりする。

- 接続直後にサーバーが `hello` を送る
- メッセージの作成・更新・削除、リアクション、スレッドの変化は**全員に**配信する
- `message.created` の `client_id` は、送信者本人の接続にだけ入れる
- `notify` は対象者にだけ送る
  - メンションされた（`<@user_id>`）
  - 自分が起点のスレッド、または自分が返信したスレッドに、他人が返信した
- 編集・削除は本人のメッセージだけ。スレッドの起点を削除すると、スレッドの返信もすべて削除する
- 失敗したら、送信者に `error` を返す
