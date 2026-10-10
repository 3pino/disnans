//! 通話（参加者の管理・中継・kick）の結合テスト。

mod common;

use std::time::Duration;

use common::TestServer;
use disnans_shared::{CallStatus, ClientEvent, ServerEvent, User};
use serde_json::json;

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";
const CAROL: &str = "carol@test";

fn status(muted: bool) -> CallStatus {
    CallStatus {
        muted,
        deafened: false,
        rtc: true,
        device: Some("laptop".into()),
    }
}

fn join(peer: &str) -> ClientEvent {
    ClientEvent::CallJoin {
        peer: peer.into(),
        status: status(false),
    }
}

fn is_state(e: &ServerEvent) -> bool {
    matches!(e, ServerEvent::CallState { .. })
}

async fn members(c: &mut common::WsClient) -> Vec<(String, String, bool)> {
    match c.recv_until(is_state).await {
        ServerEvent::CallState { members } => members
            .into_iter()
            .map(|m| (m.peer, m.user_id, m.status.muted))
            .collect(),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn join_update_leave_are_broadcast_to_everyone() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    // 参加していない人にも一覧が届く
    alice.send(join("aaa")).await;
    let m = members(&mut bob).await;
    assert_eq!(m, vec![("aaa".into(), alice_user.id.clone(), false)]);
    assert_eq!(members(&mut alice).await.len(), 1);

    alice
        .send(ClientEvent::CallUpdate {
            status: status(true),
        })
        .await;
    assert!(members(&mut bob).await[0].2);

    alice.send(ClientEvent::CallLeave).await;
    assert!(members(&mut bob).await.is_empty());
}

#[tokio::test]
async fn new_connection_receives_the_current_members_only_when_in_a_call() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    alice.send(join("aaa")).await;
    alice.recv_until(is_state).await;

    let mut bob = server.ws(BOB).await;
    assert_eq!(members(&mut bob).await.len(), 1);
}

#[tokio::test]
async fn disconnect_removes_the_member() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    bob.send(join("bbb")).await;
    assert_eq!(members(&mut alice).await.len(), 1);
    drop(bob);
    assert!(members(&mut alice).await.is_empty());
}

#[tokio::test]
async fn emit_reaches_only_other_members_with_the_sender_peer() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let mut carol = server.ws(CAROL).await;
    alice.send(join("aaa")).await;
    bob.send(join("bbb")).await;
    for c in [&mut alice, &mut bob, &mut carol] {
        c.recv_until(|e| matches!(e, ServerEvent::CallState { members } if members.len() == 2))
            .await;
    }

    alice
        .send(ClientEvent::CallEmit {
            name: "signal".into(),
            payload: json!({ "to": "bbb" }),
        })
        .await;
    let ServerEvent::CallEvent {
        peer,
        from,
        name,
        payload,
    } = bob
        .recv_until(|e| matches!(e, ServerEvent::CallEvent { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(peer, "aaa");
    assert_eq!(from, alice_user.id);
    assert_eq!(name, "signal");
    assert_eq!(payload, json!({ "to": "bbb" }));
    // 参加していない人と、送った本人には届かない
    carol.assert_silent(Duration::from_millis(200)).await;
    alice.assert_silent(Duration::from_millis(200)).await;

    // 参加していない人は送れない
    carol
        .send(ClientEvent::CallEmit {
            name: "signal".into(),
            payload: json!(null),
        })
        .await;
    assert_eq!(carol.expect_error().await.1, "not_in_call");
    bob.assert_silent(Duration::from_millis(200)).await;

    // 大きすぎる payload
    alice
        .send(ClientEvent::CallEmit {
            name: "audio".into(),
            payload: json!("x".repeat(64 * 1024)),
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "payload_too_large");
}

#[tokio::test]
async fn kick_removes_the_target_and_notifies_it() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let mut carol = server.ws(CAROL).await;
    alice.send(join("aaa")).await;
    bob.send(join("bbb")).await;
    for c in [&mut alice, &mut bob, &mut carol] {
        c.recv_until(|e| matches!(e, ServerEvent::CallState { members } if members.len() == 2))
            .await;
    }

    alice
        .send(ClientEvent::CallKick { peer: "bbb".into() })
        .await;
    let ServerEvent::CallKicked { by } = bob
        .recv_until(|e| matches!(e, ServerEvent::CallKicked { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(by, alice_user.id);
    let m = members(&mut alice).await;
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].0, "aaa");
    // 外された人は、もう中継を受け取れない・送れない
    bob.send(ClientEvent::CallEmit {
        name: "signal".into(),
        payload: json!(null),
    })
    .await;
    assert_eq!(bob.expect_error().await.1, "not_in_call");

    // 通話にいない人は kick できない。自分自身・存在しない参加者もできない
    carol
        .send(ClientEvent::CallKick { peer: "aaa".into() })
        .await;
    assert_eq!(carol.expect_error().await.1, "not_in_call");
    alice
        .send(ClientEvent::CallKick { peer: "aaa".into() })
        .await;
    assert_eq!(alice.expect_error().await.1, "invalid_kick");
    alice
        .send(ClientEvent::CallKick { peer: "zzz".into() })
        .await;
    assert_eq!(alice.expect_error().await.1, "peer_not_found");
}

#[tokio::test]
async fn join_validates_the_peer_id() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.send(join("bad id")).await;
    assert_eq!(alice.expect_error().await.1, "invalid_peer");
    alice.send(join("aaa")).await;
    alice.recv_until(is_state).await;
    bob.send(join("aaa")).await;
    assert_eq!(bob.expect_error().await.1, "peer_in_use");
    // 同じ接続が入り直すと置き換わる
    alice.send(join("aab")).await;
    assert_eq!(members(&mut alice).await[0].0, "aab");
}
