//! 共有フォルダのルールの結合テスト（FEEDBACKS「ファイルシステムがややこしい」。設計は .pi/fs-rules-design.md）。
//! 第 1 段: 変えないこと（既存のルート直下のファイルは読める・消せる、旧い書き方の添付リンク）を固定する。

mod common;

use common::TestServer;

const ALICE: &str = "alice@test";

fn dav(server: &TestServer, m: &str, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(reqwest::Method::from_bytes(m.as_bytes()).unwrap(), server.url(path))
        .header("X-Dev-User", ALICE)
}

/// 以前にできた「ルート直下のファイル」（ディスクに直接ある）は、読めて、消せる。
#[tokio::test]
async fn existing_root_files_stay_readable_and_deletable() {
    let server = TestServer::start().await;
    let shared = server.dir.path().join("shared");
    std::fs::create_dir_all(&shared).unwrap();
    std::fs::write(shared.join("old.txt"), b"legacy").unwrap();

    let res = dav(&server, "GET", "/api/shared/old.txt").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let res = dav(&server, "DELETE", "/api/shared/old.txt").send().await.unwrap();
    assert_eq!(res.status(), 204);
    assert!(!shared.join("old.txt").exists());
}

// ---- 第 4 段: ルート直下は、フォルダだけ新しく作れる。予約名は使えない ----

const DIR_SHARED: &str = "shared";

fn shared(server: &TestServer) -> std::path::PathBuf {
    let p = server.dir.path().join(DIR_SHARED);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn status(server: &TestServer, m: &str, path: &str, body: Option<&str>) -> u16 {
    let mut b = dav(server, m, path);
    if let Some(body) = body {
        b = b.body(body.to_owned());
    }
    b.send().await.unwrap().status().as_u16()
}

async fn op(server: &TestServer, body: serde_json::Value) -> reqwest::Response {
    server
        .http
        .post(server.url("/api/shared"))
        .header("X-Dev-User", ALICE)
        .json(&body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn new_root_files_are_refused_over_rest_and_webdav() {
    let server = TestServer::start().await;
    shared(&server);
    let res = dav(&server, "PUT", "/api/shared/new.txt")
        .body("x")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let body: serde_json::Value = res.json().await.unwrap();
    assert!(body["message"].as_str().unwrap().contains("フォルダだけ"), "{body}");
    assert_eq!(status(&server, "PUT", "/dav/new.txt", Some("x")).await, 403);
    assert!(!shared(&server).join("new.txt").exists());
}

#[tokio::test]
async fn existing_root_files_can_still_be_overwritten_and_nested_files_created() {
    let server = TestServer::start().await;
    let dir = shared(&server);
    std::fs::write(dir.join("old.txt"), b"a").unwrap();
    assert_eq!(status(&server, "PUT", "/api/shared/old.txt", Some("b")).await, 200);
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    assert_eq!(status(&server, "PUT", "/api/shared/docs/new.txt", Some("c")).await, 200);
}

#[tokio::test]
async fn folders_can_be_made_at_the_root_but_not_reserved_names() {
    let server = TestServer::start().await;
    shared(&server);
    assert!(op(&server, serde_json::json!({"op": "mkdir", "path": "photos"})).await.status().is_success());
    for name in ["attachments", "Attachments", ".trash", ".TRASH"] {
        let res = op(&server, serde_json::json!({"op": "mkdir", "path": name})).await;
        assert_eq!(res.status(), 403, "{name}");
        let body: serde_json::Value = res.json().await.unwrap();
        assert!(body["message"].as_str().unwrap().contains("使えません"), "{body}");
    }
}

#[tokio::test]
async fn moving_a_nested_file_to_a_new_root_name_is_refused_but_root_renames_are_kept() {
    let server = TestServer::start().await;
    let dir = shared(&server);
    std::fs::create_dir_all(dir.join("d")).unwrap();
    std::fs::write(dir.join("d").join("a.txt"), b"a").unwrap();
    std::fs::write(dir.join("root.txt"), b"r").unwrap();

    let res = op(&server, serde_json::json!({"op": "move", "from": "d/a.txt", "to": "b.txt"})).await;
    assert_eq!(res.status(), 403);
    assert!(dir.join("d").join("a.txt").exists());

    // 既存のルート直下のファイルは、名前を変えられる（整理できるように）
    let res = op(&server, serde_json::json!({"op": "move", "from": "root.txt", "to": "renamed.txt"})).await;
    assert!(res.status().is_success());
    assert!(dir.join("renamed.txt").exists());

    // 同じ名前のファイルへ上書きする移動（既存の名前）は、overwrite があれば通る
    std::fs::write(dir.join("d").join("c.txt"), b"c").unwrap();
    std::fs::write(dir.join("keep.txt"), b"k").unwrap();
    let res = op(&server, serde_json::json!({"op": "move", "from": "d/c.txt", "to": "keep.txt", "overwrite": true})).await;
    assert!(res.status().is_success());
}

#[tokio::test]
async fn copying_a_file_to_a_new_root_name_is_refused() {
    let server = TestServer::start().await;
    let dir = shared(&server);
    std::fs::create_dir_all(dir.join("d")).unwrap();
    std::fs::write(dir.join("d").join("a.txt"), b"a").unwrap();
    let res = op(&server, serde_json::json!({"op": "copy", "from": "d/a.txt", "to": "b.txt"})).await;
    assert_eq!(res.status(), 403);
    assert!(!dir.join("b.txt").exists());
}

// ---- 第 5 段: 添付の名前の [ ] | は、書き換えず、アップロードで断る ----

async fn upload_status(server: &TestServer, name: &str) -> (u16, serde_json::Value) {
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
    let status = res.status().as_u16();
    let body = res.json().await.unwrap_or(serde_json::Value::Null);
    (status, body)
}

#[tokio::test]
async fn attachment_names_with_brackets_or_bar_are_refused_at_upload() {
    let server = TestServer::start().await;
    for name in ["a[1].txt", "x]y.png", "p|q.pdf"] {
        let (status, body) = upload_status(&server, name).await;
        assert_eq!(status, 400, "{name}");
        assert_eq!(body["code"], "invalid_name", "{name}");
        assert!(body["message"].as_str().unwrap().contains("[ ] |"), "{body}");
    }
    // ふつうの名前は今までどおり（同じ名前は name (2) になる）
    assert_eq!(upload_status(&server, "report.txt").await.0, 200);
    assert_eq!(upload_status(&server, "report.txt").await.1["file_name"], "report (2).txt");
}

// ---- 第 4 段（追加）: ゴミ箱から、ルート直下のファイルへは戻さない ----

#[tokio::test]
async fn restoring_a_root_file_is_refused_and_the_item_stays_in_the_trash() {
    let server = TestServer::start().await;
    common::seed_root_file(&server, "old.txt", b"legacy");
    let res = server
        .post_json(ALICE, "/api/shared-trash", &serde_json::json!({"op": "trash", "path": "old.txt"}))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    let entry: serde_json::Value = res.json().await.unwrap();
    let id = entry["id"].as_str().unwrap().to_owned();

    let res = server
        .post_json(ALICE, "/api/shared-trash", &serde_json::json!({"op": "restore", "id": id}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let body: serde_json::Value = res.json().await.unwrap();
    assert!(body["message"].as_str().unwrap().contains("ルート直下のファイルは戻せません"), "{body}");
    // 項目は残り、ファイルも戻っていない
    let list: serde_json::Value = server.get_json(ALICE, "/api/shared-trash").await;
    assert_eq!(list["entries"].as_array().unwrap().len(), 1);
    assert!(!server.dir.path().join("shared").join("old.txt").exists());
}
