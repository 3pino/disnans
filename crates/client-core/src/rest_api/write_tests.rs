use super::*;
use crate::ServerUrl;
use futures_util::future::AbortHandle;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

/// 接続ごとの動作。
#[derive(Clone, Copy)]
enum Action {
    /// 本体まで読んで、この応答を返す（`keep_alive` なら接続を閉じない）。
    Reply {
        status: &'static str,
        body: &'static str,
        keep_alive: bool,
    },
    /// 本体まで読んで、応答せずに接続を閉じる（送信後の切断）。
    CutAfterRead,
    /// 本体まで読んで、応答せずに待つ（中止のテスト用）。
    Hang,
}

#[derive(Default)]
struct Seen {
    connections: usize,
    requests: Vec<String>,
    bodies: Vec<Vec<u8>>,
}

/// 1 接続につき 1 要求を読む。`actions` の順に動作する（尽きたら最後の動作を繰り返す）。
async fn scripted(actions: Vec<Action>) -> (RestClient, Arc<Mutex<Seen>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let seen_task = seen.clone();
    tokio::spawn(async move {
        let mut index = 0;
        loop {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            let action = actions[index.min(actions.len() - 1)];
            index += 1;
            seen_task.lock().unwrap().connections += 1;
            let seen = seen_task.clone();
            tokio::spawn(serve_one(socket, action, seen));
        }
    });
    let client = RestClient::new(
        ServerUrl::parse(&format!("http://{address}")).unwrap(),
        Some("alice"),
    )
    .unwrap();
    (client, seen)
}

async fn serve_one(mut socket: TcpStream, action: Action, seen: Arc<Mutex<Seen>>) {
    let (line, body) = read_request(&mut socket).await;
    {
        let mut seen = seen.lock().unwrap();
        seen.requests.push(line);
        seen.bodies.push(body);
    }
    match action {
        Action::Reply {
            status,
            body,
            keep_alive,
        } => {
            let connection = if keep_alive { "keep-alive" } else { "close" };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {connection}\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
            if keep_alive {
                // 応答のあと、サーバー側が接続を閉じる（次の要求は古い接続に乗ることになる）
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        Action::CutAfterRead => {
            // 何も返さず閉じる
        }
        Action::Hang => {
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    }
}

/// 要求の 1 行目と本体（Content-Length まで）を読む。
async fn read_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
    let mut buf = Vec::new();
    let head_end;
    loop {
        let mut chunk = [0u8; 4096];
        let read = socket.read(&mut chunk).await.unwrap();
        assert!(read > 0, "client closed before sending the head");
        buf.extend_from_slice(&chunk[..read]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            head_end = pos + 4;
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let length = head
        .lines()
        .find_map(|l| {
            let (name, value) = l.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while buf.len() < head_end + length {
        let mut chunk = [0u8; 4096];
        let read = socket.read(&mut chunk).await.unwrap();
        if read == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..read]);
    }
    let body = buf[head_end..].to_vec();
    (head.lines().next().unwrap_or_default().to_owned(), body)
}

#[tokio::test]
async fn json_write_sends_body_and_returns_the_value_unchanged() {
    let body = r#"{"id":"u1","extra":{"x":[null]}}"#;
    let (client, seen) = scripted(vec![Action::Reply {
        status: "200 OK",
        body,
        keep_alive: false,
    }])
    .await;
    let value = client
        .update_me(&serde_json::json!({"display_name": "Alice"}))
        .await
        .unwrap();
    assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
    let seen = seen.lock().unwrap();
    assert_eq!(seen.requests, vec!["PATCH /api/me HTTP/1.1"]);
    assert_eq!(seen.bodies[0], br#"{"display_name":"Alice"}"#);
}

#[tokio::test]
async fn device_calls_use_the_device_paths_and_bodies() {
    let (client, seen) = scripted(vec![Action::Reply {
        status: "200 OK",
        body: r#"{"prefs":{"inputId":"x"},"updated_at":5}"#,
        keep_alive: false,
    }])
    .await;
    client
        .put_device_prefs("01J8", &serde_json::json!({"inputId": "x"}))
        .await
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(
        seen.requests,
        vec!["PUT /api/me/devices/01J8/prefs HTTP/1.1"]
    );
    assert_eq!(seen.bodies[0], br#"{"prefs":{"inputId":"x"}}"#);
}

#[tokio::test]
async fn device_not_found_keeps_status_and_code() {
    let (client, _seen) = scripted(vec![Action::Reply {
        status: "404 Not Found",
        body: r#"{"code":"not_found","message":"設定がありません"}"#,
        keep_alive: false,
    }])
    .await;
    let err = client.get_device_prefs("01J8").await.unwrap_err();
    assert_eq!(err.status, Some(404));
    assert_eq!(err.code, "not_found");
}

#[tokio::test]
async fn empty_success_body_is_null() {
    let (client, _seen) = scripted(vec![Action::Reply {
        status: "204 No Content",
        body: "",
        keep_alive: false,
    }])
    .await;
    assert_eq!(client.delete_plugin("p1").await.unwrap(), Value::Null);
}

#[tokio::test]
async fn api_error_on_write_keeps_status_code_and_message() {
    let (client, _seen) = scripted(vec![Action::Reply {
        status: "409 Conflict",
        body: r#"{"code":"version_conflict","message":"版が違います"}"#,
        keep_alive: false,
    }])
    .await;
    let failure = client
        .update_session("s1", &serde_json::json!({"version": 1}))
        .await
        .unwrap_err();
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        serde_json::json!({"status": 409, "code": "version_conflict", "message": "版が違います"})
    );
}

#[tokio::test]
async fn cut_after_send_on_post_is_unknown_outcome_and_sent_once() {
    let (client, seen) = scripted(vec![Action::CutAfterRead]).await;
    let failure = client
        .plugin_post_message("p1", &serde_json::json!({"text": "hi"}))
        .await
        .unwrap_err();
    assert_eq!(failure.status, None);
    assert_eq!(failure.code, "unknown_outcome");
    // 送り直していないこと（接続も要求も 1 回だけ）
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = seen.lock().unwrap();
    assert_eq!(seen.connections, 1);
    assert_eq!(
        seen.requests,
        vec!["POST /api/plugins/p1/messages HTTP/1.1"]
    );
}

#[tokio::test]
async fn cut_after_send_on_put_is_network_and_sent_once() {
    let (client, seen) = scripted(vec![Action::CutAfterRead]).await;
    let failure = client
        .set_prefs(&serde_json::json!({"enter_sends": true}))
        .await
        .unwrap_err();
    assert_eq!(failure.status, None);
    assert_eq!(failure.code, "network");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(seen.lock().unwrap().connections, 1);
}

#[tokio::test]
async fn refused_connection_on_post_is_network_not_unknown() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let client = RestClient::new(
        ServerUrl::parse(&format!("http://{address}")).unwrap(),
        None,
    )
    .unwrap();
    let failure = client.sample_notification().await.unwrap_err();
    assert_eq!(failure.code, "network");
    assert_eq!(failure.status, None);
}

/// 再利用した接続が、応答のあとにサーバーから閉じられていても、次の書込は二重に送られない。
#[tokio::test]
async fn write_after_keep_alive_close_is_not_resent() {
    let (client, seen) = scripted(vec![
        Action::Reply {
            status: "200 OK",
            body: r#"{"ok":1}"#,
            keep_alive: true,
        },
        Action::CutAfterRead,
    ])
    .await;
    client
        .create_session(&serde_json::json!({"title": "a"}))
        .await
        .unwrap();
    let failure = client
        .create_session(&serde_json::json!({"title": "b"}))
        .await
        .unwrap_err();
    assert_eq!(failure.code, "unknown_outcome");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = seen.lock().unwrap();
    // 1 回目の要求と、2 回目の要求だけ。2 回目が再送されていれば 3 になる
    assert_eq!(seen.requests.len(), 2, "requests: {:?}", seen.requests);
    assert_eq!(seen.connections, 2);
}

#[tokio::test]
async fn avatar_sends_one_multipart_part_named_file() {
    let (client, seen) = scripted(vec![Action::Reply {
        status: "200 OK",
        body: r#"{"id":"u1"}"#,
        keep_alive: false,
    }])
    .await;
    client
        .set_avatar(b"\x89PNG-bytes", "me \"x\".png", "image/png")
        .await
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.requests, vec!["PUT /api/me/avatar HTTP/1.1"]);
    let body = String::from_utf8_lossy(&seen.bodies[0]).into_owned();
    assert!(
        body.contains(r#"name="file"; filename="me %22x%22.png""#),
        "{body}"
    );
    assert!(body.contains("Content-Type: image/png"));
    assert!(seen.bodies[0].windows(10).any(|w| w == b"\x89PNG-bytes"));
}

#[tokio::test]
async fn plugin_upload_puts_visibility_then_each_file() {
    let (client, seen) = scripted(vec![Action::Reply {
        status: "200 OK",
        body: r#"{"id":"p1"}"#,
        keep_alive: false,
    }])
    .await;
    let manifest = br#"{"name":"x"}"#;
    let main = b"body-js";
    let data = [manifest.as_slice(), main.as_slice()].concat();
    let split = manifest.len();
    client
        .create_plugin(
            "private",
            &data,
            &[
                ("manifest.json".to_owned(), 0..split),
                ("main.js".to_owned(), split..data.len()),
            ],
        )
        .await
        .unwrap();
    let seen = seen.lock().unwrap();
    assert_eq!(seen.requests, vec!["POST /api/plugins HTTP/1.1"]);
    let body = String::from_utf8_lossy(&seen.bodies[0]).into_owned();
    let visibility = body.find(r#"name="visibility""#).unwrap();
    let manifest = body.find(r#"filename="manifest.json""#).unwrap();
    let main = body.find(r#"filename="main.js""#).unwrap();
    assert!(visibility < manifest && manifest < main);
    assert!(body.contains("private\r\n"));
    assert!(body.contains("{\"name\":\"x\"}"));
    assert!(body.contains("body-js"));
}

#[test]
fn multipart_length_matches_the_flattened_body() {
    let boundary = "b-test";
    let data = vec![7u8; 10];
    let multipart = build_multipart(
        boundary,
        &[("visibility", "public")],
        &[FilePart {
            file_name: "a.txt",
            mime: "text/plain",
            range: 2..9,
        }],
    );
    let flat = flatten(&multipart, &data);
    assert_eq!(multipart.len(), flat.len() as u64);
    assert_eq!(
        multipart.content_type,
        "multipart/form-data; boundary=b-test"
    );
    assert!(flat.ends_with(b"--b-test--\r\n"));
}

#[test]
fn boundaries_differ_between_calls() {
    let a = new_boundary();
    let b = new_boundary();
    assert_ne!(a, b);
    assert!(a.starts_with("disnans-") && a.len() == 8 + 32);
}

#[test]
fn file_names_are_quoted_safely() {
    assert_eq!(quote_file_name("a\"b\r\nc"), "a%22b%0D%0Ac");
    assert_eq!(quote_file_name("日本.png"), "日本.png");
}
type Updates = Arc<Mutex<Vec<(u64, u64)>>>;

fn progress_recorder() -> (Arc<dyn Fn(u64, u64) + Send + Sync>, Updates) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorder = seen.clone();
    let callback: Arc<dyn Fn(u64, u64) + Send + Sync> =
        Arc::new(move |loaded, total| recorder.lock().unwrap().push((loaded, total)));
    (callback, seen)
}

#[test]
fn upload_pieces_keep_bytes_and_cap_the_chunk_size() {
    let data = vec![1u8; UPLOAD_CHUNK * 2 + 5];
    let multipart = build_multipart(
        "b",
        &[],
        &[FilePart {
            file_name: "a.bin",
            mime: "application/octet-stream",
            range: 0..data.len(),
        }],
    );
    let pieces = upload_pieces(&multipart);
    let mut rebuilt = Vec::new();
    for piece in &pieces {
        match piece {
            Segment::Bytes(bytes) => rebuilt.extend_from_slice(bytes),
            Segment::Data(range) => {
                assert!(range.end - range.start <= UPLOAD_CHUNK);
                rebuilt.extend_from_slice(&data[range.clone()]);
            }
        }
    }
    assert_eq!(rebuilt, flatten(&multipart, &data));
    assert!(pieces.len() >= 4);
}

#[tokio::test]
async fn upload_streams_the_whole_file_with_monotonic_progress() {
    let (client, seen) = scripted(vec![Action::Reply {
        status: "200 OK",
        body: r#"{"id":"f1","file_name":"big.bin"}"#,
        keep_alive: false,
    }])
    .await;
    let data: Vec<u8> = (0..(UPLOAD_CHUNK * 3 + 17))
        .map(|i| (i % 251) as u8)
        .collect();
    let (progress, updates) = progress_recorder();
    let (_handle, registration) = AbortHandle::new_pair();
    let value = client
        .upload_file(
            Arc::new(data.clone()),
            "big.bin",
            "application/octet-stream",
            progress,
            registration,
        )
        .await
        .unwrap();
    assert_eq!(value["id"], "f1");

    let updates = updates.lock().unwrap();
    assert!(updates.len() >= 4);
    assert!(updates.windows(2).all(|w| w[0].0 <= w[1].0));
    let (last_loaded, total) = *updates.last().unwrap();
    assert_eq!(last_loaded, total);
    assert!(
        updates
            .iter()
            .all(|(loaded, t)| *loaded <= *t && *t == total)
    );

    let seen = seen.lock().unwrap();
    assert_eq!(seen.requests, vec!["POST /api/files HTTP/1.1"]);
    assert_eq!(seen.bodies[0].len() as u64, total);
    assert!(
        seen.bodies[0]
            .windows(data.len())
            .any(|w| w == data.as_slice())
    );
}

#[tokio::test]
async fn aborting_an_upload_ends_it_as_aborted() {
    let (client, _seen) = scripted(vec![Action::Hang]).await;
    let (progress, _updates) = progress_recorder();
    let (handle, registration) = AbortHandle::new_pair();
    let task = tokio::spawn(async move {
        client
            .upload_file(
                Arc::new(vec![3u8; 100]),
                "a.bin",
                "application/octet-stream",
                progress,
                registration,
            )
            .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    handle.abort();
    let failure = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("abort should end the upload promptly")
        .unwrap()
        .unwrap_err();
    assert_eq!(failure.code, "aborted");
    assert_eq!(failure.status, None);
}

#[tokio::test]
async fn upload_cut_after_send_is_unknown_outcome_and_sent_once() {
    let (client, seen) = scripted(vec![Action::CutAfterRead]).await;
    let (progress, _updates) = progress_recorder();
    let (_handle, registration) = AbortHandle::new_pair();
    let failure = client
        .upload_file(
            Arc::new(vec![9u8; 2048]),
            "a.bin",
            "application/octet-stream",
            progress,
            registration,
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, "unknown_outcome");
    assert_eq!(failure.status, None);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let seen = seen.lock().unwrap();
    assert_eq!(seen.connections, 1);
    assert_eq!(seen.requests, vec!["POST /api/files HTTP/1.1"]);
}
