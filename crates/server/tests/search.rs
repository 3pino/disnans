//! メッセージの全文検索（`/api/messages/search`）の結合テスト。

mod common;

use common::TestServer;
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

#[tokio::test]
async fn finds_japanese_substrings_in_the_main_chat() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;

    let main = alice.post("明日の会議は十三時です").await;
    let other = alice.post("会議の資料は共有フォルダに置きました").await;

    // 3文字以上（trigram の索引）
    let hits = search(&server, "会議は").await;
    assert_eq!(bodies(&hits), ["明日の会議は十三時です"]);
    assert_eq!(hits[0].id, main.id);

    // 2文字（LIKE で探す）。新しい順
    let hits = search(&server, "会議").await;
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].id, other.id);
    assert_eq!(hits[1].id, main.id);
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
async fn deleting_a_message_removes_it_from_search() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let msg = alice.post("旅行先はどこにしますか").await;
    assert_eq!(search(&server, "旅行先").await.len(), 1);

    alice
        .send(ClientEvent::MessageDelete {
            message_id: msg.id.clone(),
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

/// 投稿前にアップロードして、本文の `![[disnans:file/<ID>]]` で添付する。
async fn upload_and_post(server: &TestServer, name: &str, text: &str) -> Message {
    let part = reqwest::multipart::Part::bytes(b"data".to_vec())
        .file_name(name.to_owned())
        .mime_str("text/plain")
        .unwrap();
    let form = reqwest::multipart::Form::new().part("file", part);
    let att: disnans_shared::Attachment = server
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
    let mut alice = server.ws(ALICE).await;
    alice
        .post(&format!("{text} ![[disnans:file/{}]]", att.id))
        .await
}

#[tokio::test]
async fn a_linked_files_current_name_is_searchable_and_follows_renames() {
    let server = TestServer::start().await;
    let msg = upload_and_post(&server, "quarterly-report.pdf", "見て").await;

    // 本文は ID だけ。添付の名前で引ける（3 文字以上・短い語のどちらも）
    assert_eq!(search(&server, "quarterly").await.first().map(|m| m.id.as_str()), Some(msg.id.as_str()));
    assert_eq!(search(&server, "quarterly-report").await.len(), 1);
    assert_eq!(search(&server, "見て quarterly").await.len(), 1, "本文と名前の語が両方一致");
    assert!(search(&server, "quarterly nothere").await.is_empty(), "AND なので、どちらかに無ければ出ない");

    // 改名したら、新しい名前で引ける（古い名前では引けない）
    let res = server
        .http
        .post(server.url("/api/shared"))
        .header("X-Dev-User", ALICE)
        .json(&serde_json::json!({ "op": "move", "from": "attachments/quarterly-report.pdf", "to": "attachments/annual.pdf" }))
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success(), "{}", res.status());
    assert_eq!(search(&server, "annual").await.len(), 1);
    assert!(search(&server, "quarterly").await.is_empty());
}

#[tokio::test]
async fn a_deleted_file_is_not_found_by_its_name() {
    let server = TestServer::start().await;
    let msg = upload_and_post(&server, "gone-soon.txt", "x").await;
    assert_eq!(search(&server, "gone-soon").await.len(), 1);
    // 投稿済みの添付は「消された」印になる（行は残る）。名前では引かない
    let res = server
        .http
        .delete(server.url(&format!("/api/files/{}", msg.attachments[0].id)))
        .header("X-Dev-User", ALICE)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);
    assert_eq!(search(&server, "gone-soon").await.len(), 1);
}
