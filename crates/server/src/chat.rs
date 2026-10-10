//! メッセージ・スレッド・リアクションの操作。
//!
//! WebSocket の `ClientEvent` から呼ばれる。DB を書き換えたあと、結果を全員に配信し、
//! 必要なら通知を送る。

use disnans_shared::{Id, Message, PluginInfo, PluginPostMessage, ServerEvent, User};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::files;
use crate::hub::ConnId;
use crate::notify;
use crate::state::AppState;
use crate::store::messages::{self, MessageRow};
use crate::store::{files as file_store, sessions, users};

/// 本文の最大文字数。
const MAX_BODY_CHARS: usize = 10_000;
/// ボットの表示名の最大文字数。
const MAX_BOT_NAME_CHARS: usize = 40;
/// リアクションの絵文字の最大文字数（合字の絵文字は複数の文字からなる）。
const MAX_EMOJI_CHARS: usize = 32;

/// 操作をした人と、その接続。
pub struct Actor<'a> {
    pub user: &'a User,
    pub conn: Option<ConnId>,
}

pub struct SendMessage {
    pub client_id: String,
    pub thread_id: Option<Id>,
    pub body: String,
    pub attachment_ids: Vec<Id>,
    /// `true` なら、このメッセージを起点にスレッドを作る。
    pub start_thread: bool,
}

pub async fn send_message(state: &AppState, actor: &Actor<'_>, req: SendMessage) -> AppResult<()> {
    let mut attachment_ids = req.attachment_ids;
    dedup_keep_order(&mut attachment_ids);
    validate_body(&req.body, !attachment_ids.is_empty())?;

    let _guard = state.write_lock().await;

    if let Some(thread_id) = &req.thread_id {
        if req.start_thread {
            return Err(nested_thread());
        }
        ensure_thread_exists(state, thread_id).await?;
    }

    let row = new_row(&actor.user.id, req.thread_id.clone(), req.body);

    let mut tx = state.pool.begin().await?;
    messages::insert(&mut tx, &row).await?;
    if let Err(file_id) =
        file_store::attach(&mut tx, &attachment_ids, &row.id, &actor.user.id).await?
    {
        return Err(AppError::bad_request(
            "invalid_attachment",
            format!("添付できないファイルです（{file_id}）"),
        ));
    }
    if req.start_thread {
        messages::insert_thread(&mut tx, &row.id, row.created_at).await?;
    }
    tx.commit().await?;

    let sender = actor.conn.map(|conn| (conn, req.client_id));
    let message = broadcast_created(state, &row.id, sender).await?;
    if req.start_thread {
        broadcast_thread(state, &message.id).await?;
    }

    // 通知
    let participants = match &message.thread_id {
        Some(thread_id) => messages::thread_participants(&state.pool, thread_id).await?,
        None => Vec::new(),
    };
    let all_users = users::list(&state.pool).await?;
    for (user_id, notification) in notify::plan(&message, &all_users, &participants) {
        state.notifier.notify(&user_id, &notification);
    }
    Ok(())
}

/// プラグインが、ボットとして投稿する。`author_id` は呼び出した人のまま（責任の所在を残す）。
/// 通常の投稿と同じ経路で配信・通知する。
pub async fn post_bot_message(
    state: &AppState,
    user: &User,
    plugin: &PluginInfo,
    req: PluginPostMessage,
) -> AppResult<Message> {
    validate_body(&req.body, false)?;
    let name = match req.name.as_deref().map(str::trim) {
        None | Some("") => plugin.name.clone(),
        Some(name) => name.chars().take(MAX_BOT_NAME_CHARS).collect(),
    };

    let _guard = state.write_lock().await;
    if let Some(thread_id) = &req.thread_id {
        ensure_thread_exists(state, thread_id).await?;
    }
    let mut row = new_row(&user.id, req.thread_id, req.body);
    row.bot_plugin = Some(plugin.id.clone());
    row.bot_name = Some(name);

    let mut tx = state.pool.begin().await?;
    messages::insert(&mut tx, &row).await?;
    tx.commit().await?;

    let message = broadcast_created(state, &row.id, None).await?;
    let participants = match &message.thread_id {
        Some(thread_id) => messages::thread_participants(&state.pool, thread_id).await?,
        None => Vec::new(),
    };
    let all_users = users::list(&state.pool).await?;
    for (user_id, notification) in notify::plan(&message, &all_users, &participants) {
        state.notifier.notify(&user_id, &notification);
    }
    Ok(message)
}

pub async fn edit_message(
    state: &AppState,
    actor: &Actor<'_>,
    message_id: &str,
    body: String,
) -> AppResult<()> {
    let _guard = state.write_lock().await;
    let row = own_message(state, actor, message_id).await?;
    if row.bot_plugin.is_some() {
        return Err(AppError::bad_request(
            "bot_not_editable",
            "ボットのメッセージは編集できません",
        ));
    }
    if sessions::is_card(&state.pool, message_id).await? {
        return Err(AppError::bad_request(
            "card_not_editable",
            "カードのメッセージは編集できません",
        ));
    }
    validate_body(
        &body,
        messages::has_attachments(&state.pool, message_id).await?,
    )?;

    messages::update_body(&state.pool, message_id, &body, db::now_ms()).await?;

    let message = messages::get(&state.pool, &row.id)
        .await?
        .ok_or_else(|| AppError::not_found("メッセージが見つかりません"))?;
    let is_root = message.thread.is_some();
    state
        .hub
        .broadcast(&ServerEvent::MessageUpdated { message });
    if is_root {
        broadcast_thread(state, message_id).await?;
    }
    Ok(())
}

/// メッセージを完全に消す。スレッドの起点なら、返信と添付ファイルもすべて消す。
pub async fn delete_message(
    state: &AppState,
    actor: &Actor<'_>,
    message_id: &str,
) -> AppResult<()> {
    let _guard = state.write_lock().await;
    let row = own_message(state, actor, message_id).await?;

    let mut tx = state.pool.begin().await?;
    let file_ids = file_store::ids_in_message_tree(&mut tx, message_id).await?;
    messages::delete(&mut tx, message_id).await?;
    tx.commit().await?;

    files::remove_stored(&state.config, &file_ids).await;

    state.hub.broadcast(&ServerEvent::MessageDeleted {
        message_id: row.id,
        thread_id: row.thread_id.clone(),
    });
    if let Some(thread_id) = &row.thread_id {
        broadcast_thread(state, thread_id).await?;
    }
    Ok(())
}

/// 既存のメッセージを起点にスレッドを作る。スレッドの中の返信からは作れない（ネストしない）。
pub async fn create_thread(state: &AppState, root_message_id: &str) -> AppResult<()> {
    let _guard = state.write_lock().await;
    let row = find_message(state, root_message_id).await?;
    if row.thread_id.is_some() {
        return Err(nested_thread());
    }
    if messages::thread_exists(&state.pool, root_message_id).await? {
        return Err(AppError::new(
            axum::http::StatusCode::CONFLICT,
            "thread_exists",
            "このメッセージにはすでにスレッドがあります",
        ));
    }

    let mut conn = state.pool.acquire().await?;
    messages::insert_thread(&mut conn, root_message_id, db::now_ms()).await?;
    drop(conn);

    if let Some(message) = messages::get(&state.pool, root_message_id).await? {
        state
            .hub
            .broadcast(&ServerEvent::MessageUpdated { message });
    }
    broadcast_thread(state, root_message_id).await
}

pub async fn add_reaction(
    state: &AppState,
    actor: &Actor<'_>,
    message_id: &str,
    emoji: &str,
) -> AppResult<()> {
    let emoji = validate_emoji(emoji)?;
    let _guard = state.write_lock().await;
    find_message(state, message_id).await?;
    messages::add_reaction(&state.pool, message_id, &actor.user.id, emoji, db::now_ms()).await?;
    broadcast_reactions(state, message_id).await
}

pub async fn remove_reaction(
    state: &AppState,
    actor: &Actor<'_>,
    message_id: &str,
    emoji: &str,
) -> AppResult<()> {
    let emoji = validate_emoji(emoji)?;
    let _guard = state.write_lock().await;
    find_message(state, message_id).await?;
    messages::remove_reaction(&state.pool, message_id, &actor.user.id, emoji).await?;
    broadcast_reactions(state, message_id).await
}

// ---- メッセージの作成（プラグインのアナウンスやカードと共通） ----

/// 新しいメッセージの行を作る。ID と作成時刻は同じ ULID から決める。
pub(crate) fn new_row(author_id: &str, thread_id: Option<Id>, body: String) -> MessageRow {
    let ulid = db::new_ulid();
    MessageRow {
        id: ulid.to_string(),
        author_id: author_id.to_owned(),
        thread_id,
        body,
        created_at: ulid.timestamp_ms() as i64,
        edited_at: None,
        bot_plugin: None,
        bot_name: None,
    }
}

/// 作ったメッセージを読み直し、全員に `message.created` を配信する。
/// スレッドの返信なら、そのスレッドの `thread.updated` も配信する。
///
/// `sender` は送信者の接続と client_id。client_id は送信者本人の接続にだけ入れる。
/// サーバーが作るメッセージ（アナウンス、カード）では `None`。
/// write_lock を持ったまま呼ぶこと。
pub(crate) async fn broadcast_created(
    state: &AppState,
    message_id: &str,
    sender: Option<(ConnId, String)>,
) -> AppResult<Message> {
    let message = messages::get(&state.pool, message_id)
        .await?
        .ok_or_else(|| AppError::internal("作ったメッセージが見つかりません"))?;

    let created = |client_id| ServerEvent::MessageCreated {
        client_id,
        message: message.clone(),
    };
    match sender {
        Some((conn, client_id)) => {
            state.hub.send_to_conn(conn, &created(Some(client_id)));
            state.hub.broadcast_except(&created(None), conn);
        }
        None => state.hub.broadcast(&created(None)),
    }

    if let Some(thread_id) = &message.thread_id {
        broadcast_thread(state, thread_id).await?;
    }
    Ok(message)
}

// ---- 補助 ----

async fn find_message(state: &AppState, id: &str) -> AppResult<MessageRow> {
    messages::get_row(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("メッセージが見つかりません"))
}

/// 自分のメッセージを取る。他人のメッセージなら `forbidden`。
async fn own_message(state: &AppState, actor: &Actor<'_>, id: &str) -> AppResult<MessageRow> {
    let row = find_message(state, id).await?;
    if row.author_id != actor.user.id {
        return Err(AppError::forbidden(
            "自分のメッセージだけ編集・削除できます",
        ));
    }
    Ok(row)
}

/// スレッドがなければ `thread_not_found`。
pub(crate) async fn ensure_thread_exists(state: &AppState, thread_id: &str) -> AppResult<()> {
    if !messages::thread_exists(&state.pool, thread_id).await? {
        return Err(AppError::new(
            axum::http::StatusCode::NOT_FOUND,
            "thread_not_found",
            "スレッドが見つかりません",
        ));
    }
    Ok(())
}

pub(crate) async fn broadcast_thread(state: &AppState, thread_id: &str) -> AppResult<()> {
    if let Some(thread) = messages::get_thread(&state.pool, thread_id).await? {
        state.hub.broadcast(&ServerEvent::ThreadUpdated { thread });
    }
    Ok(())
}

async fn broadcast_reactions(state: &AppState, message_id: &str) -> AppResult<()> {
    let reactions = messages::reactions(&state.pool, message_id).await?;
    state.hub.broadcast(&ServerEvent::ReactionUpdated {
        message_id: message_id.to_owned(),
        reactions,
    });
    Ok(())
}

fn nested_thread() -> AppError {
    AppError::bad_request("nested_thread", "スレッドの中にスレッドは作れません")
}

fn validate_body(body: &str, has_attachments: bool) -> AppResult<()> {
    if body.trim().is_empty() && !has_attachments {
        return Err(AppError::bad_request("empty_message", "本文が空です"));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(AppError::bad_request(
            "body_too_long",
            format!("本文は {MAX_BODY_CHARS} 文字までです"),
        ));
    }
    Ok(())
}

fn validate_emoji(emoji: &str) -> AppResult<&str> {
    let emoji = emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > MAX_EMOJI_CHARS {
        return Err(AppError::bad_request("invalid_emoji", "絵文字が不正です"));
    }
    Ok(emoji)
}

fn dedup_keep_order(ids: &mut Vec<Id>) {
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
}
