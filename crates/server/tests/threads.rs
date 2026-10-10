//! 返信・silent・スレッドのタイトル/タグ/アーカイブの結合テスト。

mod common;

use std::time::Duration;

use common::TestServer;
use disnans_shared::{
    ApiError, ClientEvent, SetThreadTags, Thread, ThreadTag, ThreadTagUsage, UpdateThread,
};
use disnans_shared::{Message, ServerEvent};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn msg(thread_id: Option<&str>, body: &str, reply_to: Option<&str>, silent: bool) -> ClientEvent {
    ClientEvent::MessageSend {
        client_id: format!("c-{body}"),
        thread_id: thread_id.map(Into::into),
        body: body.into(),
        attachment_ids: vec![],
        start_thread: false,
        reply_to: reply_to.map(Into::into),
        silent,
    }
}

fn tag(label: &str, icon: Option<&str>) -> ThreadTag {
    ThreadTag {
        label: label.into(),
        icon: icon.map(Into::into),
    }
}

async fn make_thread(alice: &mut common::WsClient) -> Message {
    let root = alice.post("話題").await;
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
async fn reply_carries_preview_and_notifies_target() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    let original = alice.post("元の発言").await;
    let reply = bob
        .post_with(msg(None, "返信です", Some(&original.id), false))
        .await;
    assert_eq!(reply.reply_to.as_deref(), Some(original.id.as_str()));
    let preview = reply.reply_preview.as_ref().unwrap();
    assert_eq!(preview.body, "元の発言");
    assert_eq!(preview.author_id, original.author_id);

    // 返信先の作者に通知が届く
    let ServerEvent::Notify { title, .. } = alice
        .recv_until(|e| matches!(e, ServerEvent::Notify { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(title, "bob さんが返信");

    // 履歴にも返信先の要約が入る
    let list = server.messages("").await;
    assert!(list.iter().any(|m| m.reply_preview.is_some()));

    // 返信先を消すと、reply_to は残り要約は null になる
    alice
        .send(ClientEvent::MessageDelete {
            message_id: original.id.clone(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    let list = server.messages("").await;
    let after = list.iter().find(|m| m.id == reply.id).unwrap();
    assert_eq!(after.reply_to.as_deref(), Some(original.id.as_str()));
    assert!(after.reply_preview.is_none());
}

#[tokio::test]
async fn reply_only_in_same_place() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let root = make_thread(&mut alice).await;
    let main = alice.post("メイン").await;
    let inner = alice
        .post_with(msg(Some(&root.id), "中", None, false))
        .await;

    // スレッドの中からメインのメッセージには返信できない
    alice
        .send(msg(Some(&root.id), "x", Some(&main.id), false))
        .await;
    assert_eq!(alice.expect_error().await.1, "reply_other_place");
    // メインからスレッドの返信にも返信できない
    alice.send(msg(None, "y", Some(&inner.id), false)).await;
    assert_eq!(alice.expect_error().await.1, "reply_other_place");
    // 存在しない
    alice.send(msg(None, "z", Some("NOPE"), false)).await;
    assert_eq!(alice.expect_error().await.1, "reply_not_found");
    // スレッドの中で、同じスレッドの返信や起点には返信できる
    let r = alice
        .post_with(msg(Some(&root.id), "a", Some(&inner.id), false))
        .await;
    assert_eq!(r.reply_to.as_deref(), Some(inner.id.as_str()));
    let r = alice
        .post_with(msg(Some(&root.id), "b", Some(&root.id), false))
        .await;
    assert_eq!(r.reply_to.as_deref(), Some(root.id.as_str()));
}

#[tokio::test]
async fn silent_sends_no_notification() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    let base = bob.post("hi").await;
    alice
        .send(msg(
            None,
            &format!("<@{}> こっそり", base.author_id),
            Some(&base.id),
            true,
        ))
        .await;
    // message.created は届くが notify は来ない
    bob.recv_until(|e| matches!(e, ServerEvent::MessageCreated { .. }))
        .await;
    bob.assert_silent(Duration::from_millis(300)).await;
}

#[tokio::test]
async fn title_and_archive_are_creator_only_tags_are_open() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    let root = make_thread(&mut alice).await;
    bob.recv_until(|e| matches!(e, ServerEvent::ThreadUpdated { .. }))
        .await;

    let path = format!("/api/threads/{}", root.id);
    // 他人はタイトルもアーカイブも変えられない
    let res = server
        .http
        .patch(server.url(&path))
        .header("X-Dev-User", BOB)
        .json(&UpdateThread {
            title: Some("乗っ取り".into()),
            archived: None,
        })
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 403);

    // 本人は変えられ、他のクライアントにも届く
    let res = server
        .http
        .patch(server.url(&path))
        .header("X-Dev-User", ALICE)
        .json(&UpdateThread {
            title: Some(" 週末の予定 ".into()),
            archived: Some(true),
        })
        .send()
        .await
        .unwrap();
    assert!(res.status().is_success());
    let ServerEvent::ThreadUpdated { thread } = bob
        .recv_until(|e| matches!(e, ServerEvent::ThreadUpdated { .. }))
        .await
    else {
        unreachable!()
    };
    assert_eq!(thread.info.title.as_deref(), Some("週末の予定"));
    assert!(thread.info.archived);
    assert_eq!(thread.info.created_by, root.author_id);

    // アーカイブ中でも返信できる
    let reply = bob
        .post_with(msg(Some(&root.id), "返信", None, false))
        .await;
    assert_eq!(reply.thread_id.as_deref(), Some(root.id.as_str()));

    // 空のタイトルで消える。archived は省略すれば変わらない
    let res = server
        .http
        .patch(server.url(&path))
        .header("X-Dev-User", ALICE)
        .json(&UpdateThread {
            title: Some("".into()),
            archived: None,
        })
        .send()
        .await
        .unwrap();
    let t: Thread = res.json().await.unwrap();
    assert!(t.info.title.is_none());
    assert!(t.info.archived);

    // タグは誰でも置き換えられる
    let res = server
        .put_json(
            BOB,
            &format!("{path}/tags"),
            &SetThreadTags {
                tags: vec![
                    tag("🍙 ごはん", None),
                    tag("予定", Some("calendar")),
                    tag("予定", Some("calendar")),
                ],
            },
        )
        .send()
        .await
        .unwrap();
    let t: Thread = res.json().await.unwrap();
    assert_eq!(
        t.info.tags,
        vec![tag("🍙 ごはん", None), tag("予定", Some("calendar"))]
    );

    // 既存タグの一覧
    let usages: Vec<ThreadTagUsage> = server.get_json(ALICE, "/api/thread-tags").await;
    assert_eq!(usages.len(), 2);
    assert!(usages.iter().all(|u| u.count == 1));

    // 不正なタグ
    for bad in [tag("  ", None), tag("a", Some("Bad Icon"))] {
        let res = server
            .put_json(
                ALICE,
                &format!("{path}/tags"),
                &SetThreadTags { tags: vec![bad] },
            )
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
        let err: ApiError = res.json().await.unwrap();
        assert_eq!(err.code, "invalid_tag");
    }

    // 一覧にも反映されている
    let all: Vec<Thread> = server.get_json(ALICE, "/api/threads").await;
    assert_eq!(all[0].info.tags.len(), 2);

    // 存在しないスレッド
    let res = server
        .put_json(
            ALICE,
            "/api/threads/NOPE/tags",
            &SetThreadTags { tags: vec![] },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}
