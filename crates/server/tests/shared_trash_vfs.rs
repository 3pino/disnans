//! 仮想の `.trash`（共有フォルダのルートに見えるゴミ箱）の結合テスト。REST と WebDAV の両方から確かめる。
//! 一時のデータフォルダだけを使う。

mod common;

use common::TestServer;
use disnans_server::trash::alias_of;
use disnans_shared::{
    ClientEvent, ServerEvent, SharedEntry, SharedKind, SharedListing, SharedSize, SharedTrashEntry,
    SharedTrashListing, SharedTrashNode,
};

const ALICE: &str = "alice@test";

fn method(name: &str) -> reqwest::Method {
    reqwest::Method::from_bytes(name.as_bytes()).unwrap()
}

fn req(server: &TestServer, m: &str, path: &str) -> reqwest::RequestBuilder {
    server
        .http
        .request(method(m), server.url(path))
        .header("X-Dev-User", ALICE)
}

async fn put_file(server: &TestServer, path: &str, data: &[u8]) {
    let res = req(server, "PUT", &format!("/api/shared/{path}"))
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
    assert_eq!(res.status(), 200);
}

async fn trash(server: &TestServer, path: &str) -> SharedTrashEntry {
    let res = server
        .post_json(
            ALICE,
            "/api/shared-trash",
            &serde_json::json!({"op": "trash", "path": path}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    res.json().await.unwrap()
}

/// 名前（`.trash/` の後ろ）を返す。
fn alias_name(e: &SharedTrashEntry) -> String {
    e.trash_path
        .clone()
        .unwrap()
        .strip_prefix(".trash/")
        .unwrap()
        .to_owned()
}

async fn listing(server: &TestServer, path: &str) -> SharedListing {
    let url = if path.is_empty() {
        "/api/shared".to_owned()
    } else {
        format!("/api/shared/{path}")
    };
    server.get_json(ALICE, &url).await
}

async fn read_rest(server: &TestServer, path: &str) -> Vec<u8> {
    let res = req(server, "GET", &format!("/api/shared/{path}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{path}");
    res.bytes().await.unwrap().to_vec()
}

async fn read_dav(server: &TestServer, path: &str) -> Vec<u8> {
    let res = req(server, "GET", &format!("/dav/{path}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{path}");
    res.bytes().await.unwrap().to_vec()
}

async fn status_of(res: reqwest::Response) -> u16 {
    res.status().as_u16()
}

async fn dav_move(server: &TestServer, from: &str, to: &str) -> u16 {
    let res = req(server, "MOVE", &format!("/dav/{from}"))
        .header("Destination", server.url(&format!("/dav/{to}")))
        .send()
        .await
        .unwrap();
    status_of(res).await
}

async fn rest_copy(server: &TestServer, from: &str, to: &str) -> u16 {
    status_of(
        server
            .post_json(
                ALICE,
                "/api/shared",
                &serde_json::json!({"op": "copy", "from": from, "to": to}),
            )
            .send()
            .await
            .unwrap(),
    )
    .await
}

async fn upload(server: &TestServer, name: &str, data: &[u8]) -> disnans_shared::Attachment {
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

/// 添付を投稿し、そのメッセージの ID を返す。
async fn post_attachment(server: &TestServer, att: &str) -> String {
    let mut ws = server.ws(ALICE).await;
    let m = ws
        .post_with(ClientEvent::MessageSend {
            client_id: format!("c-{att}"),
            body: String::new(),
            attachment_ids: vec![att.to_owned()],
            reply_to: None,
            silent: false,
        })
        .await;
    m.id
}

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

// ---- 一覧・名前 ----

#[tokio::test]
async fn trash_is_a_flat_folder_at_the_root_with_full_id_names() {
    let server = TestServer::start().await;
    put_file(&server, "a.txt", b"hello").await;
    let e = trash(&server, "a.txt").await;
    let alias = alias_name(&e);
    assert_eq!(alias, alias_of(&e.id, "a.txt"));
    assert!(alias.starts_with(&format!("{}--", e.id)), "{alias}");
    assert!(alias.ends_with("--a.txt"));

    // ルートに `.trash` が見える（ルートの種類は Root）
    let root = listing(&server, "").await;
    let t = root
        .entries
        .iter()
        .find(|x| x.name == ".trash")
        .expect("ルートに .trash");
    assert_eq!(t.kind, SharedKind::Dir);
    assert_eq!(t.trash, Some(SharedTrashNode::Root));

    // `.trash` の直下に、ファイルがそのまま見える（フォルダ `<ID>` は無い）
    let inner = listing(&server, ".trash").await;
    assert_eq!(inner.entries.len(), 1);
    let it = &inner.entries[0];
    assert_eq!(it.name, alias);
    assert_eq!(it.kind, SharedKind::File);
    assert_eq!(it.size, 5);
    assert!(matches!(&it.trash, Some(SharedTrashNode::Item { entry }) if entry.id == e.id));

    // WebDAV の PROPFIND でも同じ名前
    let res = req(&server, "PROPFIND", "/dav/.trash")
        .header("Depth", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 207);
    assert!(res.text().await.unwrap().contains(&alias));
}

#[tokio::test]
async fn names_are_exact_duplicates_are_distinct_and_long_names_are_shortened_with_extension() {
    let server = TestServer::start().await;
    put_file(&server, "dup.txt", b"one").await;
    let first = trash(&server, "dup.txt").await;
    put_file(&server, "dup.txt", b"two").await;
    let second = trash(&server, "dup.txt").await;
    assert_ne!(alias_name(&first), alias_name(&second));
    // 両方とも、その ID の名前で読める
    assert_eq!(
        read_rest(&server, &format!(".trash/{}", alias_name(&first))).await,
        b"one"
    );
    assert_eq!(
        read_rest(&server, &format!(".trash/{}", alias_name(&second))).await,
        b"two"
    );

    // 別名・大文字・ID の一部は、違う名前として扱われる（404）
    let a = alias_name(&first);
    for wrong in [
        a[..26].to_owned(),               // ID だけ
        a[..8].to_owned(),                // 先頭 8 文字（時刻で衝突する）
        a.to_lowercase(),                 // 大文字小文字の違い
        format!("{}--dup.TXT", &a[..26]), // 名前の違い
        format!("{}--x", &a[..26]),
    ] {
        let res = req(&server, "GET", &format!("/api/shared/.trash/{wrong}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404, "{wrong}");
    }

    // 長い UTF-8 の名前: 255 バイト以内、拡張子は残る、名前は決まっている（同じ一覧を二度読んでも同じ）
    // 255 バイト以内の名前で、名前の部分（227 バイト）を超える: 切り詰められる（拡張子は残る）
    let long = format!("{}.txt", "あ".repeat(76));
    put_file(&server, &long, b"long").await;
    let e = trash(&server, &long).await;
    let alias = alias_name(&e);
    assert!(alias.len() <= 255, "{}", alias.len());
    assert!(alias.ends_with(".txt"));
    assert_eq!(alias, alias_of(&e.id, &long));
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"long"
    );
    assert_eq!(read_dav(&server, &format!(".trash/{alias}")).await, b"long");
}

// ---- 読む（ファイル・範囲・フォルダ・コピー） ----

#[tokio::test]
async fn files_stream_with_ranges_over_rest_and_webdav() {
    let server = TestServer::start().await;
    put_file(&server, "r.txt", b"0123456789").await;
    let alias = alias_name(&trash(&server, "r.txt").await);
    let res = req(&server, "GET", &format!("/api/shared/.trash/{alias}"))
        .header("Range", "bytes=2-4")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"234");
    let res = req(&server, "GET", &format!("/dav/.trash/{alias}"))
        .header("Range", "bytes=-3")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"789");
}

#[tokio::test]
async fn folders_browse_nested_and_copy_out_as_ordinary_content() {
    let server = TestServer::start().await;
    mkdir(&server, "box").await;
    mkdir(&server, "box/empty").await;
    mkdir(&server, "box/sub").await;
    put_file(&server, "box/sub/x.txt", b"nested").await;
    let e = trash(&server, "box").await;
    let alias = alias_name(&e);

    // 中身は子孫として見える
    let inner = listing(&server, &format!(".trash/{alias}")).await;
    let names: Vec<&str> = inner.entries.iter().map(|x| x.name.as_str()).collect();
    assert!(
        names.contains(&"sub") && names.contains(&"empty"),
        "{names:?}"
    );
    assert!(
        inner
            .entries
            .iter()
            .all(|x| matches!(&x.trash, Some(SharedTrashNode::Descendant { id }) if *id == e.id))
    );
    let sub = listing(&server, &format!(".trash/{alias}/sub")).await;
    assert_eq!(sub.entries[0].name, "x.txt");
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}/sub/x.txt")).await,
        b"nested"
    );
    assert_eq!(
        read_dav(&server, &format!(".trash/{alias}/sub/x.txt")).await,
        b"nested"
    );
    // 空のフォルダも見える
    let empty = listing(&server, &format!(".trash/{alias}/empty")).await;
    assert!(empty.entries.is_empty());

    // 中のファイルを外へコピーできる（通常のコピー。ゴミ箱の中は変わらない）
    assert_eq!(
        rest_copy(&server, &format!(".trash/{alias}/sub/x.txt"), "copied.txt").await,
        200
    );
    assert_eq!(read_rest(&server, "copied.txt").await, b"nested");
    // フォルダごとコピーできる
    assert_eq!(
        rest_copy(&server, &format!(".trash/{alias}"), "box-copy").await,
        200
    );
    assert_eq!(read_rest(&server, "box-copy/sub/x.txt").await, b"nested");
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}/sub/x.txt")).await,
        b"nested"
    );
}

// ---- 戻す・完全に消す・禁止 ----

#[tokio::test]
async fn whole_item_moves_back_only_to_the_exact_original_path() {
    let server = TestServer::start().await;
    mkdir(&server, "docs").await;
    put_file(&server, "docs/a.txt", b"back").await;
    let alias = alias_name(&trash(&server, "docs/a.txt").await);

    // 元以外の場所へは動かせない（403）。ゴミ箱の中のまま
    assert_eq!(
        dav_move(&server, &format!(".trash/{alias}"), "elsewhere.txt").await,
        403
    );
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"back"
    );

    // 元の場所へは戻る（同じ中身）
    assert_eq!(
        dav_move(&server, &format!(".trash/{alias}"), "docs/a.txt").await,
        201
    );
    assert_eq!(read_rest(&server, "docs/a.txt").await, b"back");
    assert!(listing(&server, ".trash").await.entries.is_empty());
}

#[tokio::test]
async fn restore_never_overwrites_a_live_item_at_the_original_path() {
    let server = TestServer::start().await;
    put_file(&server, "k.txt", b"old").await;
    let alias = alias_name(&trash(&server, "k.txt").await);
    put_file(&server, "k.txt", b"live").await;
    // Overwrite の指定があっても、今の項目は消されない（412 か 409 で止まる）
    let status = dav_move(&server, &format!(".trash/{alias}"), "k.txt").await;
    assert!(status == 412 || status == 409, "{status}");
    assert_eq!(read_rest(&server, "k.txt").await, b"live");
    assert_eq!(read_rest(&server, &format!(".trash/{alias}")).await, b"old");
}

#[tokio::test]
async fn whole_item_delete_purges_and_partial_changes_are_refused() {
    let server = TestServer::start().await;
    mkdir(&server, "p").await;
    put_file(&server, "p/q.txt", b"q").await;
    let e = trash(&server, "p").await;
    let alias = alias_name(&e);

    // 中身の一つだけを消す・動かす・書く: すべて拒否
    assert_eq!(
        status_of(
            req(&server, "DELETE", &format!("/dav/.trash/{alias}/q.txt"))
                .send()
                .await
                .unwrap()
        )
        .await,
        403
    );
    assert_eq!(
        dav_move(&server, &format!(".trash/{alias}/q.txt"), "q.txt").await,
        403
    );
    assert_eq!(
        status_of(
            req(&server, "PUT", &format!("/dav/.trash/{alias}/new.txt"))
                .body("x")
                .send()
                .await
                .unwrap()
        )
        .await,
        403
    );
    assert_eq!(
        status_of(
            req(&server, "MKCOL", &format!("/dav/.trash/{alias}/d"))
                .send()
                .await
                .unwrap()
        )
        .await,
        403
    );
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}/q.txt")).await,
        b"q"
    );

    // ゴミ箱の直下そのものへの書き込み・削除・移動・コピー: 拒否
    assert_eq!(
        status_of(
            req(&server, "PUT", "/dav/.trash/new.txt")
                .body("x")
                .send()
                .await
                .unwrap()
        )
        .await,
        403
    );
    assert_eq!(
        status_of(
            req(&server, "MKCOL", "/dav/.trash/new")
                .send()
                .await
                .unwrap()
        )
        .await,
        403
    );
    assert_eq!(
        status_of(req(&server, "DELETE", "/dav/.trash").send().await.unwrap()).await,
        403
    );
    assert_eq!(dav_move(&server, ".trash", "moved").await, 403);
    assert_eq!(rest_copy(&server, ".trash", "copy-of-trash").await, 403);
    assert_eq!(
        rest_copy(&server, &format!(".trash/{alias}"), ".trash/into").await,
        403
    );
    // REST の書き込み・作成も拒否（403）
    let res = req(&server, "PUT", &format!("/api/shared/.trash/{alias}/z.txt"))
        .body("z")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "mkdir", "path": ".trash/x"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    // 直下の項目を DELETE すると、完全に消える（ゴミ箱の一覧から消え、実体も無い）
    assert_eq!(
        status_of(
            req(&server, "DELETE", &format!("/dav/.trash/{alias}"))
                .send()
                .await
                .unwrap()
        )
        .await,
        204
    );
    assert!(listing(&server, ".trash").await.entries.is_empty());
    let left = std::fs::read_dir(server.state.config.trash_dir())
        .unwrap()
        .count();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn trashed_attachment_keeps_its_id_through_the_mount_and_restores_exactly() {
    let server = TestServer::start().await;
    let a = upload(&server, "pic.txt", b"att-bytes").await;
    let msg = post_attachment(&server, &a.id).await;
    let e = trash(&server, "attachments/pic.txt").await;
    let alias = alias_name(&e);

    // 一覧の項目は、削除された添付の ID を出さない（ID は内部に残り、戻すと同じ ID になる）
    let inner = listing(&server, ".trash").await;
    assert_eq!(inner.entries[0].file_id, None);
    assert_eq!(
        read_dav(&server, &format!(".trash/{alias}")).await,
        b"att-bytes"
    );
    // 中には入れない（添付は 1 つのファイル）
    let res = req(&server, "GET", &format!("/dav/.trash/{alias}/x"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    // 外へコピーすると、新しい添付になる（ID は別）
    assert_eq!(
        rest_copy(&server, &format!(".trash/{alias}"), "attachments/copy.txt").await,
        200
    );
    let items = listing(&server, "attachments").await;
    let copy = items.entries.iter().find(|x| x.name == "copy.txt").unwrap();
    assert_ne!(copy.file_id.as_deref(), Some(a.id.as_str()));

    // 元の名前で戻すと、同じ添付 ID で本文に戻る
    assert_eq!(
        dav_move(&server, &format!(".trash/{alias}"), "attachments/pic.txt").await,
        201
    );
    let got = server.messages("").await;
    let att = got.iter().find(|m| m.id == msg).unwrap().attachments[0].clone();
    assert!(!att.deleted);
    assert_eq!(att.id, a.id);
    assert_eq!(read_dav(&server, "attachments/pic.txt").await, b"att-bytes");
}

// ---- 実際の `.trash` との衝突（実際の中身は守る） ----

#[tokio::test]
async fn a_real_trash_folder_disables_the_virtual_one_and_keeps_its_contents() {
    let server = TestServer::start().await;
    // 実際の `shared/.trash/` を作っておく（ユーザーのデータとして）
    let real = server.state.config.shared_dir().join(".trash");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("keep.txt"), b"mine").unwrap();

    // 一覧には実際のものが出る（仮想の印は付かない）
    let root = listing(&server, "").await;
    let t = root.entries.iter().find(|x| x.name == ".trash").unwrap();
    assert_eq!(t.trash, None);
    // 中身は読める・書ける（そのまま）
    assert_eq!(read_rest(&server, ".trash/keep.txt").await, b"mine");
    put_file(&server, ".trash/new.txt", b"added").await;
    assert_eq!(read_rest(&server, ".trash/new.txt").await, b"added");
    // 大文字違いの実際の名前も、仮想としては使わない（そのまま）
    mkdir(&server, "Other").await;

    // ゴミ箱の API は動く（409 にはならない）。仮想の名前は付かない
    put_file(&server, "plain.txt", b"p").await;
    let e = trash(&server, "plain.txt").await;
    assert!(e.trash_path.is_none());
    let res = server.get(ALICE, "/api/shared-trash").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let list: SharedTrashListing = res.json().await.unwrap();
    assert_eq!(list.entries.len(), 1);

    // 実際のもの（中身）は、消されず・隠されず・取り込まれていない
    assert_eq!(std::fs::read(real.join("keep.txt")).unwrap(), b"mine");
    assert_eq!(std::fs::read(real.join("new.txt")).unwrap(), b"added");
    assert!(
        !server
            .state
            .config
            .trash_dir()
            .join(&e.id)
            .join("keep.txt")
            .exists()
    );
    // 仮想の `.trash` は作られていない（大文字の実際のものと同じで、書き込みが許される）
    let res = server
        .post_json(
            ALICE,
            "/api/shared",
            &serde_json::json!({"op": "mkdir", "path": ".TRASH"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn an_existing_real_name_in_any_case_disables_the_namespace() {
    let server = TestServer::start().await;
    std::fs::write(
        server.state.config.shared_dir().join(".Trash"),
        b"file-not-folder",
    )
    .unwrap();
    let root = listing(&server, "").await;
    let t = root.entries.iter().find(|x| x.name == ".Trash").unwrap();
    assert_eq!(t.trash, None);
    assert_eq!(read_rest(&server, ".Trash").await, b"file-not-folder");
    // 使えないので、ゴミ箱の名前は出ない（`.trash` という名前は無い）
    assert!(root.entries.iter().all(|x| x.name != ".trash"));
}

// ---- 途中の状態・壊れた状態・並行 ----

#[tokio::test]
async fn pending_rows_are_completed_by_listing_and_broken_rows_stay_hidden() {
    let server = TestServer::start().await;
    put_file(&server, "late.txt", b"late").await;
    let id = "01TESTVFSPENDINGROW0000000";
    let dir = server.state.config.trash_dir().join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::rename(
        server.state.config.shared_dir().join("late.txt"),
        dir.join("item"),
    )
    .unwrap();
    sqlx::query("INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'pending', 'late.txt', 4, 1)")
        .bind(id)
        .execute(&server.state.pool)
        .await
        .unwrap();
    // 途中の行は、一覧で完了してから見える（再起動なし）
    let inner = listing(&server, ".trash").await;
    let alias = alias_of(id, "late.txt");
    assert!(inner.entries.iter().any(|x| x.name == alias));
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"late"
    );

    // 壊れた行は、名前を知っていても見えない（404）。消されない
    let bid = "01TESTVFSBROKENROW00000000";
    std::fs::create_dir_all(server.state.config.trash_dir().join(bid)).unwrap();
    sqlx::query("INSERT INTO shared_trash (id, kind, state, original_path, size, deleted_at) VALUES (?, 'file', 'broken', 'gone.txt', 0, 1)")
        .bind(bid)
        .execute(&server.state.pool)
        .await
        .unwrap();
    let res = req(
        &server,
        "GET",
        &format!("/api/shared/.trash/{}", alias_of(bid, "gone.txt")),
    )
    .send()
    .await
    .unwrap();
    // 壊れた項目を直接指定すると 403（一覧には出ない。消されない）
    assert_eq!(res.status(), 403);
    assert!(
        listing(&server, ".trash")
            .await
            .entries
            .iter()
            .all(|x| !x.name.starts_with(bid))
    );
    let state: String = sqlx::query_scalar("SELECT state FROM shared_trash WHERE id = ?")
        .bind(bid)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(state, "broken");
}

#[tokio::test]
async fn concurrent_listing_reads_and_restore_never_lose_bytes() {
    let server = TestServer::start().await;
    put_file(&server, "c.txt", b"steady").await;
    let id = trash(&server, "c.txt").await.id;
    let alias = alias_of(&id, "c.txt");
    let reads = (0..8).map(|_| {
        let http = server.http.clone();
        let url = server.url(&format!("/api/shared/.trash/{alias}"));
        async move {
            http.get(url)
                .header("X-Dev-User", ALICE)
                .send()
                .await
                .unwrap()
        }
    });
    let restore = server
        .post_json(
            ALICE,
            "/api/shared-trash",
            &serde_json::json!({"op": "restore", "id": id}),
        )
        .send();
    let (restored, responses) = tokio::join!(restore, futures_util::future::join_all(reads));
    assert_eq!(restored.unwrap().status().as_u16(), 200);
    for res in responses {
        // 戻す前に読めたもの（中身は同じ）、戻している最中（403）、戻したあと（404）。どれでも中身は失われない
        let status = res.status().as_u16();
        assert!(status == 200 || status == 403 || status == 404, "{status}");
        if status == 200 {
            assert_eq!(res.bytes().await.unwrap().as_ref(), b"steady");
        }
    }
    assert_eq!(read_rest(&server, "c.txt").await, b"steady");
}

// ---- 大きさ・通知・再起動 ----

#[tokio::test]
async fn trash_size_counts_retained_content_once_and_root_excludes_it() {
    let server = TestServer::start().await;
    put_file(&server, "f.txt", b"12345").await;
    mkdir(&server, "d").await;
    put_file(&server, "d/g.txt", b"123").await;
    trash(&server, "f.txt").await;
    trash(&server, "d").await;

    let all: SharedSize = server.get_json(ALICE, "/api/shared-size/.trash").await;
    assert_eq!((all.size, all.files, all.dirs), (8, 2, 1));
    let root: SharedSize = server.get_json(ALICE, "/api/shared-size").await;
    assert_eq!(root.size, 0, "ルートの大きさにゴミ箱は入らない");
}

#[tokio::test]
async fn trash_operations_and_moves_announce_the_namespace_to_other_clients() {
    let server = TestServer::start().await;
    put_file(&server, "n.txt", b"n").await;
    let mut ws = server.ws(ALICE).await;
    let e = trash(&server, "n.txt").await;
    ws.recv_until(|ev| matches!(ev, ServerEvent::FilesChanged { path } if path == ".trash"))
        .await;
    assert_eq!(
        dav_move(&server, &format!(".trash/{}", alias_name(&e)), "n.txt").await,
        201
    );
    ws.recv_until(|ev| matches!(ev, ServerEvent::FilesChanged { path } if path == ".trash"))
        .await;
}

#[tokio::test]
async fn the_namespace_survives_a_restart_without_changes() {
    let server = TestServer::start().await;
    put_file(&server, "s.txt", b"survive").await;
    let e = trash(&server, "s.txt").await;
    let server = restart(&server).await;
    let inner = listing(&server, ".trash").await;
    assert!(inner.entries.iter().any(|x| x.name == alias_name(&e)));
    assert_eq!(
        read_rest(&server, &format!(".trash/{}", alias_name(&e))).await,
        b"survive"
    );
    // 名前は再起動のあとも同じ（時刻や番号に依らない）
    assert_eq!(alias_name(&e), alias_of(&e.id, "s.txt"));
    let _ = SharedEntry::clone; // 型の確認
}

// ---- Overwrite:T の先消し（dav-server）を、ゴミ箱から・ゴミ箱へ向く要求で止める ----

/// `MOVE` / `COPY`（宛先と Overwrite を指定できる）。結果は状態の数字。
async fn dav_transfer(
    server: &TestServer,
    m: &str,
    from: &str,
    to: &str,
    overwrite: Option<&str>,
) -> u16 {
    let mut r = req(server, m, &format!("/dav/{from}"))
        .header("Destination", server.url(&format!("/dav/{to}")));
    if let Some(v) = overwrite {
        r = r.header("Overwrite", v);
    }
    status_of(r.send().await.unwrap()).await
}

#[tokio::test]
async fn restore_over_a_live_file_with_overwrite_t_keeps_both() {
    let server = TestServer::start().await;
    put_file(&server, "doc.txt", b"old").await;
    let alias = alias_name(&trash(&server, "doc.txt").await);
    put_file(&server, "doc.txt", b"live").await;
    // dav-server の先消しをさせない: 412 で止まり、今の中身も、ゴミ箱の中身も残る
    assert_eq!(
        dav_transfer(
            &server,
            "MOVE",
            &format!(".trash/{alias}"),
            "doc.txt",
            Some("T")
        )
        .await,
        412
    );
    assert_eq!(read_rest(&server, "doc.txt").await, b"live");
    assert_eq!(read_rest(&server, &format!(".trash/{alias}")).await, b"old");
}

#[tokio::test]
async fn restore_over_a_live_folder_with_overwrite_t_keeps_the_whole_tree() {
    let server = TestServer::start().await;
    mkdir(&server, "d").await;
    put_file(&server, "d/a.txt", b"A").await;
    mkdir(&server, "d/sub").await;
    put_file(&server, "d/sub/b.txt", b"B").await;
    let alias = alias_name(&trash(&server, "d").await);
    mkdir(&server, "d").await;
    put_file(&server, "d/keep.txt", b"K").await;

    assert_eq!(
        dav_transfer(&server, "MOVE", &format!(".trash/{alias}"), "d", Some("T")).await,
        412
    );
    // 今のフォルダは中身ごと残る（先に消されていない）
    assert_eq!(read_rest(&server, "d/keep.txt").await, b"K");
    assert_eq!(listing(&server, "d").await.entries.len(), 1);
    // ゴミ箱の中身も、そのまま（子孫が見える）
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}/a.txt")).await,
        b"A"
    );
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}/sub/b.txt")).await,
        b"B"
    );
}

#[tokio::test]
async fn copy_out_over_a_live_file_with_overwrite_t_keeps_the_destination() {
    let server = TestServer::start().await;
    put_file(&server, "src.txt", b"from-trash").await;
    let alias = alias_name(&trash(&server, "src.txt").await);
    put_file(&server, "target.txt", b"dest").await;
    assert_eq!(
        dav_transfer(
            &server,
            "COPY",
            &format!(".trash/{alias}"),
            "target.txt",
            Some("T")
        )
        .await,
        412
    );
    assert_eq!(read_rest(&server, "target.txt").await, b"dest");
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"from-trash"
    );
}

#[tokio::test]
async fn nested_copy_out_over_a_live_folder_with_overwrite_t_keeps_the_tree() {
    let server = TestServer::start().await;
    mkdir(&server, "box").await;
    put_file(&server, "box/x.txt", b"x").await;
    let alias = alias_name(&trash(&server, "box").await);
    mkdir(&server, "out").await;
    put_file(&server, "out/mine.txt", b"mine").await;

    // フォルダごと（中身を含む）・中身の一つを、既存の場所へ T でコピーしても、先消しはされない
    assert_eq!(
        dav_transfer(
            &server,
            "COPY",
            &format!(".trash/{alias}"),
            "out",
            Some("T")
        )
        .await,
        412
    );
    assert_eq!(read_rest(&server, "out/mine.txt").await, b"mine");
    assert_eq!(listing(&server, "out").await.entries.len(), 1);
    assert_eq!(
        dav_transfer(
            &server,
            "COPY",
            &format!(".trash/{alias}/x.txt"),
            "out/mine.txt",
            Some("T")
        )
        .await,
        412
    );
    assert_eq!(read_rest(&server, "out/mine.txt").await, b"mine");
}

#[tokio::test]
async fn encoded_and_dot_relative_trash_paths_are_the_same_source() {
    let server = TestServer::start().await;
    put_file(&server, "e.txt", b"e-old").await;
    let alias = alias_name(&trash(&server, "e.txt").await);
    put_file(&server, "e.txt", b"e-live").await;
    // `.` を %2E にし、`a` を %61 にした形でも、同じゴミ箱の項目として扱う
    let encoded = format!("%2Etr%61sh/{alias}");
    assert_eq!(
        dav_transfer(&server, "MOVE", &encoded, "e.txt", Some("T")).await,
        412
    );
    assert_eq!(read_rest(&server, "e.txt").await, b"e-live");
    // `..` で戻った形（`x/../.trash/…`）も、同じ
    let dotted = format!("x/../.trash/{alias}");
    assert_eq!(
        dav_transfer(&server, "MOVE", &dotted, "e.txt", Some("T")).await,
        412
    );
    assert_eq!(read_rest(&server, "e.txt").await, b"e-live");
    // 直下の DELETE（完全に消す）も、符号化した形で同じ
    let res = req(&server, "DELETE", &format!("/dav/%2Etrash/{alias}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    assert!(listing(&server, ".trash").await.entries.is_empty());
}

#[tokio::test]
async fn a_destination_inside_the_trash_is_never_pre_deleted() {
    let server = TestServer::start().await;
    put_file(&server, "t.txt", b"in-trash").await;
    let alias = alias_name(&trash(&server, "t.txt").await);
    put_file(&server, "m.txt", b"m").await;
    // 宛先がゴミ箱の項目（dav-server の先消しは、その項目の完全な削除になってしまう）
    assert_eq!(
        dav_transfer(
            &server,
            "MOVE",
            "m.txt",
            &format!(".trash/{alias}"),
            Some("T")
        )
        .await,
        412
    );
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"in-trash"
    );
    assert_eq!(read_rest(&server, "m.txt").await, b"m");
    assert_eq!(
        dav_transfer(
            &server,
            "COPY",
            "m.txt",
            &format!(".trash/{alias}"),
            Some("T")
        )
        .await,
        412
    );
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"in-trash"
    );
}

#[tokio::test]
async fn normal_shared_moves_and_copies_are_unchanged() {
    let server = TestServer::start().await;
    put_file(&server, "a.txt", b"a").await;
    // 同名がない移動・コピーは、従来どおり 201
    assert_eq!(
        dav_transfer(&server, "MOVE", "a.txt", "b.txt", None).await,
        201
    );
    assert_eq!(
        dav_transfer(&server, "COPY", "b.txt", "c.txt", None).await,
        201
    );
    assert_eq!(read_rest(&server, "c.txt").await, b"a");
}

#[tokio::test]
async fn a_real_trash_folder_is_ordinary_data_for_overwrite() {
    let server = TestServer::start().await;
    let real = server.state.config.shared_dir().join(".trash");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::write(real.join("keep.txt"), b"real").unwrap();
    put_file(&server, "dest.txt", b"old").await;
    // 実際の `.trash` は普通の項目（仮想のゴミ箱ではない）: Overwrite:T は従来どおり置き換える
    assert_eq!(
        dav_transfer(&server, "COPY", ".trash/keep.txt", "dest.txt", Some("T")).await,
        204
    );
    assert_eq!(read_rest(&server, "dest.txt").await, b"real");
}

/// 現状の記録（承認ではない）: 通常の共有フォルダへの Overwrite:T の移動は、従来どおり宛先を置き換える。
/// これは dav-server の先消しの結果で、別途レビューする（`.pi/webdav-overwrite-predelete.txt`）。
#[tokio::test]
async fn recorded_current_behaviour_shared_overwrite_t_replaces_the_destination() {
    let server = TestServer::start().await;
    put_file(&server, "s.txt", b"new").await;
    put_file(&server, "t.txt", b"old").await;
    assert_eq!(
        dav_transfer(&server, "MOVE", "s.txt", "t.txt", Some("T")).await,
        // 置き換えたときは 204（新しい項目は 201）
        204
    );
    assert_eq!(read_rest(&server, "t.txt").await, b"new");
}

#[tokio::test]
async fn malformed_and_short_alias_prefixes_are_not_found_without_panic() {
    let server = TestServer::start().await;
    put_file(&server, "z.txt", b"z").await;
    let _ = trash(&server, "z.txt").await;
    for bad in [
        "-",
        "--",
        "あいうえおかきくけこさしすせそたちつてと",
        "01ABC",
        "01ABCDEFGHJKMNPQRSTVWXYZ0あ--x",
    ] {
        let res = req(&server, "GET", &format!("/api/shared/.trash/{bad}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404, "{bad:?}");
    }
}

// ---- 削除された添付（PDF）の一覧は ID を出さない。古い API は 410 のまま ----

async fn upload_as(
    server: &TestServer,
    name: &str,
    mime: &str,
    data: &[u8],
) -> disnans_shared::Attachment {
    let part = reqwest::multipart::Part::bytes(data.to_vec())
        .file_name(name.to_owned())
        .mime_str(mime)
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

#[tokio::test]
async fn trashed_pdf_attachment_lists_without_its_id_and_keeps_its_mime() {
    let server = TestServer::start().await;
    let a = upload_as(&server, "report.pdf", "application/pdf", b"%PDF-1.4 bytes").await;
    post_attachment(&server, &a.id).await;
    let e = trash(&server, "attachments/report.pdf").await;
    let alias = alias_name(&e);

    // 一覧（DTO）: ID・投稿は出さない。MIME は元のまま
    let inner = listing(&server, ".trash").await;
    let item = inner.entries.iter().find(|x| x.name == alias).unwrap();
    assert_eq!(item.file_id, None);
    assert_eq!(item.message_id, None);
    assert_eq!(item.mime.as_deref(), Some("application/pdf"));
    assert_eq!(item.kind, SharedKind::File);
    // 中身は、マウント（REST と WebDAV）から読める
    assert_eq!(
        read_rest(&server, &format!(".trash/{alias}")).await,
        b"%PDF-1.4 bytes"
    );
    assert_eq!(
        read_dav(&server, &format!(".trash/{alias}")).await,
        b"%PDF-1.4 bytes"
    );
    // 古い添付の API（ID で読む）は、削除されたので 410 のまま
    let res = req(&server, "GET", &format!("/api/files/{}", a.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 410);
}

// ---- 大きさ: 実際のファイルの大きさ・要求した項目は自分を数えない ----

#[tokio::test]
async fn sizes_count_real_bytes_and_never_the_requested_folder_itself() {
    let server = TestServer::start().await;
    mkdir(&server, "box").await;
    mkdir(&server, "box/sub").await;
    put_file(&server, "box/sub/x.txt", b"1234567").await; // 7
    put_file(&server, "box/y.txt", b"123").await; // 3
    let alias = alias_name(&trash(&server, "box").await);

    // 中のファイル 1 つ: 自分の大きさだけ
    let f: SharedSize = server
        .get_json(ALICE, &format!("/api/shared-size/.trash/{alias}/sub/x.txt"))
        .await;
    assert_eq!((f.size, f.files, f.dirs), (7, 1, 0));
    // 中のフォルダ: 配下だけ（自分は数えない）
    let nested: SharedSize = server
        .get_json(ALICE, &format!("/api/shared-size/.trash/{alias}/sub"))
        .await;
    assert_eq!((nested.size, nested.files, nested.dirs), (7, 1, 0));
    // 直下のフォルダ（項目）: 配下だけ（`box` 自身は数えない）。`sub` は配下のフォルダとして 1
    let top: SharedSize = server
        .get_json(ALICE, &format!("/api/shared-size/.trash/{alias}"))
        .await;
    assert_eq!((top.size, top.files, top.dirs), (10, 2, 1));
    // ゴミ箱の直下: 直下の項目（フォルダ 1）を一度だけ数える
    let all: SharedSize = server.get_json(ALICE, "/api/shared-size/.trash").await;
    assert_eq!((all.size, all.files, all.dirs), (10, 2, 2));
}

// ---- リンク（シンボリックリンク）は辿らない。外のものは読めない・数えない（Unix） ----

#[cfg(unix)]
mod symlinks {
    use super::*;

    /// データフォルダの外に、秘密のファイルを置く（テスト用の一時の場所）。
    fn outside_secret(server: &TestServer) -> std::path::PathBuf {
        let p = server.dir.path().join("outside");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("secret.txt"), b"SECRET").unwrap();
        p
    }

    #[tokio::test]
    async fn an_id_directory_replaced_by_a_link_is_refused_and_hidden() {
        let server = TestServer::start().await;
        put_file(&server, "f.txt", b"mine").await;
        let e = trash(&server, "f.txt").await;
        let alias = alias_name(&e);
        let real = server.state.config.trash_dir().join(&e.id);
        std::fs::rename(&real, server.dir.path().join("aside")).unwrap();
        let outside = outside_secret(&server);
        std::os::unix::fs::symlink(&outside, &real).unwrap();

        let res = req(&server, "GET", &format!("/api/shared/.trash/{alias}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        let res = req(&server, "GET", &format!("/dav/.trash/{alias}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        assert!(listing(&server, ".trash").await.entries.is_empty());
        let all: SharedSize = server.get_json(ALICE, "/api/shared-size/.trash").await;
        assert_eq!(all.size, 0);
    }

    #[tokio::test]
    async fn an_item_replaced_by_a_link_to_outside_bytes_is_never_returned() {
        let server = TestServer::start().await;
        put_file(&server, "g.txt", b"mine").await;
        let e = trash(&server, "g.txt").await;
        let alias = alias_name(&e);
        let item = server.state.config.trash_dir().join(&e.id).join("item");
        std::fs::remove_file(&item).unwrap();
        let outside = outside_secret(&server).join("secret.txt");
        std::os::unix::fs::symlink(&outside, &item).unwrap();

        let res = req(&server, "GET", &format!("/api/shared/.trash/{alias}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        assert_ne!(res.bytes().await.unwrap().as_ref(), b"SECRET");
        let res = req(&server, "GET", &format!("/dav/.trash/{alias}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        assert!(listing(&server, ".trash").await.entries.is_empty());
        assert_eq!(
            rest_copy(&server, &format!(".trash/{alias}"), "stolen.txt").await,
            404
        );
        assert!(!server.state.config.shared_dir().join("stolen.txt").exists());
        let all: SharedSize = server.get_json(ALICE, "/api/shared-size/.trash").await;
        assert_eq!(all.size, 0);
    }

    #[tokio::test]
    async fn an_attachment_blob_replaced_by_a_link_is_refused() {
        let server = TestServer::start().await;
        let a = upload_as(&server, "blob.pdf", "application/pdf", b"%PDF blob").await;
        post_attachment(&server, &a.id).await;
        let e = trash(&server, "attachments/blob.pdf").await;
        let alias = alias_name(&e);
        let blob = server.state.config.trash_dir().join(&e.id).join("blob");
        std::fs::remove_file(&blob).unwrap();
        let outside = outside_secret(&server).join("secret.txt");
        std::os::unix::fs::symlink(&outside, &blob).unwrap();

        let res = req(&server, "GET", &format!("/api/shared/.trash/{alias}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        assert_ne!(res.bytes().await.unwrap().as_ref(), b"SECRET");
        let res = req(&server, "GET", &format!("/dav/.trash/{alias}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        assert!(listing(&server, ".trash").await.entries.is_empty());
    }

    #[tokio::test]
    async fn a_nested_link_inside_a_trashed_folder_is_hidden_and_not_followed() {
        let server = TestServer::start().await;
        mkdir(&server, "dir").await;
        put_file(&server, "dir/own.txt", b"own").await;
        let e = trash(&server, "dir").await;
        let alias = alias_name(&e);
        let outside = outside_secret(&server);
        let link = server
            .state
            .config
            .trash_dir()
            .join(&e.id)
            .join("item")
            .join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();

        // 中の一覧は、リンクを見せない（own.txt だけ）
        let inner = listing(&server, &format!(".trash/{alias}")).await;
        let names: Vec<&str> = inner.entries.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["own.txt"]);
        // リンクの先の中身は読めず、大きさにも入らない
        let res = req(
            &server,
            "GET",
            &format!("/api/shared/.trash/{alias}/link/secret.txt"),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(res.status(), 404);
        assert_ne!(res.bytes().await.unwrap().as_ref(), b"SECRET");
        let res = req(
            &server,
            "GET",
            &format!("/dav/.trash/{alias}/link/secret.txt"),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(res.status(), 404);
        let res = req(
            &server,
            "GET",
            &format!("/api/shared-size/.trash/{alias}/link"),
        )
        .send()
        .await
        .unwrap();
        assert_eq!(res.status(), 404);
        let top: SharedSize = server
            .get_json(ALICE, &format!("/api/shared-size/.trash/{alias}"))
            .await;
        assert_eq!((top.size, top.files, top.dirs), (3, 1, 0));
        assert_eq!(
            rest_copy(&server, &format!(".trash/{alias}/link"), "leak").await,
            404
        );
    }
}
