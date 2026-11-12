//! 通話の制御（call.join → call.update）を Rust の ChatSession から送ったとき、サーバーがどう応じるかを
//! 実サーバーで確かめる（再現用の診断テスト）。
//!
//! 確かめること: join が成功して参加者一覧に載るか、update が `not_in_call` で落ちないか、
//! サーバーの error イベントが ChatSession の受信側に届くか。

use std::time::Duration;

use disnans_client_core::{ChatSession, ConnectOptions, ServerUrl, WatchItem};
use disnans_server::testing::DevServer;
use disnans_shared::{CallStatus, ClientEvent, ServerEvent};

const IO: Duration = Duration::from_secs(10);

/// 開発モードのサーバー（一時ディレクトリ）。`addr`・`state` は DevServer のもの。
struct TestServer {
    dev: DevServer,
}

impl std::ops::Deref for TestServer {
    type Target = DevServer;
    fn deref(&self) -> &DevServer {
        &self.dev
    }
}

impl TestServer {
    async fn start() -> Self {
        Self {
            dev: DevServer::start().await,
        }
    }

    fn server(&self) -> ServerUrl {
        ServerUrl::parse(&format!("http://{}", self.addr)).unwrap()
    }

    async fn stop(self) {
        self.dev.stop().await;
    }
}

fn opts(user: &str) -> ConnectOptions {
    ConnectOptions {
        dev_user: Some(user.into()),
        ..ConnectOptions::default()
    }
}

fn status(muted: bool) -> CallStatus {
    CallStatus {
        muted,
        deafened: false,
        device: Some("laptop".into()),
    }
}

/// `ms` のあいだ受信できたイベントを集める（ChatSession::next の Connected 等も含む）
async fn collect(session: &mut ChatSession, ms: u64) -> Vec<String> {
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    while let Ok(item) = tokio::time::timeout_at(deadline, session.next()).await {
        match item {
            WatchItem::Event { event, .. } => out.push(describe(&event)),
            other => out.push(format!("{other:?}")),
        }
    }
    out
}

fn describe(event: &ServerEvent) -> String {
    match event {
        ServerEvent::Error { code, message, .. } => format!("error code={code} message={message}"),
        ServerEvent::CallState { members } => format!(
            "call.state members={:?}",
            members
                .iter()
                .map(|m| (&m.peer, &m.user_id, m.status.muted))
                .collect::<Vec<_>>()
        ),
        other => format!("{other:?}").chars().take(120).collect(),
    }
}

#[tokio::test]
async fn rust_session_call_join_then_update() {
    let server = TestServer::start().await;
    let mut alice = tokio::time::timeout(IO, ChatSession::start(&server.server(), opts("alice")))
        .await
        .unwrap()
        .unwrap();
    let mut bob = tokio::time::timeout(IO, ChatSession::start(&server.server(), opts("bob")))
        .await
        .unwrap()
        .unwrap();
    let sender = alice.sender();
    let _ = collect(&mut alice, 300).await;
    let _ = collect(&mut bob, 300).await;

    let join = sender
        .emit(ClientEvent::CallJoin {
            peer: "a1b2c3d4e5f6".into(),
            status: status(false),
        })
        .await;
    println!("emit call.join -> {join:?}");
    let alice_after_join = collect(&mut alice, 500).await;
    println!("alice after join: {alice_after_join:#?}");
    let bob_after_join = collect(&mut bob, 300).await;
    println!("bob after join: {bob_after_join:#?}");

    let update = sender
        .emit(ClientEvent::CallUpdate {
            status: status(true),
        })
        .await;
    println!("emit call.update -> {update:?}");
    let alice_after_update = collect(&mut alice, 500).await;
    println!("alice after update: {alice_after_update:#?}");
    let bob_after_update = collect(&mut bob, 300).await;
    println!("bob after update: {bob_after_update:#?}");

    join.unwrap();
    update.unwrap();
    assert!(
        !alice_after_update.iter().any(|l| l.contains("not_in_call")),
        "update failed with not_in_call"
    );
    assert!(
        bob_after_update
            .iter()
            .any(|l| l.contains("call.state") && l.contains("a1b2c3d4e5f6")),
        "bob never saw alice in the call"
    );

    server.stop().await;
}
