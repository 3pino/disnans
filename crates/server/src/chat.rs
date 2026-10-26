//! メッセージ・リアクションの操作。
//!
//! WebSocket の `ClientEvent` から呼ばれる。DB を書き換えたあと、結果を全員に配信し、
//! 必要なら通知を送る。

use disnans_shared::{Id, Message, PluginInfo, PluginPostMessage, ServerEvent, User};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::files;
use crate::hub::ConnId;
use crate::notify::{self, Sender};
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
    pub body: String,
    pub attachment_ids: Vec<Id>,
    /// 返信先のメッセージ。
    pub reply_to: Option<Id>,
    /// `true` なら通知を送らない。
    pub silent: bool,
}

pub async fn send_message(state: &AppState, actor: &Actor<'_>, req: SendMessage) -> AppResult<()> {
    let mut attachment_ids = req.attachment_ids;
    dedup_keep_order(&mut attachment_ids);
    // 長さは送られた本文（表示の形）で見る。添付の埋め込みは末尾に足す（旧クライアントの attachment_ids）
    validate_body(&req.body, !attachment_ids.is_empty())?;
    let stored = crate::links::to_stored(
        &state.pool,
        &state.config.shared_dir(),
        &actor.user.id,
        &req.body,
    )
    .await?;
    let body = crate::links::append_links(&stored, &attachment_ids);

    let _guard = state.write_lock().await;

    let reply_author = match &req.reply_to {
        Some(reply_to) => {
            let target = messages::get_row(&state.pool, reply_to)
                .await?
                .ok_or_else(|| {
                    AppError::bad_request("reply_not_found", "返信先のメッセージが見つかりません")
                })?;
            Some(target.author_id)
        }
        None => None,
    };

    let mut row = new_row(&actor.user.id, body.clone());
    row.reply_to = req.reply_to.clone();

    let mut tx = state.pool.begin().await?;
    messages::insert(&mut tx, &row).await?;
    claim_or_fail(
        &mut tx,
        &body,
        &attachment_ids,
        &row.id,
        &actor.user.id,
        row.created_at,
    )
    .await?;
    tx.commit().await?;
    // 投稿された添付は `attachments/` に現れる（新しく紐付いたもの）
    for file_id in &attachment_ids {
        if let Some(file) = file_store::get(&state.pool, file_id).await? {
            state.hub.broadcast(&ServerEvent::FilesChanged {
                path: crate::attachments::path_of(&file.file_name),
            });
        }
    }

    let sender = actor.conn.map(|conn| (conn, req.client_id));
    let message = broadcast_created(state, &row.id, sender).await?;

    // 通知（silent なら送らない）
    if req.silent {
        return Ok(());
    }
    let all_users = users::list(&state.pool).await?;
    for (user_id, notification) in
        notify::plan(&message, &all_users, reply_author.as_deref(), Sender::User)
    {
        state.notifier.notify(&user_id, &notification);
    }
    Ok(())
}

/// プラグインが、ボットとして投稿する。`author_id` は呼び出した人のまま（責任の所在を残す）。
/// 通常の投稿と同じ経路で配信する。通知は `notify` が `true` のときだけ送る（投稿した本人にも送る）。
pub async fn post_bot_message(
    state: &AppState,
    user: &User,
    plugin: &PluginInfo,
    req: PluginPostMessage,
) -> AppResult<Message> {
    validate_body(&req.body, false)?;
    let body =
        crate::links::to_stored(&state.pool, &state.config.shared_dir(), &user.id, &req.body)
            .await?;
    let name = match req.name.as_deref().map(str::trim) {
        None | Some("") => plugin.name.clone(),
        Some(name) => name.chars().take(MAX_BOT_NAME_CHARS).collect(),
    };

    let _guard = state.write_lock().await;
    let mut row = new_row(&user.id, body.clone());
    row.bot_plugin = Some(plugin.id.clone());
    row.bot_name = Some(name.clone());

    let mut tx = state.pool.begin().await?;
    messages::insert(&mut tx, &row).await?;
    claim_or_fail(&mut tx, &body, &[], &row.id, &user.id, row.created_at).await?;
    tx.commit().await?;

    let message = broadcast_created(state, &row.id, None).await?;
    if req.notify {
        let all_users = users::list(&state.pool).await?;
        let plan = notify::plan(&message, &all_users, None, Sender::Bot(&name));
        for (user_id, notification) in plan {
            state.notifier.notify(&user_id, &notification);
        }
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
    // 添付も本文の中にあるので、本文が空なら空のメッセージ
    validate_body(&body, false)?;
    let stored = crate::links::to_stored(
        &state.pool,
        &state.config.shared_dir(),
        &actor.user.id,
        &body,
    )
    .await?;

    let old_ids = crate::links::ids_in(&row.body);
    let new_ids = crate::links::ids_in(&stored);
    let added: Vec<String> = new_ids
        .iter()
        .filter(|id| !old_ids.contains(id))
        .cloned()
        .collect();
    let removed: Vec<String> = old_ids
        .iter()
        .filter(|id| !new_ids.contains(id))
        .cloned()
        .collect();

    let mut tx = state.pool.begin().await?;
    if let Some(bad) =
        file_store::claim(&mut tx, &added, &[], &row.id, &actor.user.id, db::now_ms()).await?
    {
        return Err(invalid_link(&bad));
    }
    messages::update_body(&mut tx, message_id, &stored, db::now_ms()).await?;
    // 本文から外れた添付は、メッセージから外れる（ファイルは `attachments/` に残す）
    let mut kept = Vec::new();
    let mut gone = Vec::new();
    let mut names = names_of(&mut tx, &added).await?;
    for id in &removed {
        match file_store::unlink(&mut tx, id, &row.id, true).await? {
            file_store::Unlinked::Kept => kept.push(id.clone()),
            file_store::Unlinked::Purged { name } => {
                gone.push(id.clone());
                names.extend(name);
            }
            file_store::Unlinked::Moved => {}
        }
    }
    names.extend(names_of(&mut tx, &kept).await?);
    tx.commit().await?;
    files::remove_stored(&state.config, &gone).await;
    for name in names {
        state.hub.broadcast(&ServerEvent::FilesChanged {
            path: crate::attachments::path_of(&name),
        });
    }

    let message = messages::get(&state.pool, &row.id)
        .await?
        .ok_or_else(|| AppError::not_found("メッセージが見つかりません"))?;
    state
        .hub
        .broadcast(&ServerEvent::MessageUpdated { message });
    Ok(())
}

/// メッセージを消す。本文だけが参照していた添付も消す（ほかの本文が参照していれば残す）。
pub async fn delete_message(
    state: &AppState,
    actor: &Actor<'_>,
    message_id: &str,
) -> AppResult<()> {
    let _guard = state.write_lock().await;
    let row = own_message(state, actor, message_id).await?;

    let mut tx = state.pool.begin().await?;
    let mut ids = crate::links::ids_in(&row.body);
    for id in file_store::ids_with_message(&mut tx, message_id).await? {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let mut gone = Vec::new();
    let mut names = Vec::new();
    for id in &ids {
        if let file_store::Unlinked::Purged { name } =
            file_store::unlink(&mut tx, id, message_id, false).await?
        {
            gone.push(id.clone());
            names.extend(name);
        }
    }
    messages::delete(&mut tx, message_id).await?;
    tx.commit().await?;

    files::remove_stored(&state.config, &gone).await;
    // 消えた添付は `attachments/` から消える
    for name in names {
        state.hub.broadcast(&ServerEvent::FilesChanged {
            path: crate::attachments::path_of(&name),
        });
    }

    state
        .hub
        .broadcast(&ServerEvent::MessageDeleted { message_id: row.id });
    Ok(())
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
pub(crate) fn new_row(author_id: &str, body: String) -> MessageRow {
    let ulid = db::new_ulid();
    MessageRow {
        id: ulid.to_string(),
        author_id: author_id.to_owned(),
        reply_to: None,
        body,
        created_at: ulid.timestamp_ms() as i64,
        edited_at: None,
        bot_plugin: None,
        bot_name: None,
    }
}

/// 作ったメッセージを読み直し、全員に `message.created` を配信する。
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

async fn broadcast_reactions(state: &AppState, message_id: &str) -> AppResult<()> {
    let reactions = messages::reactions(&state.pool, message_id).await?;
    state.hub.broadcast(&ServerEvent::ReactionUpdated {
        message_id: message_id.to_owned(),
        reactions,
    });
    Ok(())
}

/// 本文の中の添付を紐付ける。付けられない ID があれば、その理由（欄から来たものは `invalid_attachment`）。
/// `at` は初回の紐付けの時刻（送信なら、メッセージの作成の時刻）。
async fn claim_or_fail(
    conn: &mut sqlx::SqliteConnection,
    body: &str,
    fresh: &[Id],
    message_id: &str,
    uploader_id: &str,
    at: i64,
) -> AppResult<()> {
    let ids = crate::links::ids_in(body);
    match file_store::claim(conn, &ids, fresh, message_id, uploader_id, at).await? {
        None => Ok(()),
        Some(bad) if fresh.contains(&bad) => Err(AppError::bad_request(
            "invalid_attachment",
            format!("添付できないファイルです（{bad}）"),
        )),
        Some(bad) => Err(invalid_link(&bad)),
    }
}

fn invalid_link(id: &str) -> AppError {
    AppError::bad_request(
        "invalid_link",
        format!("本文の添付が見つからないか、付けられません（{id}）"),
    )
}

/// 添付の ID の並びを、今の別名に直す（変更の通知に使う）。
async fn names_of(conn: &mut sqlx::SqliteConnection, ids: &[String]) -> AppResult<Vec<String>> {
    let rows = file_store::rows_by_ids(conn, ids).await?;
    Ok(rows
        .into_iter()
        .filter(|r| r.deleted_at.is_none())
        .map(|r| r.file_name)
        .collect())
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
