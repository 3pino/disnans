//! 投稿前のアップロードの取り消し（`DELETE /api/files/{id}`）。本人の未投稿だけ消せる。

mod common;

use common::TestServer;
use disnans_shared::{Attachment, ClientEvent};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

async fn upload_as(server: &TestServer, user: &str, name: &str) -> Attachment {
    let part = reqwest::multipart::Part::bytes(b"data".to_vec())
        .file_name(name.to_owned())
        .mime_str("text/plain")
        .unwrap();
    let form = reqwest::multipart::Form::new().part("file", part);
    let res = server
        .http
        .post(server.url("/api/files"))
        .header("X-Dev-User", user)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn delete_as(server: &TestServer, user: &str, id: &str) -> u16 {
    server
        .http
        .delete(server.url(&format!("/api/files/{id}")))
        .header("X-Dev-User", user)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn file_status(server: &TestServer, id: &str) -> u16 {
    server
        .http
        .get(server.url(&format!("/api/files/{id}")))
        .header("X-Dev-User", ALICE)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn my_unposted_upload_is_removed_and_its_file_is_gone() {
    let server = TestServer::start().await;
    let mine = upload_as(&server, ALICE, "draft.txt").await;
    assert_eq!(delete_as(&server, ALICE, &mine.id).await, 204);
    assert_eq!(file_status(&server, &mine.id).await, 404);
    // 2 回目は見つからない
    assert_eq!(delete_as(&server, ALICE, &mine.id).await, 404);
}

#[tokio::test]
async fn someone_elses_unposted_upload_is_forbidden_and_kept() {
    let server = TestServer::start().await;
    let theirs = upload_as(&server, BOB, "bobs.txt").await;
    assert_eq!(delete_as(&server, ALICE, &theirs.id).await, 403);
    assert_eq!(file_status(&server, &theirs.id).await, 200);
}

#[tokio::test]
async fn a_posted_attachment_is_forbidden_and_kept() {
    let server = TestServer::start().await;
    let mine = upload_as(&server, ALICE, "posted.txt").await;
    let mut ws = server.ws(ALICE).await;
    ws.post_with(ClientEvent::MessageSend {
        client_id: "c-posted".into(),
        body: "see".into(),
        attachment_ids: vec![mine.id.clone()],
        reply_to: None,
        silent: false,
    })
    .await;
    assert_eq!(delete_as(&server, ALICE, &mine.id).await, 403);
    assert_eq!(file_status(&server, &mine.id).await, 200);
}

#[tokio::test]
async fn a_library_file_in_attachments_is_forbidden_and_kept() {
    let server = TestServer::start().await;
    let res = server
        .http
        .put(server.url("/api/shared/attachments/lib.txt"))
        .header("X-Dev-User", ALICE)
        .body("lib".to_owned())
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    let entry: disnans_shared::SharedEntry = res.json().await.unwrap();
    let id = entry.file_id.expect("file id");
    assert_eq!(delete_as(&server, ALICE, &id).await, 403);
    assert_eq!(file_status(&server, &id).await, 200);
}

#[tokio::test]
async fn an_unknown_id_is_not_found() {
    let server = TestServer::start().await;
    assert_eq!(delete_as(&server, ALICE, "nope").await, 404);
}
