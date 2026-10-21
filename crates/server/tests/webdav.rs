//! WebDAV 第 1 段（読み取り専用の `attachments/`）の結合テスト。
//! 仮想フォルダの中身は、投稿された添付から作る（投稿前のアップロードは出ない）。

mod common;

use common::TestServer;
use disnans_server::store::files as store_files;
use disnans_server::webdav::tree::{self, Entry};
use disnans_shared::{Attachment, ClientEvent};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

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

async fn items(server: &TestServer) -> Vec<tree::Item> {
    store_files::posted_items(&server.state.pool).await.unwrap()
}

#[tokio::test]
async fn only_posted_attachments_appear_under_attachments() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;

    let posted = upload(&server, ALICE, "report.txt", b"r").await;
    let _unposted = upload(&server, ALICE, "draft.txt", b"d").await;
    alice
        .post_with(ClientEvent::MessageSend {
            client_id: "c1".into(),
            body: "見て".into(),
            attachment_ids: vec![posted.id.clone()],
            reply_to: None,
            silent: false,
        })
        .await;

    let all = items(&server).await;
    assert_eq!(all.len(), 1, "投稿前のアップロードは出ない");
    assert_eq!(all[0].file_id, posted.id);

    // 年と月は投稿の時刻から決まる（ここでは列挙の結果を辿る）
    let files = tree::children(&all, &["attachments"]).unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].name, "report.txt");
    assert!(matches!(files[0].entry, Entry::File(_)));
    assert!(tree::find(&all, &["attachments", "report.txt"]).is_some());
}

#[tokio::test]
async fn other_users_posts_are_visible_in_the_main_chat_and_so_in_attachments() {
    // 今は全員が同じ主チャットを見る（チャンネルはない）。ほかの人の投稿の添付も見える。
    let server = TestServer::start().await;
    let mut bob = server.ws(BOB).await;
    let theirs = upload(&server, BOB, "bobs.txt", b"b").await;
    bob.post_with(ClientEvent::MessageSend {
        client_id: "b1".into(),
        body: String::new(),
        attachment_ids: vec![theirs.id.clone()],
        reply_to: None,
        silent: false,
    })
    .await;
    let all = items(&server).await;
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].file_name, "bobs.txt");
}

#[tokio::test]
async fn same_names_in_one_month_are_told_apart() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    for body in ["1", "2"] {
        let a = upload(&server, ALICE, "same.txt", body.as_bytes()).await;
        alice
            .post_with(ClientEvent::MessageSend {
                client_id: format!("c{body}"),
                body: body.into(),
                attachment_ids: vec![a.id.clone()],
                reply_to: None,
                silent: false,
            })
            .await;
    }
    let all = items(&server).await;
    assert_eq!(all.len(), 2);
    let names: Vec<String> = tree::children(&all, &["attachments"])
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert_eq!(names.len(), 2);
    assert_ne!(names[0], names[1]);
    assert!(
        names
            .iter()
            .all(|n| n.starts_with("same (") && n.ends_with(").txt")),
        "{names:?}"
    );
}
