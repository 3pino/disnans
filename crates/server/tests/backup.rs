//! 内蔵のバックアップの結合テスト（DB・共有フォルダ・添付の実体を、ハードリンクの組で残す）。

mod common;

use std::os::unix::fs::MetadataExt;

use common::TestServer;
use disnans_server::backup;

const ALICE: &str = "alice@test";

async fn put(server: &TestServer, path: &str, body: &str) {
    let res = server
        .http
        .put(server.url(path))
        .header("X-Dev-User", ALICE)
        .body(body.to_owned())
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
}

fn set_dir(server: &TestServer, ts: &str, kind: &str) -> std::path::PathBuf {
    server
        .dir
        .path()
        .join("backup")
        .join(format!("{kind}-{ts}"))
}

#[tokio::test]
async fn a_backup_set_keeps_the_db_and_hardlinked_folders() {
    let server = TestServer::start().await;
    put(&server, "/dav/a.txt", "old").await;

    let ts = backup::run(&server.state).await.unwrap();
    let backup_dir = server.dir.path().join("backup");
    let db = backup_dir.join(format!("disnans-{ts}.db"));
    assert!(std::fs::metadata(&db).unwrap().len() > 0, "DB の複製がある");

    // 共有フォルダは同じ実体（ハードリンク）
    let live = server.dir.path().join("shared/a.txt");
    let snap = set_dir(&server, &ts, "shared").join("a.txt");
    assert_eq!(
        std::fs::metadata(&live).unwrap().ino(),
        std::fs::metadata(&snap).unwrap().ino()
    );

    // 上書きをしても、バックアップの中身は古いまま
    put(&server, "/dav/a.txt", "new").await;
    assert_eq!(std::fs::read_to_string(&live).unwrap(), "new");
    assert_eq!(std::fs::read_to_string(&snap).unwrap(), "old");

    // 削除をしても、バックアップには残る
    std::fs::remove_file(&live).unwrap();
    assert_eq!(std::fs::read_to_string(&snap).unwrap(), "old");
}

#[tokio::test]
async fn attachments_are_in_the_backup_by_link_too() {
    let server = TestServer::start().await;
    let part = reqwest::multipart::Part::bytes(b"blob".to_vec())
        .file_name("p.txt".to_owned())
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
    let ts = backup::run(&server.state).await.unwrap();
    let live = server.dir.path().join("files").join(&a.id);
    let snap = set_dir(&server, &ts, "files").join(&a.id);
    assert_eq!(
        std::fs::metadata(&live).unwrap().ino(),
        std::fs::metadata(&snap).unwrap().ino()
    );
    assert_eq!(std::fs::read(&snap).unwrap(), b"blob");
}

#[tokio::test]
async fn each_run_gets_its_own_set() {
    let server = TestServer::start().await;
    let first = backup::run(&server.state).await.unwrap();
    let second = backup::run(&server.state).await.unwrap();
    assert_ne!(first, second);
    assert!(set_dir(&server, &first, "shared").is_dir());
    assert!(set_dir(&server, &second, "shared").is_dir());
}
