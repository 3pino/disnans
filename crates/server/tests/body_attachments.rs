//! 本文が真実の添付（`![[disnans:file/<ID>]]`）の結合テスト。設計は docs/API.md の「本文のリンク」。
//! 旧クライアントの `attachment_ids`、本文だけの添付、編集でのリンクの追加・削除、複数参照、削除、名前の曖昧さ、作成日時。

mod common;

use common::TestServer;
use disnans_server::store::files as store_files;
use disnans_shared::{Attachment, ClientEvent, Message, SharedEntry, SharedListing};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn req(server: &TestServer, m: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(m, server.url(path))
        .header("X-Dev-User", ALICE)
}

async fn upload(server: &TestServer, name: &str) -> Attachment {
    let part = reqwest::multipart::Part::bytes(b"data".to_vec())
        .file_name(name.to_owned())
        .mime_str("text/plain")
        .unwrap();
    let form = reqwest::multipart::Form::new().part("file", part);
    let res = server
        .http
        .post(server.url("/api/files"))
        .header("X-Dev-User", ALICE)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

/// `attachments/` に直接作る（library）。
async fn put_library(server: &TestServer, name: &str) -> SharedEntry {
    let res = req(
        server,
        reqwest::Method::PUT,
        &format!("/api/shared/attachments/{name}"),
    )
    .body("lib".to_owned())
    .send()
    .await
    .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    res.json().await.unwrap()
}

async fn ws_send(server: &TestServer, event: ClientEvent) -> Message {
    let mut ws = server.ws(ALICE).await;
    ws.post_with(event).await
}

async fn send(server: &TestServer, body: &str, ids: &[&str]) -> Message {
    ws_send(
        server,
        ClientEvent::MessageSend {
            client_id: format!("c-{body}"),
            body: body.into(),
            attachment_ids: ids.iter().map(|s| s.to_string()).collect(),
            reply_to: None,
            silent: false,
        },
    )
    .await
}

async fn send_error(server: &TestServer, body: &str, ids: &[&str]) -> String {
    let mut ws = server.ws(ALICE).await;
    ws.send(ClientEvent::MessageSend {
        client_id: "err".into(),
        body: body.into(),
        attachment_ids: ids.iter().map(|s| s.to_string()).collect(),
        reply_to: None,
        silent: false,
    })
    .await;
    ws.expect_error().await.1
}

async fn edit(server: &TestServer, id: &str, body: &str) {
    let mut ws = server.ws(ALICE).await;
    ws.send(ClientEvent::MessageEdit {
        message_id: id.into(),
        body: body.into(),
    })
    .await;
    ws.recv_until(|e| {
        matches!(
            e,
            disnans_shared::ServerEvent::MessageUpdated { .. }
                | disnans_shared::ServerEvent::Error { .. }
        )
    })
    .await;
}

async fn edit_error(server: &TestServer, id: &str, body: &str) -> String {
    let mut ws = server.ws(ALICE).await;
    ws.send(ClientEvent::MessageEdit {
        message_id: id.into(),
        body: body.into(),
    })
    .await;
    ws.expect_error().await.1
}

async fn delete_message(server: &TestServer, id: &str) {
    let mut ws = server.ws(ALICE).await;
    ws.send(ClientEvent::MessageDelete {
        message_id: id.into(),
    })
    .await;
    ws.recv_until(|e| matches!(e, disnans_shared::ServerEvent::MessageDeleted { .. }))
        .await;
}

async fn message(server: &TestServer, id: &str) -> Message {
    server
        .messages("")
        .await
        .into_iter()
        .find(|m| m.id == id)
        .unwrap()
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

async fn shared_names(server: &TestServer) -> Vec<String> {
    let listing: SharedListing = req(server, reqwest::Method::GET, "/api/shared/attachments")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    listing.entries.into_iter().map(|e| e.name).collect()
}

#[tokio::test]
async fn an_old_client_attachment_ids_send_becomes_an_embed_in_the_body() {
    let server = TestServer::start().await;
    let a = upload(&server, "a.txt").await;
    let m = send(&server, "see", &[&a.id]).await;
    assert_eq!(m.body, "see\n![[attachments/a.txt]]");
    assert_eq!(m.attachments.len(), 1);
    assert_eq!(m.attachments[0].id, a.id);
    // 空の本文の添付だけも、本文に埋め込みが入る（改行は入れない）
    let only = send(&server, "", &[&upload(&server, "b.txt").await.id]).await;
    assert_eq!(only.body, "![[attachments/b.txt]]");
    assert_eq!(only.attachments.len(), 1);
}

#[tokio::test]
async fn a_name_link_in_the_body_attaches_a_library_file() {
    let server = TestServer::start().await;
    let entry = put_library(&server, "lib.txt").await;
    let m = send(
        &server,
        "look [[lib.txt]] and [[attachments/lib.txt|x]]",
        &[],
    )
    .await;
    assert_eq!(m.attachments.len(), 1, "同じ添付は一つ");
    assert_eq!(m.attachments[0].id, entry.file_id.unwrap());
    assert_eq!(
        m.body,
        "look [[attachments/lib.txt]] and [[attachments/lib.txt|x]]"
    );
}

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

async fn send_as_error(server: &TestServer, user: &str, body: &str) -> String {
    let mut ws = server.ws(user).await;
    ws.send(ClientEvent::MessageSend {
        client_id: "err".into(),
        body: body.into(),
        attachment_ids: vec![],
        reply_to: None,
        silent: false,
    })
    .await;
    ws.expect_error().await.1
}

#[tokio::test]
async fn an_unposted_upload_is_referenced_by_its_own_uploader_only() {
    let server = TestServer::start().await;
    let mine = upload(&server, "mine.txt").await;
    // 自分の未投稿は、本文の ID でも名前でも参照できる（送信で投稿扱いになる）
    let m = send(&server, &format!("![[disnans:file/{}]]", mine.id), &[]).await;
    assert_eq!(m.attachments.len(), 1);
    assert_eq!(m.attachments[0].id, mine.id);

    let draft = upload(&server, "draft.txt").await;
    let by_name = send(&server, "![[attachments/draft.txt]]", &[]).await;
    assert_eq!(by_name.attachments[0].id, draft.id);

    // ほかの利用者の未投稿は、ID でも名前でも参照できない
    let theirs = upload_as(&server, BOB, "bobs.txt").await;
    assert_eq!(
        send_as_error(&server, ALICE, &format!("![[disnans:file/{}]]", theirs.id)).await,
        "invalid_link"
    );
    assert_eq!(
        send_as_error(&server, ALICE, "![[attachments/bobs.txt]]").await,
        "invalid_link"
    );
}

#[tokio::test]
async fn removing_the_link_detaches_the_file_and_keeps_it_in_attachments() {
    let server = TestServer::start().await;
    let a = upload(&server, "a.txt").await;
    let m = send(&server, "see", &[&a.id]).await;
    edit(&server, &m.id, "see").await;

    let after = message(&server, &m.id).await;
    assert!(after.attachments.is_empty());
    assert_eq!(after.body, "see");
    assert_eq!(file_status(&server, &a.id).await, 200, "ファイルは残る");
    assert!(shared_names(&server).await.contains(&"a.txt".to_owned()));

    // 付け直すと、同じ ID が戻る
    edit(&server, &m.id, "see ![[attachments/a.txt]]").await;
    let back = message(&server, &m.id).await;
    assert_eq!(back.attachments.len(), 1);
    assert_eq!(back.attachments[0].id, a.id);
}

#[tokio::test]
async fn an_attachment_only_message_can_be_edited_and_keeps_its_file() {
    let server = TestServer::start().await;
    let a = upload(&server, "photo.webp").await;
    let m = send(&server, "", &[&a.id]).await;
    // 本文を消すと、空のメッセージになる（添付も本文の中）
    let err = edit_error(&server, &m.id, "  ").await;
    assert_eq!(err, "empty_message");
    // 本文を書き足して編集しても、添付は残る
    edit(&server, &m.id, "![[attachments/photo.webp]] 写真").await;
    assert_eq!(message(&server, &m.id).await.attachments.len(), 1);
}

#[tokio::test]
async fn one_file_can_be_referenced_by_two_messages() {
    let server = TestServer::start().await;
    let a = upload(&server, "a.txt").await;
    let first = send(&server, "first", &[&a.id]).await;
    let second = send(&server, "again [[attachments/a.txt]]", &[]).await;
    assert_eq!(second.attachments[0].id, a.id);

    // 最初のメッセージを消しても、もう一方が残っていれば添付も残る
    delete_message(&server, &first.id).await;
    assert_eq!(file_status(&server, &a.id).await, 200);
    assert_eq!(message(&server, &second.id).await.attachments.len(), 1);

    // 最後の一つを消すと、添付も消える
    delete_message(&server, &second.id).await;
    assert_eq!(file_status(&server, &a.id).await, 404);
    assert!(!shared_names(&server).await.contains(&"a.txt".to_owned()));
}

#[tokio::test]
async fn a_deleted_attachment_stays_as_a_mark_until_the_link_is_removed() {
    let server = TestServer::start().await;
    let a = upload(&server, "gone.txt").await;
    let m = send(&server, "with file", &[&a.id]).await;
    let res = req(
        &server,
        reqwest::Method::DELETE,
        "/api/shared/attachments/gone.txt",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 204);
    let marked = message(&server, &m.id).await;
    assert!(marked.attachments[0].deleted);
    assert_eq!(marked.attachments[0].file_name, "gone.txt");

    // リンクを消すと、印も消える（行ごと消える）
    edit(&server, &m.id, "with file").await;
    assert!(message(&server, &m.id).await.attachments.is_empty());
    assert_eq!(file_status(&server, &a.id).await, 404);
}

#[tokio::test]
async fn a_bare_name_that_is_also_a_shared_file_is_ambiguous() {
    let server = TestServer::start().await;
    put_library(&server, "same.txt").await;
    std::fs::create_dir_all(server.dir.path().join("shared")).unwrap();
    std::fs::write(server.dir.path().join("shared").join("same.txt"), b"shared").unwrap();

    assert_eq!(
        send_error(&server, "[[same.txt]]", &[]).await,
        "ambiguous_link"
    );
    // 書けば解決する
    let m = send(&server, "[[attachments/same.txt]]", &[]).await;
    assert_eq!(m.attachments.len(), 1);
    // 添付に無い名前は、ただの文字として残る（共有のパス）
    let plain = send(&server, "[[other.txt]]", &[]).await;
    assert_eq!(plain.body, "[[other.txt]]");
    assert!(plain.attachments.is_empty());
}

#[tokio::test]
async fn code_is_not_read_for_links() {
    let server = TestServer::start().await;
    put_library(&server, "code.txt").await;
    let m = send(
        &server,
        "`[[attachments/code.txt]]` と\n```\n[[attachments/code.txt]]\n```",
        &[],
    )
    .await;
    assert!(m.attachments.is_empty());
    assert_eq!(
        m.body,
        "`[[attachments/code.txt]]` と\n```\n[[attachments/code.txt]]\n```"
    );
}

#[tokio::test]
async fn created_time_is_the_first_post_and_survives_detaching() {
    let server = TestServer::start().await;
    let a = upload(&server, "t.txt").await;
    let m = send(&server, "see", &[&a.id]).await;
    let posted_ms = m.created_at;
    edit(&server, &m.id, "see").await;
    let items = store_files::attachment_items(&server.state.pool)
        .await
        .unwrap();
    let item = items.iter().find(|i| i.file_id == a.id).unwrap();
    assert_eq!(item.posted_at_ms, posted_ms);
}

#[tokio::test]
async fn webdav_creationdate_is_the_first_post_time_and_stays_after_detaching() {
    let server = TestServer::start().await;
    let a = upload(&server, "dated.txt").await;
    let m = send(&server, "see", &[&a.id]).await;
    edit(&server, &m.id, "see").await;

    let res = server
        .http
        .request(
            reqwest::Method::from_bytes(b"PROPFIND").unwrap(),
            server.url("/dav/attachments/dated.txt"),
        )
        .header("X-Dev-User", ALICE)
        .header("Depth", "0")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 207);
    let xml = res.text().await.unwrap();
    // 投稿の時刻（ミリ秒）と同じ時刻の作成日時が返る（RFC 3339 の秒の精度）
    let at = chrono_like(m.created_at);
    assert!(
        xml.contains(&format!("<D:creationdate>{at}</D:creationdate>")),
        "{xml}"
    );
}

/// ミリ秒の UNIX 時刻を、WebDAV の creationdate（RFC 3339、UTC、秒まで）にする。テスト用の簡単な変換。
fn chrono_like(ms: i64) -> String {
    let secs = ms / 1000;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // 1970-01-01 からの日数 → 年月日（グレゴリオ暦）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}
