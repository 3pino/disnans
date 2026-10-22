//! 本文のリンク（`attachments/` のパス → 添付の ID → 今の名前）の結合テスト。設計は docs/PLAN_FILES.md の 3b。

mod common;

use common::TestServer;
use disnans_shared::{ClientEvent, Message, ServerEvent};
use serde_json::json;

const ALICE: &str = "alice@test";

async fn upload(server: &TestServer, name: &str) -> String {
    let part = reqwest::multipart::Part::bytes(b"data".to_vec())
        .file_name(name.to_owned())
        .mime_str("text/plain")
        .unwrap();
    let form = reqwest::multipart::Form::new().part("file", part);
    let a: disnans_shared::Attachment = server
        .http
        .post(server.url("/api/files"))
        .header("X-Dev-User", ALICE)
        .multipart(form)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    a.id
}

async fn send(server: &TestServer, body: &str, ids: &[&str]) -> Option<String> {
    let mut ws = server.ws(ALICE).await;
    ws.send(ClientEvent::MessageSend {
        client_id: format!("c-{body}"),
        body: body.into(),
        attachment_ids: ids.iter().map(|s| s.to_string()).collect(),
        reply_to: None,
        silent: false,
    })
    .await;
    // 成功なら message.created、失敗なら error が届く
    match ws
        .recv_until(|e| {
            matches!(
                e,
                ServerEvent::Error { .. } | ServerEvent::MessageCreated { .. }
            )
        })
        .await
    {
        ServerEvent::Error { code, .. } => Some(code),
        _ => None,
    }
}

fn body_of(messages: &[Message], text: &str) -> String {
    messages
        .iter()
        .find(|m| m.body.contains(text) || m.body == text)
        .map(|m| m.body.clone())
        .unwrap_or_else(|| {
            panic!(
                "本文が見つからない: {text} / {:?}",
                messages.iter().map(|m| m.body.clone()).collect::<Vec<_>>()
            )
        })
}

#[tokio::test]
async fn links_are_stored_by_id_and_shown_with_the_current_name() {
    let server = TestServer::start().await;
    let id = upload(&server, "photo.png").await;
    // リンクできるのは投稿された添付（attachments/ に見えるもの）だけ
    assert_eq!(send(&server, "post it", &[&id]).await, None);
    // 保存された本文は ID（表示は今の名前）
    assert_eq!(
        send(&server, "see [写真](attachments/photo.png) ok", &[]).await,
        None
    );
    let shown = server.messages("").await;
    assert_eq!(
        body_of(&shown, "see"),
        "see [写真](attachments/photo.png) ok"
    );

    // 名前を変えると、表示はそのまま追従する（ID は同じ）
    let res = server
        .http
        .post(server.url("/api/shared"))
        .header("X-Dev-User", ALICE)
        .json(&json!({"op": "move", "from": "attachments/photo.png", "to": "attachments/renamed.png"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let shown = server.messages("").await;
    assert_eq!(
        body_of(&shown, "see"),
        "see [写真](attachments/renamed.png) ok"
    );
    let _ = id;
}

#[tokio::test]
async fn both_link_forms_and_the_embed_form_keep_their_syntax() {
    let server = TestServer::start().await;
    let a = upload(&server, "a.pdf").await;
    let v = upload(&server, "v.mp4").await;
    assert_eq!(send(&server, "post", &[&a, &v]).await, None);
    assert_eq!(
        send(
            &server,
            "[[attachments/a.pdf|資料]] と ![[attachments/v.mp4]] と [[docs/x.md]]",
            &[]
        )
        .await,
        None
    );
    let shown = server.messages("").await;
    assert_eq!(
        body_of(&shown, "資料"),
        "[[attachments/a.pdf|資料]] と ![[attachments/v.mp4]] と [[docs/x.md]]",
        "共有フォルダのパスは文字のまま"
    );
}

#[tokio::test]
async fn unknown_or_deleted_targets_are_rejected() {
    let server = TestServer::start().await;
    assert_eq!(
        send(&server, "[x](attachments/none.png)", &[])
            .await
            .as_deref(),
        Some("invalid_link")
    );
    let id = upload(&server, "gone.txt").await;
    send(&server, "posted", &[&id]).await;
    server
        .http
        .delete(server.url("/api/shared/attachments/gone.txt"))
        .header("X-Dev-User", ALICE)
        .send()
        .await
        .unwrap();
    assert_eq!(
        send(&server, "[x](attachments/gone.txt)", &[])
            .await
            .as_deref(),
        Some("invalid_link"),
        "削除済みの名前にはリンクできない"
    );
}

#[tokio::test]
async fn a_direct_attachment_can_be_linked_and_edits_convert_too() {
    let server = TestServer::start().await;
    let res = server
        .http
        .put(server.url("/api/shared/attachments/direct.txt"))
        .header("X-Dev-User", ALICE)
        .body("d")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    assert_eq!(send(&server, "first", &[]).await, None);
    let first = server
        .messages("")
        .await
        .into_iter()
        .find(|m| m.body == "first")
        .unwrap();

    let mut ws = server.ws(ALICE).await;
    ws.send(ClientEvent::MessageEdit {
        message_id: first.id.clone(),
        body: "edited [d](attachments/direct.txt)".into(),
    })
    .await;
    ws.recv_until(|e| matches!(e, ServerEvent::MessageUpdated { .. }))
        .await;
    let shown = server.messages("").await;
    assert_eq!(
        body_of(&shown, "edited"),
        "edited [d](attachments/direct.txt)"
    );
}
