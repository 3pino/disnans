use std::{fmt, time::Duration};

use disnans_shared::{Message, User};
use reqwest::{Client, StatusCode, header::HeaderValue};
use serde::Deserialize;
use url::form_urlencoded;

use crate::ServerUrl;

#[derive(Debug, Clone, Default)]
pub struct MessagesQuery {
    pub thread_id: Option<String>,
    pub before: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Debug)]
pub enum ClientError {
    Request(reqwest::Error),
    Http {
        status: StatusCode,
        code: String,
        message: String,
    },
    InvalidDevUser,
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Request(e) => write!(f, "network request failed: {e}"),
            Self::Http {
                status,
                code,
                message,
            } => write!(f, "HTTP {status} ({code}): {message}"),
            Self::InvalidDevUser => {
                f.write_str("development user is not a valid HTTP header value")
            }
        }
    }
}
impl std::error::Error for ClientError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Request(e) => Some(e),
            _ => None,
        }
    }
}

#[derive(Deserialize)]
struct ApiErrorBody {
    code: String,
    message: String,
}

/// The development identity is sent as an HTTP header, so it must be non-blank visible ASCII
/// (the server reads it with `HeaderValue::to_str`, which rejects anything else).
pub(crate) fn is_valid_dev_user(value: &str) -> bool {
    !value.trim().is_empty() && value.bytes().all(|b| (0x20..=0x7e).contains(&b))
}

pub struct RestClient {
    server: ServerUrl,
    client: Client,
    dev_user: Option<HeaderValue>,
}

impl RestClient {
    pub fn new(server: ServerUrl, dev_user: Option<&str>) -> Result<Self, ClientError> {
        let dev_user = dev_user
            .map(|value| {
                if !is_valid_dev_user(value) {
                    return Err(ClientError::InvalidDevUser);
                }
                HeaderValue::from_str(value).map_err(|_| ClientError::InvalidDevUser)
            })
            .transpose()?;
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(ClientError::Request)?;
        Ok(Self {
            server,
            client,
            dev_user,
        })
    }

    pub fn server(&self) -> &ServerUrl {
        &self.server
    }

    pub async fn me(&self) -> Result<User, ClientError> {
        self.get_json("/api/me").await
    }

    pub async fn users(&self) -> Result<Vec<User>, ClientError> {
        self.get_json("/api/users").await
    }

    /// The signed-in user's preferences (`GET /api/me/prefs`). A JSON object, or `{}` if unset.
    pub async fn prefs(&self) -> Result<serde_json::Value, ClientError> {
        self.get_json("/api/me/prefs").await
    }

    pub async fn messages(&self, query: &MessagesQuery) -> Result<Vec<Message>, ClientError> {
        let mut serializer = form_urlencoded::Serializer::new(String::new());
        if let Some(value) = &query.thread_id {
            serializer.append_pair("thread_id", value);
        }
        if let Some(value) = &query.before {
            serializer.append_pair("before", value);
        }
        if let Some(value) = query.limit {
            serializer.append_pair("limit", &value.to_string());
        }
        let query = serializer.finish();
        let path = if query.is_empty() {
            "/api/messages".to_owned()
        } else {
            format!("/api/messages?{query}")
        };
        self.get_json(&path).await
    }

    /// 開発用ヘッダー（X-Dev-User）を付けた GET の準備。`rest_api` の読み取りでも使う（status と本文を自分で扱うため）。
    pub(crate) fn get_request(&self, path: &str) -> reqwest::RequestBuilder {
        let mut request = self.client.get(self.server.http_url(path));
        if let Some(user) = &self.dev_user {
            request = request.header("X-Dev-User", user);
        }
        request
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T, ClientError> {
        let request = self.get_request(path);
        let response = request.send().await.map_err(ClientError::Request)?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.json::<ApiErrorBody>().await;
            return match body {
                Ok(error) => Err(ClientError::Http {
                    status,
                    code: error.code,
                    message: error.message,
                }),
                Err(_) => Err(ClientError::Http {
                    status,
                    code: format!("http_{}", status.as_u16()),
                    message: status.canonical_reason().unwrap_or("HTTP error").to_owned(),
                }),
            };
        }
        response.json().await.map_err(ClientError::Request)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    async fn mock_response(
        status: &str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        mock_response_with_headers(status, body, "").await
    }

    async fn mock_response_with_headers(
        status: &str,
        body: &'static str,
        headers: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let status = status.to_owned();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).into_owned();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request
        });
        (format!("http://{address}"), task)
    }

    #[tokio::test]
    async fn requests_me_and_sends_dev_identity_header() {
        let (base, server) = mock_response(
            "200 OK",
            r#"{"id":"id1","login_name":"dev@local","display_name":"Dev","avatar_url":null,"created_at":1}"#,
        ).await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), Some("dev@local")).unwrap();
        let user = client.me().await.unwrap();
        assert_eq!(user.login_name, "dev@local");
        let request = server.await.unwrap();
        assert!(request.starts_with("GET /api/me HTTP/1.1"));
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-dev-user: dev@local")
        );
    }

    #[tokio::test]
    async fn users_fetches_shared_user_list() {
        let (base, server) = mock_response("200 OK", "[]").await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), None).unwrap();
        assert!(client.users().await.unwrap().is_empty());
        assert!(server.await.unwrap().starts_with("GET /api/users HTTP/1.1"));
    }

    #[tokio::test]
    async fn messages_encodes_query_and_preserves_api_error() {
        let (base, server) = mock_response(
            "400 Bad Request",
            r#"{"code":"bad_query","message":"bad query"}"#,
        )
        .await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), None).unwrap();
        let error = client
            .messages(&MessagesQuery {
                thread_id: Some("thread/1".into()),
                before: Some("id+2".into()),
                limit: Some(25),
            })
            .await
            .unwrap_err();
        let request = server.await.unwrap();
        assert!(
            request.starts_with(
                "GET /api/messages?thread_id=thread%2F1&before=id%2B2&limit=25 HTTP/1.1"
            )
        );
        assert!(
            matches!(error, ClientError::Http { code, message, .. } if code == "bad_query" && message == "bad query")
        );
    }

    #[tokio::test]
    async fn non_json_http_error_is_preserved_without_panicking() {
        let (base, server) = mock_response("502 Bad Gateway", "not json").await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), None).unwrap();
        let error = client.me().await.unwrap_err();
        server.await.unwrap();
        assert!(
            matches!(error, ClientError::Http { status, code, .. } if status.as_u16() == 502 && code == "http_502")
        );
    }

    #[tokio::test]
    async fn redirect_is_not_followed_with_development_header() {
        let (base, server) = mock_response_with_headers(
            "302 Found",
            "{}",
            "Location: http://example.invalid/redirect\r\n",
        )
        .await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), Some("dev@local")).unwrap();
        let error = client.me().await.unwrap_err();
        let request = server.await.unwrap();
        assert!(
            request
                .to_ascii_lowercase()
                .contains("x-dev-user: dev@local")
        );
        assert!(matches!(error, ClientError::Http { status, .. } if status.as_u16() == 302));
    }

    #[tokio::test]
    async fn invalid_json_http_error_uses_fallback_error() {
        let (base, server) = mock_response("500 Internal Server Error", "{").await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), None).unwrap();
        let error = client.me().await.unwrap_err();
        server.await.unwrap();
        assert!(matches!(error, ClientError::Http { code, .. } if code == "http_500"));
    }

    #[test]
    fn rejects_empty_or_invalid_development_identity() {
        let url = ServerUrl::parse("localhost:8080").unwrap();
        assert!(matches!(
            RestClient::new(url.clone(), Some("  ")),
            Err(ClientError::InvalidDevUser)
        ));
        assert!(matches!(
            RestClient::new(url.clone(), Some("x\r\ny")),
            Err(ClientError::InvalidDevUser)
        ));
        assert!(matches!(
            RestClient::new(url, Some("アリス")),
            Err(ClientError::InvalidDevUser)
        ));
    }

    #[tokio::test]
    async fn prefs_fetches_the_preference_object() {
        let (base, server) = mock_response("200 OK", r#"{"enter_sends":true}"#).await;
        let client = RestClient::new(ServerUrl::parse(&base).unwrap(), None).unwrap();
        let prefs = client.prefs().await.unwrap();
        assert_eq!(prefs["enter_sends"], serde_json::Value::Bool(true));
        assert!(
            server
                .await
                .unwrap()
                .starts_with("GET /api/me/prefs HTTP/1.1")
        );
    }
}
