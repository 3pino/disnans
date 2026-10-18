//! セッションを開いている人の一覧（`session.open` / `session.close` / `session.presence`）の結合テスト。

mod common;

use common::{TestServer, WsClient};
use disnans_shared::{Card, ClientEvent, CreateSession, ServerEvent, Session, User};
use serde_json::json;

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";
const CAROL: &str = "carol@test";

async fn new_session(server: &TestServer) -> Session {
    let req = CreateSession {
        plugin: "dice".into(),
        state: json!({ "schema": 1 }),
        card: Card {
            title: "サイコロ".into(),
            text: String::new(),
        },
    };
    let res = server
        .post_json(ALICE, "/api/sessions", &req)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn user_id(server: &TestServer, who: &str) -> String {
    let me: User = server.get_json(who, "/api/me").await;
    me.id
}

/// この session の一覧が届くまで待つ（届いた順の最初の1件）。
async fn presence_of(client: &mut WsClient, session_id: &str) -> Vec<String> {
    let event = client
        .recv_until(
            |e| matches!(e, ServerEvent::SessionPresence { session_id: s, .. } if s == session_id),
        )
        .await;
    let ServerEvent::SessionPresence { mut user_ids, .. } = event else {
        unreachable!()
    };
    user_ids.sort();
    user_ids
}

/// ping の返事まで受け取り、その間に一覧が届いていないことを確かめる。
async fn no_presence(client: &mut WsClient) {
    client.send(ClientEvent::Ping).await;
    loop {
        match client.recv_any().await {
            ServerEvent::Pong => break,
            ServerEvent::SessionPresence { .. } => panic!("一覧が届くはずではありません"),
            _ => {}
        }
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

#[tokio::test]
async fn only_openers_hear_about_who_is_open() {
    let server = TestServer::start().await;
    let alice_id = user_id(&server, ALICE).await;
    let bob_id = user_id(&server, BOB).await;
    let session = new_session(&server).await;
    let sid = session.id.as_str();

    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let mut carol = server.ws(CAROL).await;

    // 開いたら、いまの一覧が自分に返る
    alice
        .send(ClientEvent::SessionOpen {
            session_id: sid.into(),
        })
        .await;
    assert_eq!(presence_of(&mut alice, sid).await, [alice_id.clone()]);

    bob.send(ClientEvent::SessionOpen {
        session_id: sid.into(),
    })
    .await;
    let both = sorted(vec![alice_id.clone(), bob_id.clone()]);
    assert_eq!(presence_of(&mut bob, sid).await, both);
    // 開いている alice にも変化が届く
    assert_eq!(presence_of(&mut alice, sid).await, both);

    // 開いていない carol には届かない
    no_presence(&mut carol).await;

    // 閉じた bob には、もう届かない。alice には一覧が戻る
    bob.send(ClientEvent::SessionClose {
        session_id: sid.into(),
    })
    .await;
    assert_eq!(presence_of(&mut alice, sid).await, [alice_id]);
    no_presence(&mut bob).await;
}

#[tokio::test]
async fn same_user_on_two_devices_counts_once() {
    let server = TestServer::start().await;
    let alice_id = user_id(&server, ALICE).await;
    let bob_id = user_id(&server, BOB).await;
    let session = new_session(&server).await;
    let sid = session.id.as_str();

    let mut alice = server.ws(ALICE).await;
    let mut alice2 = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    bob.send(ClientEvent::SessionOpen {
        session_id: sid.into(),
    })
    .await;
    assert_eq!(presence_of(&mut bob, sid).await, [bob_id.clone()]);

    alice
        .send(ClientEvent::SessionOpen {
            session_id: sid.into(),
        })
        .await;
    let both = sorted(vec![alice_id.clone(), bob_id.clone()]);
    assert_eq!(presence_of(&mut bob, sid).await, both);

    // 同じ人の2台目。1人のまま（一覧は変わらない）
    alice2
        .send(ClientEvent::SessionOpen {
            session_id: sid.into(),
        })
        .await;
    assert_eq!(presence_of(&mut bob, sid).await, both);

    // 片方の端末を閉じても、もう片方が開いているあいだは残る
    alice
        .send(ClientEvent::SessionClose {
            session_id: sid.into(),
        })
        .await;
    assert_eq!(presence_of(&mut bob, sid).await, both);

    // 両方閉じたら消える
    alice2
        .send(ClientEvent::SessionClose {
            session_id: sid.into(),
        })
        .await;
    assert_eq!(presence_of(&mut bob, sid).await, [bob_id]);
}

#[tokio::test]
async fn a_dropped_connection_closes_its_sessions() {
    let server = TestServer::start().await;
    let session = new_session(&server).await;
    let sid = session.id.as_str();
    let bob_id = user_id(&server, BOB).await;

    let mut bob = server.ws(BOB).await;
    let mut alice = server.ws(ALICE).await;
    bob.send(ClientEvent::SessionOpen {
        session_id: sid.into(),
    })
    .await;
    assert_eq!(presence_of(&mut bob, sid).await, [bob_id.clone()]);

    alice
        .send(ClientEvent::SessionOpen {
            session_id: sid.into(),
        })
        .await;
    assert_eq!(
        presence_of(&mut bob, sid).await,
        sorted(vec![bob_id.clone(), user_id(&server, ALICE).await])
    );

    // 切断（画面を閉じた・電波が切れた）したら、自動で閉じる
    drop(alice);
    assert_eq!(presence_of(&mut bob, sid).await, [bob_id]);
}

#[tokio::test]
async fn unknown_session_is_not_found() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    alice
        .send(ClientEvent::SessionOpen {
            session_id: "01NOPE".into(),
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "not_found");
}
