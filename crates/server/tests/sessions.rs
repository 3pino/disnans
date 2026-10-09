//! プラグインのセッション・カード・一時的なイベント・通知の結合テスト。

mod common;

use std::time::Duration;

use common::{TestServer, send};
use disnans_shared::{
    ApiError, Card, ClientEvent, CreateSession, Message, PluginNotify, ServerEvent, Session,
    UpdateSession, User,
};
use serde_json::json;

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";
const CAROL: &str = "carol@test";

fn card(title: &str, text: &str) -> Card {
    Card {
        title: title.into(),
        text: text.into(),
    }
}

fn create_req(thread_id: Option<String>) -> CreateSession {
    CreateSession {
        plugin: "dice".into(),
        thread_id,
        state: json!({ "schema": 1, "dice": "2d6", "result": null }),
        card: card("サイコロ", "alice がサイコロ（2d6）を用意しました"),
    }
}

async fn create(server: &TestServer, user: &str, req: &CreateSession) -> Session {
    let res = server
        .post_json(user, "/api/sessions", req)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    res.json().await.unwrap()
}

async fn error_code(res: reqwest::Response) -> (u16, String) {
    let status = res.status().as_u16();
    (status, res.json::<ApiError>().await.unwrap().code)
}

#[tokio::test]
async fn create_get_update_and_conflict() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await; // bob の user.updated

    // 作成: 配布されていないプラグインでもよい。カードのメッセージが全員に流れる
    let session = create(&server, ALICE, &create_req(None)).await;
    assert_eq!(session.plugin, "dice");
    assert_eq!(session.version, 1);
    assert_eq!(session.created_by, alice_user.id);
    assert_eq!(session.state["dice"], "2d6");
    for client in [&mut alice, &mut bob] {
        let ServerEvent::MessageCreated { client_id, message } = client.recv().await else {
            panic!()
        };
        assert_eq!(client_id, None);
        assert_eq!(message.id, session.message_id);
        assert_eq!(message.body, "");
        assert_eq!(message.author_id, alice_user.id);
        let card = message.card.unwrap();
        assert_eq!(card.session_id, session.id);
        assert_eq!(card.plugin, "dice");
        assert_eq!(card.title, "サイコロ");
    }
    // 通知は出ない
    bob.assert_silent(Duration::from_millis(200)).await;

    // 履歴にもカードが付く
    let history = server.messages("").await;
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].card.as_ref().unwrap().session_id, session.id);

    // 取得
    let got: Session = server
        .get_json(BOB, &format!("/api/sessions/{}", session.id))
        .await;
    assert_eq!(got.state, session.state);
    assert_eq!(got.card.text, session.card.text);
    let res = server.get(BOB, "/api/sessions/nope").send().await.unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));

    // 更新（カードなし）: session.updated だけ
    let path = format!("/api/sessions/{}", session.id);
    let res = server
        .put_json(
            BOB,
            &path,
            &UpdateSession {
                version: 1,
                state: json!({ "schema": 1, "rolling": true }),
                card: None,
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let updated: Session = res.json().await.unwrap();
    assert_eq!(updated.version, 2);
    assert_eq!(updated.state["rolling"], true);
    assert_eq!(updated.card.title, "サイコロ");
    for client in [&mut alice, &mut bob] {
        let ServerEvent::SessionUpdated { session: s } = client.recv().await else {
            panic!()
        };
        assert_eq!(s.version, 2);
    }
    alice.assert_silent(Duration::from_millis(200)).await;

    // 古い version では失敗する
    let res = server
        .put_json(
            ALICE,
            &path,
            &UpdateSession {
                version: 1,
                state: json!({}),
                card: None,
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (409, "version_conflict".into()));

    // カードも書き換える: session.updated と message.updated（edited_at は付かない）
    let res = server
        .put_json(
            ALICE,
            &path,
            &UpdateSession {
                version: 2,
                state: json!({ "schema": 1, "result": [3, 5] }),
                card: Some(card("サイコロ", "🎲 alice: 2d6 → 3 + 5 = 8")),
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    for client in [&mut alice, &mut bob] {
        let ServerEvent::SessionUpdated { session: s } = client.recv().await else {
            panic!()
        };
        assert_eq!(s.version, 3);
        assert_eq!(s.card.text, "🎲 alice: 2d6 → 3 + 5 = 8");
        let ServerEvent::MessageUpdated { message } = client.recv().await else {
            panic!()
        };
        assert_eq!(message.id, session.message_id);
        assert_eq!(message.card.unwrap().text, "🎲 alice: 2d6 → 3 + 5 = 8");
        assert_eq!(message.edited_at, None);
    }
    let got: Session = server.get_json(BOB, &path).await;
    assert_eq!(got.version, 3);
    assert_eq!(got.state["result"], json!([3, 5]));

    // 存在しないセッションの更新
    let res = server
        .put_json(
            ALICE,
            "/api/sessions/nope",
            &UpdateSession {
                version: 1,
                state: json!({}),
                card: None,
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));
}

#[tokio::test]
async fn rejects_invalid_sessions() {
    let server = TestServer::start().await;

    let mut req = create_req(None);
    req.plugin = "Bad_ID".into();
    let res = server
        .post_json(ALICE, "/api/sessions", &req)
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "invalid_plugin_id".into()));

    let req = create_req(Some("nope".into()));
    let res = server
        .post_json(ALICE, "/api/sessions", &req)
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "thread_not_found".into()));

    let mut req = create_req(None);
    req.state = json!({ "big": "x".repeat(1024 * 1024) });
    let res = server
        .post_json(ALICE, "/api/sessions", &req)
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (413, "state_too_large".into()));

    // 失敗したものはメッセージを作らない
    assert!(server.messages("").await.is_empty());

    // 大きすぎる state での更新も失敗する
    let session = create(&server, ALICE, &create_req(None)).await;
    let res = server
        .put_json(
            ALICE,
            &format!("/api/sessions/{}", session.id),
            &UpdateSession {
                version: 1,
                state: json!("x".repeat(1024 * 1024)),
                card: None,
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (413, "state_too_large".into()));
}

#[tokio::test]
async fn card_in_thread_cannot_be_edited_and_deletion_removes_session() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await; // bob の user.updated

    // スレッドにカードを流すと thread.updated も届く
    let root = alice
        .post_with(ClientEvent::MessageSend {
            client_id: "root".into(),
            thread_id: None,
            body: "ゲームしよう".into(),
            attachment_ids: vec![],
            start_thread: true,
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::ThreadUpdated { .. }))
        .await;
    bob.recv_until(|e| matches!(e, ServerEvent::ThreadUpdated { .. }))
        .await;

    let session = create(&server, ALICE, &create_req(Some(root.id.clone()))).await;
    let ServerEvent::MessageCreated { message, .. } = bob.recv().await else {
        panic!()
    };
    assert_eq!(message.thread_id.as_deref(), Some(root.id.as_str()));
    assert!(message.card.is_some());
    let ServerEvent::ThreadUpdated { thread } = bob.recv().await else {
        panic!()
    };
    assert_eq!(thread.info.reply_count, 1);
    alice.recv().await;
    alice.recv().await;
    let replies: Vec<Message> = server.messages(&format!("?thread_id={}", root.id)).await;
    assert_eq!(replies[0].card.as_ref().unwrap().session_id, session.id);

    // カードは編集できない
    alice
        .send(ClientEvent::MessageEdit {
            message_id: session.message_id.clone(),
            body: "書き換え".into(),
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "card_not_editable");

    // リアクションは付けられる
    bob.send(ClientEvent::ReactionAdd {
        message_id: session.message_id.clone(),
        emoji: "👍".into(),
    })
    .await;
    bob.recv_until(|e| matches!(e, ServerEvent::ReactionUpdated { .. }))
        .await;

    // 削除は作成者だけ。消すとセッションも消える
    bob.send(ClientEvent::MessageDelete {
        message_id: session.message_id.clone(),
    })
    .await;
    assert_eq!(bob.expect_error().await.1, "forbidden");
    alice
        .send(ClientEvent::MessageDelete {
            message_id: session.message_id.clone(),
        })
        .await;
    bob.recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    let res = server
        .get(BOB, &format!("/api/sessions/{}", session.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn emit_is_relayed_to_other_connections() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut alice = server.ws(ALICE).await;
    let mut alice2 = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await; // bob の user.updated
    alice2.recv().await;

    let session = create(&server, ALICE, &create_req(None)).await;
    for client in [&mut alice, &mut alice2, &mut bob] {
        client.recv().await; // message.created
    }

    alice
        .send(ClientEvent::SessionEmit {
            session_id: session.id.clone(),
            name: "thinking".into(),
            payload: json!({ "x": 1 }),
        })
        .await;
    for client in [&mut alice2, &mut bob] {
        let ServerEvent::SessionEvent {
            session_id,
            from,
            name,
            payload,
        } = client.recv().await
        else {
            panic!()
        };
        assert_eq!(session_id, session.id);
        assert_eq!(from, alice_user.id);
        assert_eq!(name, "thinking");
        assert_eq!(payload, json!({ "x": 1 }));
    }
    // 送った接続には返さない
    alice.assert_silent(Duration::from_millis(200)).await;

    // 存在しないセッション
    alice
        .send(ClientEvent::SessionEmit {
            session_id: "nope".into(),
            name: "thinking".into(),
            payload: json!(null),
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "not_found");

    // 大きすぎる payload
    alice
        .send(ClientEvent::SessionEmit {
            session_id: session.id.clone(),
            name: "big".into(),
            payload: json!("x".repeat(64 * 1024)),
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "payload_too_large");
    bob.assert_silent(Duration::from_millis(200)).await;

    // イベントは保存しない（ほかの操作の妨げにならない）
    alice.send(send("after")).await;
    bob.recv_until(|e| matches!(e, ServerEvent::MessageCreated { .. }))
        .await;
}

#[tokio::test]
async fn plugin_notify() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let bob_user: User = server.get_json(BOB, "/api/me").await;
    let carol_user: User = server.get_json(CAROL, "/api/me").await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let mut carol = server.ws(CAROL).await;

    // 配布されていなければ、タイトルは ID
    let res = server
        .post_json(
            ALICE,
            "/api/plugins/dice/notify",
            &PluginNotify {
                user_ids: vec![bob_user.id.clone(), "nobody".into(), bob_user.id.clone()],
                body: "あなたの番です".into(),
                session_id: None,
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let ServerEvent::Notify {
        title,
        body,
        message_id,
        thread_id,
        sample,
    } = bob.recv().await
    else {
        panic!()
    };
    assert_eq!(title, "dice");
    assert_eq!(body, "あなたの番です");
    assert_eq!((message_id, thread_id, sample), (None, None, false));
    // 重複して送らない。ほかの人には送らない
    bob.assert_silent(Duration::from_millis(200)).await;
    carol.assert_silent(Duration::from_millis(100)).await;

    // 配布されていれば名前。セッションを指定するとカードの場所が入る。自分宛ても送る
    let manifest = r#"{"id":"dice","name":"ダイス","version":"1.0.0"}"#.as_bytes();
    let res = server
        .upload_plugin(ALICE, &[("manifest.json", manifest), ("main.js", b"")])
        .await;
    assert_eq!(res.status(), 200);
    let session = create(&server, ALICE, &create_req(None)).await;
    for client in [&mut alice, &mut bob, &mut carol] {
        client
            .recv_until(|e| matches!(e, ServerEvent::MessageCreated { message, .. } if message.card.is_some()))
            .await;
    }

    let res = server
        .post_json(
            BOB,
            "/api/plugins/dice/notify",
            &PluginNotify {
                user_ids: vec![alice_user.id.clone(), carol_user.id.clone()],
                body: "結果が出ました".into(),
                session_id: Some(session.id.clone()),
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    for client in [&mut alice, &mut carol] {
        let ServerEvent::Notify {
            title,
            message_id,
            thread_id,
            ..
        } = client.recv().await
        else {
            panic!()
        };
        assert_eq!(title, "ダイス");
        assert_eq!(message_id.as_deref(), Some(session.message_id.as_str()));
        assert_eq!(thread_id, None);
    }
    bob.assert_silent(Duration::from_millis(200)).await;

    // 不正な入力
    let notify = |session_id: Option<&str>, body: &str| PluginNotify {
        user_ids: vec![bob_user.id.clone()],
        body: body.into(),
        session_id: session_id.map(Into::into),
    };
    let res = server
        .post_json(
            ALICE,
            "/api/plugins/dice/notify",
            &notify(Some("nope"), "x"),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));
    let res = server
        .post_json(ALICE, "/api/plugins/dice/notify", &notify(None, "  "))
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "invalid_body".into()));
    let res = server
        .post_json(ALICE, "/api/plugins/Dice/notify", &notify(None, "x"))
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "invalid_plugin_id".into()));
}
