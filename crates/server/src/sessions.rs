//! プラグインのセッションとカード、一時的なイベントの中継、プラグインからの通知（SPEC 9.5）。
//!
//! サーバーは state の中身を解釈しない。保存して配るだけ。

use axum::http::StatusCode;
use disnans_shared::{Card, CreateSession, Id, PluginNotify, ServerEvent, Session, UpdateSession};

use crate::chat::{self, Actor};
use crate::db;
use crate::error::{AppError, AppResult};
use crate::notify::Notification;
use crate::plugins;
use crate::state::AppState;
use crate::store::sessions::{self as session_store, SessionRow};
use crate::store::{messages, plugins as plugin_store, users};

/// state（JSON）の最大バイト数。
const MAX_STATE_BYTES: usize = 1024 * 1024;
/// 一時的なイベントの payload（JSON）の最大バイト数。
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
/// 一時的なイベントの名前の最大文字数。
const MAX_EVENT_NAME_CHARS: usize = 64;
/// カードの最大文字数。
const MAX_CARD_TITLE_CHARS: usize = 200;
const MAX_CARD_TEXT_CHARS: usize = 2_000;
/// プラグインからの通知の本文の最大文字数。
const MAX_NOTIFY_BODY_CHARS: usize = 500;

/// セッションを作り、カードのメッセージを流す。通知は出さない。
///
/// プラグインが配布済みかは問わない（開発中のプラグインでも使えるように）。
pub async fn create(state: &AppState, actor: &Actor<'_>, req: CreateSession) -> AppResult<Session> {
    plugins::validate_id(&req.plugin)?;
    let state_json = encode_state(&req.state)?;
    validate_card(&req.card)?;

    let _guard = state.write_lock().await;
    if let Some(thread_id) = &req.thread_id {
        chat::ensure_thread_exists(state, thread_id).await?;
    }

    // カードは本文が空のメッセージ（本文の検証は通さない）
    let message = chat::new_row(&actor.user.id, req.thread_id, String::new());
    let row = SessionRow {
        id: db::new_id(),
        plugin: req.plugin,
        message_id: message.id.clone(),
        created_by: actor.user.id.clone(),
        state: state_json,
        version: 1,
        card_title: req.card.title,
        card_text: req.card.text,
        created_at: message.created_at,
        updated_at: message.created_at,
    };

    let mut tx = state.pool.begin().await?;
    messages::insert(&mut tx, &message).await?;
    session_store::insert(&mut tx, &row).await?;
    tx.commit().await?;

    chat::broadcast_created(state, &message.id, None).await?;
    Ok(row.into())
}

pub async fn get(state: &AppState, id: &str) -> AppResult<Session> {
    Ok(find(state, id).await?.into())
}

/// state（とカード）をまるごと書き換える。`version` が一致しなければ `409 version_conflict`。
pub async fn update(state: &AppState, id: &str, req: UpdateSession) -> AppResult<Session> {
    let state_json = encode_state(&req.state)?;
    if let Some(card) = &req.card {
        validate_card(card)?;
    }

    let _guard = state.write_lock().await;
    let mut row = find(state, id).await?;
    if row.version != req.version {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "version_conflict",
            format!(
                "ほかの人が先に更新しました（現在の version は {}）",
                row.version
            ),
        ));
    }
    row.state = state_json;
    row.version += 1;
    row.updated_at = db::now_ms();
    let card_changed = req.card.is_some();
    if let Some(card) = req.card {
        row.card_title = card.title;
        row.card_text = card.text;
    }
    session_store::update(&state.pool, &row).await?;

    let session: Session = row.into();
    state.hub.broadcast(&ServerEvent::SessionUpdated {
        session: session.clone(),
    });
    // カードの書き換えは編集ではないので、edited_at は変えない
    if card_changed && let Some(message) = messages::get(&state.pool, &session.message_id).await? {
        let is_root = message.thread.is_some();
        state
            .hub
            .broadcast(&ServerEvent::MessageUpdated { message });
        if is_root {
            chat::broadcast_thread(state, &session.message_id).await?;
        }
    }
    Ok(session)
}

/// 一時的なイベントを、送信した接続以外の全員に中継する（保存しない）。
pub async fn emit(
    state: &AppState,
    actor: &Actor<'_>,
    session_id: Id,
    name: String,
    payload: serde_json::Value,
) -> AppResult<()> {
    if name.is_empty() || name.chars().count() > MAX_EVENT_NAME_CHARS {
        return Err(AppError::bad_request(
            "invalid_event_name",
            format!("イベント名は 1〜{MAX_EVENT_NAME_CHARS} 文字にしてください"),
        ));
    }
    if json_len(&payload) > MAX_PAYLOAD_BYTES {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            format!("payload は {} KB までです", MAX_PAYLOAD_BYTES / 1024),
        ));
    }
    find(state, &session_id).await?;

    let event = ServerEvent::SessionEvent {
        session_id,
        from: actor.user.id.clone(),
        name,
        payload,
    };
    match actor.conn {
        Some(conn) => state.hub.broadcast_except(&event, conn),
        None => state.hub.broadcast(&event),
    }
    Ok(())
}

/// プラグインから通知を送る。タイトルはプラグインの名前（配布されていなければ ID）。
///
/// 自分宛ても送る。存在しないユーザーは無視する。
pub async fn notify(state: &AppState, plugin_id: &str, req: PluginNotify) -> AppResult<()> {
    plugins::validate_id(plugin_id)?;
    let body = req.body.trim();
    if body.is_empty() || body.chars().count() > MAX_NOTIFY_BODY_CHARS {
        return Err(AppError::bad_request(
            "invalid_body",
            format!("本文は 1〜{MAX_NOTIFY_BODY_CHARS} 文字にしてください"),
        ));
    }

    let title = plugin_store::get(&state.pool, plugin_id)
        .await?
        .map(|p| p.name)
        .unwrap_or_else(|| plugin_id.to_owned());
    let (message_id, thread_id) = match &req.session_id {
        Some(session_id) => {
            let row = find(state, session_id).await?;
            let message = messages::get_row(&state.pool, &row.message_id).await?;
            (Some(row.message_id), message.and_then(|m| m.thread_id))
        }
        None => (None, None),
    };
    let notification = Notification {
        title,
        body: body.to_owned(),
        message_id,
        thread_id,
        sample: false,
    };

    let all_users = users::list(&state.pool).await?;
    let mut sent = std::collections::HashSet::new();
    for user_id in &req.user_ids {
        if all_users.iter().any(|u| &u.id == user_id) && sent.insert(user_id) {
            state.notifier.notify(user_id, &notification);
        }
    }
    Ok(())
}

// ---- 補助 ----

async fn find(state: &AppState, id: &str) -> AppResult<SessionRow> {
    session_store::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::not_found("セッションが見つかりません"))
}

/// state を保存する JSON 文字列にする。大きすぎれば `state_too_large`。
fn encode_state(value: &serde_json::Value) -> AppResult<String> {
    let json = serde_json::to_string(value).map_err(AppError::internal)?;
    if json.len() > MAX_STATE_BYTES {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "state_too_large",
            format!("state は {} MB までです", MAX_STATE_BYTES / 1024 / 1024),
        ));
    }
    Ok(json)
}

fn json_len(value: &serde_json::Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
}

fn validate_card(card: &Card) -> AppResult<()> {
    if card.title.chars().count() > MAX_CARD_TITLE_CHARS
        || card.text.chars().count() > MAX_CARD_TEXT_CHARS
    {
        return Err(AppError::bad_request(
            "invalid_card",
            format!(
                "カードのタイトルは {MAX_CARD_TITLE_CHARS} 文字、本文は {MAX_CARD_TEXT_CHARS} 文字までです"
            ),
        ));
    }
    Ok(())
}
