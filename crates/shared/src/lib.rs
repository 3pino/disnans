//! サーバーとクライアントで共有する API の型定義。
//!
//! `cargo test -p disnans-shared` を実行すると、TypeScript の型が
//! `app/src/lib/protocol/` に書き出される（ts-rs）。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// ULID 文字列。
pub type Id = String;

/// Unix 時刻（ミリ秒）。
pub type Timestamp = i64;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct User {
    pub id: Id,
    /// Tailscale のログイン名（例: `alice@github`）。アカウントの識別に使う。
    pub login_name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub created_at: Timestamp,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Attachment {
    pub id: Id,
    pub file_name: String,
    pub mime: String,
    pub size: u64,
    /// 画像のときだけ入る。
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// サムネイル（`/api/files/{id}/thumb`）があるか。
    pub has_thumb: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Reaction {
    pub emoji: String,
    pub user_ids: Vec<Id>,
}

/// スレッドの情報。スレッドの ID は起点のメッセージの ID と同じ。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ThreadInfo {
    pub reply_count: u32,
    pub last_reply_at: Option<Timestamp>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Message {
    pub id: Id,
    pub author_id: Id,
    /// スレッド内の返信なら、そのスレッド（起点のメッセージ）の ID。メインチャットなら `null`。
    pub thread_id: Option<Id>,
    /// Markdown サブセットの生テキスト。メンションは `<@user_id>`。
    pub body: String,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<Reaction>,
    pub created_at: Timestamp,
    pub edited_at: Option<Timestamp>,
    /// このメッセージがスレッドの起点なら入る。
    pub thread: Option<ThreadInfo>,
}

/// スレッド一覧の1件。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Thread {
    pub root: Message,
    pub info: ThreadInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateMe {
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

/// クライアント → サーバー（WebSocket）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum ClientEvent {
    #[serde(rename = "message.send")]
    MessageSend {
        /// 仮表示と確定したメッセージを突き合わせるための、クライアントが決める ID。
        client_id: String,
        thread_id: Option<Id>,
        body: String,
        /// 事前に `POST /api/files` でアップロードした添付ファイルの ID。
        attachment_ids: Vec<Id>,
        /// `true` なら、このメッセージを起点にスレッドを作る。
        start_thread: bool,
    },
    #[serde(rename = "message.edit")]
    MessageEdit { message_id: Id, body: String },
    #[serde(rename = "message.delete")]
    MessageDelete { message_id: Id },
    #[serde(rename = "thread.create")]
    ThreadCreate { root_message_id: Id },
    #[serde(rename = "reaction.add")]
    ReactionAdd { message_id: Id, emoji: String },
    #[serde(rename = "reaction.remove")]
    ReactionRemove { message_id: Id, emoji: String },
    #[serde(rename = "ping")]
    Ping,
}

/// サーバー → クライアント（WebSocket）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export)]
pub enum ServerEvent {
    /// 接続直後に1回送る。
    #[serde(rename = "hello")]
    Hello { me: User, users: Vec<User> },
    #[serde(rename = "message.created")]
    MessageCreated {
        /// 送信者本人にだけ入る。
        client_id: Option<String>,
        message: Message,
    },
    #[serde(rename = "message.updated")]
    MessageUpdated { message: Message },
    #[serde(rename = "message.deleted")]
    MessageDeleted {
        message_id: Id,
        thread_id: Option<Id>,
    },
    /// スレッドが作られた、または返信数などが変わった。
    #[serde(rename = "thread.updated")]
    ThreadUpdated { thread: Thread },
    #[serde(rename = "reaction.updated")]
    ReactionUpdated {
        message_id: Id,
        reactions: Vec<Reaction>,
    },
    #[serde(rename = "user.updated")]
    UserUpdated { user: User },
    /// 自分宛ての通知（メンション、スレッドへの返信など）。
    #[serde(rename = "notify")]
    Notify {
        title: String,
        body: String,
        message_id: Option<Id>,
        thread_id: Option<Id>,
        /// 「サンプル通知を送信」で送ったもの。アプリを表示中でもシステム通知を出す。
        sample: bool,
    },
    #[serde(rename = "error")]
    Error {
        client_id: Option<String>,
        code: String,
        message: String,
    },
    #[serde(rename = "pong")]
    Pong,
}
