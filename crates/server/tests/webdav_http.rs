//! `/dav` の HTTP の結合テスト（PROPFIND・GET・書き込みの拒否・LOCK）。
//! 開発モード（`X-Dev-User`）で利用者を決める。

mod common;

use common::TestServer;
use disnans_shared::{Attachment, ClientEvent};

const ALICE: &str = "alice@test";

fn method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).unwrap()
}

async fn upload(server: &TestServer, name: &str, data: &[u8]) -> Attachment {
    let part = reqwest::multipart::Part::bytes(data.to_vec())
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

/// 添付を投稿して、本文（メッセージ）に付ける
async fn post_attachment(server: &TestServer, name: &str, data: &[u8]) {
    let a = upload(server, name, data).await;
    let mut ws = server.ws(ALICE).await;
    ws.post_with(ClientEvent::MessageSend {
        client_id: format!("c-{name}"),
        body: String::new(),
        attachment_ids: vec![a.id],
        reply_to: None,
        silent: false,
    })
    .await;
}

fn dav(server: &TestServer, m: &str, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(method(m), server.url(path))
        .header("X-Dev-User", ALICE)
}

#[tokio::test]
async fn root_lists_the_attachments_folder() {
    let server = TestServer::start().await;
    let res = dav(&server, "PROPFIND", "/dav/")
        .header("Depth", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 207, "{}", res.text().await.unwrap());
    let body = res.text().await.unwrap();
    assert!(body.contains("/dav/attachments/"), "{body}");
}

#[tokio::test]
async fn posted_attachments_are_listed_and_readable() {
    let server = TestServer::start().await;
    post_attachment(&server, "report.txt", b"hello dav").await;
    // 投稿前のアップロードは見えない
    upload(&server, "draft.txt", b"not posted").await;

    let res = dav(&server, "PROPFIND", "/dav/attachments/")
        .header("Depth", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 207);
    let body = res.text().await.unwrap();
    assert!(body.contains("report.txt"), "{body}");
    assert!(!body.contains("draft.txt"), "{body}");

    let res = dav(&server, "GET", "/dav/attachments/report.txt")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"hello dav");

    let res = dav(&server, "GET", "/dav/attachments/draft.txt")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn range_reads_work() {
    let server = TestServer::start().await;
    post_attachment(&server, "range.txt", b"0123456789").await;
    let res = dav(&server, "GET", "/dav/attachments/range.txt")
        .header("Range", "bytes=2-4")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"234");
}

#[tokio::test]
async fn attachments_accept_writes_and_keep_the_reserved_folder() {
    let server = TestServer::start().await;
    post_attachment(&server, "keep.txt", b"keep").await;

    // 中身の差し替え（同じ名前）と、新しい添付（直接作る）
    let res = dav(&server, "PUT", "/dav/attachments/keep.txt")
        .body("changed")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    let res = dav(&server, "PUT", "/dav/attachments/new.txt")
        .body("fresh")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    let res = dav(&server, "GET", "/dav/attachments/keep.txt")
        .send()
        .await
        .unwrap();
    assert_eq!(res.text().await.unwrap(), "changed");

    // 名前の変更（attachments の中だけ）
    let res = dav(&server, "MOVE", "/dav/attachments/new.txt")
        .header("Destination", server.url("/dav/attachments/renamed.txt"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "MOVE {}", res.status());
    assert_eq!(
        dav(&server, "GET", "/dav/attachments/new.txt")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );

    // 予約のフォルダそのもの・フォルダの作成・PROPPATCH は拒否
    for (m, path) in [
        ("MKCOL", "/dav/attachments/newdir"),
        ("DELETE", "/dav/attachments"),
        ("DELETE", "/dav/attachments/"),
        ("DELETE", "/dav"),
        ("PROPPATCH", "/dav/attachments/keep.txt"),
    ] {
        let mut req = dav(&server, m, path);
        if m == "PUT" || m == "PROPPATCH" {
            req = req.body("x");
        }
        let res = req.send().await.unwrap();
        assert!(
            matches!(res.status().as_u16(), 403 | 405),
            "{m} {path} -> {}",
            res.status()
        );
    }
    // 添付のフォルダを消そうとして、中身も消えていないこと
    let res = dav(&server, "PROPFIND", "/dav/attachments/")
        .header("Depth", "1")
        .send()
        .await
        .unwrap();
    let body = res.text().await.unwrap();
    assert!(
        body.contains("keep.txt") && body.contains("renamed.txt"),
        "{body}"
    );

    // 共有フォルダへは移動できない（コピーだけ）
    let res = dav(&server, "MOVE", "/dav/attachments/renamed.txt")
        .header("Destination", server.url("/dav/moved.txt"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403, "MOVE 先が共有フォルダ");
    assert_eq!(
        dav(&server, "GET", "/dav/attachments/renamed.txt")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}
#[tokio::test]
async fn paths_outside_the_listing_are_not_found() {
    let server = TestServer::start().await;
    post_attachment(&server, "a.txt", b"a").await;
    for path in [
        "/dav/nothing",
        "/dav/attachments/nothing.txt",
        "/dav/attachments/..%2F..%2Fdata",
        "/dav/attachments/a.txt/x",
    ] {
        let res = dav(&server, "GET", path).send().await.unwrap();
        // 見つからない（404）か、不正なパス（400）。どちらでも本文は返らない
        assert!(
            res.status() == 404 || res.status() == 400,
            "{path} -> {}",
            res.status()
        );
    }
}

#[tokio::test]
async fn lock_and_unlock_are_available_for_windows_clients() {
    let server = TestServer::start().await;
    post_attachment(&server, "lock.txt", b"l").await;
    let res = dav(&server, "LOCK", "/dav/attachments/lock.txt")
        .header("Timeout", "Second-60")
        .body(
            r#"<?xml version="1.0" encoding="utf-8"?>
<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>tester</D:owner></D:lockinfo>"#,
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
}

#[tokio::test]
async fn options_advertises_the_methods_and_dav_class() {
    let server = TestServer::start().await;
    post_attachment(&server, "opt.txt", b"o").await;
    // 添付（ファイル）には読み取りと書き込みの印が付く。フォルダには PROPFIND など
    let res = dav(&server, "OPTIONS", "/dav/attachments/opt.txt")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let allow = res
        .headers()
        .get("allow")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(allow.contains("GET") && allow.contains("LOCK"), "{allow}");
    assert!(!allow.contains("PROPPATCH"), "{allow}");
    let res = dav(&server, "OPTIONS", "/dav/").send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.headers().get("dav").is_some(), "DAV: ヘッダーがある");
    let allow = res
        .headers()
        .get("allow")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(allow.contains("PROPFIND"), "{allow}");
}
