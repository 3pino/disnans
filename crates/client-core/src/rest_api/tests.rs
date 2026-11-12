
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

#[tokio::test]
async fn get_bytes_returns_the_body_and_enforces_the_limit() {
    let (client, task) = one_shot("200 OK", "abc").await;
    assert_eq!(
        client.get_bytes("/api/avatars/x", 10).await.unwrap(),
        b"abc"
    );
    assert_eq!(task.await.unwrap(), "GET /api/avatars/x HTTP/1.1");

    let (client, _task) = one_shot("200 OK", "abcdef").await;
    let error = client.get_bytes("/api/avatars/x", 5).await.unwrap_err();
    assert_eq!(error.code, "too_large");

    let (client, _task) = one_shot("404 Not Found", r#"{"code":"not_found","message":"no"}"#).await;
    let error = client
        .get_bytes("/api/files/x/thumb", 10)
        .await
        .unwrap_err();
    assert_eq!(
        (error.status, error.code.as_str()),
        (Some(404), "not_found")
    );
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
        before: Some("id+2".into()),
        limit: Some(25),
    });
    assert_eq!(path, "/api/messages?before=id%2B2&limit=25");
    let path = messages_path(&MessagesQuery {
        before: Some(String::new()),
        limit: Some(0),
    });
    assert_eq!(path, "/api/messages?limit=0");
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
        r#"{"code":"not_found","message":"見つかりません"}"#,
    )
    .await;
    let failure = client.get_value("/api/sessions/x").await.unwrap_err();
    server.await.unwrap();
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        serde_json::json!({"status": 404, "code": "not_found", "message": "見つかりません"})
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
