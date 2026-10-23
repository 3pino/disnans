//! 添付の別名・中身の差し替え・削除・直接作った添付（`attachments/` の作り直し）の結合テスト。

mod common;

use common::TestServer;
use disnans_server::files as stored_files;
use disnans_shared::{Attachment, ClientEvent, Message, ServerEvent, SharedEntry, SharedListing};
use serde_json::json;

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn req(server: &TestServer, user: &str, m: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(m, server.url(path))
        .header("X-Dev-User", user)
}

async fn upload(server: &TestServer, user: &str, name: &str, data: &[u8]) -> Attachment {
    let part = reqwest::multipart::Part::bytes(data.to_vec())
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

async fn post(server: &TestServer, user: &str, body: &str, ids: &[&str]) -> Message {
    let mut ws = server.ws(user).await;
    ws.post_with(ClientEvent::MessageSend {
        client_id: format!("c-{body}"),
        body: body.into(),
        attachment_ids: ids.iter().map(|s| s.to_string()).collect(),
        reply_to: None,
        silent: false,
    })
    .await
}

async fn listing(server: &TestServer, path: &str) -> SharedListing {
    let res = req(server, ALICE, reqwest::Method::GET, path)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{path}");
    res.json().await.unwrap()
}

async fn names(server: &TestServer) -> Vec<String> {
    listing(server, "/api/shared/attachments")
        .await
        .entries
        .into_iter()
        .map(|e| e.name)
        .collect()
}

async fn file_bytes(server: &TestServer, id: &str) -> (u16, String) {
    let res = server
        .http
        .get(server.url(&format!("/api/files/{id}")))
        .header("X-Dev-User", ALICE)
        .send()
        .await
        .unwrap();
    let status = res.status().as_u16();
    (status, res.text().await.unwrap())
}

async fn put_attachment(server: &TestServer, user: &str, name: &str, body: &str) -> SharedEntry {
    let res = req(
        server,
        user,
        reqwest::Method::PUT,
        &format!("/api/shared/attachments/{name}"),
    )
    .body(body.to_owned())
    .send()
    .await
    .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    res.json().await.unwrap()
}

#[tokio::test]
async fn same_names_get_numbered_at_upload_and_keep_them() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "a.txt", b"1").await;
    let b = upload(&server, ALICE, "a.txt", b"2").await;
    let c = upload(&server, ALICE, "A.TXT", b"3").await;
    for (i, f) in [&a, &b, &c].iter().enumerate() {
        post(&server, ALICE, &format!("m{i}"), &[&f.id]).await;
    }
    // 大文字小文字を区別しないので、A.TXT は (3) になる
    assert_eq!(
        names(&server).await,
        vec!["a.txt", "a (2).txt", "A (3).TXT"]
    );
    // 後のアップロードで、最初の名前が変わることはない
    upload(&server, ALICE, "a.txt", b"4").await;
    assert_eq!(names(&server).await[0], "a.txt");
}

#[tokio::test]
async fn an_unposted_upload_is_not_listed_until_it_is_posted() {
    let server = TestServer::start().await;
    let f = upload(&server, ALICE, "draft.txt", b"d").await;
    assert!(names(&server).await.is_empty());
    post(&server, ALICE, "posted", &[&f.id]).await;
    assert_eq!(names(&server).await, vec!["draft.txt"]);
}

#[tokio::test]
async fn rename_refuses_an_existing_name_unless_overwrite_is_set() {
    let server = TestServer::start().await;
    put_attachment(&server, ALICE, "x.txt", "x-body").await;
    put_attachment(&server, ALICE, "y.txt", "y-body").await;

    let res = req(&server, ALICE, reqwest::Method::POST, "/api/shared")
        .json(&json!({"op": "move", "from": "attachments/x.txt", "to": "attachments/y.txt"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 409);
    assert_eq!(names(&server).await, vec!["x.txt", "y.txt"]);

    let res = req(&server, ALICE, reqwest::Method::POST, "/api/shared")
        .json(&json!({"op": "move", "from": "attachments/x.txt", "to": "attachments/y.txt", "overwrite": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(names(&server).await, vec!["y.txt"]);
    let body = req(
        &server,
        ALICE,
        reqwest::Method::GET,
        "/api/shared/attachments/y.txt",
    )
    .send()
    .await
    .unwrap()
    .text()
    .await
    .unwrap();
    assert_eq!(body, "x-body", "移した中身が入る");
}

#[tokio::test]
async fn replacing_content_keeps_the_id_that_messages_refer_to() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "doc.txt", b"old").await;
    post(&server, ALICE, "see", &[&a.id]).await;

    let entry = put_attachment(&server, ALICE, "doc.txt", "new contents").await;
    assert_eq!(entry.file_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(
        file_bytes(&server, &a.id).await,
        (200, "new contents".into())
    );

    let msg = server
        .messages("")
        .await
        .into_iter()
        .find(|m| m.body.starts_with("see"))
        .unwrap();
    let att = &msg.attachments[0];
    assert_eq!(att.id, a.id);
    assert_eq!(att.size, "new contents".len() as u64);
    assert!(!att.deleted);
}

#[tokio::test]
async fn deleting_a_posted_attachment_leaves_a_deleted_mark_in_the_message() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "gone.txt", b"bye").await;
    post(&server, ALICE, "with file", &[&a.id]).await;
    let mut ws = server.ws(ALICE).await;

    let res = req(
        &server,
        ALICE,
        reqwest::Method::DELETE,
        "/api/shared/attachments/gone.txt",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 204);

    // 本体は 410、メッセージには「削除された」と最後の名前が残る
    assert_eq!(file_bytes(&server, &a.id).await.0, 410);
    let msg = server
        .messages("")
        .await
        .into_iter()
        .find(|m| m.body.starts_with("with file"))
        .unwrap();
    assert!(msg.attachments[0].deleted);
    assert_eq!(msg.attachments[0].file_name, "gone.txt");
    assert!(names(&server).await.is_empty());

    ws.recv_until(
        |e| matches!(e, ServerEvent::FilesChanged { path } if path == "attachments/gone.txt"),
    )
    .await;
}

#[tokio::test]
async fn a_directly_made_attachment_is_listed_at_once_and_anyone_can_post_it() {
    let server = TestServer::start().await;
    let entry = put_attachment(&server, ALICE, "lib.txt", "shared lib").await;
    let id = entry.file_id.clone().unwrap();
    assert_eq!(names(&server).await, vec!["lib.txt"]);

    // ほかの人も、この添付を投稿に付けられる
    let msg = post(&server, BOB, "bob posts it", &[&id]).await;
    assert_eq!(msg.attachments[0].id, id);
    let listed = listing(&server, "/api/shared/attachments").await;
    assert!(listed.entries[0].message_id.is_some());
}

#[tokio::test]
async fn a_direct_attachment_survives_cleanup_but_an_unposted_upload_does_not() {
    let server = TestServer::start().await;
    let lib = put_attachment(&server, ALICE, "keep.txt", "k").await;
    let draft = upload(&server, ALICE, "drop.txt", b"d").await;
    // 24 時間より前の作成にしてから、掃除する
    sqlx::query("UPDATE files SET created_at = 0")
        .execute(&server.state.pool)
        .await
        .unwrap();
    stored_files::cleanup_orphans(&server.state).await.unwrap();
    assert_eq!(
        file_bytes(&server, lib.file_id.as_deref().unwrap()).await.0,
        200
    );
    assert_eq!(file_bytes(&server, &draft.id).await.0, 404);
}

#[tokio::test]
async fn deleting_a_direct_attachment_removes_it_completely() {
    let server = TestServer::start().await;
    let lib = put_attachment(&server, ALICE, "tmp.txt", "t").await;
    let id = lib.file_id.unwrap();
    let res = req(
        &server,
        ALICE,
        reqwest::Method::DELETE,
        "/api/shared/attachments/tmp.txt",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 204);
    assert_eq!(file_bytes(&server, &id).await.0, 404);
    assert!(names(&server).await.is_empty());
}
