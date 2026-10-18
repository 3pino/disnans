//! 認証・メッセージ・リアクション・ページングの結合テスト。

mod common;

use std::time::Duration;

use common::{TestServer, send};
use disnans_shared::{ApiError, ClientEvent, Message, ServerEvent, User};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

#[tokio::test]
async fn dev_mode_creates_users_on_first_sight() {
    let server = TestServer::start().await;

    // 何も指定しなければ dev@local
    let res = server.http.get(server.url("/api/me")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let dev: User = res.json().await.unwrap();
    assert_eq!(dev.login_name, "dev@local");
    assert_eq!(dev.display_name, "dev");

    // ヘッダーで指定
    let alice: User = server.get_json(ALICE, "/api/me").await;
    assert_eq!(alice.login_name, ALICE);
    assert_eq!(alice.display_name, "alice");
    let again: User = server.get_json(ALICE, "/api/me").await;
    assert_eq!(again.id, alice.id);

    // クエリで指定
    let bob: User = server
        .http
        .get(server.url("/api/me?dev_user=bob@test"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bob.login_name, BOB);

    let users: Vec<User> = server.get_json(ALICE, "/api/users").await;
    assert_eq!(users.len(), 3);

    // 表示名の変更
    let res = server
        .http
        .patch(server.url("/api/me"))
        .header("X-Dev-User", ALICE)
        .json(&serde_json::json!({ "display_name": "  ありす  " }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let updated: User = res.json().await.unwrap();
    assert_eq!(updated.display_name, "ありす");
    assert_eq!(updated.id, alice.id);

    let res = server
        .http
        .patch(server.url("/api/me"))
        .header("X-Dev-User", ALICE)
        .json(&serde_json::json!({ "display_name": " " }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    let err: ApiError = res.json().await.unwrap();
    assert_eq!(err.code, "invalid_display_name");

    // 知らない API
    let res = server.get(ALICE, "/api/nope").send().await.unwrap();
    assert_eq!(res.status(), 404);
    assert_eq!(res.json::<ApiError>().await.unwrap().code, "not_found");
}

#[tokio::test]
async fn new_user_is_announced_over_ws() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let _bob = server.ws(BOB).await;
    match alice.recv().await {
        ServerEvent::UserUpdated { user } => assert_eq!(user.login_name, BOB),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn send_edit_delete_over_ws() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await; // bob の user.updated

    // 送信: client_id は送信者の接続にだけ入る
    alice.send(send("hello **world**")).await;
    let ServerEvent::MessageCreated { client_id, message } = alice.recv().await else {
        panic!()
    };
    assert_eq!(client_id.as_deref(), Some("c-hello **world**"));
    assert_eq!(message.body, "hello **world**");
    let ServerEvent::MessageCreated {
        client_id,
        message: seen,
    } = bob.recv().await
    else {
        panic!()
    };
    assert_eq!(client_id, None);
    assert_eq!(seen.id, message.id);

    // 同じユーザーの別の接続には client_id が入らない
    let mut alice2 = server.ws(ALICE).await;
    alice.send(send("second")).await;
    let ServerEvent::MessageCreated { client_id, .. } = alice2.recv().await else {
        panic!()
    };
    assert_eq!(client_id, None);
    alice.recv().await;
    bob.recv().await;

    // 空の本文は送れない（client_id 付きのエラー）
    alice.send(send("   ")).await;
    assert_eq!(
        alice.expect_error().await,
        (Some("c-   ".into()), "empty_message".into())
    );

    // 他人のメッセージは編集できない
    bob.send(ClientEvent::MessageEdit {
        message_id: message.id.clone(),
        body: "hacked".into(),
    })
    .await;
    assert_eq!(bob.expect_error().await.1, "forbidden");

    // 編集
    alice
        .send(ClientEvent::MessageEdit {
            message_id: message.id.clone(),
            body: "edited".into(),
        })
        .await;
    for client in [&mut alice, &mut bob] {
        let ServerEvent::MessageUpdated { message: m } = client.recv().await else {
            panic!()
        };
        assert_eq!(m.body, "edited");
        assert!(m.edited_at.is_some());
    }

    // 他人のメッセージは削除できない
    bob.send(ClientEvent::MessageDelete {
        message_id: message.id.clone(),
    })
    .await;
    assert_eq!(bob.expect_error().await.1, "forbidden");

    // 削除
    alice
        .send(ClientEvent::MessageDelete {
            message_id: message.id.clone(),
        })
        .await;
    for client in [&mut alice, &mut bob] {
        let ServerEvent::MessageDeleted { message_id } = client.recv().await else {
            panic!()
        };
        assert_eq!(message_id, message.id);
    }
    let history = server.messages("").await;
    assert_eq!(
        history.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        ["second"]
    );

    // 存在しないメッセージ
    alice
        .send(ClientEvent::MessageDelete {
            message_id: message.id.clone(),
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "not_found");

    // 壊れたイベントと ping
    alice.send(ClientEvent::Ping).await;
    assert!(matches!(alice.recv().await, ServerEvent::Pong));
}

/// `thread_id` を付けた履歴の取得は、メインチャットの履歴として返す。
#[tokio::test]
async fn history_ignores_thread_id() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let posted = alice.post("本文").await;
    let list = server
        .messages("?thread_id=01A000000000000000000000M9")
        .await;
    let ids: Vec<&str> = list.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec![posted.id.as_str()]);
}

#[tokio::test]
async fn mention_notifies_the_target_not_the_author() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let mut bob_phone = server.ws(BOB).await;
    alice.recv().await;
    let bob_user: User = server.get_json(BOB, "/api/me").await;

    alice.post(&format!("<@{}> 見て", bob_user.id)).await;
    for client in [&mut bob, &mut bob_phone] {
        let event = client
            .recv_until(|e| matches!(e, ServerEvent::Notify { .. }))
            .await;
        let ServerEvent::Notify { title, body, .. } = event else {
            unreachable!()
        };
        assert_eq!(title, "alice mentioned you");
        assert_eq!(body, "@bob 見て");
    }
    alice.assert_silent(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn sample_notification_goes_only_to_the_requester() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await;

    let res = reqwest::Client::new()
        .post(server.url("/api/notify/sample"))
        .header("X-Dev-User", ALICE)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    let event = alice.recv_any().await;
    assert!(matches!(event, ServerEvent::Notify { sample: true, .. }));
    bob.assert_silent(Duration::from_millis(200)).await;
}

#[tokio::test]
async fn pagination_returns_oldest_first() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut posted = Vec::new();
    for i in 0..7 {
        posted.push(alice.post(&format!("m{i}")).await.id);
    }
    let ids = |list: Vec<Message>| list.into_iter().map(|m| m.id).collect::<Vec<_>>();

    // 既定では全部（古い順）
    assert_eq!(ids(server.messages("").await), posted);

    // 最新の3件
    let page1 = ids(server.messages("?limit=3").await);
    assert_eq!(page1, posted[4..]);
    // それより古い3件
    let page2 = ids(server
        .messages(&format!("?limit=3&before={}", page1[0]))
        .await);
    assert_eq!(page2, posted[1..4]);
    let page3 = ids(server
        .messages(&format!("?limit=3&before={}", page2[0]))
        .await);
    assert_eq!(page3, posted[..1]);
    let page4 = ids(server
        .messages(&format!("?limit=3&before={}", page3[0]))
        .await);
    assert!(page4.is_empty());

    // limit は 1〜200 に丸める。空の thread_id は省略と同じ
    assert_eq!(ids(server.messages("?limit=0").await), posted[6..]);
    assert_eq!(ids(server.messages("?limit=1000&thread_id=").await), posted);
}

#[tokio::test]
async fn reactions_are_grouped_by_emoji() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let bob_user: User = server.get_json(BOB, "/api/me").await;

    let msg = alice.post("react me").await;
    bob.recv().await;

    let react = |emoji: &str, add: bool| {
        let (message_id, emoji) = (msg.id.clone(), emoji.to_owned());
        if add {
            ClientEvent::ReactionAdd { message_id, emoji }
        } else {
            ClientEvent::ReactionRemove { message_id, emoji }
        }
    };

    alice.send(react("👍", true)).await;
    bob.recv().await;
    bob.send(react("🎉", true)).await;
    bob.recv().await;
    bob.send(react("👍", true)).await;
    // 2回付けても1回
    bob.send(react("👍", true)).await;
    bob.recv().await;
    let ServerEvent::ReactionUpdated {
        message_id,
        reactions,
    } = bob.recv().await
    else {
        panic!()
    };
    assert_eq!(message_id, msg.id);
    assert_eq!(reactions.len(), 2);
    assert_eq!(reactions[0].emoji, "👍");
    assert_eq!(
        reactions[0].user_ids,
        [alice_user.id.clone(), bob_user.id.clone()]
    );
    assert_eq!(reactions[1].emoji, "🎉");
    assert_eq!(reactions[1].user_ids, vec![bob_user.id.clone()]);

    alice.send(react("👍", false)).await;
    let ServerEvent::ReactionUpdated { reactions, .. } = bob.recv().await else {
        panic!()
    };
    assert_eq!(reactions[0].user_ids, vec![bob_user.id.clone()]);

    let history = server.messages("").await;
    assert_eq!(history[0].reactions.len(), 2);

    alice.send(react("  ", true)).await;
    assert_eq!(alice.expect_error().await.1, "invalid_emoji");
}
