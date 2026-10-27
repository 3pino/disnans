# disnans API: WebSocket

REST と認証・エラーは [rest.md](rest.md)。型の定義は `crates/shared/src/lib.rs`（TypeScript 版は `app/src/lib/protocol/`、自動生成）。

## 接続

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
- `message.send` の `silent: true`（省略は `false`）は、通知を一切送らない（配信は通常の投稿と同じ）
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
