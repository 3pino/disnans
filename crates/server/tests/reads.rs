//! 既読の位置と未読数（`/api/me/read`）の結合テスト。

mod common;

use std::time::Duration;

use common::TestServer;
use disnans_shared::{ApiError, ClientEvent, MarkRead, Message, ReadMarker, ServerEvent};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";
const CAROL: &str = "carol@test";

async fn markers(server: &TestServer, user: &str) -> Vec<ReadMarker> {
    server.get_json(user, "/api/me/read").await
}

fn find<'a>(list: &'a [ReadMarker], thread_id: Option<&str>) -> &'a ReadMarker {
    list.iter()
        .find(|m| m.thread_id.as_deref() == thread_id)
        .unwrap_or_else(|| panic!("{thread_id:?} がありません: {list:?}"))
}

async fn mark(
    server: &TestServer,
    user: &str,
    thread_id: Option<&str>,
    message_id: &str,
) -> reqwest::Response {
    server
        .put_json(
            user,
            "/api/me/read",
            &MarkRead {
                thread_id: thread_id.map(Into::into),
                message_id: message_id.into(),
            },
        )
        .send()
        .await
        .unwrap()
}

fn reply(thread_id: &str, body: &str) -> ClientEvent {
    ClientEvent::MessageSend {
        client_id: format!("r-{body}"),
        thread_id: Some(thread_id.into()),
        body: body.into(),
        attachment_ids: vec![],
        start_thread: false,
    }
}

#[tokio::test]
async fn counts_unread_and_syncs_between_devices() {
    let server = TestServer::start().await;
    // 先にアカウントを作っておく（作る前のメッセージは既読とみなすため）
    let mut alice = server.ws(ALICE).await;
    let mut alice2 = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    // 最初は未読なし。メインチャットは必ず先頭にある
    let list = markers(&server, ALICE).await;
    assert_eq!(list.len(), 1);
    assert!(list[0].thread_id.is_none());
    assert_eq!(list[0].unread_count, 0);

    let m1 = bob.post("1").await;
    let m2 = bob.post("2").await;
    // 自分のメッセージは数えない
    alice.post("自分").await;
    let root = bob
        .post_with(ClientEvent::MessageSend {
            client_id: "root".into(),
            thread_id: None,
            body: "話題".into(),
            attachment_ids: vec![],
            start_thread: true,
        })
        .await;
    let r1 = bob.post_with(reply(&root.id, "a")).await;
    bob.post_with(reply(&root.id, "b")).await;
    alice.post_with(reply(&root.id, "自分の返信")).await;
    // 返信のあとの thread.updated まで受け取っておく（あとで接続する bob2 に混ざらないように）
    alice
        .recv_until(|e| matches!(e, ServerEvent::ThreadUpdated { .. }))
        .await;

    let list = markers(&server, ALICE).await;
    assert_eq!(list.len(), 2);
    assert_eq!(find(&list, None).unread_count, 3);
    assert_eq!(find(&list, Some(&root.id)).unread_count, 2);
    // bob から見ると、alice の分だけ未読
    let list = markers(&server, BOB).await;
    assert_eq!(find(&list, None).unread_count, 1);
    assert_eq!(find(&list, Some(&root.id)).unread_count, 1);

    // 既読を進めると、自分のすべての接続に read.updated が届く
    let mut bob2 = server.ws(BOB).await;
    let res = mark(&server, ALICE, None, &m1.id).await;
    assert_eq!(res.status(), 200);
    let marker: ReadMarker = res.json().await.unwrap();
    assert_eq!(marker.last_read_id, m1.id);
    assert_eq!(marker.unread_count, 2);
    for client in [&mut alice, &mut alice2] {
        let ServerEvent::ReadUpdated { marker } = client
            .recv_until(|e| matches!(e, ServerEvent::ReadUpdated { .. }))
            .await
        else {
            unreachable!()
        };
        assert!(marker.thread_id.is_none());
        assert_eq!(marker.last_read_id, m1.id);
        assert_eq!(marker.unread_count, 2);
    }
    // 他人には届かない
    bob2.assert_silent(Duration::from_millis(200)).await;

    // 戻らない（古い ID なら何もせず、いまの位置を返す。配信もしない）
    mark(&server, ALICE, None, &m2.id).await;
    alice2
        .recv_until(|e| matches!(e, ServerEvent::ReadUpdated { .. }))
        .await;
    let res = mark(&server, ALICE, None, &m1.id).await;
    let marker: ReadMarker = res.json().await.unwrap();
    assert_eq!(marker.last_read_id, m2.id);
    assert_eq!(marker.unread_count, 1);
    alice2.assert_silent(Duration::from_millis(200)).await;

    // スレッドの既読
    let marker: ReadMarker = mark(&server, ALICE, Some(&root.id), &r1.id)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(marker.thread_id.as_deref(), Some(root.id.as_str()));
    assert_eq!(marker.unread_count, 1);

    // 未読のメッセージが消えたら数えない
    let list = markers(&server, ALICE).await;
    let last = find(&list, None).last_read_id.clone();
    assert_eq!(last, m2.id);
    bob.send(ClientEvent::MessageDelete {
        message_id: root.id.clone(),
    })
    .await;
    bob.recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    let list = markers(&server, ALICE).await;
    assert_eq!(list.len(), 1, "消したスレッドは出さない");
    assert_eq!(find(&list, None).unread_count, 0);
    // スレッドの既読の位置も消える
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM read_markers WHERE scope = ?")
        .bind(&root.id)
        .fetch_one(&server.state.pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[tokio::test]
async fn history_before_joining_is_read() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let old: Message = alice.post("むかしの話").await;
    tokio::time::sleep(Duration::from_millis(5)).await;

    // あとから来た人には、それまでの履歴は未読にならない
    let list = markers(&server, CAROL).await;
    let main = find(&list, None);
    assert_eq!(main.unread_count, 0);
    assert!(main.last_read_id > old.id);

    // それより古い位置への既読は何もしない
    let marker: ReadMarker = mark(&server, CAROL, None, &old.id)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(marker.last_read_id, main.last_read_id);

    // 来たあとのメッセージは未読になる
    alice.post("新しい話").await;
    let list = markers(&server, CAROL).await;
    assert_eq!(find(&list, None).unread_count, 1);
}

#[tokio::test]
async fn rejects_bad_requests() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let m = alice.post("hi").await;

    let res = mark(&server, ALICE, None, "not-a-ulid").await;
    assert_eq!(res.status(), 400);
    assert_eq!(
        res.json::<ApiError>().await.unwrap().code,
        "invalid_message_id"
    );

    let res = mark(&server, ALICE, Some(&m.id), &m.id).await;
    assert_eq!(res.status(), 404);
}

/// 0008 を当てた時点のメッセージは、全員について既読になる。
#[tokio::test]
async fn migration_marks_existing_messages_read() {
    use sqlx::migrate::Migrator;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    let dir = tempfile::tempdir().unwrap();
    let options = SqliteConnectOptions::new()
        .filename(dir.path().join("db.sqlite"))
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .connect_with(options)
        .await
        .unwrap();

    // 0008 より前まで当てる
    let all = sqlx::migrate!("./migrations");
    let mut before = Migrator::DEFAULT;
    before.migrations = all
        .migrations
        .iter()
        .filter(|m| m.version < 8)
        .cloned()
        .collect::<Vec<_>>()
        .into();
    before.run(&pool).await.unwrap();

    for (id, login) in [("U1", "alice@test"), ("U2", "bob@test")] {
        sqlx::query(
            "INSERT INTO users (id, login_name, display_name, created_at) VALUES (?, ?, ?, 0)",
        )
        .bind(id)
        .bind(login)
        .bind(login)
        .execute(&pool)
        .await
        .unwrap();
    }
    // メインチャット: M1, M2（M2 が起点のスレッドに R1, R2）
    for (id, author, thread) in [
        ("01A000000000000000000000M1", "U1", None),
        ("01A000000000000000000000M2", "U2", None),
        (
            "01A000000000000000000000R1",
            "U1",
            Some("01A000000000000000000000M2"),
        ),
        (
            "01A000000000000000000000R2",
            "U2",
            Some("01A000000000000000000000M2"),
        ),
    ] {
        sqlx::query(
            "INSERT INTO messages (id, author_id, thread_id, body, created_at) VALUES (?, ?, ?, '', 0)",
        )
        .bind(id)
        .bind(author)
        .bind(thread)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("INSERT INTO threads (id, created_at) VALUES ('01A000000000000000000000M2', 0)")
        .execute(&pool)
        .await
        .unwrap();

    all.run(&pool).await.unwrap();

    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT user_id, scope, last_read_id FROM read_markers ORDER BY user_id, scope",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let expected = |u: &str, s: &str, id: &str| (u.to_owned(), s.to_owned(), id.to_owned());
    assert_eq!(
        rows,
        vec![
            expected("U1", "", "01A000000000000000000000M2"),
            expected(
                "U1",
                "01A000000000000000000000M2",
                "01A000000000000000000000R2"
            ),
            expected("U2", "", "01A000000000000000000000M2"),
            expected(
                "U2",
                "01A000000000000000000000M2",
                "01A000000000000000000000R2"
            ),
        ]
    );
}
