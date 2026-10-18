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

/// 返信先のメッセージの要約（引用の表示用）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReplyPreview {
    pub author_id: Id,
    /// 本文の冒頭（改行を空白にして切ったもの）。添付だけなら空。
    pub body: String,
    pub has_attachments: bool,
    pub bot: Option<BotInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Message {
    pub id: Id,
    pub author_id: Id,
    /// 返信なら、返信先のメッセージの ID（メインチャットのメッセージ）。
    pub reply_to: Option<Id>,
    /// 返信先の要約。返信先が削除されていれば `null`（`reply_to` だけが残る）。
    pub reply_preview: Option<ReplyPreview>,
    /// Markdown サブセットの生テキスト。メンションは `<@user_id>`。
    pub body: String,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<Reaction>,
    pub created_at: Timestamp,
    pub edited_at: Option<Timestamp>,
    /// プラグインのセッションのカードなら入る（本文は空）。
    pub card: Option<MessageCard>,
    /// プラグインがボットとして投稿したメッセージなら入る。`author_id` は投稿を実行した人。
    pub bot: Option<BotInfo>,
}

/// ボットとして投稿したメッセージの表示名と、投稿したプラグイン。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BotInfo {
    pub plugin: String,
    pub name: String,
}

/// `POST /api/plugins/{id}/messages`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PluginPostMessage {
    pub body: String,
    /// 省略するとプラグインの表示名。
    pub name: Option<String>,
    /// `true` なら、通常の通知の宛先に加えて投稿した本人にも通知する（自分で通知の確認をするため）。
    /// 省略すると `false`（通知は一切送らない）。
    #[serde(default)]
    pub notify: bool,
}

// ---- プラグイン ----

/// パッケージの種類（manifest の `type`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PluginKind {
    /// `main.js` で動くプラグイン。
    Plugin,
    /// `theme.css` だけのテーマ（JS なし）。端末ごとに1つ選んで適用する。
    Theme,
}

/// 配布の範囲。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum PluginVisibility {
    /// みんなに配布。全員の一覧に出て、誰でも更新・削除できる。
    Public,
    /// 自分だけ。持ち主（`owner`）の一覧にだけ出て、持ち主だけが更新・削除できる。
    Private,
}

/// サーバーに配布されたプラグイン・テーマ。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PluginInfo {
    /// 英小文字・数字・ハイフン（2〜32文字）。プラグインとテーマ、みんなのものと自分だけのものを通して一意。
    pub id: String,
    /// プラグインかテーマか（manifest の `type`。省略すると `plugin`）。
    #[serde(rename = "type")]
    pub kind: PluginKind,
    pub visibility: PluginVisibility,
    /// 自分だけのものの持ち主。みんなに配布したものは `null`。
    pub owner: Option<Id>,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub min_api_version: u32,
    /// manifest の `apiVersion`（このプラグインを作った本体の版）。なければ `null`。版が違えば本体が警告する。
    pub api_version: Option<u32>,
    /// manifest の `icon`（Lucide のアイコン名、英小文字・数字・ハイフン）。なければ `null`。
    pub icon: Option<String>,
    /// `icon.svg` が配布されているか（`/api/plugins/{id}/files/icon.svg`）。
    pub has_icon: bool,
    /// 配布されているファイル名（`manifest.json` / `main.js` / `styles.css` / `theme.css` / `icon.svg`）。
    pub files: Vec<String>,
    /// ファイルの中身のハッシュ（16進）。キャッシュの区別と、更新の判定に使う。
    pub hash: String,
    pub updated_by: Id,
    pub updated_at: Timestamp,
}

/// カードに表示する内容。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Card {
    pub title: String,
    pub text: String,
}

/// メッセージに付くカード。タップすると `plugin` の view で `session_id` を開く。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MessageCard {
    pub session_id: Id,
    pub plugin: String,
    pub title: String,
    pub text: String,
}

/// プラグインの「1回分の利用」（ゲームの1局など）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Session {
    pub id: Id,
    pub plugin: String,
    /// カードのメッセージ。
    pub message_id: Id,
    pub created_by: Id,
    /// プラグインが自由に決める JSON。
    #[ts(type = "unknown")]
    pub state: serde_json::Value,
    /// 更新のたびに +1。楽観ロックに使う。
    pub version: i64,
    pub card: Card,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

/// `POST /api/sessions`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CreateSession {
    pub plugin: String,
    #[ts(type = "unknown")]
    pub state: serde_json::Value,
    pub card: Card,
}

/// `PUT /api/sessions/{id}`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UpdateSession {
    /// 読み込んだときの version。一致しなければ `409 version_conflict`。
    pub version: i64,
    #[ts(type = "unknown")]
    pub state: serde_json::Value,
    /// 指定するとカードも書き換える。
    pub card: Option<Card>,
}

/// `POST /api/plugins/{id}/notify`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PluginNotify {
    pub user_ids: Vec<Id>,
    pub body: String,
    /// 指定すると、通知から開いたときにそのカードのある場所を開く。
    pub session_id: Option<Id>,
}

/// 既読の位置と未読数（メインチャット）。`GET /api/me/read` と `read.updated` で使う。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReadMarker {
    /// ここまで読んだ位置。この ID 以下のメッセージは既読（ID の文字列の大小で比べる）。
    /// 実在するメッセージの ID とは限らない（一度も既読にしていなければ、アカウントを作った時刻の位置）。
    pub last_read_id: Id,
    /// `last_read_id` より新しい、他人のメッセージの数。
    pub unread_count: u32,
}

/// 端末の一覧の1件（`GET /api/me/devices`）。端末 ID はクライアントが決める。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DeviceInfo {
    pub device_id: String,
    pub name: String,
    pub created_at: Timestamp,
    /// 最後に設定を読み書きした時刻。
    pub last_seen_at: Timestamp,
    /// 端末の設定が保存されているか。
    pub has_prefs: bool,
}

/// `PUT /api/me/devices/{device_id}`（端末の登録と名前の変更）
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PutDevice {
    pub name: String,
}

/// 端末ごとの設定（`GET/PUT /api/me/devices/{device_id}/prefs`）。
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DevicePrefs {
    /// JSON オブジェクト。中身はクライアントが決める。
    #[ts(type = "unknown")]
    pub prefs: serde_json::Value,
    pub updated_at: Timestamp,
}

/// `PUT /api/me/devices/{device_id}/prefs`（まるごと置き換え）
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PutDevicePrefs {
    /// JSON オブジェクト。
    #[ts(type = "unknown")]
    pub prefs: serde_json::Value,
}

/// `PUT /api/me/read`
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MarkRead {
    /// ここまで読んだメッセージの ID。いまの位置より古ければ何もしない（戻らない）。
    pub message_id: Id,
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

/// 通話の参加者（接続）が自分で知らせる状態。サーバーは中身を解釈せずに保存して配る。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallStatus {
    /// マイクをミュートしている。
    pub muted: bool,
    /// スピーカーミュート（相手の声を消している）。
    pub deafened: bool,
    /// 端末の種類（smartphone / tablet / laptop / monitor）。
    #[serde(default)]
    pub device: Option<String>,
}

/// 通話にいる接続1つ分。同じ人が2台で入れば2つ。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CallMember {
    /// 参加者が決める接続の ID（シグナリングの宛先に使う）。
    pub peer: String,
    pub user_id: Id,
    pub status: CallStatus,
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
        body: String,
        /// 事前に `POST /api/files` でアップロードした添付ファイルの ID。
        attachment_ids: Vec<Id>,
        /// 返信先のメッセージ ID。メインチャットのメッセージだけ指定できる。
        #[serde(default)]
        reply_to: Option<Id>,
        /// `true` なら通知を送らない。
        #[serde(default)]
        silent: bool,
    },
    #[serde(rename = "message.edit")]
    MessageEdit { message_id: Id, body: String },
    #[serde(rename = "message.delete")]
    MessageDelete { message_id: Id },
    #[serde(rename = "reaction.add")]
    ReactionAdd { message_id: Id, emoji: String },
    #[serde(rename = "reaction.remove")]
    ReactionRemove { message_id: Id, emoji: String },
    /// セッションの一時的なイベント（保存しない）。送信者以外の全員に中継する。
    #[serde(rename = "session.emit")]
    SessionEmit {
        session_id: Id,
        name: String,
        #[ts(type = "unknown")]
        payload: serde_json::Value,
    },
    /// セッションを開いた（画面に出している）ことを知らせる。返事として `session.presence` が届く。
    #[serde(rename = "session.open")]
    SessionOpen { session_id: Id },
    /// セッションを閉じた。接続が切れたときも自動で閉じる。
    #[serde(rename = "session.close")]
    SessionClose { session_id: Id },
    /// プラグインの一時的なイベント（保存しない・セッションに紐づかない）。送信した接続以外の全員に中継する。
    #[serde(rename = "plugin.emit")]
    PluginEmit {
        plugin: String,
        name: String,
        #[ts(type = "unknown")]
        payload: serde_json::Value,
    },
    /// 通話に参加する（この接続が参加者になる）。入り直すときは同じ接続で呼べば置き換わる。
    #[serde(rename = "call.join")]
    CallJoin { peer: String, status: CallStatus },
    /// 通話から抜ける。接続が切れたときも自動で抜ける。
    #[serde(rename = "call.leave")]
    CallLeave,
    /// 通話での自分の状態（ミュートなど）を更新する。
    #[serde(rename = "call.update")]
    CallUpdate { status: CallStatus },
    /// 通話の参加者を通話から外す（`peer` は外す接続の ID）。外された接続には `call.kicked` が届く。
    #[serde(rename = "call.kick")]
    CallKick { peer: String },
    /// 通話のシグナリング・音声を、ほかの参加者全員に中継する（保存しない）。参加者だけが送れる。
    #[serde(rename = "call.emit")]
    CallEmit {
        name: String,
        #[ts(type = "unknown")]
        payload: serde_json::Value,
    },
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
    MessageDeleted { message_id: Id },
    #[serde(rename = "reaction.updated")]
    ReactionUpdated {
        message_id: Id,
        reactions: Vec<Reaction>,
    },
    #[serde(rename = "user.updated")]
    UserUpdated { user: User },
    /// 自分宛ての通知（メンション、返信、全体向けの投稿など）。
    #[serde(rename = "notify")]
    Notify {
        title: String,
        body: String,
        message_id: Option<Id>,
        /// 「サンプル通知を送信」で送ったもの。アプリを表示中でもシステム通知を出す。
        sample: bool,
        /// 接続が切れていた間の通知を、接続し直したときに再送したもの（直近の分だけ）。
        /// 受け取るクライアントは、表示済みかどうかを message_id で確かめてから出すこと。
        #[serde(default)]
        replayed: bool,
    },
    /// プラグイン・テーマが配布・更新された。自分だけのものは持ち主にだけ届く。
    #[serde(rename = "plugin.updated")]
    PluginUpdated { plugin: PluginInfo },
    /// プラグイン・テーマが削除された（自分だけのものになって見えなくなったときも）。
    #[serde(rename = "plugin.removed")]
    PluginRemoved { plugin_id: String },
    /// セッションの state（とカード）が更新された。
    #[serde(rename = "session.updated")]
    SessionUpdated { session: Session },
    /// セッションを開いている人の一覧（同じ人の複数の端末は1人）。そのセッションを開いている接続にだけ、変わるたびに送る。
    #[serde(rename = "session.presence")]
    SessionPresence { session_id: Id, user_ids: Vec<Id> },
    /// `session.emit` の中継。
    #[serde(rename = "session.event")]
    SessionEvent {
        session_id: Id,
        from: Id,
        name: String,
        #[ts(type = "unknown")]
        payload: serde_json::Value,
    },
    /// `plugin.emit` の中継。
    #[serde(rename = "plugin.event")]
    PluginEvent {
        plugin: String,
        from: Id,
        name: String,
        #[ts(type = "unknown")]
        payload: serde_json::Value,
    },
    /// 通話の参加者の一覧。参加・退出・状態の更新のたびに全員へ送る（接続直後は、通話中なら送る）。
    #[serde(rename = "call.state")]
    CallState { members: Vec<CallMember> },
    /// `call.emit` の中継（参加者にだけ届く）。
    #[serde(rename = "call.event")]
    CallEvent {
        /// 送った接続の ID（サーバーが付ける）。
        peer: String,
        from: Id,
        name: String,
        #[ts(type = "unknown")]
        payload: serde_json::Value,
    },
    /// 自分が通話から外された。
    #[serde(rename = "call.kicked")]
    CallKicked { by: Id },
    /// 自分の設定（`/api/me/prefs`）が変わった。同じユーザーのすべての接続に届く。
    #[serde(rename = "prefs.updated")]
    PrefsUpdated {
        #[ts(type = "Record<string, unknown>")]
        prefs: serde_json::Value,
    },
    /// 自分の既読の位置が変わった（別の端末で読んだときも）。自分のすべての接続に送る。
    #[serde(rename = "read.updated")]
    ReadUpdated { marker: ReadMarker },
    #[serde(rename = "error")]
    Error {
        client_id: Option<String>,
        code: String,
        message: String,
    },
    #[serde(rename = "pong")]
    Pong,
}
