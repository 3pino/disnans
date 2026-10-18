//! `disnans send` と `disnans watch` の子プロセス試験。
//!
//! - 実際の開発モードサーバー（一時データ）に対する送信・監視。
//! - 障害を注入する fake WebSocket サーバー。送信の成否が不明な障害で CLI が
//!   自動再送しないことを、fake が受け取った `message.send` の数で確かめる。
//!
//! すべての子プロセスは一時ディレクトリの設定・データ・ホームで動かし、10 秒で強制終了する。
//! 試験の終わりにサーバーと子プロセスを止め、孤児プロセスを残さない。

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use disnans_server::{config::Config, state::SharedState, store::users};
use disnans_shared::{Message, ServerEvent, User};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::{
    net::{TcpListener, TcpStream},
    task::JoinHandle as TokioJoinHandle,
};
use tokio_tungstenite::{
    WebSocketStream, accept_async, accept_hdr_async,
    tungstenite::{
        Message as WsMessage,
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
    },
};

/// 子プロセス 1 件の上限。超えたら強制終了して試験を失敗させる。
const PROCESS_TIMEOUT: Duration = Duration::from_secs(10);
/// stream の 1 行を待つ上限。
const LINE_TIMEOUT: Duration = Duration::from_secs(10);
/// 送信の確認（ack）を短くする隠し環境変数。CLI 側の実装と合わせる。
const ACK_TIMEOUT_ENV: &str = "DISNANS_CLI_ACK_TIMEOUT_MS";

// ---------------------------------------------------------------------------
// 実サーバー
// ---------------------------------------------------------------------------

struct TestServer {
    address: SocketAddr,
    task: TokioJoinHandle<()>,
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
        // 送信者を先に作っておく（CLI の dev user と同じログイン名）
        users::get_or_create(&state.pool, "alice", "Alice", None)
            .await
            .unwrap();

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

    async fn stop(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
        // Windows で一時ディレクトリを消せるよう、SQLite の接続を先に閉じる。
        self.state.pool.close().await;
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// ---------------------------------------------------------------------------
// fake サーバー（障害注入）
// ---------------------------------------------------------------------------

/// `message.send` のエラーに付ける client_id。
#[derive(Clone, Copy, PartialEq, Eq)]
enum ErrorIds {
    /// 送った client_id をそのまま返す（送信の確定判断に使われるべき）。
    Echo,
    /// 別の client_id を返す（確定判断には使われない）。
    OtherClient,
    /// client_id を付けない。
    Absent,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Script {
    /// hello のあと、`message.send` を受けたら何も返さず接続を即切る。
    CloseOnSend,
    /// hello のあと、`message.send` に何も返さない（ack が来ない）。
    SilentOnSend,
    /// `message.send` にエラーで答える。client_id の付け方は `ids` で決める。
    Error { code: &'static str, ids: ErrorIds },
    /// 1 本目の接続は message.created を送ってから切る。2 本目以降は開いたままにする。
    #[cfg_attr(not(unix), allow(dead_code))]
    WatchReconnect,
    /// 1 本目の接続は message.created を送ってから切る。2 本目以降は upgrade を 401 で拒否する。
    WatchReconnectThen401,
    /// WebSocket の upgrade を 401 で拒否する。
    Unauthorized,
}

type Sends = Arc<Mutex<Vec<Value>>>;

struct Fake {
    address: SocketAddr,
    sends: Sends,
    connections: Arc<AtomicUsize>,
    task: TokioJoinHandle<()>,
}

impl Fake {
    async fn start(script: Script) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let sends: Sends = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let (sends_for_task, connections_for_task) = (sends.clone(), connections.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let index = connections_for_task.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(serve(stream, index, script, sends_for_task.clone()));
            }
        });
        Self {
            address,
            sends,
            connections,
            task,
        }
    }

    fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    fn connections(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }

    /// 届いた `message.send` が `expected` 件になるまで待ち、さらに少し待って増えないことを確かめる。
    async fn settle_sends(&self, expected: usize) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.sends.lock().unwrap().len() < expected && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            self.sends.lock().unwrap().len(),
            expected,
            "message.send の受信数が違います（再送の疑い）"
        );
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn serve(stream: TcpStream, index: usize, script: Script, sends: Sends) {
    if script == Script::Unauthorized || (script == Script::WatchReconnectThen401 && index > 0) {
        reject_upgrade(stream).await;
        return;
    }

    let Ok(mut ws) = accept_async(stream).await else {
        return;
    };
    let me = fake_user();
    let hello = ServerEvent::Hello {
        me: me.clone(),
        users: vec![me],
    };
    if send_event(&mut ws, &hello).await.is_err() {
        return;
    }

    if matches!(
        script,
        Script::WatchReconnect | Script::WatchReconnectThen401
    ) && index == 0
    {
        let created = ServerEvent::MessageCreated {
            client_id: None,
            message: fake_message("m-from-fake", "from fake"),
        };
        let _ = send_event(&mut ws, &created).await;
        let _ = ws.close(None).await;
        return;
    }

    while let Some(Ok(frame)) = ws.next().await {
        let WsMessage::Text(text) = frame else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(text.as_str()) else {
            continue;
        };
        if event["type"] != "message.send" {
            continue;
        }
        sends.lock().unwrap().push(event.clone());
        let client_id = event["client_id"].as_str().unwrap_or_default().to_owned();
        match script {
            Script::CloseOnSend => return,
            Script::SilentOnSend
            | Script::WatchReconnect
            | Script::WatchReconnectThen401
            | Script::Unauthorized => {}
            Script::Error { code, ids } => {
                let client_id = match ids {
                    ErrorIds::Echo => Some(client_id),
                    ErrorIds::OtherClient => Some("someone-else".to_owned()),
                    ErrorIds::Absent => None,
                };
                let error = ServerEvent::Error {
                    client_id,
                    code: code.to_owned(),
                    message: "fake error".to_owned(),
                };
                let _ = send_event(&mut ws, &error).await;
            }
        }
    }
}

/// upgrade を 401 で拒否する（認証されていない、という応答）。
// tungstenite の拒否応答の型（ErrorResponse）が大きいのは、ライブラリの都合として許容する。
#[allow(clippy::result_large_err)]
async fn reject_upgrade(stream: TcpStream) {
    let _ = accept_hdr_async(
        stream,
        |_: &Request, _: Response| -> Result<Response, ErrorResponse> {
            Err(tokio_tungstenite::tungstenite::http::Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .body(Some("unauthorized".to_owned()))
                .unwrap())
        },
    )
    .await;
}

async fn send_event(
    ws: &mut WebSocketStream<TcpStream>,
    event: &ServerEvent,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let text = serde_json::to_string(event).unwrap();
    ws.send(WsMessage::Text(text.into())).await
}

fn fake_user() -> User {
    User {
        id: "u-alice".into(),
        login_name: "alice".into(),
        display_name: "Alice".into(),
        avatar_url: None,
        created_at: 1,
    }
}

fn fake_message(id: &str, body: &str) -> Message {
    Message {
        id: id.into(),
        author_id: "u-alice".into(),
        reply_to: None,
        reply_preview: None,
        body: body.into(),
        attachments: Vec::new(),
        reactions: Vec::new(),
        created_at: 1,
        edited_at: None,
        card: None,
        bot: None,
    }
}

// ---------------------------------------------------------------------------
// 子プロセス
// ---------------------------------------------------------------------------

/// 試験が途中で失敗しても、起動した CLI を残さないための保護。
struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn spawn(mut command: Command) -> Self {
        Self(Some(command.spawn().unwrap()))
    }

    fn child(&mut self) -> &mut Child {
        self.0.as_mut().unwrap()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take()
            && matches!(child.try_wait(), Ok(None))
        {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn isolated_command(root: &Path, args: &[String], env: &[(&str, String)]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_disnans"));
    command
        .args(args)
        .env("DISNANS_CLIENT_CONFIG_DIR", root.join("client-config"))
        .env("DISNANS_CLIENT_DATA_DIR", root.join("client-data"))
        .env("XDG_CONFIG_HOME", root.join("xdg-config"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("local-appdata"))
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("user-profile"))
        .env_remove("DISNANS_DATA_DIR")
        .env_remove("DISNANS_DEV")
        .env_remove(ACK_TIMEOUT_ENV)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    command
}

fn args(url: &str, command: &[&str]) -> Vec<String> {
    let mut out = vec![
        "--server".to_owned(),
        url.to_owned(),
        "--dev-user".to_owned(),
        "alice".to_owned(),
    ];
    out.extend(command.iter().map(|arg| (*arg).to_owned()));
    out
}

struct Finished {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

async fn run(
    root: PathBuf,
    args: Vec<String>,
    stdin: Option<String>,
    env: Vec<(&'static str, String)>,
) -> Finished {
    tokio::task::spawn_blocking(move || run_blocking(&root, &args, stdin, &env))
        .await
        .unwrap()
}

fn run_blocking(
    root: &Path,
    args: &[String],
    stdin: Option<String>,
    env: &[(&'static str, String)],
) -> Finished {
    let mut command = isolated_command(root, args, env);
    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut guard = ChildGuard::spawn(command);
    let child = guard.child();
    if let Some(input) = stdin {
        let mut pipe = child.stdin.take().unwrap();
        // 入力を書き終えたら閉じる（EOF）。CLI が読まずに終わっても失敗にしない。
        thread::spawn(move || {
            let _ = pipe.write_all(input.as_bytes());
        });
    }
    let stdout = drain(child.stdout.take().unwrap());
    let stderr = drain(child.stderr.take().unwrap());
    let status = wait_timeout(guard.child(), PROCESS_TIMEOUT);
    Finished {
        status,
        stdout: String::from_utf8_lossy(&stdout.join().unwrap()).into_owned(),
        stderr: String::from_utf8_lossy(&stderr.join().unwrap()).into_owned(),
    }
}

/// パイプを読み切るスレッド。出力が大きくても子プロセスが詰まらないようにする。
fn drain<R: Read + Send + 'static>(mut reader: R) -> JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = reader.read_to_end(&mut bytes);
        bytes
    })
}

fn wait_timeout(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("子プロセスが {timeout:?} 以内に終わりませんでした");
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// `watch` を起動したまま、NDJSON を 1 行ずつ受け取る。
#[cfg_attr(not(unix), allow(dead_code))]
struct Watch {
    guard: ChildGuard,
    lines: mpsc::Receiver<String>,
    stderr: JoinHandle<Vec<u8>>,
}

impl Watch {
    fn start(root: &Path, args: &[String], env: &[(&'static str, String)]) -> Self {
        let mut command = isolated_command(root, args, env);
        command.stdin(Stdio::null());
        let mut guard = ChildGuard::spawn(command);
        let stdout = guard.child().stdout.take().unwrap();
        let stderr = drain(guard.child().stderr.take().unwrap());
        let (tx, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    // 受け手がいなくなったら読むのをやめる（パイプを閉じて CLI に EPIPE を起こす）
                    break;
                }
            }
        });
        Self {
            guard,
            lines,
            stderr,
        }
    }

    fn next_json(&self) -> Value {
        let line = self
            .lines
            .recv_timeout(LINE_TIMEOUT)
            .unwrap_or_else(|e| panic!("{LINE_TIMEOUT:?} 以内に行がありません: {e}"));
        serde_json::from_str(&line).unwrap_or_else(|e| panic!("NDJSON ではない行: {line:?} ({e})"))
    }

    /// Ctrl-C 相当（SIGINT）を送り、終了コードと残りの行を返す。
    #[cfg(unix)]
    fn interrupt(mut self) -> (ExitStatus, Vec<String>, String) {
        let pid = self.guard.child().id();
        let status = Command::new("/bin/sh")
            .arg("-c")
            .arg("kill -INT \"$1\"")
            .arg("sh")
            .arg(pid.to_string())
            .status()
            .unwrap();
        assert!(status.success(), "SIGINT を送れませんでした");
        let exit = wait_timeout(self.guard.child(), PROCESS_TIMEOUT);
        // 子が終わればパイプは閉じる。読み取りスレッドが止まるまで残りを集める
        let rest: Vec<String> = self.lines.iter().collect();
        let stderr = String::from_utf8_lossy(&self.stderr.join().unwrap()).into_owned();
        (exit, rest, stderr)
    }
}

async fn history(server: &TestServer, root: &Path) -> Vec<Value> {
    let out = run(
        root.to_owned(),
        args(&server.url(), &["messages", "--json", "--limit", "200"]),
        None,
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);
    serde_json::from_str::<Value>(&out.stdout)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

/// 接続を拒否される（すぐ閉じた）ポート。
fn closed_port_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    format!("http://{address}")
}

// ---------------------------------------------------------------------------
// A: 実サーバー
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn send_prints_the_confirmed_id_and_history_shows_the_body() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", "hello from the cli"]),
        None,
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);
    assert!(out.stderr.is_empty(), "{}", out.stderr);
    let id = out.stdout.strip_suffix('\n').expect("改行で終わる");
    assert!(!id.is_empty() && !id.contains('\n'));

    let messages = history(&server, client.path()).await;
    let sent = messages
        .iter()
        .find(|m| m["id"] == id)
        .expect("送った ID が履歴にある");
    assert_eq!(sent["body"], "hello from the cli");
    assert_eq!(messages.len(), 1);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn send_json_reports_message_and_client_ids() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", "--json", "json body"]),
        None,
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);
    let value: Value = serde_json::from_str(&out.stdout).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 2);
    let message_id = value["message_id"].as_str().unwrap();
    assert!(value["client_id"].as_str().is_some_and(|id| !id.is_empty()));

    let messages = history(&server, client.path()).await;
    assert_eq!(messages[0]["id"], message_id);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn stdin_body_keeps_lines_and_drops_only_one_trailing_newline() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", "--stdin"]),
        Some("first\nsecond\n\n".to_owned()),
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);

    let messages = history(&server, client.path()).await;
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["body"], "first\nsecond\n");

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn silent_send_is_accepted_and_stored() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", "--silent", "quiet"]),
        None,
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);
    let messages = history(&server, client.path()).await;
    assert_eq!(messages[0]["body"], "quiet");

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn invalid_send_inputs_exit_2_and_store_nothing() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();
    let too_long = "x".repeat(10_001);
    let boundary = "y".repeat(10_000);

    let cases: Vec<(Vec<&str>, Option<&str>)> = vec![
        (vec!["send", ""], None),
        (vec!["send", "   "], None),
        (vec!["send", "--stdin"], Some("")),
        (vec!["send", "--stdin"], None),
        (vec!["send", "--stdin", "also a text"], Some("stdin text")),
    ];
    for (command, stdin) in cases {
        let out = run(
            client.path().to_owned(),
            args(&server.url(), &command),
            stdin.map(str::to_owned),
            vec![],
        )
        .await;
        assert_eq!(out.status.code(), Some(2), "{command:?}: {}", out.stderr);
        assert!(out.stdout.is_empty(), "{command:?}");
        assert!(!out.stderr.is_empty(), "{command:?}");
    }

    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", &too_long]),
        None,
        vec![],
    )
    .await;
    assert_eq!(out.status.code(), Some(2), "{}", out.stderr);
    assert!(out.stdout.is_empty());
    assert!(history(&server, client.path()).await.is_empty());

    // 上限ちょうどの 10000 文字は送れる（境界の確認）
    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", &boundary]),
        None,
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);
    assert_eq!(history(&server, client.path()).await.len(), 1);

    server.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn connection_refused_before_sending_exits_3() {
    let client = tempfile::tempdir().unwrap();
    let url = closed_port_url();

    let out = run(
        client.path().to_owned(),
        args(&url, &["send", "never sent"]),
        None,
        vec![],
    )
    .await;
    assert_eq!(out.status.code(), Some(3), "{}", out.stderr);
    assert!(out.stdout.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_initial_connection_refused_exits_3() {
    let client = tempfile::tempdir().unwrap();
    let url = closed_port_url();

    let out = run(
        client.path().to_owned(),
        args(&url, &["watch", "--json"]),
        None,
        vec![],
    )
    .await;
    assert_eq!(out.status.code(), Some(3), "{}", out.stderr);
    assert!(out.stdout.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn watch_prints_a_message_sent_by_another_process_once() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();

    let watch = Watch::start(
        client.path(),
        &args(&server.url(), &["watch", "--json"]),
        &[],
    );
    let connected = watch.next_json();
    assert_eq!(connected["type"], "stream.connected");
    assert_eq!(connected["generation"], 1);

    let out = run(
        client.path().to_owned(),
        args(&server.url(), &["send", "from another process"]),
        None,
        vec![],
    )
    .await;
    assert!(out.status.success(), "{}", out.stderr);
    let id = out.stdout.trim_end().to_owned();

    let created = watch.next_json();
    assert_eq!(created["type"], "message.created");
    assert_eq!(created["message"]["id"], id);
    assert_eq!(created["message"]["body"], "from another process");

    #[cfg(unix)]
    {
        let (status, rest, stderr) = watch.interrupt();
        assert_eq!(status.code(), Some(130), "{stderr}");
        assert!(
            rest.iter().all(|line| !line.contains("message.created")),
            "履歴は再送されない: {rest:?}"
        );
    }
    #[cfg(not(unix))]
    drop(watch);

    server.stop().await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn watch_exits_zero_when_its_stdout_is_closed() {
    let server = TestServer::start().await;
    let client = tempfile::tempdir().unwrap();

    let watch = Watch::start(
        client.path(),
        &args(&server.url(), &["watch", "--json"]),
        &[],
    );
    assert_eq!(watch.next_json()["type"], "stream.connected");

    // 読み手を外す。次の行を読んだ読み取りスレッドが、パイプを閉じる
    let Watch {
        mut guard,
        lines,
        stderr: _,
    } = watch;
    drop(lines);
    for body in ["first after close", "second after close"] {
        let out = run(
            client.path().to_owned(),
            args(&server.url(), &["send", body]),
            None,
            vec![],
        )
        .await;
        assert!(out.status.success(), "{}", out.stderr);
        tokio::time::sleep(Duration::from_millis(300)).await;
    }

    let status = tokio::task::spawn_blocking(move || wait_timeout(guard.child(), PROCESS_TIMEOUT))
        .await
        .unwrap();
    assert_eq!(status.code(), Some(0));

    server.stop().await;
}

// ---------------------------------------------------------------------------
// B: 障害注入（fake サーバー）
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn close_after_send_is_unknown_and_never_resent() {
    let fake = Fake::start(Script::CloseOnSend).await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&fake.url(), &["send", "maybe delivered"]),
        None,
        vec![],
    )
    .await;
    assert_eq!(out.status.code(), Some(4), "{}", out.stderr);
    assert!(out.stdout.is_empty());
    assert!(out.stderr.contains("再送"), "{}", out.stderr);

    fake.settle_sends(1).await;
    assert_eq!(fake.connections(), 1, "切断後に再接続していない");
}

#[tokio::test(flavor = "multi_thread")]
async fn missing_ack_times_out_as_unknown_and_never_resent() {
    let fake = Fake::start(Script::SilentOnSend).await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&fake.url(), &["send", "no ack"]),
        None,
        vec![(ACK_TIMEOUT_ENV, "300".to_owned())],
    )
    .await;
    assert_eq!(out.status.code(), Some(4), "{}", out.stderr);
    assert!(out.stdout.is_empty());

    fake.settle_sends(1).await;
    assert_eq!(fake.connections(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn internal_or_unknown_error_codes_are_unknown() {
    for code in ["internal", "some_future_code"] {
        let fake = Fake::start(Script::Error {
            code,
            ids: ErrorIds::Echo,
        })
        .await;
        let client = tempfile::tempdir().unwrap();

        let out = run(
            client.path().to_owned(),
            args(&fake.url(), &["send", "server error"]),
            None,
            vec![],
        )
        .await;
        assert_eq!(out.status.code(), Some(4), "{code}: {}", out.stderr);
        assert!(out.stdout.is_empty(), "{code}");
        fake.settle_sends(1).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn rejected_error_codes_exit_1_for_the_matching_send() {
    for code in [
        "empty_message",
        "body_too_long",
        "reply_not_found",
        "reply_other_place",
        "invalid_attachment",
    ] {
        let fake = Fake::start(Script::Error {
            code,
            ids: ErrorIds::Echo,
        })
        .await;
        let client = tempfile::tempdir().unwrap();

        let out = run(
            client.path().to_owned(),
            args(&fake.url(), &["send", "rejected"]),
            None,
            vec![],
        )
        .await;
        assert_eq!(out.status.code(), Some(1), "{code}: {}", out.stderr);
        assert!(out.stdout.is_empty(), "{code}");
        fake.settle_sends(1).await;
    }
}

/// 別の client_id を付けたエラーは、この送信の確定判断に使われない。ack が来ないまま
/// タイムアウトして 4（成否不明）になり、fake が受けた `message.send` は 1 件のまま。
#[tokio::test(flavor = "multi_thread")]
async fn error_for_another_client_id_is_ignored_and_times_out_as_unknown() {
    let fake = Fake::start(Script::Error {
        code: "empty_message",
        ids: ErrorIds::OtherClient,
    })
    .await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&fake.url(), &["send", "mismatched"]),
        None,
        vec![(ACK_TIMEOUT_ENV, "300".to_owned())],
    )
    .await;
    assert_eq!(out.status.code(), Some(4), "{}", out.stderr);
    assert!(out.stdout.is_empty());
    fake.settle_sends(1).await;
}

/// client_id のないエラーも、この送信の確定判断には使われない（4）。
#[tokio::test(flavor = "multi_thread")]
async fn error_without_client_id_is_unknown() {
    let fake = Fake::start(Script::Error {
        code: "empty_message",
        ids: ErrorIds::Absent,
    })
    .await;
    let client = tempfile::tempdir().unwrap();

    let out = run(
        client.path().to_owned(),
        args(&fake.url(), &["send", "no client id"]),
        None,
        vec![(ACK_TIMEOUT_ENV, "300".to_owned())],
    )
    .await;
    assert_eq!(out.status.code(), Some(4), "{}", out.stderr);
    assert!(out.stdout.is_empty());
    fake.settle_sends(1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn unauthorized_upgrade_exits_1_for_send_and_watch() {
    let fake = Fake::start(Script::Unauthorized).await;
    let client = tempfile::tempdir().unwrap();

    let send = run(
        client.path().to_owned(),
        args(&fake.url(), &["send", "unauthorized"]),
        None,
        vec![],
    )
    .await;
    assert_eq!(send.status.code(), Some(1), "{}", send.stderr);
    assert!(send.stdout.is_empty());

    let watch = run(
        client.path().to_owned(),
        args(&fake.url(), &["watch", "--json"]),
        None,
        vec![],
    )
    .await;
    assert_eq!(watch.status.code(), Some(1), "{}", watch.stderr);
    assert!(watch.stdout.is_empty());
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn watch_reports_a_gap_and_a_new_generation_after_reconnect() {
    let fake = Fake::start(Script::WatchReconnect).await;
    let client = tempfile::tempdir().unwrap();

    let watch = Watch::start(client.path(), &args(&fake.url(), &["watch", "--json"]), &[]);
    let first = watch.next_json();
    assert_eq!(first["type"], "stream.connected");
    assert_eq!(first["generation"], 1);

    let created = watch.next_json();
    assert_eq!(created["type"], "message.created");
    assert_eq!(created["message"]["body"], "from fake");

    // 切断 → 欠けた可能性の通知 → 再接続（generation が進む）
    let gap = watch.next_json();
    assert_eq!(gap["type"], "stream.gap");
    assert!(gap["generation"].is_u64());
    assert!(gap["reason"].is_string());

    let second = watch.next_json();
    assert_eq!(second["type"], "stream.connected");
    assert_eq!(second["generation"], 2);

    let (status, _rest, stderr) = watch.interrupt();
    assert_eq!(status.code(), Some(130), "{stderr}");
}

/// 再接続が 401 で拒否されたら、watch は診断を stderr に出して 1 で終わる。
/// 出力を待ち続けず、有界の時間で終了することを確かめる。
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn watch_exits_1_when_reconnect_is_unauthorized() {
    let fake = Fake::start(Script::WatchReconnectThen401).await;
    let client = tempfile::tempdir().unwrap();

    let watch = Watch::start(client.path(), &args(&fake.url(), &["watch", "--json"]), &[]);
    assert_eq!(watch.next_json()["type"], "stream.connected");
    assert_eq!(watch.next_json()["type"], "message.created");

    // 切断の通知のあと、再接続が 401 で止まって終了する（無出力で待たない）
    let gap = watch.next_json();
    assert_eq!(gap["type"], "stream.gap");

    let status = tokio::task::spawn_blocking(move || {
        let mut guard = watch.guard;
        wait_timeout(guard.child(), PROCESS_TIMEOUT)
    })
    .await
    .unwrap();
    assert_eq!(status.code(), Some(1));
    assert!(fake.connections() >= 2, "再接続を試みている");
    let rest: Vec<String> = watch.lines.iter().collect();
    assert!(rest.is_empty(), "終了後に追加の行はない: {rest:?}");
    let stderr = String::from_utf8_lossy(&watch.stderr.join().unwrap()).into_owned();
    assert!(!stderr.is_empty(), "診断を stderr に出す");
}
