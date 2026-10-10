//! メッセージの全文検索（`/api/messages/search`）の結合テスト。

mod common;

use common::{TestServer, WsClient};
use disnans_shared::{ApiError, ClientEvent, Message, ServerEvent};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

/// `q` で検索した結果（新しい順）。
async fn search(server: &TestServer, query: &str) -> Vec<Message> {
    server
        .get(ALICE, "/api/messages/search")
        .query(&[("q", query)])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn bodies(list: &[Message]) -> Vec<&str> {
    list.iter().map(|m| m.body.as_str()).collect()
}

async fn make_thread(alice: &mut WsClient, title: &str) -> Message {
    let root = alice.post(title).await;
    alice
        .send(ClientEvent::ThreadCreate {
            root_message_id: root.id.clone(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::ThreadUpdated { .. }))
        .await;
    root
}

#[tokio::test]
async fn finds_japanese_substrings_in_main_chat_and_threads() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;

    let main = alice.post("明日の会議は十三時です").await;
    let root = make_thread(&mut alice, "週末の予定").await;
    let reply = alice
        .post_with(ClientEvent::MessageSend {
            client_id: "c-reply".into(),
            thread_id: Some(root.id.clone()),
            body: "会議の資料は共有フォルダに置きました".into(),
            attachment_ids: vec![],
            start_thread: false,
            reply_to: None,
            silent: true,
        })
        .await;

    // 3文字以上（trigram の索引）
    let hits = search(&server, "会議は").await;
    assert_eq!(bodies(&hits), ["明日の会議は十三時です"]);
    assert_eq!(hits[0].id, main.id);
    assert_eq!(hits[0].thread_id, None);

    // 2文字（LIKE で探す）。新しい順に、スレッドの返信も含む
    let hits = search(&server, "会議").await;
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].id, reply.id);
    assert_eq!(hits[0].thread_id.as_deref(), Some(root.id.as_str()));
    assert_eq!(hits[1].id, main.id);
    assert_eq!(hits[1].thread_id, None);
}

#[tokio::test]
async fn matching_is_case_insensitive_and_all_terms_must_match() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    alice.post("Hello World from Tokyo").await;
    alice.post("hello there").await;
    alice.post("100% done_now").await;

    assert_eq!(
        bodies(&search(&server, "HELLO").await),
        ["hello there", "Hello World from Tokyo"]
    );
    assert_eq!(
        bodies(&search(&server, "hello world").await),
        ["Hello World from Tokyo"]
    );
    // 空白で区切った語は AND
    assert!(search(&server, "hello tokyo there").await.is_empty());

    // LIKE のワイルドカードは文字として扱う（% や _ で全部に一致しない）
    assert_eq!(bodies(&search(&server, "100%").await), ["100% done_now"]);
    assert!(search(&server, "_x").await.is_empty());
    assert_eq!(bodies(&search(&server, "done_n").await), ["100% done_now"]);
}

#[tokio::test]
async fn empty_query_returns_nothing_and_long_query_is_rejected() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    alice.post("なにか").await;

    assert!(search(&server, "").await.is_empty());
    assert!(search(&server, "  ").await.is_empty());

    let long = "あ".repeat(201);
    let res = server
        .get(ALICE, "/api/messages/search")
        .query(&[("q", long.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    assert_eq!(res.json::<ApiError>().await.unwrap().code, "query_too_long");
}

#[tokio::test]
async fn edits_and_deletes_update_the_index() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;

    let first = alice.post("古い話題について").await;
    let second = alice.post("別の話題について").await;
    assert_eq!(search(&server, "古い話題").await.len(), 1);

    // 編集すると、古い本文では見つからず、新しい本文で見つかる
    alice
        .send(ClientEvent::MessageEdit {
            message_id: first.id.clone(),
            body: "新しい議題について".into(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::MessageUpdated { .. }))
        .await;
    assert!(search(&server, "古い話題").await.is_empty());
    assert_eq!(
        bodies(&search(&server, "議題に").await),
        ["新しい議題について"]
    );

    // 削除したものは出ない
    alice
        .send(ClientEvent::MessageDelete {
            message_id: second.id.clone(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    assert!(search(&server, "別の話題").await.is_empty());
    assert_eq!(
        bodies(&search(&server, "について").await),
        ["新しい議題について"]
    );
}

#[tokio::test]
async fn deleting_a_thread_root_removes_its_replies_from_search() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let root = make_thread(&mut alice, "旅行の計画").await;
    alice
        .post_with(ClientEvent::MessageSend {
            client_id: "c-reply".into(),
            thread_id: Some(root.id.clone()),
            body: "旅行先はどこにしますか".into(),
            attachment_ids: vec![],
            start_thread: false,
            reply_to: None,
            silent: true,
        })
        .await;
    assert_eq!(search(&server, "旅行先").await.len(), 1);

    alice
        .send(ClientEvent::MessageDelete {
            message_id: root.id.clone(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    assert!(search(&server, "旅行").await.is_empty());
}

#[tokio::test]
async fn paginates_newest_first_with_before() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut ids = Vec::new();
    for i in 0..5 {
        ids.push(alice.post(&format!("定例の報告 {i}")).await.id);
    }

    let first: Vec<Message> = server
        .get_json(
            ALICE,
            "/api/messages/search?q=%E5%AE%9A%E4%BE%8B%E3%81%AE%E5%A0%B1%E5%91%8A&limit=2",
        )
        .await;
    assert_eq!(first.len(), 2);
    assert_eq!(first[0].id, ids[4]);
    assert_eq!(first[1].id, ids[3]);

    let next: Vec<Message> = server
        .get_json(
            ALICE,
            &format!(
                "/api/messages/search?q=定例の報告&limit=2&before={}",
                first[1].id
            ),
        )
        .await;
    assert_eq!(
        next.iter().map(|m| m.id.clone()).collect::<Vec<_>>(),
        [ids[2].clone(), ids[1].clone()]
    );
}

#[tokio::test]
async fn other_members_can_search_too() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    alice.post("共有の資料").await;

    let hits: Vec<Message> = server
        .get(BOB, "/api/messages/search")
        .query(&[("q", "共有の資料")])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(bodies(&hits), ["共有の資料"]);
}
