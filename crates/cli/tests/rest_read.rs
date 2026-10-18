//! 読取 REST の Rust 経路（`RestClient`）と HTTP 経路（生の GET）の JSON 一致を、開発サーバーで比べる。
//!
//! 開発サーバーは一時データで起動し、サーバーの公開 API でデータを入れる。
//! Rust 経路は型付きの値を `serde_json::to_value` で JSON にし、HTTP 経路は受け取ったバイト列を
//! そのまま `serde_json::Value` にする。両方が一致すれば、型の付け替えで項目が落ちていないと言える。

use std::{net::SocketAddr, time::Duration};

use disnans_client_core::{
    MessageSearchQuery, MessagesQuery, RestClient, ServerUrl, messages_path, search_path,
    session_path,
};
use disnans_server::{chat, config::Config, state::SharedState, store::users};
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

const DEV_USER: &str = "alice";
const IO_TIMEOUT: Duration = Duration::from_secs(10);

struct TestServer {
    address: SocketAddr,
    task: JoinHandle<()>,
    state: SharedState,
    _data: tempfile::TempDir,
}

impl TestServer {
    async fn start() -> Self {
        let data = tempfile::tempdir().unwrap();
        let config = Config {
            data_dir: data.path().to_owned(),
            bind: "127.0.0.1:0".parse().unwrap(),
            dev: true,
            tailscale_socket: data.path().join("no-such-socket"),
            image_max_edge: disnans_server::image_proc::DEFAULT_MAX_EDGE,
        };
        let (app, state) = disnans_server::build(config).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            address,
            task,
            state,
            _data: data,
        }
    }

    fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    fn client(&self) -> RestClient {
        RestClient::new(ServerUrl::parse(&self.url()).unwrap(), Some(DEV_USER)).unwrap()
    }

    async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
        self.state.pool.close().await;
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 生の HTTP GET。`(ステータス, 本文)` を返す。接続は閉じる前提（`Connection: close`）。
async fn raw_get(server: &TestServer, path_and_query: &str) -> (u16, Vec<u8>) {
    let exchange = async {
        let mut socket = tokio::net::TcpStream::connect(server.address)
            .await
            .unwrap();
        let request = format!(
            "GET {path_and_query} HTTP/1.1\r\nHost: {}\r\nX-Dev-User: {DEV_USER}\r\nConnection: close\r\n\r\n",
            server.address
        );
        socket.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        response
    };
    let response = tokio::time::timeout(IO_TIMEOUT, exchange)
        .await
        .expect("HTTP 応答が時間内に来ない");
    let split = response
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("HTTP 応答の見出しの終わりがない");
    let head = String::from_utf8_lossy(&response[..split]).into_owned();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("ステータス行");
    (status, response[split + 4..].to_vec())
}

fn json(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).expect("JSON の応答")
}

/// 主チャットとスレッドに、既読・タグ・リアクション・プラグインを入れたデータ。
/// 戻り値はスレッドの ID（起点のメッセージ）。
async fn seed(server: &TestServer) -> String {
    let state = &server.state;
    let (alice, _) = users::get_or_create(&state.pool, DEV_USER, "Alice", None)
        .await
        .unwrap();
    let (bob, _) = users::get_or_create(&state.pool, "bob", "Bob", None)
        .await
        .unwrap();
    let alice_actor = chat::Actor {
        user: &alice,
        conn: None,
    };
    let bob_actor = chat::Actor {
        user: &bob,
        conn: None,
    };

    chat::send_message(
        state,
        &alice_actor,
        chat::SendMessage {
            client_id: "c-main-1".into(),
            body: "main hello".into(),
            attachment_ids: vec![],
            reply_to: None,
            silent: true,
        },
    )
    .await
    .unwrap();
    chat::send_message(
        state,
        &bob_actor,
        chat::SendMessage {
            client_id: "c-main-2".into(),
            body: "main from bob 日本語 & <tags>".into(),
            attachment_ids: vec![],
            reply_to: None,
            silent: true,
        },
    )
    .await
    .unwrap();

    chat::send_message(
        state,
        &alice_actor,
        chat::SendMessage {
            client_id: "c-thread-root".into(),
            body: "thread root".into(),
            attachment_ids: vec![],
            reply_to: None,
            silent: true,
        },
    )
    .await
    .unwrap();
    let root = messages_in(server)
        .await
        .into_iter()
        .find(|m| m["body"] == "thread root")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    chat::send_message(
        state,
        &bob_actor,
        chat::SendMessage {
            client_id: "c-thread-reply".into(),
            body: "reply in thread".into(),
            attachment_ids: vec![],
            reply_to: Some(root.clone()),
            silent: true,
        },
    )
    .await
    .unwrap();
    let first = messages_in(server)
        .await
        .into_iter()
        .find(|m| m["body"] == "main hello")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    chat::add_reaction(state, &bob_actor, &first, "👍")
        .await
        .unwrap();

    // 公開のプラグイン 1 件（一覧に出る）。ファイルは置かない（一覧は DB の情報だけを返す）
    let mut conn = state.pool.acquire().await.unwrap();
    disnans_server::store::plugins::upsert(
        &mut conn,
        &disnans_shared::PluginInfo {
            id: "sample-plugin".into(),
            kind: disnans_shared::PluginKind::Plugin,
            visibility: disnans_shared::PluginVisibility::Public,
            owner: None,
            name: "Sample".into(),
            version: "1.0.0".into(),
            description: "d".into(),
            author: "a".into(),
            min_api_version: 1,
            api_version: None,
            icon: None,
            has_icon: false,
            files: vec!["manifest.json".into()],
            hash: "abc".into(),
            updated_by: alice.id.clone(),
            updated_at: 1,
        },
    )
    .await
    .unwrap();
    drop(conn);
    disnans_server::store::prefs::set(
        &state.pool,
        &alice.id,
        r#"{"theme":"dark","nested":{"n":[1,null]}}"#,
    )
    .await
    .unwrap();

    root
}

async fn messages_in(server: &TestServer) -> Vec<Value> {
    let (status, body) = raw_get(server, "/api/messages?limit=100").await;
    assert_eq!(status, 200);
    json(&body).as_array().unwrap().clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn rust_get_matches_the_raw_http_json_for_every_read_endpoint() {
    let server = TestServer::start().await;
    seed(&server).await;
    let client = server.client();

    // (Rust 経路で使うパス, 同じ要求を生の HTTP で送るパス)
    let cases: Vec<(String, String)> = vec![
        ("/api/me".into(), "/api/me".into()),
        ("/api/users".into(), "/api/users".into()),
        ("/api/me/prefs".into(), "/api/me/prefs".into()),
        (
            messages_path(&MessagesQuery {
                before: None,
                limit: Some(100),
            }),
            "/api/messages?limit=100".into(),
        ),
        (
            search_path(&MessageSearchQuery {
                q: Some("main hello".into()),
                before: None,
                limit: Some(10),
            }),
            "/api/messages/search?q=main+hello&limit=10".into(),
        ),
        ("/api/me/read".into(), "/api/me/read".into()),
        ("/api/plugins".into(), "/api/plugins".into()),
    ];
    for (rust_path, raw_path) in cases {
        let via_rust = client
            .get_value(&rust_path)
            .await
            .unwrap_or_else(|f| panic!("{rust_path}: {f:?}"));
        let (status, body) = raw_get(&server, &raw_path).await;
        assert_eq!(status, 200, "{raw_path}");
        assert_eq!(via_rust, json(&body), "{rust_path}");
    }

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn read_bodies_still_conform_to_the_shared_types() {
    let server = TestServer::start().await;
    seed(&server).await;
    let client = server.client();

    let me = client.get_value("/api/me").await.unwrap();
    serde_json::from_value::<disnans_shared::User>(me).unwrap();
    let messages = client.get_value("/api/messages?limit=100").await.unwrap();
    let messages: Vec<disnans_shared::Message> = serde_json::from_value(messages).unwrap();
    assert!(messages.len() >= 3);
    let markers = client.get_value("/api/me/read").await.unwrap();
    serde_json::from_value::<Vec<disnans_shared::ReadMarker>>(markers).unwrap();
    let plugins = client.get_value("/api/plugins").await.unwrap();
    serde_json::from_value::<Vec<disnans_shared::PluginInfo>>(plugins).unwrap();

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn prefs_match_the_raw_http_json() {
    let server = TestServer::start().await;
    seed(&server).await;
    let client = server.client();

    let prefs = client.get_value("/api/me/prefs").await.unwrap();
    assert_eq!(
        prefs,
        serde_json::json!({"theme": "dark", "nested": {"n": [1, null]}})
    );

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn api_errors_have_the_same_status_and_code_as_http() {
    let server = TestServer::start().await;
    seed(&server).await;
    let client = server.client();

    let path = session_path("no-such-session");
    let failure = client.get_value(&path).await.unwrap_err();
    let (status, body) = raw_get(&server, &path).await;
    let raw = json(&body);
    assert_eq!(status, 404, "{path}");
    assert_eq!(failure.status, Some(status), "{path}");
    assert_eq!(Some(failure.code.as_str()), raw["code"].as_str(), "{path}");
    assert_eq!(failure.message, raw["message"].as_str().unwrap(), "{path}");

    server.stop().await;
}
