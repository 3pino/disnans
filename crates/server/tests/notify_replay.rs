//! 接続が切れていた間の通知の再送（接続し直したときに、直近の分を古い順に送る）の結合テスト。

mod common;

use std::time::Duration;

use common::TestServer;
use disnans_shared::{ClientEvent, Message, ServerEvent, User};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn mention(bob_id: &str, text: &str) -> ClientEvent {
    ClientEvent::MessageSend {
        client_id: format!("c-{text}"),
        thread_id: None,
        body: format!("<@{bob_id}> {text}"),
        attachment_ids: vec![],
        start_thread: false,
        reply_to: None,
        silent: false,
    }
}

/// 再送されたメンションの本文を、来た順に返す（replayed でないものが混じれば失敗）。
async fn replayed_bodies(bob: &mut common::WsClient, count: usize) -> Vec<String> {
    let mut out = Vec::new();
    for _ in 0..count {
        match bob.recv_any().await {
            ServerEvent::Notify { body, replayed, .. } => {
                assert!(replayed, "再送の印が付いていません");
                out.push(body);
            }
            other => panic!("通知が来るはずでした: {other:?}"),
        }
    }
    out
}

#[tokio::test]
async fn reconnect_replays_missed_mentions_in_order() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let bob_user: User = server.get_json(BOB, "/api/me").await;
    let bob = server.ws(BOB).await;
    drop(bob); // 切れている間の通知
    tokio::time::sleep(Duration::from_millis(150)).await;

    alice.post(&format!("<@{}> 一つ目", bob_user.id)).await;
    alice.post(&format!("<@{}> 二つ目", bob_user.id)).await;

    let mut bob = server.ws(BOB).await;
    let bodies = replayed_bodies(&mut bob, 2).await;
    assert_eq!(bodies, ["@bob 一つ目", "@bob 二つ目"]);
    bob.assert_silent(Duration::from_millis(150)).await;
}

#[tokio::test]
async fn replay_skips_mentions_already_read() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let bob_user: User = server.get_json(BOB, "/api/me").await;
    let bob = server.ws(BOB).await;
    drop(bob);
    tokio::time::sleep(Duration::from_millis(150)).await;

    let first: Message = alice.post_with(mention(&bob_user.id, "既読にする")).await;
    let second: Message = alice.post_with(mention(&bob_user.id, "未読のまま")).await;

    // 一つ目まで既読にする（二つ目は未読のまま）
    let res = reqwest::Client::new()
        .put(server.url("/api/me/read"))
        .header("X-Dev-User", BOB)
        .json(&serde_json::json!({ "thread_id": null, "message_id": first.id }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());

    let mut bob = server.ws(BOB).await;
    let bodies = replayed_bodies(&mut bob, 1).await;
    assert_eq!(bodies, ["@bob 未読のまま"]);
    assert_ne!(second.id, first.id);
    bob.assert_silent(Duration::from_millis(150)).await;
}

#[tokio::test]
async fn live_notifications_are_not_marked_replayed() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let bob_user: User = server.get_json(BOB, "/api/me").await;

    alice.post(&format!("<@{}> 今", bob_user.id)).await;
    match bob
        .recv_until(|e| matches!(e, ServerEvent::Notify { .. }))
        .await
    {
        ServerEvent::Notify { replayed, .. } => assert!(!replayed),
        other => panic!("{other:?}"),
    }
}
