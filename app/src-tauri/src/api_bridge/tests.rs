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
async fn device_prefs_read_returns_normalized_prefs_and_reports_missing_as_unsaved() {
    let body = r#"{"prefs":{"inputId":"mic-1","orientation":"sideways","keep":1},"updated_at":7}"#;
    let (server, task) = one_shot("200 OK", body).await;
    let view = device_prefs_read(&IdArgs {
        server,
        dev_user: Some("alice".into()),
        id: "01J8".into(),
    })
    .await
    .unwrap();
    assert!(view.saved);
    assert_eq!(view.updated_at, Some(7));
    assert_eq!(view.prefs["inputId"], "mic-1");
    assert_eq!(
        view.prefs["orientation"], "auto",
        "invalid value -> default"
    );
    assert_eq!(view.prefs["keep"], 1, "unknown key kept");
    assert_eq!(
        task.await.unwrap(),
        "GET /api/me/devices/01J8/prefs HTTP/1.1"
    );

    let (server, _task) = one_shot(
        "404 Not Found",
        r#"{"code":"not_found","message":"設定がありません"}"#,
    )
    .await;
    let view = device_prefs_read(&IdArgs {
        server,
        dev_user: Some("alice".into()),
        id: "01J8".into(),
    })
    .await
    .unwrap();
    assert!(!view.saved);
    assert_eq!(view.updated_at, None);
    assert_eq!(
        view.prefs,
        disnans_client_core::view::settings::device_defaults()
    );
}

#[tokio::test]
async fn device_prefs_write_normalizes_before_sending() {
    let (server, task) = one_shot(
        "200 OK",
        r#"{"prefs":{"hideNavigationBar":true},"updated_at":9}"#,
    )
    .await;
    let view = device_prefs_write(&IdBodyArgs {
        server,
        dev_user: Some("alice".into()),
        id: "01J8".into(),
        body: serde_json::json!({"hideNavigationBar": "yes", "deviceKind": "tablet"}),
    })
    .await
    .unwrap();
    assert!(view.saved);
    assert_eq!(view.updated_at, Some(9));
    assert_eq!(
        task.await.unwrap(),
        "PUT /api/me/devices/01J8/prefs HTTP/1.1"
    );
}

#[tokio::test]
async fn device_list_returns_the_server_list_and_sends_only_a_get() {
    let body =
        r#"[{"device_id":"01J8","name":"自宅","created_at":1,"last_seen_at":2,"has_prefs":true}]"#;
    let (server, task) = one_shot("200 OK", body).await;
    let value = device_list(&base(&server)).await.unwrap();
    assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
    assert_eq!(task.await.unwrap(), "GET /api/me/devices HTTP/1.1");
}

#[tokio::test]
async fn device_delete_sends_delete_and_treats_204_as_success() {
    let (server, task) = one_shot("204 No Content", "").await;
    let value = device_delete(&IdArgs {
        server,
        dev_user: Some("alice".into()),
        id: "01J8".into(),
    })
    .await
    .unwrap();
    assert_eq!(value, Value::Null);
    assert_eq!(task.await.unwrap(), "DELETE /api/me/devices/01J8 HTTP/1.1");
}

#[tokio::test]
async fn device_delete_reports_a_missing_device_as_not_found() {
    let (server, task) = one_shot(
        "404 Not Found",
        r#"{"code":"not_found","message":"デバイスがありません"}"#,
    )
    .await;
    let failure = device_delete(&IdArgs {
        server,
        dev_user: Some("alice".into()),
        id: "01J8".into(),
    })
    .await
    .unwrap_err();
    assert_eq!(failure.status, Some(404));
    assert_eq!(task.await.unwrap(), "DELETE /api/me/devices/01J8 HTTP/1.1");
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
        r#"{"code":"not_found","message":"見つかりません"}"#,
    )
    .await;
    let failure = read_session(&IdArgs {
        server: server.clone(),
        dev_user: None,
        id: "s/1".into(),
    })
    .await
    .unwrap_err();
    assert_eq!(task.await.unwrap(), "GET /api/sessions/s%2F1 HTTP/1.1");
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        serde_json::json!({"status": 404, "code": "not_found", "message": "見つかりません"})
    );
}

#[test]
fn history_and_search_results_carry_the_markdown_tree() {
    let messages = serde_json::json!([{"id": "m1", "body": "**a**"}, {"id": "m2", "body": "b"}]);
    let out = with_markdown(messages);
    assert_eq!(
        out[0]["markdown"],
        disnans_client_core::view::markdown::blocks_value("**a**")
    );
    assert_eq!(out[1]["markdown"][0]["type"], "paragraph");
    assert_eq!(out[1]["body"], "b");
}

#[test]
fn prefs_response_keeps_the_raw_object_and_adds_the_normalized_view() {
    let raw = serde_json::json!({"theme": "dark", "futureKey": 1});
    let out = prefs_response(raw.clone());
    assert_eq!(out["raw"], raw, "raw is the server object as it was");
    assert_eq!(out["view"]["theme"], "dark");
    assert_eq!(out["view"]["futureKey"], 1, "unknown keys stay in the view");
    assert_eq!(
        out["view"]["limitDb"], -6.0,
        "missing keys get the defaults"
    );
    assert!(out["raw"].get("limitDb").is_none(), "raw gets no defaults");
}

#[test]
fn markdown_tree_command_returns_the_core_tree() {
    let out = api_markdown_tree("a **b** <@u1>".to_owned());
    assert_eq!(
        out,
        disnans_client_core::view::markdown::blocks_value("a **b** <@u1>")
    );
    assert_eq!(api_markdown_tree(String::new()), serde_json::json!([]));
}

#[tokio::test]
async fn missing_optional_query_fields_are_not_sent() {
    let (server, task) = one_shot("200 OK", "[]").await;
    read_messages(&MessagesArgs {
        server,
        dev_user: None,
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
    assert!(serde_json::from_str::<MessagesArgs>(r#"{"server":"http://a","path":"/x"}"#).is_err());
    assert!(serde_json::from_str::<SearchArgs>(r#"{"server":"http://a","x":1}"#).is_err());
    assert!(serde_json::from_str::<IdArgs>(r#"{"server":"http://a"}"#).is_err());
}

fn encoded_args(json: &str) -> tauri::http::HeaderMap {
    let mut headers = tauri::http::HeaderMap::new();
    let value: String = json
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    headers.insert(ARGS_HEADER, value.parse().unwrap());
    headers
}

#[test]
fn percent_decode_restores_utf8_and_keeps_plus() {
    assert_eq!(percent_decode("%E6%97%A5+x%20y").as_deref(), Some("日+x y"));
    assert_eq!(percent_decode("%ZZ"), None);
    assert_eq!(percent_decode("%4"), None);
}

#[test]
fn header_args_accept_encoded_japanese_and_reject_unknown_fields() {
    let headers =
        encoded_args(r#"{"server":"http://a","devUser":null,"fileName":"写真 1.png","mime":null}"#);
    let args: AvatarArgs = decode_header_args(&headers).unwrap();
    assert_eq!(args.file_name, "写真 1.png");
    assert!(args.mime.is_none());

    let headers = encoded_args(r#"{"server":"http://a","fileName":"x","extra":1}"#);
    let failure = decode_header_args::<AvatarArgs>(&headers).unwrap_err();
    assert_eq!(failure.code, "invalid_request");

    let failure = decode_header_args::<AvatarArgs>(&tauri::http::HeaderMap::new()).unwrap_err();
    assert_eq!(failure.code, "invalid_request");
}

#[tokio::test]
async fn json_write_uses_patch_and_encodes_the_plugin_id() {
    let (server, task) = one_shot("200 OK", r#"{"id":"u1"}"#).await;
    let value = update_me(&BodyArgs {
        server,
        dev_user: Some("alice".into()),
        body: serde_json::json!({"display_name": "A"}),
    })
    .await
    .unwrap();
    assert_eq!(value["id"], "u1");
    assert_eq!(task.await.unwrap(), "PATCH /api/me HTTP/1.1");

    let (server, task) = one_shot("204 No Content", "").await;
    let value = delete_plugin(&IdArgs {
        server,
        dev_user: None,
        id: "a/b".into(),
    })
    .await
    .unwrap();
    assert_eq!(value, Value::Null);
    assert_eq!(task.await.unwrap(), "DELETE /api/plugins/a%2Fb HTTP/1.1");
}

#[tokio::test]
async fn plugin_parts_must_add_up_to_the_body_before_any_request() {
    let args = CreatePluginArgs {
        server: "http://127.0.0.1:9".into(),
        dev_user: None,
        visibility: "public".into(),
        parts: vec![PluginPartArgs {
            name: "manifest.json".into(),
            size: 3,
        }],
    };
    let failure = create_plugin(&args, b"abcd").await.unwrap_err();
    assert_eq!(failure.code, "invalid_request");

    let args = CreatePluginArgs {
        visibility: "everyone".into(),
        ..args
    };
    let failure = create_plugin(&args, b"abc").await.unwrap_err();
    assert_eq!(failure.code, "invalid_request");

    let args = CreatePluginArgs {
        visibility: "public".into(),
        parts: vec![PluginPartArgs {
            name: "../x".into(),
            size: 3,
        }],
        ..args
    };
    let failure = create_plugin(&args, b"abc").await.unwrap_err();
    assert_eq!(failure.code, "invalid_request");
}

#[tokio::test]
async fn avatar_is_sent_as_one_multipart_file_part() {
    let (server, task) = one_shot("200 OK", r#"{"id":"u1"}"#).await;
    let args = AvatarArgs {
        server,
        dev_user: None,
        file_name: "avatar.webp".into(),
        mime: Some("image/webp".into()),
    };
    set_avatar(&args, b"WEBP").await.unwrap();
    assert_eq!(task.await.unwrap(), "PUT /api/me/avatar HTTP/1.1");
}

fn upload_args(server: &str, upload_id: &str) -> UploadArgs {
    UploadArgs {
        server: server.to_owned(),
        dev_user: None,
        upload_id: upload_id.to_owned(),
        file_name: "a.txt".into(),
        mime: None,
        on_progress: "__CHANNEL__:1".into(),
    }
}

fn no_progress() -> Arc<dyn Fn(u64, u64) + Send + Sync> {
    Arc::new(|_, _| {})
}

#[test]
fn upload_registry_rejects_duplicates_and_releases_on_finish() {
    let registry = UploadRegistry::default();
    let _first = registry.start("u1").unwrap();
    assert_eq!(registry.start("u1").unwrap_err().code, "invalid_request");
    registry.finish("u1");
    assert!(registry.start("u1").is_ok());
}

#[test]
fn abort_before_start_cancels_the_next_start_of_that_id() {
    let registry = UploadRegistry::default();
    registry.abort("early");
    assert_eq!(registry.start("early").unwrap_err().code, "aborted");
    // 一度だけ効く。次は普通に始まる
    assert!(registry.start("early").is_ok());
}

#[tokio::test]
async fn upload_sends_the_bytes_and_returns_the_attachment() {
    let (server, task) = one_shot("200 OK", r#"{"id":"f1","file_name":"a.txt"}"#).await;
    let registry = UploadRegistry::default();
    let value = upload_file_raw(
        &upload_args(&server, "u-ok"),
        Arc::new(b"hello".to_vec()),
        no_progress(),
        &registry,
    )
    .await
    .unwrap();
    assert_eq!(value["id"], "f1");
    assert_eq!(task.await.unwrap(), "POST /api/files HTTP/1.1");
    // 終わったので同じ ID を再び使える
    assert!(registry.start("u-ok").is_ok());
}

#[tokio::test]
async fn abort_before_start_fails_without_any_request() {
    // 接続先に誰もいない。中止されていれば接続しに行かない（network にならない）
    let registry = UploadRegistry::default();
    registry.abort("u-early");
    let failure = upload_file_raw(
        &upload_args("http://127.0.0.1:9", "u-early"),
        Arc::new(vec![1, 2, 3]),
        no_progress(),
        &registry,
    )
    .await
    .unwrap_err();
    assert_eq!(failure.code, "aborted");
}

#[tokio::test]
async fn invalid_server_releases_nothing_and_registers_nothing() {
    let registry = UploadRegistry::default();
    let failure = upload_file_raw(
        &upload_args("ftp://example.invalid", "u-bad"),
        Arc::new(vec![1]),
        no_progress(),
        &registry,
    )
    .await
    .unwrap_err();
    assert_eq!(failure.code, "invalid_request");
    assert!(registry.start("u-bad").is_ok());
}

#[tokio::test]
async fn abort_during_upload_ends_it_and_frees_the_id() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    // 本体を読んで、応答せずに待つ
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0; 65536];
        loop {
            if socket.read(&mut buf).await.unwrap_or(0) == 0 {
                break;
            }
        }
    });
    let registry = std::sync::Arc::new(UploadRegistry::default());
    let task_registry = registry.clone();
    let task = tokio::spawn(async move {
        upload_file_raw(
            &upload_args(&format!("http://{address}"), "u-live"),
            Arc::new(vec![5u8; 4096]),
            no_progress(),
            &task_registry,
        )
        .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    registry.abort("u-live");
    let failure = tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("abort should end the upload")
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.code, "aborted");
    assert!(registry.start("u-live").is_ok());
}

#[test]
fn raw_body_takes_raw_bytes_as_they_are() {
    let body = InvokeBody::Raw(vec![0, 1, 255]);
    assert_eq!(&*raw_body(&body).unwrap(), &[0u8, 1, 255]);
}

#[test]
fn raw_body_takes_base64_json_on_android() {
    // Android の IPC は raw body を渡せず、base64 の文字列（JSON の値）で来る
    let body = InvokeBody::Json(Value::String("AAH/".into()));
    assert_eq!(&*raw_body(&body).unwrap(), &[0u8, 1, 255]);
    let empty = InvokeBody::Json(Value::String(String::new()));
    assert!(raw_body(&empty).unwrap().is_empty());
}

#[test]
fn raw_body_refuses_bad_base64_and_other_json() {
    let bad = InvokeBody::Json(Value::String("not base64!".into()));
    assert_eq!(raw_body(&bad).unwrap_err().code, "invalid_request");
    let array = InvokeBody::Json(serde_json::json!([1, 2, 3]));
    assert_eq!(raw_body(&array).unwrap_err().code, "invalid_request");
    let none = InvokeBody::Json(Value::Null);
    assert_eq!(raw_body(&none).unwrap_err().code, "invalid_request");
}
