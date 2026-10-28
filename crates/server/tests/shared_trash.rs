//! 共有フォルダのゴミ箱・フォルダのコピー・大きさ・添付のゴミ箱・起動時の回復の結合テスト。
//! 一時のデータフォルダだけを使う。

mod common;

use common::TestServer;
use disnans_shared::{
    Attachment, ClientEvent, SharedEntry, SharedSize, SharedTrashEntry, SharedTrashListing,
};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn req(server: &TestServer, user: &str, m: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(m, server.url(path))
        .header("X-Dev-User", user)
}

async fn put_file(server: &TestServer, path: &str, data: &[u8]) {
    let res = req(
        server,
        ALICE,
        reqwest::Method::PUT,
        &format!("/api/shared/{path}"),
    )
    .body(data.to_vec())
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
}

async fn mkdir(server: &TestServer, path: &str) {
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "mkdir", "path": path}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
}

async fn trash_op(server: &TestServer, body: serde_json::Value) -> reqwest::Response {
    server
        .post_json(ALICE, "/api/shared-trash", &body)
        .send()
        .await
        .unwrap()
}

async fn error_code(res: reqwest::Response) -> (u16, String) {
    let status = res.status().as_u16();
    let v: serde_json::Value = res.json().await.unwrap();
    (status, v["code"].as_str().unwrap_or_default().to_owned())
}

async fn list_trash(server: &TestServer) -> Vec<SharedTrashEntry> {
    let l: SharedTrashListing = server.get_json(ALICE, "/api/shared-trash").await;
    l.entries
}

async fn read(server: &TestServer, path: &str) -> Vec<u8> {
    let res = req(
        server,
        ALICE,
        reqwest::Method::GET,
        &format!("/api/shared/{path}"),
    )
    .send()
    .await
    .unwrap();
    assert_eq!(res.status(), 200);
    res.bytes().await.unwrap().to_vec()
}

async fn size(server: &TestServer, path: &str) -> SharedSize {
    server
        .get_json(ALICE, &format!("/api/shared-size/{path}"))
        .await
}

async fn root_size(server: &TestServer) -> SharedSize {
    server.get_json(ALICE, "/api/shared-size").await
}

/// 再起動（同じデータフォルダで、サーバーを作り直す）。回復はルートを公開する前に走る。
async fn restart(server: &TestServer) -> TestServer {
    let config = disnans_server::config::Config {
        data_dir: server.state.config.data_dir.clone(),
        bind: "127.0.0.1:0".parse().unwrap(),
        dev: true,
        tailscale_socket: server.dir.path().join("no-such.sock"),
        image_max_edge: disnans_server::image_proc::DEFAULT_MAX_EDGE,
    };
    let (app, state) = disnans_server::build(config).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    TestServer {
        addr,
        state,
        http: reqwest::Client::new(),
        dir: tempfile::tempdir().unwrap(),
    }
}

#[tokio::test]
async fn trash_round_trip_keeps_the_bytes_and_hides_the_item() {
    let server = TestServer::start().await;
    put_file(&server, "a.txt", b"hello").await;
    let res = trash_op(&server, serde_json::json!({"op": "trash", "path": "a.txt"})).await;
    assert_eq!(res.status(), 200);
    let entry: SharedTrashEntry = res.json().await.unwrap();
    assert_eq!(entry.original_path, "a.txt");
    assert_eq!(entry.size, 5);

    // 共有フォルダからは消え、ゴミ箱の一覧に出る
    let res = req(&server, ALICE, reqwest::Method::GET, "/api/shared/a.txt")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    assert_eq!(list_trash(&server).await.len(), 1);

    // 戻すと、中身はそのまま。戻した項目を返す
    let res = trash_op(
        &server,
        serde_json::json!({"op": "restore", "id": entry.id}),
    )
    .await;
    assert_eq!(res.status(), 200);
    let restored: SharedEntry = res.json().await.unwrap();
    assert_eq!(restored.path, "a.txt");
    assert_eq!(read(&server, "a.txt").await, b"hello");
    assert!(list_trash(&server).await.is_empty());
}

#[tokio::test]
async fn restore_refuses_a_taken_name_and_a_missing_parent() {
    let server = TestServer::start().await;
    mkdir(&server, "docs").await;
    put_file(&server, "docs/f.txt", b"one").await;
    let f = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "docs/f.txt"}),
    )
    .await
    .json::<SharedTrashEntry>()
    .await
    .unwrap();
    // 同じ名前が今ある → 409 exists。ゴミ箱の中身は残り、今の項目は上書きされない
    put_file(&server, "docs/f.txt", b"now").await;
    let (status, code) =
        error_code(trash_op(&server, serde_json::json!({"op": "restore", "id": f.id})).await).await;
    assert_eq!((status, code.as_str()), (409, "exists"));
    assert_eq!(read(&server, "docs/f.txt").await, b"now");
    assert_eq!(list_trash(&server).await.len(), 1);

    // 親のフォルダを消した（ゴミ箱へ入れた）あとは、親が無いので 409 parent_missing
    let docs = trash_op(&server, serde_json::json!({"op": "trash", "path": "docs"})).await;
    assert_eq!(docs.status(), 200);
    let (status, code) =
        error_code(trash_op(&server, serde_json::json!({"op": "restore", "id": f.id})).await).await;
    assert_eq!((status, code.as_str()), (409, "parent_missing"));
}

#[tokio::test]
async fn purge_removes_the_item_for_good() {
    let server = TestServer::start().await;
    put_file(&server, "gone.txt", b"bye").await;
    let e = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "gone.txt"}),
    )
    .await
    .json::<SharedTrashEntry>()
    .await
    .unwrap();
    let res = server
        .delete(ALICE, &format!("/api/shared-trash/{}", e.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    assert!(list_trash(&server).await.is_empty());
    // 実体も消えている（ゴミ箱のフォルダに何も残らない）
    let left = std::fs::read_dir(server.state.config.trash_dir())
        .unwrap()
        .count();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn folder_copy_is_recursive_and_refuses_conflicts() {
    let server = TestServer::start().await;
    mkdir(&server, "src").await;
    mkdir(&server, "src/sub").await;
    put_file(&server, "src/sub/x.txt", b"x").await;
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "copy", "from": "src", "to": "dst"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    assert_eq!(read(&server, "dst/sub/x.txt").await, b"x");

    // 同名は上書きもマージもしない（409）
    let (status, code) = error_code(
        server
            .post_json(
                ALICE,
                "/api/shared",
                &serde_json::json!({"op": "copy", "from": "src", "to": "dst"}),
            )
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!((status, code.as_str()), (409, "exists"));
    // 自分の中へは入れない
    let (status, _) = error_code(
        server
            .post_json(
                ALICE,
                "/api/shared",
                &serde_json::json!({"op": "copy", "from": "src", "to": "src/sub/inner"}),
            )
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn folder_copy_with_a_symlink_leaves_no_partial_result() {
    let server = TestServer::start().await;
    mkdir(&server, "src").await;
    put_file(&server, "src/a.txt", b"a").await;
    let shared = server.state.config.shared_dir();
    std::os::unix::fs::symlink("/etc", shared.join("src").join("link")).unwrap();
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "copy", "from": "src", "to": "dst"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    // 行き先は作られていない（部分的な結果を残さない）
    assert!(!shared.join("dst").exists());
    // 一時のフォルダも残らない
    let leftovers: Vec<_> = std::fs::read_dir(&shared)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(
        leftovers
            .iter()
            .all(|n| !n.to_string_lossy().starts_with(".disnans-"))
    );
}

#[tokio::test]
async fn size_counts_folders_and_attachments_once() {
    let server = TestServer::start().await;
    mkdir(&server, "d").await;
    mkdir(&server, "d/e").await;
    put_file(&server, "d/a.txt", b"12345").await;
    put_file(&server, "d/e/b.txt", b"123").await;

    let d = size(&server, "d").await;
    assert_eq!((d.size, d.files, d.dirs), (8, 2, 1));
    let f = size(&server, "d/a.txt").await;
    assert_eq!((f.size, f.files, f.dirs), (5, 1, 0));

    // 添付を一つ。ルートは、実際のフォルダ d と d/e（2 つ）と仮想の attachments（1 つ）を数える
    let a = upload(&server, ALICE, "att.txt", b"abcd").await;
    let mut ws = server.ws(ALICE).await;
    ws.post_with(ClientEvent::MessageSend {
        client_id: "s".into(),
        body: String::new(),
        attachment_ids: vec![a.id.clone()],
        reply_to: None,
        silent: false,
    })
    .await;
    let root = root_size(&server).await;
    assert_eq!((root.size, root.files, root.dirs), (12, 3, 3));
    let att = size(&server, "attachments").await;
    assert_eq!((att.size, att.files, att.dirs), (4, 1, 0));
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

#[tokio::test]
async fn attachment_trash_keeps_the_id_and_the_message_link() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "pic.txt", b"pixels").await;
    let mut ws = server.ws(ALICE).await;
    let msg = ws
        .post_with(ClientEvent::MessageSend {
            client_id: "m".into(),
            body: String::new(),
            attachment_ids: vec![a.id.clone()],
            reply_to: None,
            silent: false,
        })
        .await;

    let entry = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "attachments/pic.txt"}),
    )
    .await
    .json::<SharedTrashEntry>()
    .await
    .unwrap();
    assert_eq!(entry.original_path, "attachments/pic.txt");
    // 本文の添付は「削除された」になる。blob は files/ から出ている
    let got = server.messages("").await;
    let att = got.iter().find(|m| m.id == msg.id).unwrap().attachments[0].clone();
    assert!(att.deleted);
    assert!(!server.state.config.files_dir().join(&a.id).exists());

    // 戻すと、同じ ID で見える
    let res = trash_op(
        &server,
        serde_json::json!({"op": "restore", "id": entry.id}),
    )
    .await;
    assert_eq!(res.status(), 200);
    let got = server.messages("").await;
    let att = got.iter().find(|m| m.id == msg.id).unwrap().attachments[0].clone();
    assert!(!att.deleted);
    assert_eq!(att.id, a.id);
    let body = req(
        &server,
        ALICE,
        reqwest::Method::GET,
        &format!("/api/files/{}", a.id),
    )
    .send()
    .await
    .unwrap()
    .bytes()
    .await
    .unwrap();
    assert_eq!(&body[..], b"pixels");
}

#[tokio::test]
async fn restored_attachment_comes_back_as_library_when_the_message_is_gone() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "lib.txt", b"keep").await;
    let mut ws = server.ws(ALICE).await;
    let msg = ws
        .post_with(ClientEvent::MessageSend {
            client_id: "m".into(),
            body: String::new(),
            attachment_ids: vec![a.id.clone()],
            reply_to: None,
            silent: false,
        })
        .await;
    let entry = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "attachments/lib.txt"}),
    )
    .await
    .json::<SharedTrashEntry>()
    .await
    .unwrap();
    // ゴミ箱の中で、元の投稿を消す（files 行は消えてもよい。実体と記録は残る）
    ws.send(ClientEvent::MessageDelete {
        message_id: msg.id.clone(),
    })
    .await;
    let res = trash_op(
        &server,
        serde_json::json!({"op": "restore", "id": entry.id}),
    )
    .await;
    assert_eq!(res.status(), 200);
    // 投稿は作り直さない。同じ ID の添付がライブラリ（attachments/）に戻る
    let items = server
        .get_json::<serde_json::Value>(ALICE, "/api/shared/attachments")
        .await;
    let names: Vec<String> = items["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"lib.txt".to_owned()));
    let got = server.messages("").await;
    assert!(got.iter().all(|m| m.id != msg.id));
    let body = req(
        &server,
        ALICE,
        reqwest::Method::GET,
        &format!("/api/files/{}", a.id),
    )
    .send()
    .await
    .unwrap()
    .bytes()
    .await
    .unwrap();
    assert_eq!(&body[..], b"keep");
    let _ = BOB;
}

#[tokio::test]
async fn interrupted_trash_is_completed_on_restart() {
    let server = TestServer::start().await;
    put_file(&server, "half.txt", b"half").await;
    // 途中で止まった状態を作る: 行は pending、実体は trash に動いている（行の ready 化の前に止まった）
    let id = "01TESTPENDINGTRASHROW0000";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::rename(
        server.state.config.shared_dir().join("half.txt"),
        dir.join("item"),
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'half.txt', 4, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    // 再起動で完了する（ready になり、一覧に出る）
    let server = restart(&server).await;
    let list = list_trash(&server).await;
    assert!(
        list.iter()
            .any(|e| e.id == id && e.original_path == "half.txt")
    );
}

#[tokio::test]
async fn interrupted_trash_with_the_original_still_in_place_is_rolled_back_on_restart() {
    let server = TestServer::start().await;
    put_file(&server, "stay.txt", b"stay").await;
    let id = "01TESTPENDINGROLLBACK0000";
    std::fs::create_dir_all(server.state.config.trash_dir().join(id)).unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'stay.txt', 4, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    let server = restart(&server).await;
    // 元のまま残り、ゴミ箱には出ない（行は消えている）
    assert_eq!(read(&server, "stay.txt").await, b"stay");
    assert!(list_trash(&server).await.is_empty());
}

#[tokio::test]
async fn ambiguous_state_is_kept_as_broken_and_refused() {
    let server = TestServer::start().await;
    put_file(&server, "both.txt", b"both").await;
    let id = "01TESTBROKENROW00000000000";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("item"), b"other").unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'both.txt', 4, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    let server = restart(&server).await;
    // 消さずに残し、操作を拒否する
    assert!(dir.join("item").exists());
    let (status, code) =
        error_code(trash_op(&server, serde_json::json!({"op": "restore", "id": id})).await).await;
    assert_eq!((status, code.as_str()), (409, "trash_broken"));
    assert_eq!(read(&server, "both.txt").await, b"both");
}

#[tokio::test]
async fn backup_includes_the_trash_items() {
    let server = TestServer::start().await;
    put_file(&server, "kept.txt", b"kept").await;
    trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "kept.txt"}),
    )
    .await;
    let set = disnans_server::backup::run(&server.state).await.unwrap();
    let copied = server
        .state
        .config
        .backup_dir()
        .join(format!("trash-{set}"));
    let found: Vec<_> = walk(&copied);
    assert!(found.iter().any(|p| p.ends_with("item")), "{found:?}");
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

#[tokio::test]
async fn interrupted_attachment_trash_is_completed_on_restart() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "cut.txt", b"cut!").await;
    let mut ws = server.ws(ALICE).await;
    let msg = ws
        .post_with(ClientEvent::MessageSend {
            client_id: "m".into(),
            body: String::new(),
            attachment_ids: vec![a.id.clone()],
            reply_to: None,
            silent: false,
        })
        .await;
    // 途中で止まった状態: blob だけ trash に動いていて、行は pending（files 行はまだ見えている）
    let id = "01TESTATTACHPENDING000000";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::rename(
        server.state.config.files_dir().join(&a.id),
        dir.join("blob"),
    )
    .unwrap();
    let payload = serde_json::to_string(
        &sqlx::query_as::<_, disnans_server::store::files::FileRow>(
            "SELECT id, uploader_id, message_id, file_name, mime, size, width, height, has_thumb, library, deleted_at, first_posted_at, created_at FROM files WHERE id = ?",
        )
        .bind(&a.id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap(),
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at, file_id, payload)
         VALUES (?, 'attachment', 'pending', ?, 4, 1, ?, ?)",
    )
    .bind(id)
    .bind("attachments/cut.txt")
    .bind(&a.id)
    .bind(payload)
    .execute(&server.state.pool)
    .await
    .unwrap();
    let server = restart(&server).await;
    // 回復で、添付は消された扱いになり、ゴミ箱に出る
    let list = list_trash(&server).await;
    assert!(list.iter().any(|e| e.id == id));
    let got = server.messages("").await;
    let att = got.iter().find(|m| m.id == msg.id).unwrap().attachments[0].clone();
    assert!(att.deleted);
}

#[tokio::test]
async fn interrupted_purge_is_finished_on_restart() {
    let server = TestServer::start().await;
    put_file(&server, "p.txt", b"p").await;
    let e = trash_op(&server, serde_json::json!({"op": "trash", "path": "p.txt"}))
        .await
        .json::<SharedTrashEntry>()
        .await
        .unwrap();
    // 完全削除の途中（行は purging）で止まった
    sqlx::query("UPDATE shared_trash SET state = 'purging' WHERE id = ?")
        .bind(&e.id)
        .execute(&server.state.pool)
        .await
        .unwrap();
    let server = restart(&server).await;
    assert!(list_trash(&server).await.is_empty());
    let left = std::fs::read_dir(server.state.config.trash_dir())
        .unwrap()
        .count();
    assert_eq!(left, 0);
}

// ---- 上書きしない移動・通知・broken の回復（追補） ----

#[tokio::test]
async fn restore_does_not_overwrite_a_name_created_just_before() {
    let server = TestServer::start().await;
    put_file(&server, "race.txt", b"old").await;
    let e = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "race.txt"}),
    )
    .await
    .json::<SharedTrashEntry>()
    .await
    .unwrap();
    // 戻す直前に同じ名前が現れた（確かめのあとの PUT と同じ状況）
    put_file(&server, "race.txt", b"new").await;
    let (status, code) =
        error_code(trash_op(&server, serde_json::json!({"op": "restore", "id": e.id})).await).await;
    assert_eq!((status, code.as_str()), (409, "exists"));
    // 両方残る: 今の項目はそのまま、ゴミ箱の中身も残る
    assert_eq!(read(&server, "race.txt").await, b"new");
    assert_eq!(list_trash(&server).await.len(), 1);
}

#[tokio::test]
async fn restore_folder_refuses_an_existing_empty_folder_and_keeps_both() {
    let server = TestServer::start().await;
    mkdir(&server, "box").await;
    put_file(&server, "box/in.txt", b"in").await;
    let e = trash_op(&server, serde_json::json!({"op": "trash", "path": "box"}))
        .await
        .json::<SharedTrashEntry>()
        .await
        .unwrap();
    mkdir(&server, "box").await;
    let (status, code) =
        error_code(trash_op(&server, serde_json::json!({"op": "restore", "id": e.id})).await).await;
    assert_eq!((status, code.as_str()), (409, "exists"));
    assert_eq!(list_trash(&server).await.len(), 1);
    // ゴミ箱の中身は無事（後で戻せる）
    let res = req(&server, ALICE, reqwest::Method::GET, "/api/shared/box")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn restore_and_put_racing_never_lose_both() {
    let server = TestServer::start().await;
    for round in 0..10 {
        let name = format!("r{round}.txt");
        put_file(&server, &name, b"trashed").await;
        let e = trash_op(&server, serde_json::json!({"op": "trash", "path": name}))
            .await
            .json::<SharedTrashEntry>()
            .await
            .unwrap();
        // 戻す操作と、同じ名前への PUT を同時に行う
        let restore = trash_op(&server, serde_json::json!({"op": "restore", "id": e.id}));
        let put = req(
            &server,
            ALICE,
            reqwest::Method::PUT,
            &format!("/api/shared/{name}"),
        )
        .body(b"put".to_vec())
        .send();
        let (r, p) = tokio::join!(restore, put);
        assert_eq!(p.unwrap().status(), 200);
        let trash_left = list_trash(&server).await.len();
        let r_status = r.status().as_u16();
        match r_status {
            // 戻せた: 項目はゴミ箱から消えた（PUT は後から上書きした、明示の書き込み）
            200 => assert_eq!(trash_left, 0),
            // 戻せなかった: ゴミ箱の項目は残り、PUT の内容は残る（どちらも失われない）
            409 => {
                assert_eq!(trash_left, 1);
                assert_eq!(read(&server, &name).await, b"put");
            }
            other => panic!("想定外の応答: {other}"),
        }
        // 片付け（残っていれば完全削除）
        for t in list_trash(&server).await {
            server
                .delete(ALICE, &format!("/api/shared-trash/{}", t.id))
                .send()
                .await
                .unwrap();
        }
    }
}

#[tokio::test]
async fn move_and_copy_without_overwrite_keep_both_when_the_name_is_taken() {
    let server = TestServer::start().await;
    put_file(&server, "a.txt", b"a").await;
    put_file(&server, "b.txt", b"b").await;
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "move", "from": "a.txt", "to": "b.txt"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 409);
    assert_eq!(read(&server, "a.txt").await, b"a");
    assert_eq!(read(&server, "b.txt").await, b"b");
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "copy", "from": "a.txt", "to": "b.txt"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 409);
    assert_eq!(read(&server, "b.txt").await, b"b");
    // overwrite を付ければ、従来どおり置き換える
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "copy", "from": "a.txt", "to": "b.txt", "overwrite": true}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(read(&server, "b.txt").await, b"a");
}

#[tokio::test]
async fn purge_announces_files_changed_even_when_the_tree_is_unchanged() {
    let server = TestServer::start().await;
    put_file(&server, "x.txt", b"x").await;
    let e = trash_op(&server, serde_json::json!({"op": "trash", "path": "x.txt"}))
        .await
        .json::<SharedTrashEntry>()
        .await
        .unwrap();
    let mut ws = server.ws(ALICE).await;
    let res = server
        .delete(ALICE, &format!("/api/shared-trash/{}", e.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let ev = ws
        .recv_until(|e| matches!(e, disnans_shared::ServerEvent::FilesChanged { .. }))
        .await;
    assert!(matches!(
        ev,
        disnans_shared::ServerEvent::FilesChanged { .. }
    ));
}

#[tokio::test]
async fn a_missing_item_is_kept_as_broken_not_deleted() {
    let server = TestServer::start().await;
    let id = "01TESTNOTHINGHERE0000000";
    std::fs::create_dir_all(server.state.config.trash_dir().join(id)).unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'ghost.txt', 0, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    let server = restart(&server).await;
    // 行は消さずに broken。操作は拒否する
    let state: String = sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(state, "broken");
    let (status, code) =
        error_code(trash_op(&server, serde_json::json!({"op": "restore", "id": id})).await).await;
    assert_eq!((status, code.as_str()), (409, "trash_broken"));
}

#[tokio::test]
async fn attachment_with_both_blob_copies_is_kept_as_broken() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "dup.txt", b"dup!").await;
    let mut ws = server.ws(ALICE).await;
    ws.post_with(ClientEvent::MessageSend {
        client_id: "m".into(),
        body: String::new(),
        attachment_ids: vec![a.id.clone()],
        reply_to: None,
        silent: false,
    })
    .await;
    // 本体が files と trash の両方にある（途中の状態として、あり得ない組み合わせ）
    let id = "01TESTATTACHDUPLICATE0000";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("blob"), b"dup!").unwrap();
    let payload = serde_json::to_string(
        &sqlx::query_as::<_, disnans_server::store::files::FileRow>(
            "SELECT id, uploader_id, message_id, file_name, mime, size, width, height, has_thumb, library, deleted_at, first_posted_at, created_at FROM files WHERE id = ?",
        )
        .bind(&a.id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap(),
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at, file_id, payload)
         VALUES (?, 'attachment', 'pending', 'attachments/dup.txt', 4, 1, ?, ?)",
    )
    .bind(id)
    .bind(&a.id)
    .bind(payload)
    .execute(&server.state.pool)
    .await
    .unwrap();
    let server = restart(&server).await;
    let state: String = sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(state, "broken");
    // 本体は両方とも残っている（どちらも消していない）
    assert!(dir.join("blob").exists());
    assert!(server.state.config.files_dir().join(&a.id).exists());
}

#[tokio::test]
async fn attachment_that_had_a_thumb_is_not_made_ready_without_it() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "thumb.txt", b"t").await;
    let id = "01TESTATTACHTHUMBMISSING0";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::rename(
        server.state.config.files_dir().join(&a.id),
        dir.join("blob"),
    )
    .unwrap();
    let mut row = sqlx::query_as::<_, disnans_server::store::files::FileRow>(
        "SELECT id, uploader_id, message_id, file_name, mime, size, width, height, has_thumb, library, deleted_at, first_posted_at, created_at FROM files WHERE id = ?",
    )
    .bind(&a.id)
    .fetch_one(&server.state.pool)
    .await
    .unwrap();
    // 元は画像で、サムネイルがあった（ところが thumb はどこにも無い）
    row.has_thumb = true;
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at, file_id, payload)
         VALUES (?, 'attachment', 'pending', 'attachments/thumb.txt', 1, 1, ?, ?)",
    )
    .bind(id)
    .bind(&a.id)
    .bind(serde_json::to_string(&row).unwrap())
    .execute(&server.state.pool)
    .await
    .unwrap();
    let server = restart(&server).await;
    let state: String = sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    // 準備完了（ready）にせず、消さずに止める
    assert_eq!(state, "broken");
    assert!(dir.join("blob").exists());
}

#[tokio::test]
async fn folder_trash_restore_and_purge_announce_the_folder_itself() {
    let server = TestServer::start().await;
    mkdir(&server, "box").await;
    put_file(&server, "box/in.txt", b"in").await;
    let mut ws = server.ws(ALICE).await;
    let is_box = |e: &disnans_shared::ServerEvent| matches!(e, disnans_shared::ServerEvent::FilesChanged { path } if path == "box");
    // trash
    let e = trash_op(&server, serde_json::json!({"op": "trash", "path": "box"}))
        .await
        .json::<SharedTrashEntry>()
        .await
        .unwrap();
    ws.recv_until(is_box).await;
    // restore
    trash_op(&server, serde_json::json!({"op": "restore", "id": e.id})).await;
    ws.recv_until(is_box).await;
    // trash again, then purge
    let e2 = trash_op(&server, serde_json::json!({"op": "trash", "path": "box"}))
        .await
        .json::<SharedTrashEntry>()
        .await
        .unwrap();
    ws.recv_until(is_box).await;
    server
        .delete(ALICE, &format!("/api/shared-trash/{}", e2.id))
        .send()
        .await
        .unwrap();
    ws.recv_until(is_box).await;
}

#[tokio::test]
async fn no_replace_refuses_file_and_folder_collisions_both_ways() {
    let server = TestServer::start().await;
    mkdir(&server, "d").await;
    put_file(&server, "f.txt", b"file").await;
    // ファイルを、同じ名前のフォルダへ動かす → 409（どちらも残る）
    let (status, code) = error_code(
        server
            .post_json(
                ALICE,
                "/api/shared",
                &serde_json::json!({"op": "move", "from": "f.txt", "to": "d"}),
            )
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!((status, code.as_str()), (409, "exists"));
    assert_eq!(read(&server, "f.txt").await, b"file");
    // フォルダを、同じ名前のファイルへ動かす → 409（フォルダは上書きしない）
    put_file(&server, "d2.txt", b"x").await;
    mkdir(&server, "e").await;
    let (status, _) = error_code(
        server
            .post_json(
                ALICE,
                "/api/shared",
                &serde_json::json!({"op": "move", "from": "e", "to": "d2.txt"}),
            )
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status, 409);
    assert_eq!(read(&server, "d2.txt").await, b"x");
    assert_eq!(size(&server, "e").await.dirs, 0);
}

// ---- DB の失敗後の途中の行は、再起動なしで GET の一覧が回復する ----

#[tokio::test]
async fn unfinished_trash_is_completed_by_listing_without_restart() {
    let server = TestServer::start().await;
    put_file(&server, "late.txt", b"late").await;
    // 途中で止まった状態を、起動中のサーバーに注入する（行は pending、実体は trash に動いている）
    let id = "01TESTLISTRECOVERREADY000";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::rename(
        server.state.config.shared_dir().join("late.txt"),
        dir.join("item"),
    )
    .unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'late.txt', 4, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    // 一覧を読むと回復し、ready として出る（再起動はしない）。回復は元の path で通知する
    let mut ws = server.ws(ALICE).await;
    let list = list_trash(&server).await;
    assert!(
        list.iter()
            .any(|e| e.id == id && e.original_path == "late.txt")
    );
    ws.recv_until(
        |e| matches!(e, disnans_shared::ServerEvent::FilesChanged { path } if path == "late.txt"),
    )
    .await;
    let state: String = sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(state, "ready");
}

#[tokio::test]
async fn unfinished_rollback_is_settled_by_listing_without_restart() {
    let server = TestServer::start().await;
    put_file(&server, "kept.txt", b"kept").await;
    // 元がある・trash に実体が無い pending: 行を消し、元のまま（一覧にも出ない）
    let id = "01TESTLISTROLLBACK0000000";
    std::fs::create_dir_all(server.state.config.trash_dir().join(id)).unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'kept.txt', 4, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    assert!(list_trash(&server).await.is_empty());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(n, 0);
    assert_eq!(read(&server, "kept.txt").await, b"kept");
}

#[tokio::test]
async fn broken_rows_are_kept_and_listing_does_not_retry_them() {
    let server = TestServer::start().await;
    let id = "01TESTLISTBROKENKEPT00000";
    std::fs::create_dir_all(server.state.config.trash_dir().join(id)).unwrap();
    sqlx::query(
        "INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'broken', 'nowhere.txt', 0, 1)",
    )
    .bind(id)
    .execute(&server.state.pool)
    .await
    .unwrap();
    assert!(list_trash(&server).await.is_empty());
    let state: String = sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(state, "broken");
}

// ---- 実際の処理で「rename の後・ready 化の前」に DB が失敗する場合（trigger で注入） ----

const FAIL_READY: &str = "CREATE TRIGGER fail_ready BEFORE UPDATE OF state ON shared_trash
     WHEN NEW.state = 'ready'
     BEGIN SELECT RAISE(FAIL, 'injected: ready failure'); END";

async fn inject_ready_failure(server: &TestServer) {
    sqlx::query(FAIL_READY)
        .execute(&server.state.pool)
        .await
        .unwrap();
}

async fn remove_ready_failure(server: &TestServer) {
    sqlx::query("DROP TRIGGER fail_ready")
        .execute(&server.state.pool)
        .await
        .unwrap();
}

async fn trash_row_state(server: &TestServer, id: &str) -> String {
    sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap()
}

async fn only_trash_row_id(server: &TestServer) -> String {
    sqlx::query_scalar("SELECT id FROM shared_trash")
        .fetch_one(&server.state.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn ready_failure_after_rename_keeps_the_item_and_listing_recovers_it() {
    let server = TestServer::start().await;
    put_file(&server, "fail.txt", b"payload-bytes").await;
    inject_ready_failure(&server).await;

    // 移動のあと ready にできない: 応答は 500。元データは trash に残り、行は pending
    let res = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "fail.txt"}),
    )
    .await;
    assert_eq!(res.status(), 500);
    let id = only_trash_row_id(&server).await;
    assert_eq!(trash_row_state(&server, &id).await, "pending");
    let item = server.state.config.trash_dir().join(&id).join("item");
    assert_eq!(std::fs::read(&item).unwrap(), b"payload-bytes");
    assert!(!server.state.config.shared_dir().join("fail.txt").exists());

    // trigger が有効な間の一覧: 回復を試みて失敗するが、データは失わない（500。行も実体もそのまま）
    let res = server.get(ALICE, "/api/shared-trash").send().await.unwrap();
    assert_eq!(res.status(), 500);
    assert_eq!(trash_row_state(&server, &id).await, "pending");
    assert_eq!(std::fs::read(&item).unwrap(), b"payload-bytes");

    // trigger を外すと、一覧を読むだけで ready に回復する（再起動も再試行の待ちもなし）
    remove_ready_failure(&server).await;
    let list = list_trash(&server).await;
    assert!(
        list.iter()
            .any(|e| e.id == id && e.original_path == "fail.txt" && e.size == 13)
    );
    assert_eq!(trash_row_state(&server, &id).await, "ready");

    // 戻すと、同じ中身が読める
    let res = trash_op(&server, serde_json::json!({"op": "restore", "id": id})).await;
    assert_eq!(res.status(), 200);
    assert_eq!(read(&server, "fail.txt").await, b"payload-bytes");
}

#[tokio::test]
async fn ready_failure_for_an_attachment_keeps_the_file_row_and_listing_recovers_it() {
    let server = TestServer::start().await;
    let a = upload(&server, ALICE, "fail-att.txt", b"att-bytes").await;
    let mut ws = server.ws(ALICE).await;
    let msg = ws
        .post_with(ClientEvent::MessageSend {
            client_id: "m".into(),
            body: String::new(),
            attachment_ids: vec![a.id.clone()],
            reply_to: None,
            silent: false,
        })
        .await;
    inject_ready_failure(&server).await;

    // 添付の tx（files 行を隠す + ready）が失敗: 応答は 500。files 行は隠れておらず、blob は trash に動いている
    let res = trash_op(
        &server,
        serde_json::json!({"op": "trash", "path": "attachments/fail-att.txt"}),
    )
    .await;
    assert_eq!(res.status(), 500);
    let id = only_trash_row_id(&server).await;
    assert_eq!(trash_row_state(&server, &id).await, "pending");
    let dir = server.state.config.trash_dir().join(&id);
    assert_eq!(std::fs::read(dir.join("blob")).unwrap(), b"att-bytes");
    let deleted_at: Option<i64> = sqlx::query_scalar("SELECT deleted_at FROM files WHERE id = ?")
        .bind(&a.id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert!(
        deleted_at.is_none(),
        "tx が失敗したので files 行は隠れていないはず"
    );

    // trigger が有効な間の一覧は 500。データは残る
    let res = server.get(ALICE, "/api/shared-trash").send().await.unwrap();
    assert_eq!(res.status(), 500);
    assert_eq!(std::fs::read(dir.join("blob")).unwrap(), b"att-bytes");

    // trigger を外すと一覧で回復: 添付は消された扱い（投稿の本文は「削除された」）で trash に出る
    remove_ready_failure(&server).await;
    let list = list_trash(&server).await;
    assert!(
        list.iter()
            .any(|e| e.id == id && e.original_path == "attachments/fail-att.txt")
    );
    assert_eq!(trash_row_state(&server, &id).await, "ready");
    let got = server.messages("").await;
    let att = got.iter().find(|m| m.id == msg.id).unwrap().attachments[0].clone();
    assert!(att.deleted);

    // 戻すと、同じ添付 ID・同じ中身で見える
    let res = trash_op(&server, serde_json::json!({"op": "restore", "id": id})).await;
    assert_eq!(res.status(), 200);
    let got = server.messages("").await;
    let att = got.iter().find(|m| m.id == msg.id).unwrap().attachments[0].clone();
    assert!(!att.deleted);
    assert_eq!(att.id, a.id);
    let body = req(
        &server,
        ALICE,
        reqwest::Method::GET,
        &format!("/api/files/{}", a.id),
    )
    .send()
    .await
    .unwrap()
    .bytes()
    .await
    .unwrap();
    assert_eq!(&body[..], b"att-bytes");
}
