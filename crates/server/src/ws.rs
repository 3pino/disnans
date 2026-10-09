//! WebSocket（`/api/ws`）。
//!
//! `ClientEvent` を受け取って `chat` の操作を呼び、`ServerEvent` を送る。
//! 送信はすべて `Hub` のキューを通す（書き込みタスクが1つだけソケットに書く）。

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use disnans_shared::{ClientEvent, ServerEvent, User};
use futures_util::{SinkExt, StreamExt};

use crate::auth::CurrentUser;
use crate::chat::{self, Actor, SendMessage};
use crate::db;
use crate::error::AppError;
use crate::hub::ConnId;
use crate::state::SharedState;
use crate::store::users;

/// サーバーから WebSocket の ping を送る間隔。
const PING_INTERVAL: Duration = Duration::from_secs(30);
/// この時間なにも受け取らなければ、切れたものとみなして閉じる。
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

pub async fn handler(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| run(state, user, socket))
}

async fn run(state: SharedState, user: User, socket: WebSocket) {
    let users = match users::list(&state.pool).await {
        Ok(users) => users,
        Err(err) => {
            tracing::error!("ユーザー一覧を読めません: {err}");
            return;
        }
    };
    let hello = ServerEvent::Hello {
        me: user.clone(),
        users,
    };
    let (conn, mut queue) = state.hub.register(&user.id, &hello);
    tracing::info!(conn, user = %user.login_name, "WebSocket 接続");

    let (mut sink, mut stream) = socket.split();
    let last_seen = Arc::new(AtomicI64::new(db::now_ms()));

    // 書き込みタスク: キューの中身と定期的な ping をソケットに書く
    let mut writer = {
        let last_seen = last_seen.clone();
        tokio::spawn(async move {
            let mut ping = tokio::time::interval(PING_INTERVAL);
            ping.tick().await;
            loop {
                tokio::select! {
                    text = queue.recv() => {
                        // None: Hub から外された（詰まった、または終了処理）
                        let Some(text) = text else { break };
                        if sink.send(WsMessage::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    _ = ping.tick() => {
                        let idle = db::now_ms() - last_seen.load(Ordering::Relaxed);
                        if idle > IDLE_TIMEOUT.as_millis() as i64 {
                            tracing::info!("応答がないので切断します");
                            break;
                        }
                        if sink.send(WsMessage::Ping(Default::default())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = sink.close().await;
        })
    };

    // 読み込み: 受け取ったイベントを順番に処理する
    let actor = Actor {
        user: &user,
        conn: Some(conn),
    };
    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                last_seen.store(db::now_ms(), Ordering::Relaxed);
                match msg {
                    WsMessage::Text(text) => handle_text(&state, &actor, conn, text.as_str()).await,
                    WsMessage::Close(_) => break,
                    // ping への応答は axum（tungstenite）が自動で返す。pong は last_seen の更新だけ
                    _ => {}
                }
            }
            // 書き込みタスクが終わったら（切断・タイムアウト）読み込みもやめる
            _ = &mut writer => break,
        }
    }

    state.hub.unregister(conn);
    writer.abort();
    tracing::info!(conn, user = %user.login_name, "WebSocket 切断");
}

async fn handle_text(state: &SharedState, actor: &Actor<'_>, conn: ConnId, text: &str) {
    let event: ClientEvent = match serde_json::from_str(text) {
        Ok(event) => event,
        Err(err) => {
            let error = ServerEvent::Error {
                client_id: None,
                code: "invalid_event".into(),
                message: format!("イベントを解釈できません: {err}"),
            };
            state.hub.send_to_conn(conn, &error);
            return;
        }
    };

    // message.send の失敗は、どの送信が失敗したか分かるよう client_id を付けて返す
    let mut client_id = None;
    let result = match event {
        ClientEvent::MessageSend {
            client_id: id,
            thread_id,
            body,
            attachment_ids,
            start_thread,
        } => {
            client_id = Some(id.clone());
            let req = SendMessage {
                client_id: id,
                thread_id,
                body,
                attachment_ids,
                start_thread,
            };
            chat::send_message(state, actor, req).await
        }
        ClientEvent::MessageEdit { message_id, body } => {
            chat::edit_message(state, actor, &message_id, body).await
        }
        ClientEvent::MessageDelete { message_id } => {
            chat::delete_message(state, actor, &message_id).await
        }
        ClientEvent::ThreadCreate { root_message_id } => {
            chat::create_thread(state, &root_message_id).await
        }
        ClientEvent::ReactionAdd { message_id, emoji } => {
            chat::add_reaction(state, actor, &message_id, &emoji).await
        }
        ClientEvent::ReactionRemove { message_id, emoji } => {
            chat::remove_reaction(state, actor, &message_id, &emoji).await
        }
        ClientEvent::Ping => {
            state.hub.send_to_conn(conn, &ServerEvent::Pong);
            Ok(())
        }
    };

    if let Err(AppError { code, message, .. }) = result {
        let error = ServerEvent::Error {
            client_id,
            code: code.into(),
            message,
        };
        state.hub.send_to_conn(conn, &error);
    }
}
