//! GUI の読取 REST を Rust 側で行う IPC（段1）。契約は `.pi/step4-ipc-contract.md`。
//!
//! 任意のパスは受け取らない。コマンドごとに決まった GET だけを行い、書き込みはない。
//! 成功は JSON の値をそのまま返し（再シリアライズしない）、失敗は `{ status?, code, message }`。
//! 本体は Tauri に依存しない関数（`read_*`）にあり、テストはそちらを呼ぶ。

use disnans_client_core::{
    messages_path, search_path, session_path, thread_path, MessageSearchQuery, MessagesQuery,
    ReadFailure, RestClient, ServerUrl,
};
use serde::Deserialize;
use serde_json::Value;

/// 全コマンドに共通の接続先。`server` は GUI の正規化済み URL、`dev_user` は開発用ユーザー（省略可）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Base {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagesArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub id: String,
}

/// `server` と `devUser` から読取クライアントを作る。通信はまだしない。
fn client(server: &str, dev_user: Option<&str>) -> Result<RestClient, ReadFailure> {
    let url = ServerUrl::parse(server)
        .map_err(|_| ReadFailure::invalid_request("サーバー URL が不正です"))?;
    RestClient::new(url, dev_user).map_err(ReadFailure::from)
}

async fn read(server: &str, dev_user: Option<&str>, path: &str) -> Result<Value, ReadFailure> {
    client(server, dev_user)?.get_value(path).await
}

pub async fn read_me(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/me").await
}

pub async fn read_users(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/users").await
}

pub async fn read_prefs(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/me/prefs").await
}

pub async fn read_messages(args: &MessagesArgs) -> Result<Value, ReadFailure> {
    let path = messages_path(&MessagesQuery {
        thread_id: args.thread_id.clone(),
        before: args.before.clone(),
        limit: args.limit,
    });
    read(&args.server, args.dev_user.as_deref(), &path).await
}

pub async fn read_search_messages(args: &SearchArgs) -> Result<Value, ReadFailure> {
    let path = search_path(&MessageSearchQuery {
        q: args.q.clone(),
        before: args.before.clone(),
        limit: args.limit,
    });
    read(&args.server, args.dev_user.as_deref(), &path).await
}

pub async fn read_threads(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/threads").await
}

pub async fn read_thread(args: &IdArgs) -> Result<Value, ReadFailure> {
    read(
        &args.server,
        args.dev_user.as_deref(),
        &thread_path(&args.id),
    )
    .await
}

pub async fn read_thread_tags(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/thread-tags").await
}

pub async fn read_read_markers(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/me/read").await
}

pub async fn read_plugins(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/plugins").await
}

pub async fn read_session(args: &IdArgs) -> Result<Value, ReadFailure> {
    read(
        &args.server,
        args.dev_user.as_deref(),
        &session_path(&args.id),
    )
    .await
}

// ---- Tauri コマンド（引数は 1 つの `args` オブジェクト。薄いラッパー） ----

#[tauri::command]
pub async fn api_me(args: Base) -> Result<Value, ReadFailure> {
    read_me(&args).await
}

#[tauri::command]
pub async fn api_users(args: Base) -> Result<Value, ReadFailure> {
    read_users(&args).await
}

#[tauri::command]
pub async fn api_prefs(args: Base) -> Result<Value, ReadFailure> {
    read_prefs(&args).await
}

#[tauri::command]
pub async fn api_messages(args: MessagesArgs) -> Result<Value, ReadFailure> {
    read_messages(&args).await
}

#[tauri::command]
pub async fn api_search_messages(args: SearchArgs) -> Result<Value, ReadFailure> {
    read_search_messages(&args).await
}

#[tauri::command]
pub async fn api_threads(args: Base) -> Result<Value, ReadFailure> {
    read_threads(&args).await
}

#[tauri::command]
pub async fn api_thread(args: IdArgs) -> Result<Value, ReadFailure> {
    read_thread(&args).await
}

#[tauri::command]
pub async fn api_thread_tags(args: Base) -> Result<Value, ReadFailure> {
    read_thread_tags(&args).await
}

#[tauri::command]
pub async fn api_read_markers(args: Base) -> Result<Value, ReadFailure> {
    read_read_markers(&args).await
}

#[tauri::command]
pub async fn api_plugins(args: Base) -> Result<Value, ReadFailure> {
    read_plugins(&args).await
}

#[tauri::command]
pub async fn api_session(args: IdArgs) -> Result<Value, ReadFailure> {
    read_session(&args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// 1 回だけ応答する接続先。受け取った 1 行目を返す。
    async fn one_shot(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
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
        (format!("http://{address}"), task)
    }

    fn base(server: &str) -> Base {
        Base {
            server: server.to_owned(),
            dev_user: Some("alice".into()),
        }
    }

    #[tokio::test]
    async fn success_returns_the_server_json_value() {
        let body = r#"[{"id":"u1","login_name":"alice","extra":{"x":null}}]"#;
        let (server, task) = one_shot("200 OK", body).await;
        let value = read_users(&base(&server)).await.unwrap();
        assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
        assert_eq!(task.await.unwrap(), "GET /api/users HTTP/1.1");
    }

    #[tokio::test]
    async fn api_error_is_returned_with_status_code_and_message() {
        let (server, task) = one_shot(
            "404 Not Found",
            r#"{"code":"not_found","message":"スレッドが見つかりません"}"#,
        )
        .await;
        let failure = read_thread(&IdArgs {
            server: server.clone(),
            dev_user: None,
            id: "t/1".into(),
        })
        .await
        .unwrap_err();
        assert_eq!(task.await.unwrap(), "GET /api/threads/t%2F1 HTTP/1.1");
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({"status": 404, "code": "not_found", "message": "スレッドが見つかりません"})
        );
    }

    #[tokio::test]
    async fn optional_thread_id_null_is_not_sent() {
        let (server, task) = one_shot("200 OK", "[]").await;
        read_messages(&MessagesArgs {
            server,
            dev_user: None,
            thread_id: None,
            before: None,
            limit: Some(3),
        })
        .await
        .unwrap();
        assert_eq!(task.await.unwrap(), "GET /api/messages?limit=3 HTTP/1.1");
    }

    #[tokio::test]
    async fn invalid_server_and_dev_user_fail_before_any_request() {
        let failure = read_me(&Base {
            server: "ftp://example.invalid".into(),
            dev_user: None,
        })
        .await
        .unwrap_err();
        assert_eq!(failure.code, "invalid_request");
        assert_eq!(failure.status, None);

        let failure = read_me(&Base {
            server: "http://127.0.0.1:9".into(),
            dev_user: Some("x\r\ny".into()),
        })
        .await
        .unwrap_err();
        assert_eq!(failure.code, "invalid_request");
        assert_eq!(failure.status, None);
    }

    #[test]
    fn args_reject_unknown_fields_and_accept_null_dev_user() {
        let ok: Base = serde_json::from_str(r#"{"server":"http://a","devUser":null}"#).unwrap();
        assert!(ok.dev_user.is_none());
        assert!(serde_json::from_str::<Base>(r#"{"server":"http://a","path":"/x"}"#).is_err());
        assert!(
            serde_json::from_str::<MessagesArgs>(r#"{"server":"http://a","path":"/x"}"#).is_err()
        );
        assert!(serde_json::from_str::<SearchArgs>(r#"{"server":"http://a","x":1}"#).is_err());
        assert!(serde_json::from_str::<IdArgs>(r#"{"server":"http://a"}"#).is_err());
    }
}
