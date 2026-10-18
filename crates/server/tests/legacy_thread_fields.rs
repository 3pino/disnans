//! 返信・silent と、古いクライアントの送信（thread_id・start_thread）の互換、スレッド API が無いことの結合テスト。

mod common;

use std::time::Duration;

use common::TestServer;
use disnans_shared::{ApiError, ClientEvent, Message, ServerEvent};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn msg(body: &str, reply_to: Option<&str>, silent: bool) -> ClientEvent {
    ClientEvent::MessageSend {
        client_id: format!("c-{body}"),
        body: body.into(),
        attachment_ids: vec![],
        reply_to: reply_to.map(Into::into),
        silent,
    }
}

#[tokio::test]
async fn reply_carries_preview_and_notifies_target() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    let original = alice.post("元の発言").await;
    let reply = bob
        .post_with(msg("返信です", Some(&original.id), false))
        .await;
    assert_eq!(reply.reply_to.as_deref(), Some(original.id.as_str()));
    let preview = reply.reply_preview.as_ref().unwrap();
    assert_eq!(preview.body, "元の発言");
    assert_eq!(preview.author_id, original.author_id);

    // 返信先の作者に通知が届く
    let ServerEvent::Notify { title, .. } = alice
        .recv_until(|e| matches!(e, ServerEvent::Notify { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(title, "bob replied to you");

    // 履歴にも返信先の要約が入る
    let list = server.messages("").await;
    assert!(list.iter().any(|m| m.reply_preview.is_some()));

    // 返信先を消すと、reply_to は残り要約は null になる
    alice
        .send(ClientEvent::MessageDelete {
            message_id: original.id.clone(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    let list = server.messages("").await;
    let after = list.iter().find(|m| m.id == reply.id).unwrap();
    assert_eq!(after.reply_to.as_deref(), Some(original.id.as_str()));
    assert!(after.reply_preview.is_none());
}

#[tokio::test]
async fn silent_sends_no_notification() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    let base = bob.post("hi").await;
    alice
        .send(msg(
            &format!("<@{}> こっそり", base.author_id),
            Some(&base.id),
            true,
        ))
        .await;
    // message.created は届くが notify は来ない
    bob.recv_until(|e| matches!(e, ServerEvent::MessageCreated { .. }))
        .await;
    bob.assert_silent(Duration::from_millis(300)).await;
}

/// スレッドの API は無い。存在しないパスと同じ普通の 404 になる。
#[tokio::test]
async fn thread_routes_are_plain_not_found() {
    let server = TestServer::start().await;
    for (method, path) in [
        ("GET", "/api/threads"),
        ("GET", "/api/threads/01A000000000000000000000M1"),
        ("PUT", "/api/threads/01A000000000000000000000M1"),
        ("PUT", "/api/threads/01A000000000000000000000M1/tags"),
        ("GET", "/api/thread-tags"),
    ] {
        let req = match method {
            "GET" => server.get(ALICE, path),
            _ => server.put_json(ALICE, path, &serde_json::json!({ "tags": [] })),
        };
        let res = req.send().await.unwrap();
        let status = res.status();
        let code = res.json::<ApiError>().await.unwrap().code;
        assert_eq!(status, 404, "{path}");
        assert_eq!(code, "not_found", "{path}");
    }
}

/// thread.create は知らない形として断る。
#[tokio::test]
async fn thread_create_over_ws_is_unknown() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    alice
        .send_raw(r#"{"type":"thread.create","root_message_id":"01A000000000000000000000M1"}"#)
        .await;
    assert_eq!(alice.expect_error().await.1, "invalid_event");
}

/// 古いクライアントは thread_id と start_thread を付けて送ってくる。それらは無視され、メインチャットに入る。
#[tokio::test]
async fn old_message_send_with_thread_fields_still_goes_through() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice
        .send_raw(
            &serde_json::json!({
                "type": "message.send",
                "client_id": "old",
                "thread_id": "01A000000000000000000000M9",
                "body": "古い送り方",
                "attachment_ids": [],
                "start_thread": true,
                "silent": false
            })
            .to_string(),
        )
        .await;
    let ServerEvent::MessageCreated { message, .. } = bob
        .recv_until(|e| matches!(e, ServerEvent::MessageCreated { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(message.body, "古い送り方");
    assert_eq!(message.reply_to, None);

    let list: Vec<Message> = server.messages("").await;
    assert!(list.iter().any(|m| m.body == "古い送り方"));
}
