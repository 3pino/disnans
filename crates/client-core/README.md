# disnans-client-core

GUI（Tauri）・CLI・TUI が共有するクライアント側の部品。URL の解釈、REST、WebSocket（feature `ws`）、共通ファイル（設定・下書き）、デバイスの方針、表示データ（`view`）を持つ。

## 境界（何がどこにあるか）

分担の考え方は [docs/design/architecture.md](../../docs/design/architecture.md)。

- `crates/shared`: サーバーとの型（ts-rs で TypeScript の型も作る）。
- `crates/client-core`（このクレート）: 通信・保存・デバイスの方針（`platform`）・表示データ（`view`: 行の並び、同じ人の続き、Markdown の木、メンションの取り出し）。描画・文字の幅・色は持たない。
- `crates/cli`: CLI と TUI。core を直接使い、TUI は `view` の行をターミナルの幅で描く。
- `app/src-tauri`: Tauri の薄い橋（invoke の受け口、チャットの橋、共通ファイルの橋、デバイスの情報の注入）。方針は core に置き、橋は呼ぶだけ。
- `app`（Svelte / TypeScript）: 画面、状態、Android の通知サービス（`notifier` プラグイン）。Tauri（Windows・Linux・Android）のチャットは Rust の接続を使う。ブラウザー開発版は TypeScript の WebSocket のまま。GUI の本文は Rust が作った Markdown の木を描画し、設定の正規化も core を使う。続き・日付の区切りは GUI に判定を残し、fixture で一致を保つ（[共通表示データ](../../docs/design/architecture.md#クライアントと共通表示データ)）。
- デバイスごとの方針（`platform::capabilities_for`）は core に一つだけ置く。Tauri・TUI・CLI の値はここから決まる。

## 通信の基本

- REST は `disnans_shared` の型を返す。HTTP エラーの status・code・message を保持し、画面の文言や終了コードへの変換は呼び出し側が行う。
- 接続先（URL）は GUI と CLI で同じ規則で解釈する。認証情報・query・fragment を含むものは拒否する。
- 送信の成否が分からないとき（切断・タイムアウトなど）は「成否不明」とし、自動では再送しない。
- 切断中のイベントは復元しない。再接続後に、呼び出し側が表示中の履歴を REST で取り直す。

## Storage contract

`LocalStore` methods do synchronous filesystem I/O; async callers must use a blocking context. Config and drafts live separately under platform user directories. Draft keys include normalized server URL and user ID (the main chat is the only place; threads are gone, and old thread drafts are not read). Writes are serialized across processes with OS file locks and committed through a same-directory temporary file plus atomic replacement. Missing values and explicit clears are distinct (`StoredValue::Missing` vs `StoredValue::Cleared`); clears are persisted as tombstones so legacy values cannot reappear. `import_*_if_missing` methods import legacy data only when no shared value (including a tombstone) exists. Corrupt or unknown-schema data returns an error and is not overwritten.

Linux uses XDG config/data roots (falling back to `~/.config` and `~/.local/share` if unset or non-absolute); Windows uses APPDATA/LOCALAPPDATA. Absolute `DISNANS_CLIENT_CONFIG_DIR` and `DISNANS_CLIENT_DATA_DIR` overrides support isolated tests; a present relative/empty override is an error. Newly created Unix directories/files are restricted to user-only permissions without changing permissions on existing directories. Windows relies on the user-profile directory ACL. Storage operations can fail and callers must preserve old values until a new write has succeeded.

## WebSocket client (feature `ws`)

Enable with `features = ["ws"]`. The Tauri GUI (Windows, Linux and Android), CLI and TUI use this Rust connection. Only the browser opened through `vite dev` keeps the development TypeScript WebSocket.

- `ChatConnection::connect(&server, ConnectOptions)` opens `/api/ws` (`ws://` or `wss://`). The development identity goes in the `X-Dev-User` header (visible ASCII only), never in the URL. Redirects are never followed. TLS uses the webpki root set. Frames larger than 8 MiB are rejected. The connection waits for `hello`; events before `hello` are ignored. `me()` and `users()` come from `hello`.
- `ConnectOptions::idle_timeout` (default 90 s, matching the server): if no frame arrives for this long, `next_event` returns `Disconnected` with reason `"idle timeout"`. `send_message` refuses to write once this much time has passed without the client writing anything, because the server would have dropped the connection. Pongs are only written while the connection is being read.
- `ChatConnection::send_message(body, silent, ack_timeout)` and `send_message_with_id(client_id, body, silent, ack_timeout)` send one main-chat message and return a `SendOutcome`. `new_client_id()` creates an ID you can print before sending. Only a `message.created` or `error` carrying this call's `client_id` on the same connection settles the result; errors for other IDs are ignored. `Rejected` is returned only for codes that guarantee the message was not committed (`empty_message`, `body_too_long`, `reply_not_found`, `reply_other_place`, `invalid_attachment`, `invalid_link`). Everything else after the write is `Unknown`. Messages are never resent automatically. `NotSent` means nothing was written. Other events received while waiting are discarded, so do not use the same connection as a watch.
- `ChatConnection::next_event()` is cancel-safe and returns `ServerEvent`s. Ping frames are answered internally.
- `ChatWatch::start(&server, ConnectOptions)` opens the first connection and returns its error without retrying. `next()` yields:
  - `Connected { generation, me }`: generation 1 is the first connection.
  - `Event { generation, event }`.
  - `Gap { generation, reason }`: the connection ended. Events from this point until the next `Connected` with generation 2 or more may be lost.
  - `Failed { reason, http_status }`: reconnecting stopped (HTTP 401 or 403). This is terminal, and every later `next()` returns the same `Failed`.

  After a disconnect the watch reconnects with jittered exponential backoff (1 s, doubling, capped at 30 s). The backoff resets only after a connection that lived at least 30 s. Events are not replayed.
- Refetch rules: after `Connected { generation >= 2 }`, refetch history over REST and remove overlaps by message ID. Do not refetch during a disconnect gap; the next `Connected` covers it. For `Gap { reason: "lagged" }`, refetch now. The queue is bounded at 256 items. On overflow, queued events and older connection items are dropped, and one `lagged` gap plus the newest `Connected` are kept, so the queue cannot grow without bound.
- Dropping a `ChatWatch` aborts its task. `close()` shuts it down gracefully.
- `ChatSession::start(&server, ConnectOptions)` is a reconnecting connection that both reads and sends, using one socket. It has the same receive rules as `ChatWatch` (gap, refetch, `Failed`, bounded queue), plus `WatchItem::Connecting { attempt }` before each reconnect attempt. `ChatWatch::next()` does not return `Connecting`.
- `session.sender()` returns a `SessionSender` (cloneable, concurrent sends allowed):
  - `send(client_id, body, silent, ack_timeout)`: a plain main-chat message.
  - `send_request(client_id, SendRequest { body, attachment_ids, reply_to, silent }, ack_timeout)`: all `message.send` options (main chat only; threads are gone). An empty body is allowed when there are attachments.
  - `emit(ClientEvent)`: fire-and-forget events (edit, delete, reactions, call and plugin signalling). Returns once written. `message.send` is refused with `EmitError::SendNotAllowed`.
  Sends and emits made while not connected return `NotSent` / `EmitError::NotConnected` without writing.
- `session.reconnect_now()` ends a running backoff at once and resets it to the first step. It does nothing while connected or while an attempt is in progress.
- Rejected codes are the six that the server returns before committing (`empty_message`, `body_too_long`, `reply_not_found`, `reply_other_place`, `invalid_attachment`, `invalid_link`). The server rolls back the transaction on those paths.

Both types must be used inside a Tokio runtime.
