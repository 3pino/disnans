//! `ChatConnection::react` を、偽の WebSocket サーバーで確かめる（cli-tui の依頼）。
//! 結果の決まり: 自分の ID が付いた（外れた）`reaction.updated` で Confirmed、`error` で Rejected、
//! 時間切れ・切断で Unknown。自動では再送しない。

#![cfg(feature = "ws")]

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use disnans_client_core::{ChatConnection, ConnectOptions, ReactOutcome, ServerUrl, UnknownReason};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    net::{TcpListener, TcpStream},
    time::{sleep, timeout},
};
use tokio_tungstenite::{WebSocketStream, accept_async, tungstenite::Message as WsMessage};

const WAIT: Duration = Duration::from_secs(5);
const ME: &str = "u-me";

type Socket = WebSocketStream<TcpStream>;

/// 偽サーバーが次にすること（hello のあと、クライアントの最初の 1 フレームを受けてから順に行う）
#[derive(Clone)]
enum Step {
    /// JSON を 1 つ送る
    Send(Value),
    /// 何もせず待つ
    Pause(Duration),
    /// 接続を閉じる
    Close,
}

/// 1 接続だけ受けて、`steps` を行う。クライアントが書いたフレーム（JSON）を `seen` に残す。
/// `steps` の後は接続を開いたままにする（Close を除く）。
async fn serve(steps: Vec<Step>) -> (ServerUrl, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seen_task = seen.clone();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json_frame(&hello())).await;
        // 最初のクライアントのフレーム（reaction.add / remove）を受けてから、応答を始める
        if !wait_for_first_text(&mut socket, &seen_task).await {
            return;
        }
        for step in steps {
            match step {
                Step::Send(value) => {
                    let _ = socket.send(json_frame(&value)).await;
                }
                Step::Pause(duration) => sleep(duration).await,
                Step::Close => {
                    let _ = socket.close(None).await;
                    return;
                }
            }
        }
        // 開いたままにする（クライアントの時間切れや、テストの終わりまで）
        wait_for_client(&mut socket, &seen_task).await;
    });
    let url = ServerUrl::parse(&format!("http://{address}")).unwrap();
    (url, seen)
}

/// 最初のテキストのフレームを記録する。閉じられたら false
async fn wait_for_first_text(socket: &mut Socket, seen: &Arc<Mutex<Vec<Value>>>) -> bool {
    while let Some(Ok(frame)) = socket.next().await {
        if let WsMessage::Text(text) = frame
            && let Ok(value) = serde_json::from_str::<Value>(text.as_str())
        {
            seen.lock().unwrap().push(value);
            return true;
        }
    }
    false
}

/// 送られてきたフレームを記録し続ける（閉じられたら戻る）
async fn wait_for_client(socket: &mut Socket, seen: &Arc<Mutex<Vec<Value>>>) {
    while let Some(Ok(frame)) = socket.next().await {
        if let WsMessage::Text(text) = frame
            && let Ok(value) = serde_json::from_str::<Value>(text.as_str())
        {
            seen.lock().unwrap().push(value);
        }
    }
}

fn json_frame(value: &Value) -> WsMessage {
    WsMessage::Text(value.to_string().into())
}

fn user(id: &str, login: &str) -> Value {
    json!({
        "id": id,
        "login_name": login,
        "display_name": login,
        "avatar_url": null,
        "created_at": 1,
    })
}

fn hello() -> Value {
    json!({
        "type": "hello",
        "me": user(ME, "alice@test"),
        "users": [user(ME, "alice@test")],
    })
}

/// 反応の状態の通知（`users` はその絵文字に反応した人の ID）
fn reaction_updated(message_id: &str, emoji: &str, users: &[&str]) -> Value {
    json!({
        "type": "reaction.updated",
        "message_id": message_id,
        "reactions": [{ "emoji": emoji, "user_ids": users }],
    })
}

fn error_event(code: &str, message: &str) -> Value {
    json!({
        "type": "error",
        "client_id": null,
        "code": code,
        "message": message,
    })
}

async fn connect(url: &ServerUrl) -> ChatConnection {
    timeout(
        WAIT,
        ChatConnection::connect(url, ConnectOptions::default()),
    )
    .await
    .expect("connect in time")
    .expect("connect ok")
}

async fn react_with(
    conn: &mut ChatConnection,
    message_id: &str,
    emoji: &str,
    add: bool,
    ack: Duration,
) -> ReactOutcome {
    timeout(WAIT, conn.react(message_id, emoji, add, ack))
        .await
        .expect("react returns in time")
}

#[tokio::test]
async fn adding_is_confirmed_when_my_id_appears_and_sends_the_add_frame() {
    let (url, seen) = serve(vec![Step::Send(reaction_updated("m1", "👍", &[ME]))]).await;
    let mut conn = connect(&url).await;
    let outcome = react_with(&mut conn, "m1", "👍", true, WAIT).await;
    assert_eq!(outcome, ReactOutcome::Confirmed);
    // 送った内容: reaction.add（client_id は付かない）
    sleep(Duration::from_millis(50)).await;
    let frames = seen.lock().unwrap().clone();
    assert_eq!(
        frames,
        vec![json!({"type": "reaction.add", "message_id": "m1", "emoji": "👍"})]
    );
}

#[tokio::test]
async fn removing_is_confirmed_when_my_id_is_gone() {
    let (url, seen) = serve(vec![Step::Send(reaction_updated("m1", "👍", &["u-other"]))]).await;
    let mut conn = connect(&url).await;
    let outcome = react_with(&mut conn, "m1", "👍", false, WAIT).await;
    assert_eq!(outcome, ReactOutcome::Confirmed);
    sleep(Duration::from_millis(50)).await;
    assert_eq!(
        seen.lock().unwrap().clone(),
        vec![json!({"type": "reaction.remove", "message_id": "m1", "emoji": "👍"})]
    );
}

#[tokio::test]
async fn updates_for_other_messages_or_emojis_do_not_settle_it() {
    let (url, _seen) = serve(vec![
        // 別のメッセージ（自分の ID が付いていても無視）
        Step::Send(reaction_updated("m2", "👍", &[ME])),
        // 同じメッセージだが別の絵文字（こちらの 👍 は付いていない）
        Step::Send(reaction_updated("m1", "🎉", &[ME])),
        // 同じメッセージの 👍 に、自分の ID が付いた
        Step::Send(reaction_updated("m1", "👍", &["u-other", ME])),
    ])
    .await;
    let mut conn = connect(&url).await;
    let outcome = react_with(&mut conn, "m1", "👍", true, WAIT).await;
    assert_eq!(outcome, ReactOutcome::Confirmed);
}

#[tokio::test]
async fn an_update_without_my_id_does_not_confirm_an_add() {
    let (url, _seen) = serve(vec![Step::Send(reaction_updated("m1", "👍", &["u-other"]))]).await;
    let mut conn = connect(&url).await;
    let outcome = react_with(&mut conn, "m1", "👍", true, Duration::from_millis(300)).await;
    assert_eq!(outcome, ReactOutcome::Unknown(UnknownReason::Timeout));
}

#[tokio::test]
async fn an_error_event_is_a_rejection_with_its_code_and_message() {
    let (url, _seen) = serve(vec![Step::Send(error_event(
        "not_found",
        "メッセージがありません",
    ))])
    .await;
    let mut conn = connect(&url).await;
    let outcome = react_with(&mut conn, "m-missing", "👍", true, WAIT).await;
    assert_eq!(
        outcome,
        ReactOutcome::Rejected {
            code: "not_found".into(),
            message: "メッセージがありません".into(),
        }
    );
}

#[tokio::test]
async fn no_reply_within_the_timeout_is_unknown_and_the_connection_still_works() {
    // 最初の要求には遅れて答える（時間切れになる）。そのあとの要求には、すぐ答える
    let (url, seen) = serve(vec![
        Step::Pause(Duration::from_millis(400)),
        Step::Send(reaction_updated("m1", "👍", &[ME])),
    ])
    .await;
    let mut conn = connect(&url).await;
    let first = react_with(&mut conn, "m1", "👍", true, Duration::from_millis(100)).await;
    assert_eq!(first, ReactOutcome::Unknown(UnknownReason::Timeout));
    // 確認の時間切れは接続を壊さない（書き込みの途中ではないため）。次の要求は届く
    let second = react_with(&mut conn, "m1", "👍", true, WAIT).await;
    assert_eq!(second, ReactOutcome::Confirmed);
    sleep(Duration::from_millis(50)).await;
    // 自動では再送しない: 書いたのは最初の 1 回と、次の 1 回だけ
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_closed_connection_before_the_update_is_unknown_disconnected() {
    let (url, _seen) = serve(vec![Step::Close]).await;
    let mut conn = connect(&url).await;
    let outcome = react_with(&mut conn, "m1", "👍", true, WAIT).await;
    assert_eq!(outcome, ReactOutcome::Unknown(UnknownReason::Disconnected));
}

#[tokio::test]
async fn empty_ids_are_refused_without_writing_anything() {
    let (url, seen) = serve(vec![Step::Send(reaction_updated("m1", "👍", &[ME]))]).await;
    let mut conn = connect(&url).await;
    assert!(matches!(
        react_with(&mut conn, "", "👍", true, WAIT).await,
        ReactOutcome::NotSent { .. }
    ));
    assert!(matches!(
        react_with(&mut conn, "m1", "", true, WAIT).await,
        ReactOutcome::NotSent { .. }
    ));
    // 拒否された呼び出しは何も書いていない。そのあとの正しい呼び出しは届く
    assert_eq!(
        react_with(&mut conn, "m1", "👍", true, WAIT).await,
        ReactOutcome::Confirmed
    );
    sleep(Duration::from_millis(50)).await;
    assert_eq!(seen.lock().unwrap().len(), 1);
}
