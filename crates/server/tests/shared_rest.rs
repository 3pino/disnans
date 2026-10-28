//! `/api/shared`（共有フォルダの REST）の結合テスト。WebDAV と同じ中身・同じ規則。

mod common;

use common::TestServer;
use disnans_shared::{Attachment, ClientEvent, ServerEvent, SharedEntry, SharedListing};
use serde_json::{Value, json};

const ALICE: &str = "alice@test";

fn req(server: &TestServer, m: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(m, server.url(path))
        .header("X-Dev-User", ALICE)
}

async fn put(server: &TestServer, path: &str, body: &str) -> reqwest::Response {
    req(server, reqwest::Method::PUT, path)
        .body(body.to_owned())
        .send()
        .await
        .unwrap()
}

async fn op(server: &TestServer, body: Value) -> reqwest::Response {
    req(server, reqwest::Method::POST, "/api/shared")
        .json(&body)
        .send()
        .await
        .unwrap()
}

async fn read(server: &TestServer, path: &str) -> String {
    req(server, reqwest::Method::GET, path)
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
}

async fn listing(server: &TestServer, path: &str) -> SharedListing {
    let res = req(server, reqwest::Method::GET, path)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{path}");
    res.json().await.unwrap()
}

async fn post_attachment(server: &TestServer, name: &str, mime: &str, data: &[u8]) -> Attachment {
    let part = reqwest::multipart::Part::bytes(data.to_vec())
        .file_name(name.to_owned())
        .mime_str(mime)
        .unwrap();
    let form = reqwest::multipart::Form::new().part("file", part);
    let a: Attachment = server
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
    let mut ws = server.ws(ALICE).await;
    ws.post_with(ClientEvent::MessageSend {
        client_id: format!("c-{name}"),
        body: String::new(),
        attachment_ids: vec![a.id.clone()],
        reply_to: None,
        silent: false,
    })
    .await;
    a
}

#[tokio::test]
async fn root_lists_attachments_and_nothing_else_at_first() {
    let server = TestServer::start().await;
    let root = listing(&server, "/api/shared").await;
    assert_eq!(root.path, "");
    let names: Vec<&str> = root.entries.iter().map(|e| e.name.as_str()).collect();
    // 仮想のゴミ箱（`.trash`）は、ルートの直下に見える（実際の項目は無い）
    assert_eq!(names, vec!["attachments", ".trash"]);
    assert_eq!(root.entries[0].kind, disnans_shared::SharedKind::Dir);
}

#[tokio::test]
async fn put_get_and_range_read_a_file() {
    let server = TestServer::start().await;
    // 親のフォルダが無いと 409
    let res = put(&server, "/api/shared/docs/a.txt", "x").await;
    assert_eq!(res.status(), 409);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["code"], "parent_missing", "{body}");

    let res = op(&server, json!({"op": "mkdir", "path": "docs"})).await;
    assert_eq!(res.status(), 200);
    let made: SharedEntry = res.json().await.unwrap();
    assert_eq!(made.kind, disnans_shared::SharedKind::Dir);
    assert_eq!(made.path, "docs");

    let res = put(&server, "/api/shared/docs/a.txt", "0123456789").await;
    assert_eq!(res.status(), 200);
    let entry: SharedEntry = res.json().await.unwrap();
    assert_eq!(entry.path, "docs/a.txt");
    assert_eq!(entry.size, 10);

    let res = req(&server, reqwest::Method::GET, "/api/shared/docs/a.txt")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"0123456789");

    let res = req(&server, reqwest::Method::GET, "/api/shared/docs/a.txt")
        .header("Range", "bytes=2-4")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"234");

    let folder = listing(&server, "/api/shared/docs").await;
    assert_eq!(folder.entries.len(), 1);
    assert_eq!(folder.entries[0].path, "docs/a.txt");
    assert_eq!(folder.entries[0].kind, disnans_shared::SharedKind::File);
    assert!(
        folder.entries[0].message_id.is_none(),
        "共有フォルダの項目には添付の情報がない"
    );
}

#[tokio::test]
async fn overwrite_move_copy_and_recursive_delete() {
    let server = TestServer::start().await;
    op(&server, json!({"op": "mkdir", "path": "d"})).await;
    put(&server, "/api/shared/d/a.txt", "v1").await;
    assert_eq!(
        put(&server, "/api/shared/d/a.txt", "v2").await.status(),
        200
    );
    assert_eq!(
        req(&server, reqwest::Method::GET, "/api/shared/d/a.txt")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "v2"
    );

    let res = op(
        &server,
        json!({"op": "copy", "from": "d/a.txt", "to": "b.txt"}),
    )
    .await;
    assert_eq!(res.status(), 200);
    let res = op(
        &server,
        json!({"op": "move", "from": "d/a.txt", "to": "d/c.txt"}),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        req(&server, reqwest::Method::GET, "/api/shared/d/a.txt")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        req(&server, reqwest::Method::GET, "/api/shared/d/c.txt")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "v2"
    );

    // フォルダは中身ごと消せる
    let res = req(&server, reqwest::Method::DELETE, "/api/shared/d")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    assert_eq!(
        req(&server, reqwest::Method::GET, "/api/shared/d")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    // 削除したものは、もう一度は 404
    assert_eq!(
        req(&server, reqwest::Method::DELETE, "/api/shared/d")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

#[tokio::test]
async fn attachments_can_be_listed_read_written_renamed_and_copied() {
    let server = TestServer::start().await;
    let a = post_attachment(&server, "report.txt", "text/plain", b"hello").await;

    let att = listing(&server, "/api/shared/attachments").await;
    assert_eq!(att.entries.len(), 1);
    let e = &att.entries[0];
    assert_eq!(e.name, "report.txt");
    assert_eq!(e.path, "attachments/report.txt");
    assert_eq!(e.mime.as_deref(), Some("text/plain"));
    assert_eq!(e.file_id.as_deref(), Some(a.id.as_str()));
    assert!(
        e.message_id.is_some(),
        "投稿された添付はメッセージの ID を持つ"
    );

    // 読める
    let res = req(
        &server,
        reqwest::Method::GET,
        "/api/shared/attachments/report.txt",
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"hello");

    // 中身を差し替えると、同じ ID のまま中身が変わる
    let res = put(&server, "/api/shared/attachments/report.txt", "changed").await;
    assert_eq!(res.status(), 200);
    let entry: SharedEntry = res.json().await.unwrap();
    assert_eq!(entry.file_id.as_deref(), Some(a.id.as_str()));
    assert_eq!(
        read(&server, "/api/shared/attachments/report.txt").await,
        "changed"
    );

    // 名前を変える（attachments の中だけ）
    let res = op(
        &server,
        json!({"op": "move", "from": "attachments/report.txt", "to": "attachments/final.txt"}),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        read(&server, "/api/shared/attachments/final.txt").await,
        "changed"
    );
    // 共有フォルダへは移動できない（コピーだけ）
    let res = op(
        &server,
        json!({"op": "move", "from": "attachments/final.txt", "to": "moved.txt"}),
    )
    .await;
    assert_eq!(res.status(), 403);
    // フォルダは作れない・消せない
    for res in [
        op(&server, json!({"op": "mkdir", "path": "attachments/x"})).await,
        op(&server, json!({"op": "mkdir", "path": "attachments"})).await,
    ] {
        assert_eq!(res.status(), 403, "{}", res.status());
    }
    assert_eq!(
        req(&server, reqwest::Method::DELETE, "/api/shared/attachments")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    // 添付から共有フォルダへはコピーできる
    let res = op(
        &server,
        json!({"op": "copy", "from": "attachments/final.txt", "to": "copy.txt"}),
    )
    .await;
    assert_eq!(res.status(), 200);
    let copied: SharedEntry = res.json().await.unwrap();
    assert_eq!(copied.path, "copy.txt");
    assert_eq!(read(&server, "/api/shared/copy.txt").await, "changed");
}
#[tokio::test]
async fn names_and_paths_are_checked() {
    let server = TestServer::start().await;
    for path in [
        "/api/shared/CON.txt",
        "/api/shared/a%3Ab",
        "/api/shared/%2E%2E/x",
        "/api/shared/..%2Fx",
    ] {
        let res = put(&server, path, "x").await;
        assert!(
            res.status() == 403 || res.status() == 404 || res.status() == 409,
            "{path} -> {}",
            res.status()
        );
    }
    let res = op(&server, json!({"op": "mkdir", "path": ".disnans-tmp-1"})).await;
    assert_eq!(res.status(), 403);
    let root = listing(&server, "/api/shared").await;
    assert_eq!(
        root.entries.len(),
        2,
        "{:?}",
        root.entries.iter().map(|e| &e.name).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn changes_are_announced_on_the_websocket() {
    let server = TestServer::start().await;
    let mut ws = server.ws(ALICE).await;
    put(&server, "/api/shared/hello.txt", "hi").await;
    let ev = ws
        .recv_until(|e| matches!(e, ServerEvent::FilesChanged { path } if path == "hello.txt"))
        .await;
    assert!(matches!(ev, ServerEvent::FilesChanged { .. }));

    op(&server, json!({"op": "mkdir", "path": "dir1"})).await;
    ws.recv_until(|e| matches!(e, ServerEvent::FilesChanged { path } if path == "dir1"))
        .await;

    req(&server, reqwest::Method::DELETE, "/api/shared/hello.txt")
        .send()
        .await
        .unwrap();
    ws.recv_until(|e| matches!(e, ServerEvent::FilesChanged { path } if path == "hello.txt"))
        .await;

    // WebDAV の書き込みも同じく流れる
    let res = server
        .http
        .put(server.url("/dav/from-dav.txt"))
        .header("X-Dev-User", ALICE)
        .body("d")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    ws.recv_until(|e| matches!(e, ServerEvent::FilesChanged { path } if path == "from-dav.txt"))
        .await;
}

#[tokio::test]
async fn copy_and_move_refuse_an_existing_destination_unless_overwrite_is_set() {
    let server = TestServer::start().await;
    put(&server, "/api/shared/src.txt", "new").await;
    put(&server, "/api/shared/dst.txt", "old").await;

    // 既定（overwrite なし）は 409 exists、中身は変わらない
    let res = op(
        &server,
        json!({"op": "copy", "from": "src.txt", "to": "dst.txt"}),
    )
    .await;
    assert_eq!(res.status(), 409);
    assert_eq!(res.json::<Value>().await.unwrap()["code"], "exists");
    assert_eq!(read(&server, "/api/shared/dst.txt").await, "old");

    let res = op(
        &server,
        json!({"op": "move", "from": "src.txt", "to": "dst.txt", "overwrite": false}),
    )
    .await;
    assert_eq!(res.status(), 409);
    assert_eq!(
        read(&server, "/api/shared/src.txt").await,
        "new",
        "移動に失敗したら元はそのまま"
    );

    // overwrite: true なら差し替える
    let res = op(
        &server,
        json!({"op": "copy", "from": "src.txt", "to": "dst.txt", "overwrite": true}),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(read(&server, "/api/shared/dst.txt").await, "new");
    let res = op(
        &server,
        json!({"op": "move", "from": "src.txt", "to": "dst.txt", "overwrite": true}),
    )
    .await;
    assert_eq!(res.status(), 200);
    assert_eq!(read(&server, "/api/shared/dst.txt").await, "new");
    assert_eq!(
        req(&server, reqwest::Method::GET, "/api/shared/src.txt")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

#[tokio::test]
async fn folders_are_never_overwritten_even_with_overwrite() {
    let server = TestServer::start().await;
    op(&server, json!({"op": "mkdir", "path": "dir"})).await;
    put(&server, "/api/shared/f.txt", "f").await;
    let res = op(
        &server,
        json!({"op": "copy", "from": "f.txt", "to": "dir", "overwrite": true}),
    )
    .await;
    assert_eq!(res.status(), 409);
    let res = op(
        &server,
        json!({"op": "move", "from": "f.txt", "to": "dir", "overwrite": true}),
    )
    .await;
    assert_eq!(res.status(), 409);
    assert_eq!(listing(&server, "/api/shared/dir").await.entries.len(), 0);
}
