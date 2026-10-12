use std::{
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use disnans_server::{
    config::Config,
    state::SharedState,
    store::{messages, users},
};
use serde_json::Value;
use tokio::{net::TcpListener, task::JoinHandle};

const PROCESS_TIMEOUT: Duration = Duration::from_secs(10);

struct TestServer {
    address: SocketAddr,
    task: JoinHandle<()>,
    state: SharedState,
    _data: tempfile::TempDir,
}

impl TestServer {
    async fn start(seed_messages: bool) -> Self {
        let data = tempfile::tempdir().unwrap();
        let config = Config {
            data_dir: data.path().to_owned(),
            bind: "127.0.0.1:0".parse().unwrap(),
            dev: true,
            tailscale_socket: data.path().join("no-such-socket"),
            image_max_edge: disnans_server::image_proc::DEFAULT_MAX_EDGE,
        };
        let (app, state) = disnans_server::build(config).await.unwrap();
        if seed_messages {
            let (alice, _) = users::get_or_create(&state.pool, "alice", "Alice", None)
                .await
                .unwrap();
            let mut tx = state.pool.begin().await.unwrap();
            for (id, body) in [("msg-1", "first"), ("msg-2", "second"), ("msg-3", "third")] {
                messages::insert(
                    &mut tx,
                    &messages::MessageRow {
                        id: id.into(),
                        author_id: alice.id.clone(),
                        thread_id: None,
                        reply_to: None,
                        body: body.into(),
                        created_at: 1,
                        edited_at: None,
                        bot_plugin: None,
                        bot_name: None,
                    },
                )
                .await
                .unwrap();
            }
            tx.commit().await.unwrap();
        }

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
        // Release SQLite handles before removing the temp directory, especially on Windows.
        self.state.pool.close().await;
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn isolated_command(root: &Path, args: &[&str]) -> Command {
    let config_dir = root.join("client-config");
    let data_dir = root.join("client-data");
    let xdg_config = root.join("xdg-config");
    let xdg_data = root.join("xdg-data");
    let appdata = root.join("appdata");
    let local_appdata = root.join("local-appdata");
    let home = root.join("home");
    let user_profile = root.join("user-profile");

    let mut command = Command::new(env!("CARGO_BIN_EXE_disnans"));
    command
        .args(args)
        .env("DISNANS_CLIENT_CONFIG_DIR", config_dir)
        .env("DISNANS_CLIENT_DATA_DIR", data_dir)
        .env("XDG_CONFIG_HOME", xdg_config)
        .env("XDG_DATA_HOME", xdg_data)
        .env("APPDATA", appdata)
        .env("LOCALAPPDATA", local_appdata)
        .env("HOME", home)
        .env("USERPROFILE", user_profile)
        .env_remove("DISNANS_DATA_DIR")
        .env_remove("DISNANS_DEV")
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

fn run_cli(root: &Path, args: &[&str]) -> Output {
    let command = isolated_command(root, args);
    run_command(command, args)
}

async fn run_cli_async(root: PathBuf, args: Vec<String>) -> Output {
    tokio::task::spawn_blocking(move || {
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        run_cli(&root, &args)
    })
    .await
    .unwrap()
}

fn cli_args(server: &TestServer, command: &[&str]) -> Vec<String> {
    let mut args = vec![
        "--server".into(),
        server.url(),
        "--dev-user".into(),
        "alice".into(),
    ];
    args.extend(command.iter().map(|arg| (*arg).to_owned()));
    args
}

fn assert_success_json(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "exit={:?}, stdout={}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test]
async fn me_messages_and_paging_use_an_isolated_dev_server() {
    let server = TestServer::start(true).await;
    let client = tempfile::tempdir().unwrap();

    let me = run_cli_async(
        client.path().to_owned(),
        cli_args(&server, &["me", "--json"]),
    )
    .await;
    assert_eq!(assert_success_json(&me)["login_name"], "alice");

    let messages = run_cli_async(
        client.path().to_owned(),
        cli_args(&server, &["messages", "--json", "--limit", "2"]),
    )
    .await;
    let messages = assert_success_json(&messages);
    assert_eq!(messages.as_array().unwrap().len(), 2);
    assert_eq!(messages[0]["body"], "second");
    assert_eq!(messages[1]["body"], "third");

    let before = run_cli_async(
        client.path().to_owned(),
        cli_args(
            &server,
            &["messages", "--json", "--limit", "10", "--before", "msg-3"],
        ),
    )
    .await;
    let before = assert_success_json(&before);
    assert_eq!(before.as_array().unwrap().len(), 2);
    assert_eq!(before[0]["body"], "first");
    assert_eq!(before[1]["body"], "second");

    server.stop().await;
}

#[tokio::test]
async fn config_is_shared_between_cli_processes() {
    let server = TestServer::start(false).await;
    let client = tempfile::tempdir().unwrap();

    let set = run_cli_async(
        client.path().to_owned(),
        vec!["config".into(), "set-server".into(), server.url()],
    )
    .await;
    assert!(
        set.status.success(),
        "{}",
        String::from_utf8_lossy(&set.stderr)
    );
    assert!(set.stderr.is_empty());

    let show = run_cli_async(
        client.path().to_owned(),
        vec!["config".into(), "show".into(), "--json".into()],
    )
    .await;
    assert_eq!(assert_success_json(&show)["server_url"], server.url());

    let empty_messages = run_cli_async(
        client.path().to_owned(),
        cli_args(&server, &["messages", "--json"]),
    )
    .await;
    assert!(
        assert_success_json(&empty_messages)
            .as_array()
            .unwrap()
            .is_empty()
    );

    server.stop().await;
}

#[tokio::test]
async fn invalid_server_url_fails_on_stderr_without_stdout() {
    let client = tempfile::tempdir().unwrap();
    let output = run_cli_async(
        client.path().to_owned(),
        vec![
            "--server".into(),
            "not a URL".into(),
            "--dev-user".into(),
            "alice".into(),
            "me".into(),
            "--json".into(),
        ],
    )
    .await;
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(!output.stderr.is_empty());
}

#[tokio::test]
async fn explicit_server_override_does_not_open_client_storage() {
    let server = TestServer::start(false).await;
    let client = tempfile::tempdir().unwrap();
    let not_a_directory = client.path().join("a-file-not-a-directory");
    std::fs::write(&not_a_directory, "unrelated user data").unwrap();
    let invalid_path = not_a_directory.clone();
    let client_root = client.path().to_owned();

    let args = cli_args(&server, &["me", "--json"]);
    let args_for_panic = args.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_disnans"));
        command
            .args(&args)
            .env("DISNANS_CLIENT_CONFIG_DIR", &invalid_path)
            .env("DISNANS_CLIENT_DATA_DIR", &invalid_path)
            .env("XDG_CONFIG_HOME", client_root.join("xdg-config"))
            .env("XDG_DATA_HOME", client_root.join("xdg-data"))
            .env("APPDATA", client_root.join("appdata"))
            .env("LOCALAPPDATA", client_root.join("local-appdata"))
            .env("HOME", client_root.join("home"))
            .env("USERPROFILE", client_root.join("user-profile"))
            .env_remove("DISNANS_DATA_DIR")
            .env_remove("DISNANS_DEV")
            .current_dir(&client_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // 共有設定の保存先が壊れていても、明示した接続先だけで読み取りできる契約。
        run_command(command, &args_for_panic)
    })
    .await
    .unwrap();
    assert_eq!(assert_success_json(&output)["login_name"], "alice");
    assert_eq!(
        std::fs::read_to_string(&not_a_directory).unwrap(),
        "unrelated user data"
    );

    server.stop().await;
}

fn run_command(mut command: Command, args: &[impl std::fmt::Debug]) -> Output {
    let mut child = command.spawn().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    thread::scope(|scope| {
        // Drain both pipes while waiting: a large history must not fill a pipe and deadlock.
        let out = scope.spawn(move || {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let err = scope.spawn(move || {
            let mut bytes = Vec::new();
            stderr.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Output {
                        status,
                        stdout: out.join().unwrap(),
                        stderr: err.join().unwrap(),
                    };
                }
                Ok(None) if start.elapsed() < PROCESS_TIMEOUT => {
                    thread::sleep(Duration::from_millis(10));
                }
                outcome => {
                    let _ = child.kill();
                    let _ = child.wait();
                    panic!("disnans process did not complete: {outcome:?}, args={args:?}");
                }
            }
        }
    })
}
