//! 読取専用の REST（GUI 通信の Rust 移行 段1）。契約は `.pi/step4-ipc-contract.md`。
//!
//! 書き込みはここには置かない。`RestClient` に `impl` を足すだけで、既存の `rest.rs` は触らない。
//! 成功は JSON の値をそのまま返す（型付き構造体へ変換して再シリアライズしない）。
//! 失敗は `{ status?, code, message }` の [`ReadFailure`] にする。

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rest::{ClientError, MessagesQuery, RestClient};

/// `GET /api/messages/search` の条件。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageSearchQuery {
    pub q: Option<String>,
    pub before: Option<String>,
    pub limit: Option<u32>,
}

/// 読取の失敗。`status` は HTTP の応答があったときだけ入る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadFailure {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
}

impl ReadFailure {
    fn new(status: Option<u16>, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// 引数（サーバー URL・開発用ユーザー名）が使えない。通信は始めていない。
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(None, "invalid_request", message)
    }
}

impl fmt::Display for ReadFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} ({}): {}",
            self.code,
            self.status.unwrap_or(0),
            self.message
        )
    }
}

impl From<ClientError> for ReadFailure {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::InvalidDevUser => {
                Self::invalid_request("開発用のユーザー名が HTTP ヘッダーに使えません")
            }
            ClientError::Request(err) => transport_failure(&err, None),
            ClientError::Http {
                status,
                code,
                message,
            } => Self::new(Some(status.as_u16()), &code, message),
        }
    }
}

fn transport_failure(err: &reqwest::Error, status: Option<u16>) -> ReadFailure {
    if err.is_timeout() {
        ReadFailure::new(status, "timeout", "応答がありませんでした")
    } else {
        ReadFailure::new(status, "network", "ネットワークエラー")
    }
}

#[derive(Deserialize)]
struct ApiErrorBody {
    code: String,
    message: String,
}

/// 非 2xx の応答を、契約どおりの失敗にする。
fn http_failure(status: reqwest::StatusCode, body: &[u8]) -> ReadFailure {
    match serde_json::from_slice::<ApiErrorBody>(body) {
        Ok(error) => ReadFailure::new(Some(status.as_u16()), &error.code, error.message),
        Err(_) => ReadFailure::new(
            Some(status.as_u16()),
            &format!("http_{}", status.as_u16()),
            status.canonical_reason().unwrap_or("HTTP error"),
        ),
    }
}

/// パスの 1 区切り分を `encodeURIComponent` と同じ規則でエンコードする。
/// 非予約文字は `A-Za-z0-9 - _ . ! ~ * ' ( )` だけ残し、それ以外（UTF-8 の各バイトを含む）は `%XX` にする。
pub fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(char::from(byte)),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 値のあるものだけを、`key=value` の列（`application/x-www-form-urlencoded`）にする。
fn query_string(pairs: &[(&str, Option<String>)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            serializer.append_pair(key, value);
        }
    }
    serializer.finish()
}

fn with_query(path: &str, query: String) -> String {
    if query.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{query}")
    }
}

/// `GET /api/messages?…`（順序は `thread_id`, `before`, `limit`）。
pub fn messages_path(query: &MessagesQuery) -> String {
    with_query(
        "/api/messages",
        query_string(&[
            ("thread_id", query.thread_id.clone()),
            ("before", query.before.clone()),
            ("limit", query.limit.map(|v| v.to_string())),
        ]),
    )
}

/// `GET /api/messages/search?…`（順序は `q`, `before`, `limit`）。
pub fn search_path(query: &MessageSearchQuery) -> String {
    with_query(
        "/api/messages/search",
        query_string(&[
            ("q", query.q.clone()),
            ("before", query.before.clone()),
            ("limit", query.limit.map(|v| v.to_string())),
        ]),
    )
}

/// `GET /api/threads/{id}`。
pub fn thread_path(id: &str) -> String {
    format!("/api/threads/{}", encode_path_segment(id))
}

/// `GET /api/sessions/{id}`。
pub fn session_path(id: &str) -> String {
    format!("/api/sessions/{}", encode_path_segment(id))
}

impl RestClient {
    /// 任意の GET の JSON を、そのまま値として返す。読取専用（呼び出し側が固定のパスを渡す）。
    /// パスは `messages_path` などの関数で作る。
    pub async fn get_value(&self, path: &str) -> Result<Value, ReadFailure> {
        let response = self
            .get_request(path)
            .send()
            .await
            .map_err(|err| transport_failure(&err, None))?;
        let status = response.status();
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(err) => return Err(transport_failure(&err, Some(status.as_u16()))),
        };
        if !status.is_success() {
            return Err(http_failure(status, &body));
        }
        serde_json::from_slice::<Value>(&body).map_err(|_| {
            ReadFailure::new(
                Some(status.as_u16()),
                "bad_response",
                "サーバーの応答を読めませんでした",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ServerUrl;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// 1 回だけ応答するサーバー。受け取ったリクエストの 1 行目を返す。
    async fn one_shot(
        status: &'static str,
        body: &'static str,
    ) -> (RestClient, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).into_owned();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request.lines().next().unwrap_or_default().to_owned()
        });
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            Some("alice"),
        )
        .unwrap();
        (client, task)
    }

    #[test]
    fn path_segments_follow_encode_uri_component() {
        assert_eq!(encode_path_segment("01HZ-a_b.c!~*'()"), "01HZ-a_b.c!~*'()");
        assert_eq!(
            encode_path_segment("a/b?c#d&e=f+g"),
            "a%2Fb%3Fc%23d%26e%3Df%2Bg"
        );
        assert_eq!(encode_path_segment("a b%"), "a%20b%25");
        assert_eq!(encode_path_segment("日"), "%E6%97%A5");
    }

    #[test]
    fn messages_query_omits_empty_values_and_keeps_order() {
        assert_eq!(messages_path(&MessagesQuery::default()), "/api/messages");
        let path = messages_path(&MessagesQuery {
            thread_id: Some(String::new()),
            before: Some("id+2".into()),
            limit: Some(25),
        });
        assert_eq!(path, "/api/messages?before=id%2B2&limit=25");
        let path = messages_path(&MessagesQuery {
            thread_id: Some("t 1".into()),
            before: None,
            limit: Some(0),
        });
        assert_eq!(path, "/api/messages?thread_id=t+1&limit=0");
    }

    #[test]
    fn search_query_uses_q_before_limit() {
        assert_eq!(
            search_path(&MessageSearchQuery::default()),
            "/api/messages/search"
        );
        let path = search_path(&MessageSearchQuery {
            q: Some("a b&c".into()),
            before: None,
            limit: Some(5),
        });
        assert_eq!(path, "/api/messages/search?q=a+b%26c&limit=5");
    }

    #[test]
    fn id_paths_are_encoded() {
        assert_eq!(thread_path("a/../b?x"), "/api/threads/a%2F..%2Fb%3Fx");
        assert_eq!(session_path("s 1"), "/api/sessions/s%201");
    }

    #[tokio::test]
    async fn success_returns_the_json_value_unchanged() {
        let body = r#"{"unknown_field":{"nested":[1,null]},"id":"u1"}"#;
        let (client, server) = one_shot("200 OK", body).await;
        let value = client.get_value("/api/me").await.unwrap();
        assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
        let request = server.await.unwrap();
        assert_eq!(request, "GET /api/me HTTP/1.1");
    }

    #[tokio::test]
    async fn api_error_keeps_status_code_and_message() {
        let (client, server) = one_shot(
            "404 Not Found",
            r#"{"code":"not_found","message":"スレッドが見つかりません"}"#,
        )
        .await;
        let failure = client.get_value("/api/threads/x").await.unwrap_err();
        server.await.unwrap();
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({"status": 404, "code": "not_found", "message": "スレッドが見つかりません"})
        );
    }

    #[tokio::test]
    async fn non_json_error_uses_http_code_and_reason_phrase() {
        let (client, server) = one_shot("502 Bad Gateway", "not json").await;
        let failure = client.get_value("/api/me").await.unwrap_err();
        server.await.unwrap();
        assert_eq!(failure.status, Some(502));
        assert_eq!(failure.code, "http_502");
        assert_eq!(failure.message, "Bad Gateway");
    }

    #[tokio::test]
    async fn redirect_is_an_error_not_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            None,
        )
        .unwrap();
        let failure = client.get_value("/api/me").await.unwrap_err();
        task.await.unwrap();
        assert_eq!(failure.status, Some(302));
        assert_eq!(failure.code, "http_302");
    }

    #[tokio::test]
    async fn success_with_invalid_json_is_bad_response_with_status() {
        let (client, server) = one_shot("200 OK", "{").await;
        let failure = client.get_value("/api/me").await.unwrap_err();
        server.await.unwrap();
        assert_eq!(failure.status, Some(200));
        assert_eq!(failure.code, "bad_response");
    }

    #[tokio::test]
    async fn connection_refused_is_network_without_status() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            None,
        )
        .unwrap();
        let failure = client.get_value("/api/me").await.unwrap_err();
        assert_eq!(failure.status, None);
        assert_eq!(failure.code, "network");
        assert_eq!(failure.message, "ネットワークエラー");
    }

    #[test]
    fn failure_json_omits_missing_status() {
        assert_eq!(
            serde_json::to_value(ReadFailure::invalid_request("m")).unwrap(),
            serde_json::json!({"code": "invalid_request", "message": "m"})
        );
    }

    #[test]
    fn dev_user_problem_maps_to_invalid_request() {
        let failure = ReadFailure::from(ClientError::InvalidDevUser);
        assert_eq!(failure.code, "invalid_request");
        assert_eq!(failure.status, None);
    }
}
