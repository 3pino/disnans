//! 結合テスト用の共通コード。開発モードのサーバーを一時ディレクトリで起動する。

#![allow(dead_code)]

use std::net::SocketAddr;
use std::time::Duration;

use disnans_server::config::Config;
use disnans_server::state::SharedState;
use disnans_shared::{ClientEvent, Message, ServerEvent};
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub struct TestServer {
    pub addr: SocketAddr,
    pub state: SharedState,
    pub http: reqwest::Client,
    pub dir: tempfile::TempDir,
}

impl TestServer {
    pub async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = Config {
            data_dir: dir.path().to_owned(),
            bind: "127.0.0.1:0".parse().unwrap(),
            dev: true,
            tailscale_socket: dir.path().join("no-such.sock"),
        };
        let (app, state) = disnans_server::build(config).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        Self {
            addr,
            state,
            http: reqwest::Client::new(),
            dir,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    /// `user` として GET する。
    pub fn get(&self, user: &str, path: &str) -> reqwest::RequestBuilder {
        self.http.get(self.url(path)).header("X-Dev-User", user)
    }

    pub async fn get_json<T: DeserializeOwned>(&self, user: &str, path: &str) -> T {
        let res = self.get(user, path).send().await.unwrap();
        assert!(res.status().is_success(), "GET {path}: {}", res.status());
        res.json().await.unwrap()
    }

    pub async fn messages(&self, query: &str) -> Vec<Message> {
        self.get_json("alice@test", &format!("/api/messages{query}"))
            .await
    }

    /// `user` として WebSocket に接続し、`hello` を受け取るところまで進める。
    pub async fn ws(&self, user: &str) -> WsClient {
        let url = format!("ws://{}/api/ws?dev_user={user}", self.addr);
        let (stream, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let mut client = WsClient { stream };
        match client.recv().await {
            ServerEvent::Hello { me, .. } => assert_eq!(me.login_name, user),
            other => panic!("hello が来ませんでした: {other:?}"),
        }
        client
    }
}

pub struct WsClient {
    stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl WsClient {
    pub async fn send(&mut self, event: ClientEvent) {
        let text = serde_json::to_string(&event).unwrap();
        self.stream.send(WsMessage::text(text)).await.unwrap();
    }

    /// 次のイベントを受け取る（3秒でタイムアウト）。
    pub async fn recv(&mut self) -> ServerEvent {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match self.stream.next().await.expect("切断されました").unwrap() {
                    WsMessage::Text(text) => return serde_json::from_str(&text).unwrap(),
                    WsMessage::Close(_) => panic!("切断されました"),
                    _ => continue,
                }
            }
        })
        .await
        .expect("イベントが来ませんでした")
    }

    /// 条件に合うイベントが来るまで読み飛ばす。
    pub async fn recv_until(&mut self, mut pred: impl FnMut(&ServerEvent) -> bool) -> ServerEvent {
        loop {
            let event = self.recv().await;
            if pred(&event) {
                return event;
            }
        }
    }

    /// 指定した時間、イベントが来ないことを確かめる。
    pub async fn assert_silent(&mut self, wait: Duration) {
        if let Ok(Some(Ok(WsMessage::Text(text)))) =
            tokio::time::timeout(wait, self.stream.next()).await
        {
            panic!("予期しないイベント: {text}");
        }
    }

    /// メッセージを送り、自分に `message.created` が届くまで待つ。
    pub async fn post(&mut self, body: &str) -> Message {
        self.post_with(send(body)).await
    }

    /// 送ったイベントの `message.created`（client_id が入ったもの）が届くまで待つ。
    /// 他人の投稿の `message.created` は読み飛ばす。
    pub async fn post_with(&mut self, event: ClientEvent) -> Message {
        self.send(event).await;
        let mine = |e: &ServerEvent| {
            matches!(
                e,
                ServerEvent::MessageCreated {
                    client_id: Some(_),
                    ..
                } | ServerEvent::Error { .. }
            )
        };
        match self.recv_until(mine).await {
            ServerEvent::MessageCreated { message, .. } => message,
            other => panic!("送信に失敗しました: {other:?}"),
        }
    }

    /// `error` が届くまで待ち、そのコードを返す。
    pub async fn expect_error(&mut self) -> (Option<String>, String) {
        match self
            .recv_until(|e| matches!(e, ServerEvent::Error { .. }))
            .await
        {
            ServerEvent::Error {
                client_id, code, ..
            } => (client_id, code),
            _ => unreachable!(),
        }
    }
}

/// メインチャットへのふつうの送信。
pub fn send(body: &str) -> ClientEvent {
    ClientEvent::MessageSend {
        client_id: format!("c-{body}"),
        thread_id: None,
        body: body.into(),
        attachment_ids: vec![],
        start_thread: false,
    }
}
