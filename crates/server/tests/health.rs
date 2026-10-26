//! 診断用 `GET /api/health`（認証なし。版・稼働秒数・DB の応答・接続数だけ）。

mod common;

use common::TestServer;

#[tokio::test]
async fn health_is_public_and_reports_only_diagnostics() {
    let s = TestServer::start().await;
    // 認証のヘッダーなしで答える（障害の切り分けのため、認証より前に見られる必要がある）
    let res = s.http.get(s.url("/api/health")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(body["ok"], true);
    assert_eq!(body["version"], env!("CARGO_PKG_VERSION"));
    assert!(body["uptime_secs"].as_u64().is_some());
    assert_eq!(body["db"]["ok"], true);
    assert!(body["db"]["ms"].as_u64().is_some());
    assert_eq!(body["ws_connections"], 0);
    // 個人情報（利用者・接続元）は含めない
    let text = body.to_string();
    assert!(!text.contains("dev@local"), "{text}");
    assert!(!text.contains("login"), "{text}");
}

#[tokio::test]
async fn health_counts_open_websockets() {
    let s = TestServer::start().await;
    let ws = s.ws("alice@local").await;
    let body: serde_json::Value = s
        .http
        .get(s.url("/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["ws_connections"], 1);
    drop(ws);
}

#[tokio::test]
async fn unknown_api_paths_are_still_not_found() {
    let s = TestServer::start().await;
    let res = s.http.get(s.url("/api/nope")).send().await.unwrap();
    assert_eq!(res.status(), 404);
}
