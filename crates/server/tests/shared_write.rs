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
    assert_eq!(send(&server, "PUT", "/dav/notes.txt", "one").await, 201);
    assert_eq!(get(&server, "/dav/notes.txt").await, (200, "one".into()));
    assert_eq!(
        std::fs::read_to_string(on_disk(&server, "notes.txt")).unwrap(),
        "one"
    );

    assert_eq!(send(&server, "PUT", "/dav/notes.txt", "two").await, 204);
    assert_eq!(get(&server, "/dav/notes.txt").await, (200, "two".into()));
    // 一時ファイルは残らない
    let names: Vec<String> = std::fs::read_dir(server.dir.path().join("shared"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, vec!["notes.txt".to_owned()]);
}

#[tokio::test]
async fn overwrite_replaces_the_name_and_keeps_the_old_content_for_hardlinks() {
    let server = TestServer::start().await;
    send(&server, "PUT", "/dav/a.txt", "v1").await;
    // 今の実体をハードリンクで残す（バックアップと同じ仕組み）
    let keep = server.dir.path().join("kept.txt");
    std::fs::hard_link(on_disk(&server, "a.txt"), &keep).unwrap();
    assert_eq!(send(&server, "PUT", "/dav/a.txt", "v2").await, 204);
    assert_eq!(
        std::fs::read_to_string(&keep).unwrap(),
        "v1",
        "上書きでも古い実体の中身は変わらない"
    );
    assert_eq!(get(&server, "/dav/a.txt").await, (200, "v2".into()));
}

#[tokio::test]
async fn partial_put_with_content_range_changes_only_that_part() {
    let server = TestServer::start().await;
    send(&server, "PUT", "/dav/range.txt", "0123456789").await;
    let res = dav(&server, "PUT", "/dav/range.txt")
        .header("Content-Range", "bytes 2-4/10")
        .body("abc")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    assert_eq!(
        get(&server, "/dav/range.txt").await,
        (200, "01abc56789".into())
    );
}

#[tokio::test]
async fn folders_can_be_made_filled_and_removed() {
    let server = TestServer::start().await;
    assert_eq!(send(&server, "MKCOL", "/dav/docs", "").await, 201);
    assert_eq!(
        send(&server, "MKCOL", "/dav/docs", "").await,
        405,
        "同じ名前のフォルダは作れない"
    );
    assert_eq!(send(&server, "PUT", "/dav/docs/a.txt", "a").await, 201);
    assert_eq!(get(&server, "/dav/docs/a.txt").await, (200, "a".into()));
    // 中身のあるフォルダも消せる（DELETE は再帰）
    assert_eq!(send(&server, "DELETE", "/dav/docs", "").await, 204);
    assert!(!on_disk(&server, "docs").exists());
}

#[tokio::test]
async fn put_into_a_missing_folder_conflicts() {
    let server = TestServer::start().await;
    assert_eq!(send(&server, "PUT", "/dav/nofolder/x.txt", "x").await, 409);
    assert!(!on_disk(&server, "nofolder").exists());
}

#[tokio::test]
async fn move_and_copy_work_inside_the_shared_folder() {
    let server = TestServer::start().await;
    send(&server, "PUT", "/dav/a.txt", "A").await;
    let to = |p: &str| server.url(p);
    let res = dav(&server, "COPY", "/dav/a.txt")
        .header("Destination", to("/dav/b.txt"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "COPY {}", res.status());
    assert_eq!(get(&server, "/dav/b.txt").await, (200, "A".into()));
    assert_eq!(get(&server, "/dav/a.txt").await, (200, "A".into()));

    let res = dav(&server, "MOVE", "/dav/a.txt")
        .header("Destination", to("/dav/c.txt"))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "MOVE {}", res.status());
    assert_eq!(get(&server, "/dav/a.txt").await.0, 404);
    assert_eq!(get(&server, "/dav/c.txt").await, (200, "A".into()));
}

#[tokio::test]
async fn the_attachments_folder_is_reserved_and_read_only() {
    let server = TestServer::start().await;
    send(&server, "PUT", "/dav/x.txt", "x").await;
    // 作る・消す・動かす・コピーする（いずれも成功しない）
    for (m, path, dest) in [
        ("MKCOL", "/dav/attachments", None),
        ("PUT", "/dav/attachments", None),
        ("DELETE", "/dav/attachments", None),
        ("MOVE", "/dav/x.txt", Some("/dav/attachments/x.txt")),
        ("COPY", "/dav/x.txt", Some("/dav/attachments/y.txt")),
        ("MOVE", "/dav/attachments", Some("/dav/moved")),
        ("PUT", "/dav/attachments/new.txt", None),
    ] {
        let mut req = dav(&server, m, path).body("z");
        if let Some(d) = dest {
            req = req.header("Destination", server.url(d));
        }
        let status = req.send().await.unwrap().status().as_u16();
        // 207 は、フォルダを消すときに中身が一つずつ拒否されたという意味
        assert!(
            (400..500).contains(&status) || status == 207,
            "{m} {path} -> {status}"
        );
    }
    assert!(
        !on_disk(&server, "attachments").exists(),
        "予約の名前の実体は作られない"
    );
    assert_eq!(get(&server, "/dav/x.txt").await, (200, "x".into()));
}

#[tokio::test]
async fn dangerous_names_are_refused_and_nothing_escapes_the_shared_folder() {
    let server = TestServer::start().await;
    let outside = server.dir.path().join("escaped.txt");
    for path in [
        "/dav/%2E%2E/escaped.txt",
        "/dav/..%2Fescaped.txt",
        "/dav/CON.txt",
        "/dav/nul",
        "/dav/a%3Ab.txt",
        "/dav/trailing.",
        "/dav/.disnans-tmp-x",
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
    let secret = server.dir.path().join("secret.txt");
    std::fs::write(&secret, "SECRET").unwrap();
    std::os::unix::fs::symlink(&secret, on_disk(&server, "link")).unwrap();
    std::os::unix::fs::symlink(server.dir.path(), on_disk(&server, "dirlink")).unwrap();

    // 読めない・書けない（リンクの先は見せない）
    assert!(get(&server, "/dav/link").await.0 >= 400);
    assert!(send(&server, "PUT", "/dav/link", "over").await >= 400);
    assert!(send(&server, "PUT", "/dav/dirlink/new.txt", "x").await >= 400);
    assert!(get(&server, "/dav/dirlink/secret.txt").await.0 >= 400);
    assert!(send(&server, "DELETE", "/dav/link", "").await >= 400);
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
