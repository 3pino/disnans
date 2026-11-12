// Handshake callbacks return tungstenite's own (large) HTTP response type.
#![allow(clippy::result_large_err, clippy::large_enum_variant)]

use std::{future::Future, sync::Mutex as StdMutex};

use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{
    accept_async, accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http,
    },
};

use super::*;

const WAIT: Duration = Duration::from_secs(5);

type Socket = WebSocketStream<TcpStream>;
type Seen = Arc<StdMutex<Vec<ClientEvent>>>;

/// Accepts connections on 127.0.0.1 and runs `script` for each one, numbered from zero.
async fn serve<F, Fut>(script: F) -> ServerUrl
where
    F: Fn(usize, TcpStream) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut index = 0;
        while let Ok((stream, _)) = listener.accept().await {
            tokio::spawn(script(index, stream));
            index += 1;
        }
    });
    ServerUrl::parse(&format!("http://{address}")).unwrap()
}

fn user(login: &str) -> User {
    User {
        id: format!("id-{login}"),
        login_name: login.into(),
        display_name: login.into(),
        avatar_url: None,
        created_at: 1,
    }
}

fn message(id: &str, body: &str) -> Message {
    Message {
        id: id.into(),
        author_id: "id-alice".into(),
        reply_to: None,
        reply_preview: None,
        body: body.into(),
        attachments: vec![],
        reactions: vec![],
        created_at: 1,
        edited_at: None,
        card: None,
        bot: None,
    }
}

fn hello() -> ServerEvent {
    ServerEvent::Hello {
        me: user("alice@test"),
        users: vec![user("alice@test")],
    }
}

fn json(event: &ServerEvent) -> WsMessage {
    WsMessage::Text(serde_json::to_string(event).unwrap().into())
}

/// Next frame from the peer, or `None` on close, error, or timeout.
async fn read_frame(socket: &mut Socket) -> Option<WsMessage> {
    match timeout(WAIT, socket.next()).await {
        Ok(Some(Ok(frame))) => Some(frame),
        _ => None,
    }
}

/// Next `message.send` from the client, skipping control frames.
async fn read_client(socket: &mut Socket) -> Option<ClientEvent> {
    loop {
        match read_frame(socket).await? {
            WsMessage::Text(text) => return serde_json::from_str(text.as_str()).ok(),
            WsMessage::Close(_) => return None,
            _ => {}
        }
    }
}

/// What the scripted server does after receiving a `message.send`.
enum Step {
    Event(ServerEvent),
    Close,
}

/// Scripted chat server: sends `hello`, records every `message.send`, and replies with
/// `reply(event)`.
async fn serve_chat<R>(seen: Seen, reply: R) -> ServerUrl
where
    R: Fn(&ClientEvent) -> Vec<Step> + Send + Sync + 'static,
{
    let reply = Arc::new(reply);
    serve(move |_, stream| {
        let seen = seen.clone();
        let reply = reply.clone();
        async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            if socket.send(json(&hello())).await.is_err() {
                return;
            }
            while let Some(event) = read_client(&mut socket).await {
                seen.lock().unwrap().push(event.clone());
                for step in reply(&event) {
                    match step {
                        Step::Event(event) => {
                            if socket.send(json(&event)).await.is_err() {
                                return;
                            }
                        }
                        Step::Close => {
                            let _ = socket.close(None).await;
                            return;
                        }
                    }
                }
            }
        }
    })
    .await
}

fn new_seen() -> Seen {
    Arc::new(StdMutex::new(Vec::new()))
}

fn sent_ids(seen: &Seen) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            ClientEvent::MessageSend { client_id, .. } => Some(client_id.clone()),
            _ => None,
        })
        .collect()
}

fn client_id_of(event: &ClientEvent) -> String {
    match event {
        ClientEvent::MessageSend { client_id, .. } => client_id.clone(),
        other => panic!("unexpected client event: {other:?}"),
    }
}

fn body_of(event: &ClientEvent) -> String {
    match event {
        ClientEvent::MessageSend { body, .. } => body.clone(),
        other => panic!("unexpected client event: {other:?}"),
    }
}

/// Confirm the send with its own `client_id`.
fn ack(event: &ClientEvent) -> Step {
    Step::Event(ServerEvent::MessageCreated {
        client_id: Some(client_id_of(event)),
        message: message("m-ack", &body_of(event)),
    })
}

fn error_for(client_id: Option<String>, code: &str) -> Step {
    Step::Event(ServerEvent::Error {
        client_id,
        code: code.into(),
        message: "test error".into(),
    })
}

async fn connect(server: &ServerUrl) -> ChatConnection {
    timeout(
        WAIT,
        ChatConnection::connect(server, ConnectOptions::default()),
    )
    .await
    .expect("connect timed out")
    .expect("connect failed")
}

async fn send(conn: &mut ChatConnection, body: &str) -> SendOutcome {
    conn.send_message(body, true, WAIT).await
}

async fn next_item(watch: &mut ChatWatch) -> WatchItem {
    timeout(WAIT, watch.next())
        .await
        .expect("timed out waiting for a watch item")
}

fn fast_tuning() -> Tuning {
    Tuning {
        backoff_min: Duration::from_millis(10),
        backoff_max: Duration::from_millis(20),
        ..Tuning::DEFAULT
    }
}

// ----- pure helpers -------------------------------------------------------------------

#[test]
fn backoff_starts_at_one_second_doubles_and_caps_at_thirty() {
    let tuning = Tuning::DEFAULT;
    assert_eq!(backoff_delay(0, &tuning), Duration::from_secs(1));
    assert_eq!(backoff_delay(1, &tuning), Duration::from_secs(2));
    assert_eq!(backoff_delay(4, &tuning), Duration::from_secs(16));
    assert_eq!(backoff_delay(5, &tuning), Duration::from_secs(30));
    assert_eq!(backoff_delay(500, &tuning), Duration::from_secs(30));
}

#[test]
fn backoff_resets_only_after_a_long_lived_connection() {
    let tuning = Tuning::DEFAULT;
    // A connection that drops right after hello keeps growing the delay.
    assert_eq!(failures_after_disconnect(5, Duration::ZERO, &tuning), 5);
    assert_eq!(
        failures_after_disconnect(5, Duration::from_secs(29), &tuning),
        5
    );
    assert_eq!(
        failures_after_disconnect(5, Duration::from_secs(30), &tuning),
        0
    );
}

#[test]
fn websocket_url_uses_ws_schemes_and_keeps_base_path() {
    let plain = ServerUrl::parse("http://host:8080").unwrap();
    assert_eq!(
        websocket_url(&plain).unwrap().as_str(),
        "ws://host:8080/api/ws"
    );
    let secure = ServerUrl::parse("https://host:8443/base/").unwrap();
    assert_eq!(
        websocket_url(&secure).unwrap().as_str(),
        "wss://host:8443/base/api/ws"
    );
}

#[test]
fn invalid_dev_user_is_rejected_before_connecting() {
    let server = ServerUrl::parse("http://127.0.0.1:9").unwrap();
    let url = websocket_url(&server).unwrap();
    for bad in ["  ", "", "a\nb", "a\tb", "アリス"] {
        assert!(matches!(
            build_request(&url, Some(bad)),
            Err(WsError::InvalidDevUser)
        ));
    }
    assert!(build_request(&url, Some("alice@github")).is_ok());
}

#[test]
fn client_ids_are_unique_ulids() {
    let a = new_client_id();
    let b = new_client_id();
    assert_eq!(a.len(), 26);
    assert_ne!(a, b);
}

// ----- connect and hello gate ---------------------------------------------------------

#[tokio::test]
async fn connect_sends_dev_user_header_and_ignores_events_before_hello() {
    let seen = Arc::new(StdMutex::new(None::<(String, Option<String>)>));
    let server = {
        let seen = seen.clone();
        serve(move |_, stream| {
            let seen = seen.clone();
            async move {
                let callback = move |request: &Request,
                                     response: Response|
                      -> Result<Response, ErrorResponse> {
                    let header = request
                        .headers()
                        .get(DEV_USER_HEADER)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    *seen.lock().unwrap() = Some((request.uri().to_string(), header));
                    Ok(response)
                };
                let Ok(mut socket) = accept_hdr_async(stream, callback).await else {
                    return;
                };
                let _ = socket
                    .send(json(&ServerEvent::UserUpdated {
                        user: user("early"),
                    }))
                    .await;
                let _ = socket.send(json(&hello())).await;
                let _ = read_frame(&mut socket).await;
            }
        })
        .await
    };

    let options = ConnectOptions {
        dev_user: Some("a b&c".into()),
        ..ConnectOptions::default()
    };
    let conn = timeout(WAIT, ChatConnection::connect(&server, options))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(conn.me().login_name, "alice@test");
    assert_eq!(conn.users().len(), 1);

    let (uri, header) = seen.lock().unwrap().clone().expect("upgrade seen");
    assert_eq!(uri, "/api/ws", "dev_user must not be in the query string");
    assert_eq!(header.as_deref(), Some("a b&c"));
    conn.close().await;
}

#[tokio::test]
async fn closing_before_hello_is_a_protocol_error() {
    let server = serve(|_, stream| async move {
        if let Ok(mut socket) = accept_async(stream).await {
            let _ = socket.close(None).await;
        }
    })
    .await;
    let result = timeout(
        WAIT,
        ChatConnection::connect(&server, ConnectOptions::default()),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(WsError::Protocol(_))));
}

#[tokio::test]
async fn no_hello_within_hello_timeout_is_a_timeout() {
    let server = serve(|_, stream| async move {
        if let Ok(_socket) = accept_async(stream).await {
            tokio::time::sleep(WAIT).await;
        }
    })
    .await;
    let options = ConnectOptions {
        hello_timeout: Duration::from_millis(100),
        ..ConnectOptions::default()
    };
    let result = timeout(WAIT, ChatConnection::connect(&server, options))
        .await
        .unwrap();
    assert!(matches!(result, Err(WsError::Timeout)));
}

#[tokio::test]
async fn tcp_accept_without_upgrade_times_out_at_connect_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let server = ServerUrl::parse(&format!("http://{}", listener.local_addr().unwrap())).unwrap();
    let options = ConnectOptions {
        connect_timeout: Duration::from_millis(100),
        ..ConnectOptions::default()
    };
    let result = timeout(WAIT, ChatConnection::connect(&server, options))
        .await
        .unwrap();
    assert!(matches!(result, Err(WsError::Timeout)));
    drop(listener);
}

#[tokio::test]
async fn upgrade_rejection_is_an_http_error() {
    let server = serve(|_, stream| async move {
        let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
            Err(http::Response::builder()
                .status(401)
                .body(Some("denied".to_owned()))
                .unwrap())
        };
        let _ = accept_hdr_async(stream, callback).await;
    })
    .await;
    let result = timeout(
        WAIT,
        ChatConnection::connect(&server, ConnectOptions::default()),
    )
    .await
    .unwrap();
    assert!(matches!(result, Err(WsError::Http { status: 401 })));
}

// ----- send_message -------------------------------------------------------------------

#[tokio::test]
async fn confirmed_when_client_id_matches_and_unrelated_events_are_ignored() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| {
        vec![
            Step::Event(ServerEvent::MessageCreated {
                client_id: Some("someone-else".into()),
                message: message("m-other", "other"),
            }),
            Step::Event(ServerEvent::MessageCreated {
                client_id: None,
                message: message("m-broadcast", "broadcast"),
            }),
            ack(event),
        ]
    })
    .await;
    let mut conn = connect(&server).await;
    let outcome = send(&mut conn, "hi").await;
    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    match (&outcome, &sent[0]) {
        (
            SendOutcome::Confirmed { client_id, message },
            ClientEvent::MessageSend {
                client_id: sent_id,
                body,
                silent,
                reply_to,
                attachment_ids,
            },
        ) => {
            assert_eq!(client_id, sent_id);
            assert_eq!(message.body, "hi");
            assert_eq!(body, "hi");
            assert!(*silent);
            assert!(reply_to.is_none());
            assert!(attachment_ids.is_empty());
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    conn.close().await;
}

#[tokio::test]
async fn send_message_with_id_uses_the_callers_id_on_the_wire() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
    let mut conn = connect(&server).await;
    let id = new_client_id();
    match conn.send_message_with_id(&id, "hello", false, WAIT).await {
        SendOutcome::Confirmed { client_id, .. } => assert_eq!(client_id, id),
        other => panic!("unexpected outcome: {other:?}"),
    }
    assert_eq!(sent_ids(&seen), vec![id]);
    match conn.send_message_with_id("", "x", false, WAIT).await {
        SendOutcome::NotSent { .. } => {}
        other => panic!("unexpected outcome: {other:?}"),
    }
    conn.close().await;
}

#[tokio::test]
async fn allowlisted_error_for_this_send_is_rejected() {
    let server = serve_chat(new_seen(), |event| {
        vec![error_for(Some(client_id_of(event)), "body_too_long")]
    })
    .await;
    let mut conn = connect(&server).await;
    match send(&mut conn, "long").await {
        SendOutcome::Rejected {
            client_id: _,
            code,
            message,
        } => {
            assert_eq!(code, "body_too_long");
            assert_eq!(message, "test error");
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
}

#[tokio::test]
async fn errors_that_do_not_prove_refusal_stay_unknown_and_connection_survives() {
    let server = serve_chat(new_seen(), |event| match body_of(event).as_str() {
        "internal" => vec![error_for(Some(client_id_of(event)), "internal")],
        "unknown-code" => vec![error_for(Some(client_id_of(event)), "brand_new_code")],
        "no-id" => vec![error_for(None, "reply_not_found")],
        _ => vec![ack(event)],
    })
    .await;
    let mut conn = connect(&server).await;

    match send(&mut conn, "internal").await {
        SendOutcome::Unknown {
            reason: UnknownReason::ServerError { code, .. },
            ..
        } => assert_eq!(code, "internal"),
        other => panic!("unexpected outcome: {other:?}"),
    }
    match send(&mut conn, "unknown-code").await {
        SendOutcome::Unknown {
            reason: UnknownReason::ServerError { code, .. },
            ..
        } => assert_eq!(code, "brand_new_code"),
        other => panic!("unexpected outcome: {other:?}"),
    }
    match send(&mut conn, "no-id").await {
        SendOutcome::Unknown {
            reason: UnknownReason::ServerError { code, .. },
            ..
        } => assert_eq!(code, "reply_not_found"),
        other => panic!("unexpected outcome: {other:?}"),
    }
    assert!(matches!(
        send(&mut conn, "fine").await,
        SendOutcome::Confirmed { .. }
    ));
}

#[tokio::test]
async fn late_error_for_an_earlier_timed_out_send_does_not_affect_the_next_send() {
    // The first send is never acknowledged. Its error arrives while the second send waits.
    let first_id: Arc<StdMutex<Option<String>>> = Arc::new(StdMutex::new(None));
    let server = {
        let first_id = first_id.clone();
        serve_chat(new_seen(), move |event| {
            let id = client_id_of(event);
            let mut first = first_id.lock().unwrap();
            match first.clone() {
                None => {
                    *first = Some(id);
                    vec![]
                }
                Some(earlier) => vec![
                    error_for(Some(earlier), "body_too_long"),
                    error_for(Some("someone-else".into()), "reply_not_found"),
                    ack(event),
                ],
            }
        })
        .await
    };
    let mut conn = connect(&server).await;
    assert!(matches!(
        conn.send_message("first", false, Duration::from_millis(200))
            .await,
        SendOutcome::Unknown {
            reason: UnknownReason::Timeout,
            ..
        }
    ));
    match send(&mut conn, "second").await {
        SendOutcome::Confirmed { message, .. } => assert_eq!(message.body, "second"),
        other => panic!("second send was affected: {other:?}"),
    }
    conn.close().await;
}

#[tokio::test]
async fn missing_ack_is_unknown_timeout_and_connection_stays_usable() {
    let server = serve_chat(new_seen(), |event| match body_of(event).as_str() {
        "silent" => vec![],
        _ => vec![ack(event)],
    })
    .await;
    let mut conn = connect(&server).await;
    let outcome = conn
        .send_message("silent", false, Duration::from_millis(200))
        .await;
    assert!(matches!(
        outcome,
        SendOutcome::Unknown {
            reason: UnknownReason::Timeout,
            ..
        }
    ));
    assert!(matches!(
        send(&mut conn, "after").await,
        SendOutcome::Confirmed { .. }
    ));
}

#[tokio::test]
async fn disconnect_before_ack_is_unknown_and_later_sends_are_not_sent() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| match body_of(event).as_str() {
        "drop" => vec![Step::Close],
        _ => vec![ack(event)],
    })
    .await;
    let mut conn = connect(&server).await;
    assert!(matches!(
        send(&mut conn, "drop").await,
        SendOutcome::Unknown {
            reason: UnknownReason::Disconnected,
            ..
        }
    ));
    assert!(matches!(
        send(&mut conn, "after").await,
        SendOutcome::NotSent { .. }
    ));
    assert_eq!(sent_ids(&seen).len(), 1);
}

#[tokio::test]
async fn refused_inputs_write_nothing_to_the_server() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
    let mut conn = connect(&server).await;

    let too_long = "a".repeat(MAX_BODY_CHARS + 1);
    for body in ["", "   \n\t", too_long.as_str()] {
        assert!(matches!(
            send(&mut conn, body).await,
            SendOutcome::NotSent { .. }
        ));
    }
    // The first frame the server sees must be this valid one.
    assert!(matches!(
        send(&mut conn, "ok").await,
        SendOutcome::Confirmed { .. }
    ));
    let sent = seen.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert_eq!(body_of(&sent[0]), "ok");
}

#[tokio::test]
async fn body_at_the_limit_is_sent() {
    let server = serve_chat(new_seen(), |event| vec![ack(event)]).await;
    let mut conn = connect(&server).await;
    let body = "a".repeat(MAX_BODY_CHARS);
    assert!(matches!(
        send(&mut conn, &body).await,
        SendOutcome::Confirmed { .. }
    ));
}

#[tokio::test]
async fn unacknowledged_send_is_never_resent_after_reconnect() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |_| vec![]).await;
    let mut conn = connect(&server).await;
    assert!(matches!(
        conn.send_message("once", false, Duration::from_millis(200))
            .await,
        SendOutcome::Unknown {
            reason: UnknownReason::Timeout,
            ..
        }
    ));
    conn.close().await;

    let mut again = connect(&server).await;
    // Nothing may arrive on the new connection, so a resend would show up here.
    assert!(
        timeout(Duration::from_millis(300), again.next_event())
            .await
            .is_err()
    );
    assert_eq!(sent_ids(&seen).len(), 1);
    again.close().await;
}

#[tokio::test]
async fn send_is_refused_once_the_connection_has_been_silent_for_the_idle_timeout() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
    let options = ConnectOptions {
        idle_timeout: Duration::from_millis(100),
        ..ConnectOptions::default()
    };
    let mut conn = timeout(WAIT, ChatConnection::connect(&server, options))
        .await
        .unwrap()
        .unwrap();
    // Nothing reads the connection, so no pong is sent and the server would drop it.
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(matches!(
        send(&mut conn, "late").await,
        SendOutcome::NotSent { .. }
    ));
    assert!(sent_ids(&seen).is_empty());
}

// ----- next_event: ping, idle, size ---------------------------------------------------

#[tokio::test]
async fn ping_is_answered_with_pong_and_not_returned() {
    let (pongs, mut pong_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let server = serve(move |_, stream| {
        let pongs = pongs.clone();
        async move {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let _ = socket.send(WsMessage::Ping(b"p".to_vec().into())).await;
            let _ = socket.send(json(&ServerEvent::Pong)).await;
            while let Some(frame) = read_frame(&mut socket).await {
                if let WsMessage::Pong(payload) = frame {
                    let _ = pongs.send(payload.to_vec());
                    break;
                }
            }
        }
    })
    .await;

    let mut conn = connect(&server).await;
    assert!(matches!(
        timeout(WAIT, conn.next_event()).await.unwrap(),
        Ok(ServerEvent::Pong)
    ));
    let payload = timeout(WAIT, pong_rx.recv()).await.unwrap().unwrap();
    assert_eq!(payload, b"p");
    conn.close().await;
}

#[tokio::test]
async fn pings_keep_an_otherwise_quiet_connection_alive() {
    // Pings arrive every 50 ms for 300 ms, longer than the 200 ms idle timeout.
    let server = serve(|_, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let _ = socket.send(WsMessage::Ping(Vec::new().into())).await;
        }
        let _ = socket
            .send(json(&ServerEvent::UserUpdated {
                user: user("after-pings"),
            }))
            .await;
        let _ = read_frame(&mut socket).await;
    })
    .await;
    let options = ConnectOptions {
        idle_timeout: Duration::from_millis(200),
        ..ConnectOptions::default()
    };
    let mut conn = timeout(WAIT, ChatConnection::connect(&server, options))
        .await
        .unwrap()
        .unwrap();
    match timeout(WAIT, conn.next_event()).await.unwrap() {
        Ok(ServerEvent::UserUpdated { user }) => assert_eq!(user.login_name, "after-pings"),
        other => panic!("connection dropped during pings: {other:?}"),
    }
    conn.close().await;
}

#[tokio::test]
async fn silence_past_the_idle_timeout_is_a_disconnect() {
    let server = serve(|_, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        tokio::time::sleep(WAIT).await;
    })
    .await;
    let options = ConnectOptions {
        idle_timeout: Duration::from_millis(150),
        ..ConnectOptions::default()
    };
    let mut conn = timeout(WAIT, ChatConnection::connect(&server, options))
        .await
        .unwrap()
        .unwrap();
    match timeout(WAIT, conn.next_event()).await.unwrap() {
        Err(Disconnected { reason }) => assert_eq!(reason, "idle timeout"),
        other => panic!("expected idle disconnect: {other:?}"),
    }
}

#[tokio::test]
async fn oversized_message_is_a_disconnect_not_a_huge_allocation() {
    let server = serve(|_, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        let huge = "x".repeat(MAX_MESSAGE_BYTES + 1024);
        let _ = socket.send(WsMessage::Text(huge.into())).await;
        let _ = read_frame(&mut socket).await;
    })
    .await;
    let mut conn = connect(&server).await;
    assert!(matches!(
        timeout(WAIT, conn.next_event()).await.unwrap(),
        Err(Disconnected { .. })
    ));
}

// ----- ChatWatch ----------------------------------------------------------------------

#[tokio::test]
async fn watch_reports_events_gap_and_reconnect_generation() {
    let server = serve(|index, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        let marker = if index == 0 { "one" } else { "two" };
        let _ = socket
            .send(json(&ServerEvent::UserUpdated { user: user(marker) }))
            .await;
        if index == 0 {
            let _ = socket.close(None).await;
        } else {
            let _ = read_frame(&mut socket).await;
        }
    })
    .await;

    let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), fast_tuning())
        .await
        .unwrap();
    match next_item(&mut watch).await {
        WatchItem::Connected {
            generation,
            me,
            users,
        } => {
            assert_eq!(generation, 1);
            assert_eq!(me.login_name, "alice@test");
            assert_eq!(users.len(), 1);
        }
        other => panic!("unexpected item: {other:?}"),
    }
    match next_item(&mut watch).await {
        WatchItem::Event {
            generation,
            event: ServerEvent::UserUpdated { user },
        } => {
            assert_eq!(generation, 1);
            assert_eq!(user.login_name, "one");
        }
        other => panic!("unexpected item: {other:?}"),
    }
    assert!(matches!(
        next_item(&mut watch).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    match next_item(&mut watch).await {
        WatchItem::Connected { generation, .. } => assert_eq!(generation, 2),
        other => panic!("unexpected item: {other:?}"),
    }
    match next_item(&mut watch).await {
        WatchItem::Event {
            generation,
            event: ServerEvent::UserUpdated { user },
        } => {
            assert_eq!(generation, 2);
            assert_eq!(user.login_name, "two");
        }
        other => panic!("unexpected item: {other:?}"),
    }
    watch.close().await;
}

#[tokio::test]
async fn watch_treats_idle_silence_as_a_disconnect_and_reconnects() {
    let server = serve(|index, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        if index == 0 {
            // Silent: the client must notice through its idle timeout.
            tokio::time::sleep(WAIT).await;
        } else {
            let _ = socket
                .send(json(&ServerEvent::UserUpdated {
                    user: user("second"),
                }))
                .await;
            let _ = read_frame(&mut socket).await;
        }
    })
    .await;
    let options = ConnectOptions {
        idle_timeout: Duration::from_millis(150),
        ..ConnectOptions::default()
    };
    let mut watch = ChatWatch::start_with(&server, options, fast_tuning())
        .await
        .unwrap();
    assert!(matches!(
        next_item(&mut watch).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    match next_item(&mut watch).await {
        WatchItem::Gap { generation, reason } => {
            assert_eq!(generation, 1);
            assert_eq!(reason, "idle timeout");
        }
        other => panic!("unexpected item: {other:?}"),
    }
    assert!(matches!(
        next_item(&mut watch).await,
        WatchItem::Connected { generation: 2, .. }
    ));
    assert!(matches!(
        next_item(&mut watch).await,
        WatchItem::Event { generation: 2, .. }
    ));
    watch.close().await;
}

#[tokio::test]
async fn watch_start_failure_is_returned_without_retrying() {
    let server = serve(|_, stream| async move {
        let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
            Err(http::Response::builder()
                .status(403)
                .body(Some("forbidden".to_owned()))
                .unwrap())
        };
        let _ = accept_hdr_async(stream, callback).await;
    })
    .await;
    let result = timeout(WAIT, ChatWatch::start(&server, ConnectOptions::default()))
        .await
        .unwrap();
    assert!(matches!(result, Err(WsError::Http { status: 403 })));
}

#[tokio::test]
async fn rejected_reconnect_is_terminal_and_sticky() {
    let server = serve(|index, stream| async move {
        if index == 0 {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let _ = socket.close(None).await;
        } else {
            let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
                Err(http::Response::builder()
                    .status(401)
                    .body(Some("denied".to_owned()))
                    .unwrap())
            };
            let _ = accept_hdr_async(stream, callback).await;
        }
    })
    .await;
    let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), fast_tuning())
        .await
        .unwrap();
    assert!(matches!(
        next_item(&mut watch).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        next_item(&mut watch).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    for _ in 0..2 {
        match next_item(&mut watch).await {
            WatchItem::Failed {
                http_status: Some(401),
                ..
            } => {}
            other => panic!("expected a sticky Failed: {other:?}"),
        }
    }
}

#[tokio::test]
async fn watch_overflow_is_reported_as_lagged_gap() {
    let server = serve(|_, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        for n in 0..10 {
            let _ = socket
                .send(json(&ServerEvent::UserUpdated {
                    user: user(&format!("u{n}")),
                }))
                .await;
        }
        let _ = read_frame(&mut socket).await;
    })
    .await;

    let tuning = Tuning {
        queue_capacity: 3,
        ..fast_tuning()
    };
    let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), tuning)
        .await
        .unwrap();
    // Let the background task read every event before the consumer drains the queue.
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut lagged = false;
    let mut events = Vec::new();
    loop {
        match timeout(Duration::from_millis(500), watch.next()).await {
            Err(_) => break,
            Ok(WatchItem::Gap { reason, .. }) if reason == LAGGED => lagged = true,
            Ok(WatchItem::Event {
                event: ServerEvent::UserUpdated { user },
                ..
            }) => events.push(user.login_name),
            Ok(_) => {}
        }
    }
    assert!(lagged, "queue overflow must produce a lagged gap");
    assert!(events.len() < 10);
    assert!(events.windows(2).all(|pair| pair[0] < pair[1]));
    watch.close().await;
}

#[tokio::test]
async fn flapping_server_cannot_grow_the_queue_without_bound() {
    // Every connection says hello and then closes. The consumer does not read for a while.
    let server = serve(|_, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        let _ = socket.close(None).await;
    })
    .await;
    let tuning = Tuning {
        queue_capacity: 4,
        ..fast_tuning()
    };
    let mut watch = ChatWatch::start_with(&server, ConnectOptions::default(), tuning)
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let queued = watch.session.shared.lock().queue.len();
    assert!(queued <= 4, "queue holds {queued} items");

    // Reconnects keep going while we drain, so only the first few items are inspected.
    let mut items = Vec::new();
    for _ in 0..4 {
        match timeout(Duration::from_millis(200), watch.next()).await {
            Ok(item) => items.push(item),
            Err(_) => break,
        }
    }
    assert!(
        items
            .iter()
            .any(|item| matches!(item, WatchItem::Gap { reason, .. } if reason == LAGGED))
    );
    watch.close().await;
}

// ----- ChatSession ---------------------------------------------------------------------

fn created(event: &ClientEvent) -> ServerEvent {
    ServerEvent::MessageCreated {
        client_id: Some(client_id_of(event)),
        message: message("m-created", &body_of(event)),
    }
}

async fn start_session(server: &ServerUrl, tuning: Tuning) -> ChatSession {
    timeout(
        WAIT,
        ChatSession::start_with(server, ConnectOptions::default(), tuning),
    )
    .await
    .expect("session start timed out")
    .expect("session start failed")
}

/// Next item, including `Connecting`.
async fn next_session_raw(session: &mut ChatSession) -> WatchItem {
    timeout(WAIT, session.next())
        .await
        .expect("timed out waiting for a session item")
}

/// Next item, skipping `Connecting`, for tests that do not look at reconnect attempts.
async fn next_session(session: &mut ChatSession) -> WatchItem {
    loop {
        match next_session_raw(session).await {
            WatchItem::Connecting { .. } => continue,
            item => return item,
        }
    }
}

#[tokio::test]
async fn session_confirms_send_and_streams_the_created_event() {
    let server = serve_chat(new_seen(), |event| vec![ack(event)]).await;
    let mut session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    match sender.send("c-1", "hello", false, WAIT).await {
        SendOutcome::Confirmed { client_id, message } => {
            assert_eq!(client_id, "c-1");
            assert_eq!(message.body, "hello");
        }
        other => panic!("unexpected outcome: {other:?}"),
    }
    match next_session(&mut session).await {
        WatchItem::Connected {
            generation: 1,
            users,
            ..
        } => {
            assert_eq!(users.len(), 1);
            assert_eq!(users[0].login_name, "alice@test");
        }
        other => panic!("unexpected item: {other:?}"),
    }
    // The confirmation is also an ordinary event, with its client_id still attached.
    match next_session(&mut session).await {
        WatchItem::Event {
            generation: 1,
            event:
                ServerEvent::MessageCreated {
                    client_id: Some(id),
                    message,
                },
        } => {
            assert_eq!(id, "c-1");
            assert_eq!(message.body, "hello");
        }
        other => panic!("unexpected item: {other:?}"),
    }
    session.close().await;
}

#[tokio::test]
async fn session_send_while_reconnecting_is_not_sent_and_writes_nothing() {
    let seen = new_seen();
    let server = {
        let seen = seen.clone();
        serve(move |index, stream| {
            let seen = seen.clone();
            async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let _ = socket.send(json(&hello())).await;
                if index == 0 {
                    let _ = socket.close(None).await;
                    return;
                }
                while let Some(event) = read_client(&mut socket).await {
                    seen.lock().unwrap().push(event.clone());
                    let _ = socket.send(json(&created(&event))).await;
                }
            }
        })
        .await
    };
    let tuning = Tuning {
        backoff_min: Duration::from_millis(400),
        backoff_max: Duration::from_millis(400),
        ..Tuning::DEFAULT
    };
    let mut session = start_session(&server, tuning).await;
    let sender = session.sender();
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    // The session is backing off now: the send is refused and nothing reaches the server.
    assert!(matches!(
        sender.send("c-offline", "x", false, WAIT).await,
        SendOutcome::NotSent { .. }
    ));
    assert!(seen.lock().unwrap().is_empty());

    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Connected { generation: 2, .. }
    ));
    assert!(matches!(
        sender.send("c-online", "y", false, WAIT).await,
        SendOutcome::Confirmed { .. }
    ));
    assert_eq!(sent_ids(&seen), vec!["c-online".to_owned()]);
    session.close().await;
}

#[tokio::test]
async fn session_disconnect_before_ack_is_unknown_and_never_resent() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| match body_of(event).as_str() {
        "drop" => vec![Step::Close],
        _ => vec![ack(event)],
    })
    .await;
    let mut session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    assert!(matches!(
        sender.send("c-drop", "drop", false, WAIT).await,
        SendOutcome::Unknown {
            reason: UnknownReason::Disconnected,
            ..
        }
    ));
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Connected { generation: 2, .. }
    ));
    // Give the new connection time to receive anything that would be a resend.
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(sent_ids(&seen), vec!["c-drop".to_owned()]);
    session.close().await;
}

#[tokio::test]
async fn session_settles_concurrent_sends_independently() {
    // One error for another client arrives first, then both sends are answered in reverse.
    let server = serve(|_, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        let mut got = Vec::new();
        while got.len() < 2 {
            match read_client(&mut socket).await {
                Some(event) => got.push(event),
                None => return,
            }
        }
        let _ = socket
            .send(json(&ServerEvent::Error {
                client_id: Some("someone-else".into()),
                code: "body_too_long".into(),
                message: "not yours".into(),
            }))
            .await;
        for event in got.iter().rev() {
            let _ = socket.send(json(&created(event))).await;
        }
        let _ = read_frame(&mut socket).await;
    })
    .await;
    let session = start_session(&server, fast_tuning()).await;
    let a = session.sender();
    let b = a.clone();
    let (ra, rb) = tokio::join!(
        a.send("c-a", "from a", false, WAIT),
        b.send("c-b", "from b", false, WAIT)
    );
    match ra {
        SendOutcome::Confirmed { client_id, message } => {
            assert_eq!(client_id, "c-a");
            assert_eq!(message.body, "from a");
        }
        other => panic!("unexpected outcome for a: {other:?}"),
    }
    match rb {
        SendOutcome::Confirmed { client_id, message } => {
            assert_eq!(client_id, "c-b");
            assert_eq!(message.body, "from b");
        }
        other => panic!("unexpected outcome for b: {other:?}"),
    }
    session.close().await;
}

#[tokio::test]
async fn session_refuses_duplicate_pending_id_and_times_out_unacked_sends() {
    let seen = new_seen();
    // Never acknowledges anything.
    let server = serve_chat(seen.clone(), |_| vec![]).await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    let first = {
        let sender = sender.clone();
        tokio::spawn(async move {
            sender
                .send("c-1", "one", false, Duration::from_millis(300))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(matches!(
        sender.send("c-1", "again", false, WAIT).await,
        SendOutcome::NotSent { .. }
    ));
    assert!(matches!(
        first.await.unwrap(),
        SendOutcome::Unknown {
            reason: UnknownReason::Timeout,
            ..
        }
    ));
    assert_eq!(sent_ids(&seen), vec!["c-1".to_owned()]);
    // An ack timeout does not end the session: the next send is still written.
    assert!(matches!(
        sender
            .send("c-2", "two", false, Duration::from_millis(100))
            .await,
        SendOutcome::Unknown {
            reason: UnknownReason::Timeout,
            ..
        }
    ));
    assert_eq!(sent_ids(&seen).len(), 2);
    session.close().await;
}

#[tokio::test]
async fn closing_the_session_settles_pending_sends_and_later_sends_are_not_sent() {
    let server = serve_chat(new_seen(), |_| vec![]).await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    let pending = {
        let sender = sender.clone();
        tokio::spawn(async move { sender.send("c-open", "open", false, WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    session.close().await;
    assert!(matches!(
        pending.await.unwrap(),
        SendOutcome::Unknown {
            reason: UnknownReason::Disconnected,
            ..
        }
    ));
    assert!(matches!(
        sender.send("c-late", "late", false, WAIT).await,
        SendOutcome::NotSent { .. }
    ));
}

#[tokio::test]
async fn dropping_the_session_settles_pending_sends_as_unknown() {
    let server = serve_chat(new_seen(), |_| vec![]).await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    let pending = {
        let sender = sender.clone();
        tokio::spawn(async move { sender.send("c-drop-owner", "x", false, WAIT).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(session);
    assert!(matches!(
        pending.await.unwrap(),
        SendOutcome::Unknown {
            reason: UnknownReason::Disconnected,
            ..
        }
    ));
    assert!(matches!(
        sender.send("c-after", "x", false, WAIT).await,
        SendOutcome::NotSent { .. }
    ));
}

#[tokio::test]
async fn session_reports_terminal_failure_and_refuses_later_sends() {
    let server = serve(|index, stream| async move {
        if index == 0 {
            let Ok(mut socket) = accept_async(stream).await else {
                return;
            };
            let _ = socket.send(json(&hello())).await;
            let _ = socket.close(None).await;
        } else {
            let callback = |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
                Err(http::Response::builder()
                    .status(403)
                    .body(Some("forbidden".to_owned()))
                    .unwrap())
            };
            let _ = accept_hdr_async(stream, callback).await;
        }
    })
    .await;
    let mut session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        next_session(&mut session).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    for _ in 0..2 {
        assert!(matches!(
            next_session(&mut session).await,
            WatchItem::Failed {
                http_status: Some(403),
                ..
            }
        ));
    }
    assert!(matches!(
        sender.send("c-dead", "x", false, WAIT).await,
        SendOutcome::NotSent { .. }
    ));
    session.close().await;
}

fn outgoing_request(event: &ClientEvent) -> Option<SendRequest> {
    match event {
        ClientEvent::MessageSend {
            body,
            attachment_ids,
            reply_to,
            silent,
            ..
        } => Some(SendRequest {
            body: body.clone(),
            attachment_ids: attachment_ids.clone(),
            reply_to: reply_to.clone(),
            silent: *silent,
        }),
        _ => None,
    }
}

#[tokio::test]
async fn send_request_puts_every_option_on_the_wire() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();

    let reply = SendRequest {
        body: "a reply".into(),
        reply_to: Some("m-parent".into()),
        silent: true,
        ..SendRequest::default()
    };
    assert!(matches!(
        sender.send_request("c-reply", reply.clone(), WAIT).await,
        SendOutcome::Confirmed { .. }
    ));
    // An attachment-only message is valid; the body may be empty.
    let attachments = SendRequest {
        attachment_ids: vec!["f-1".into(), "f-2".into()],
        ..SendRequest::default()
    };
    assert!(matches!(
        sender
            .send_request("c-files", attachments.clone(), WAIT)
            .await,
        SendOutcome::Confirmed { .. }
    ));

    let sent: Vec<SendRequest> = seen
        .lock()
        .unwrap()
        .iter()
        .filter_map(outgoing_request)
        .collect();
    assert_eq!(sent, vec![reply, attachments]);
    session.close().await;
}

#[tokio::test]
async fn send_request_refuses_empty_content_and_empty_ids_without_writing() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |event| vec![ack(event)]).await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    let refused = [
        SendRequest::default(),
        SendRequest {
            body: "  ".into(),
            ..SendRequest::default()
        },
        SendRequest {
            body: "x".into(),
            reply_to: Some(String::new()),
            ..SendRequest::default()
        },
        SendRequest {
            body: "x".into(),
            attachment_ids: vec!["f".into(), String::new()],
            ..SendRequest::default()
        },
    ];
    for request in refused {
        assert!(matches!(
            sender.send_request("c-bad", request, WAIT).await,
            SendOutcome::NotSent { .. }
        ));
    }
    assert!(seen.lock().unwrap().is_empty());
    session.close().await;
}

#[tokio::test]
async fn each_allowlisted_code_is_rejected_and_other_codes_are_unknown() {
    // The body names the error code the server answers with.
    let server = serve_chat(new_seen(), |event| {
        vec![error_for(Some(client_id_of(event)), &body_of(event))]
    })
    .await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    for code in REJECTED_CODES {
        match sender.send("c-code", code, false, WAIT).await {
            SendOutcome::Rejected { code: got, .. } => assert_eq!(got, code),
            other => panic!("{code} should be Rejected: {other:?}"),
        }
    }
    match sender.send("c-other", "internal", false, WAIT).await {
        SendOutcome::Unknown {
            reason: UnknownReason::ServerError { code, .. },
            ..
        } => assert_eq!(code, "internal"),
        other => panic!("unexpected outcome: {other:?}"),
    }
    session.close().await;
}

#[tokio::test]
async fn emit_writes_the_event_and_refuses_message_send() {
    let seen = new_seen();
    let server = serve_chat(seen.clone(), |_| vec![]).await;
    let session = start_session(&server, fast_tuning()).await;
    let sender = session.sender();
    assert_eq!(
        sender
            .emit(ClientEvent::ReactionAdd {
                message_id: "m-1".into(),
                emoji: "+1".into(),
            })
            .await,
        Ok(())
    );
    assert_eq!(
        sender
            .emit(ClientEvent::MessageSend {
                client_id: "c-x".into(),
                body: "sneaky".into(),
                attachment_ids: Vec::new(),
                reply_to: None,
                silent: false,
            })
            .await,
        Err(EmitError::SendNotAllowed)
    );
    // Let the server read the frame before checking what it received.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let events = seen.lock().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert!(matches!(
        &events[0],
        ClientEvent::ReactionAdd { message_id, .. } if message_id == "m-1"
    ));
    session.close().await;
}

#[tokio::test]
async fn emit_and_send_while_reconnecting_are_refused_without_writing() {
    let seen = new_seen();
    let server = {
        let seen = seen.clone();
        serve(move |index, stream| {
            let seen = seen.clone();
            async move {
                let Ok(mut socket) = accept_async(stream).await else {
                    return;
                };
                let _ = socket.send(json(&hello())).await;
                if index == 0 {
                    let _ = socket.close(None).await;
                    return;
                }
                while let Some(event) = read_client(&mut socket).await {
                    seen.lock().unwrap().push(event);
                }
            }
        })
        .await
    };
    let tuning = Tuning {
        backoff_min: Duration::from_millis(400),
        backoff_max: Duration::from_millis(400),
        ..Tuning::DEFAULT
    };
    let mut session = start_session(&server, tuning).await;
    let sender = session.sender();
    assert!(matches!(
        next_session_raw(&mut session).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        next_session_raw(&mut session).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    assert_eq!(
        sender
            .emit(ClientEvent::ReactionRemove {
                message_id: "m-1".into(),
                emoji: "+1".into(),
            })
            .await,
        Err(EmitError::NotConnected)
    );
    assert!(matches!(
        sender.send("c-off", "x", false, WAIT).await,
        SendOutcome::NotSent { .. }
    ));
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(seen.lock().unwrap().is_empty());
    session.close().await;
}

#[tokio::test]
async fn reconnect_now_is_ignored_while_connected_and_wakes_a_backoff() {
    // Connection 0 drops at once, connection 1 drops after 200 ms, later ones stay open.
    let server = serve(|index, stream| async move {
        let Ok(mut socket) = accept_async(stream).await else {
            return;
        };
        let _ = socket.send(json(&hello())).await;
        match index {
            0 => {
                let _ = socket.close(None).await;
            }
            1 => {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let _ = socket.close(None).await;
            }
            _ => {
                let _ = read_frame(&mut socket).await;
            }
        }
    })
    .await;
    // A 2 s backoff (jittered to 1-2 s) so the two checks below can tell the two cases apart.
    let tuning = Tuning {
        backoff_min: Duration::from_secs(2),
        backoff_max: Duration::from_secs(2),
        ..Tuning::DEFAULT
    };
    let mut session = start_session(&server, tuning).await;
    // Called while connected, before the drop is seen: must not shorten the backoff.
    session.reconnect_now();
    assert!(matches!(
        next_session_raw(&mut session).await,
        WatchItem::Connected { generation: 1, .. }
    ));
    assert!(matches!(
        next_session_raw(&mut session).await,
        WatchItem::Gap { generation: 1, .. }
    ));
    let backoff_started = tokio::time::Instant::now();
    assert!(matches!(
        timeout(Duration::from_secs(5), session.next()).await,
        Ok(WatchItem::Connecting { attempt: 1 })
    ));
    assert!(
        backoff_started.elapsed() >= Duration::from_millis(900),
        "the early reconnect_now must not have skipped the backoff"
    );
    assert!(matches!(
        next_session_raw(&mut session).await,
        WatchItem::Connected { generation: 2, .. }
    ));
    assert!(matches!(
        next_session_raw(&mut session).await,
        WatchItem::Gap { generation: 2, .. }
    ));
    // Now the backoff is running again. reconnect_now must end it at once.
    let woken_at = tokio::time::Instant::now();
    session.reconnect_now();
    match timeout(Duration::from_millis(800), session.next()).await {
        Ok(WatchItem::Connecting { attempt: 1 }) => {}
        other => panic!("reconnect_now did not wake the backoff: {other:?}"),
    }
    assert!(matches!(
        timeout(Duration::from_secs(1), session.next()).await,
        Ok(WatchItem::Connected { generation: 3, .. })
    ));
    assert!(woken_at.elapsed() < Duration::from_secs(1));
    session.close().await;
}
