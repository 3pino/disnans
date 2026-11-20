//! 共有フォルダへの書き込み（第 2 段）の結合テスト。`/dav` を開発モード（`X-Dev-User`）で使う。

mod common;

use common::TestServer;

const ALICE: &str = "alice@test";

fn method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).unwrap()
}

fn dav(server: &TestServer, m: &str, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(method(m), server.url(path))
        .header("X-Dev-User", ALICE)
}

/// 本文付きのリクエスト。戻り値はステータス。
async fn send(server: &TestServer, m: &str, path: &str, body: &str) -> u16 {
    dav(server, m, path)
        .body(body.to_owned())
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

async fn get(server: &TestServer, path: &str) -> (u16, String) {
    let res = dav(server, "GET", path).send().await.unwrap();
    let status = res.status().as_u16();
    (status, res.text().await.unwrap())
}

fn on_disk(server: &TestServer, rel: &str) -> std::path::PathBuf {
    server.dir.path().join("shared").join(rel)
}

#[tokio::test]
async fn put_creates_and_overwrites_a_file() {
    let server = TestServer::start().await;
    make_d(&server);
    assert_eq!(send(&server, "PUT", "/dav/d/notes.txt", "one").await, 201);
    assert_eq!(get(&server, "/dav/d/notes.txt").await, (200, "one".into()));
    assert_eq!(
        std::fs::read_to_string(on_disk(&server, "d/notes.txt")).unwrap(),
        "one"
    );

    assert_eq!(send(&server, "PUT", "/dav/d/notes.txt", "two").await, 204);
    assert_eq!(get(&server, "/dav/d/notes.txt").await, (200, "two".into()));
    // 一時ファイルは残らない
    let names: Vec<String> = std::fs::read_dir(server.dir.path().join("shared").join("d"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["notes.txt".to_owned()]);
}

#[tokio::test]
async fn overwrite_replaces_the_name_and_keeps_the_old_content_for_hardlinks() {
    let server = TestServer::start().await;
    make_d(&server);
    send(&server, "PUT", "/dav/d/a.txt", "v1").await;
    // 今の実体をハードリンクで残す（バックアップと同じ仕組み）
    let keep = server.dir.path().join("kept.txt");
    std::fs::hard_link(on_disk(&server, "d/a.txt"), &keep).unwrap();
    assert_eq!(send(&server, "PUT", "/dav/d/a.txt", "v2").await, 204);
    assert_eq!(
        std::fs::read_to_string(&keep).unwrap(),
        "v1",
        "上書きでも古い実体の中身は変わらない"
    );
    assert_eq!(get(&server, "/dav/d/a.txt").await, (200, "v2".into()));
}

#[tokio::test]
async fn partial_put_with_content_range_changes_only_that_part() {
    let server = TestServer::start().await;
    make_d(&server);
    send(&server, "PUT", "/dav/d/range.txt", "0123456789").await;
    let res = dav(&server, "PUT", "/dav/d/range.txt")
        .header("Content-Range", "bytes 2-4/10")
        .body("abc")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    assert_eq!(
        get(&server, "/dav/d/range.txt").await,
        (200, "01abc56789".into())
    );
}

#[tokio::test]
async fn folders_can_be_made_filled_and_removed() {
    let server = TestServer::start().await;
    make_d(&server);
    assert_eq!(send(&server, "MKCOL", "/dav/d/docs", "").await, 201);
    assert_eq!(
        send(&server, "MKCOL", "/dav/d/docs", "").await,
        405,
        "同じ名前のフォルダは作れない"
    );
    assert_eq!(send(&server, "PUT", "/dav/d/docs/a.txt", "a").await, 201);
    assert_eq!(get(&server, "/dav/d/docs/a.txt").await, (200, "a".into()));
    // 中身のあるフォルダも消せる（DELETE は再帰）
    assert_eq!(send(&server, "DELETE", "/dav/d/docs", "").await, 204);
    assert!(!on_disk(&server, "d/docs").exists());
}

#[tokio::test]
async fn put_into_a_missing_folder_conflicts() {
    let server = TestServer::start().await;
    make_d(&server);
    assert_eq!(send(&server, "PUT", "/dav/nofolder/x.txt", "x").await, 409);
    assert!(!on_disk(&server, "d/nofolder").exists());
}

#[tokio::test]
async fn move_and_copy_work_inside_the_shared_folder() {
    let server = TestServer::start().await;
    make_d(&server);
    send(&server, "PUT", "/dav/d/a.txt", "A").await;
    let to = |p: &str| server.url(p);
    let res = dav(&server, "COPY", "/dav/d/a.txt")
        .header("Destination", to("/dav/d/b.txt"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "COPY {}", res.status());
    assert_eq!(get(&server, "/dav/d/b.txt").await, (200, "A".into()));
    assert_eq!(get(&server, "/dav/d/a.txt").await, (200, "A".into()));

    let res = dav(&server, "MOVE", "/dav/d/a.txt")
        .header("Destination", to("/dav/d/c.txt"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "MOVE {}", res.status());
    assert_eq!(get(&server, "/dav/d/a.txt").await.0, 404);
    assert_eq!(get(&server, "/dav/d/c.txt").await, (200, "A".into()));
}

#[tokio::test]
async fn the_attachments_folder_is_reserved_but_its_files_can_change() {
    let server = TestServer::start().await;
    make_d(&server);
    send(&server, "PUT", "/dav/d/x.txt", "x").await;
    // フォルダそのもの・共有への移動は不可
    for (m, path, dest) in [
        ("MKCOL", "/dav/attachments", None),
        ("PUT", "/dav/attachments", None),
        ("DELETE", "/dav/attachments", None),
        ("MOVE", "/dav/d/x.txt", Some("/dav/attachments/x.txt")),
        ("MOVE", "/dav/attachments", Some("/dav/d/moved")),
    ] {
        let mut req = dav(&server, m, path).body("z");
        if let Some(d) = dest {
            req = req.header("Destination", server.url(d));
        }
        let status = req.send().await.unwrap().status().as_u16();
        assert!(
            (400..500).contains(&status) || status == 207,
            "{m} {path} -> {status}"
        );
    }
    assert!(
        !on_disk(&server, "d/attachments").exists(),
        "予約の名前の実体は作られない"
    );
    assert_eq!(get(&server, "/dav/d/x.txt").await, (200, "x".into()));

    // 添付の中へはコピーで入る（新しい添付）
    let res = dav(&server, "COPY", "/dav/d/x.txt")
        .header("Destination", server.url("/dav/attachments/x-copy.txt"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "COPY {}", res.status());
    assert_eq!(
        get(&server, "/dav/attachments/x-copy.txt").await,
        (200, "x".into())
    );
    assert_eq!(get(&server, "/dav/d/x.txt").await, (200, "x".into()));
}
#[tokio::test]
async fn dangerous_names_are_refused_and_nothing_escapes_the_shared_folder() {
    let server = TestServer::start().await;
    make_d(&server);
    let outside = server.dir.path().join("escaped.txt");
    for path in [
        "/dav/%2E%2E/escaped.txt",
        "/dav/..%2Fescaped.txt",
        "/dav/d/CON.txt",
        "/dav/d/nul",
        "/dav/a%3Ab.txt",
        "/dav/d/trailing.",
        "/dav/d/.disnans-tmp-x",
    ] {
        let status = send(&server, "PUT", path, "bad").await;
        assert!((400..500).contains(&status), "{path} -> {status}");
    }
    assert!(!outside.exists(), "共有フォルダの外には書けない");
    let listing = dav(&server, "PROPFIND", "/dav/")
        .header("Depth", "1")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!listing.contains(".disnans-tmp"), "{listing}");
}

#[cfg(unix)]
#[tokio::test]
async fn symbolic_links_are_never_followed_or_listed() {
    let server = TestServer::start().await;
    make_d(&server);
    let secret = server.dir.path().join("secret.txt");
    std::fs::write(&secret, "SECRET").unwrap();
    std::os::unix::fs::symlink(&secret, on_disk(&server, "d/link")).unwrap();
    std::os::unix::fs::symlink(server.dir.path(), on_disk(&server, "d/dirlink")).unwrap();

    // 読めない・書けない（リンクの先は見せない）
    assert!(get(&server, "/dav/d/link").await.0 >= 400);
    assert!(send(&server, "PUT", "/dav/d/link", "over").await >= 400);
    assert!(send(&server, "PUT", "/dav/dirlink/new.txt", "x").await >= 400);
    assert!(get(&server, "/dav/dirlink/secret.txt").await.0 >= 400);
    assert!(send(&server, "DELETE", "/dav/d/link", "").await >= 400);
    assert_eq!(std::fs::read_to_string(&secret).unwrap(), "SECRET");
    // 一覧にも出ない
    let listing = dav(&server, "PROPFIND", "/dav/")
        .header("Depth", "1")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(!listing.contains("link"), "{listing}");
}

/// 直下のファイルは PUT で作れない（fs_rules.rs）。この試験の本体は `d/` の中で行う。
fn make_d(server: &TestServer) {
    std::fs::create_dir_all(server.dir.path().join("shared").join("d")).unwrap();
}
