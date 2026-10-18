//! End-to-end tests for the desktop file-storage commands.
//!
//! `open_default` reads process-global environment, so these tests run the actual command calls in
//! a subprocess with every home/config location redirected. The parent test never mutates env.

use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use crate::client_storage::{
    ImportArgs, ImportValue, StorageKey, StorageState, WriteArgs, client_storage_import,
    client_storage_read, client_storage_write,
};
use disnans_client_core::{DraftKey, DraftPlace, LocalStore, ServerUrl, StoredValue};
use serde_json::json;

const CHILD_MARKER: &str = "DISNANS_CLIENT_STORAGE_TEST_CHILD";
const CHILD_TEST: &str = "client_storage_tests::isolated_bridge_child";
const SERVER_URL: &str = "https://storage-test.example/base";
const USER_ID: &str = "u1";

#[test]
fn bridge_commands_roundtrip_in_isolated_process() {
    let root = tempfile::tempdir().expect("create test root");
    let root_path = root.path();
    let config = root_path.join("config");
    let data = root_path.join("data");
    let home = root_path.join("home");
    let xdg_config = root_path.join("xdg-config");
    let xdg_data = root_path.join("xdg-data");
    let appdata = root_path.join("appdata");
    let local_appdata = root_path.join("local-appdata");
    let temp = root_path.join("temp");
    for directory in [
        &config,
        &data,
        &home,
        &xdg_config,
        &xdg_data,
        &appdata,
        &local_appdata,
        &temp,
    ] {
        fs::create_dir_all(directory).expect("create isolated directory");
    }

    let mut child = Command::new(std::env::current_exe().expect("current test executable"));
    child
        .args(["--exact", CHILD_TEST])
        .env(CHILD_MARKER, root_path)
        .env("DISNANS_CLIENT_CONFIG_DIR", &config)
        .env("DISNANS_CLIENT_DATA_DIR", &data)
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("XDG_CONFIG_HOME", &xdg_config)
        .env("XDG_DATA_HOME", &xdg_data)
        .env("APPDATA", &appdata)
        .env("LOCALAPPDATA", &local_appdata)
        .env("TMPDIR", &temp)
        .env("TMP", &temp)
        .env("TEMP", &temp)
        .current_dir(root_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = child.spawn().expect("spawn isolated test process");
    let stdout = child.stdout.take().expect("child stdout pipe");
    let stderr = child.stderr.take().expect("child stderr pipe");
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .take(1024 * 1024)
            .read_to_end(&mut bytes)
            .expect("read child stdout");
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .take(1024 * 1024)
            .read_to_end(&mut bytes)
            .expect("read child stderr");
        bytes
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait().expect("poll isolated test process") {
            Some(status) => break status,
            None if start.elapsed() > Duration::from_secs(45) => {
                let _ = child.kill();
                let _ = child.wait();
                let stdout = stdout_reader
                    .join()
                    .expect("collect timed-out child stdout");
                let stderr = stderr_reader
                    .join()
                    .expect("collect timed-out child stderr");
                panic!(
                    "isolated test timed out; stdout={} stderr={}",
                    String::from_utf8_lossy(&stdout),
                    String::from_utf8_lossy(&stderr)
                );
            }
            None => thread::sleep(Duration::from_millis(20)),
        }
    };
    let stdout = stdout_reader.join().expect("collect child stdout");
    let stderr = stderr_reader.join().expect("collect child stderr");
    let stdout_text = String::from_utf8_lossy(&stdout);
    let stderr_text = String::from_utf8_lossy(&stderr);
    assert!(
        status.success(),
        "isolated bridge test failed ({:?}); stdout={} stderr={}",
        status.code(),
        stdout_text,
        stderr_text
    );
    assert!(
        stdout_text.contains("test result: ok. 1 passed; 0 failed;"),
        "child ran no test or reported an unexpected count; stdout={stdout_text} stderr={stderr_text}"
    );

    let expected_config = br#"{"schema_version":2,"server_url":"https://future"}"#;
    assert_eq!(
        fs::read(config.join("config.json")).unwrap(),
        expected_config
    );
    assert!(draft_json_files(&data).iter().any(|path| {
        fs::read(path).is_ok_and(|bytes| bytes == br#"{"schema_version":2,"body":"future"}"#)
    }));
}

/// This test is inert during the normal test-suite run. The parent invokes only this exact test
/// after setting the marker and all storage/home environment variables to its temporary root.
#[test]
fn isolated_bridge_child() {
    let Some(marker) = std::env::var_os(CHILD_MARKER).map(PathBuf::from) else {
        return;
    };
    let current_dir = std::env::current_dir().expect("child current directory");
    let config = marker.join("config");
    let data = marker.join("data");
    if marker != current_dir
        || std::env::var_os("DISNANS_CLIENT_CONFIG_DIR").as_deref() != Some(config.as_os_str())
        || std::env::var_os("DISNANS_CLIENT_DATA_DIR").as_deref() != Some(data.as_os_str())
    {
        return;
    }

    tauri::async_runtime::block_on(async {
        let config_path = PathBuf::from(
            std::env::var_os("DISNANS_CLIENT_CONFIG_DIR").expect("isolated config path"),
        )
        .join("config.json");
        let data_dir =
            PathBuf::from(std::env::var_os("DISNANS_CLIENT_DATA_DIR").expect("isolated data path"));
        let core_draft_key = core_draft_key();
        let core_cleared_draft_key = core_cleared_draft_key();

        // Reading absent config/draft and importing an absent legacy value are read-only with
        // respect to value files: no config or draft record is created.
        assert_eq!(
            client_storage_read(server_key()).await.unwrap(),
            StorageState::Missing
        );
        assert!(!config_path.exists());
        assert_eq!(
            client_storage_import(ImportArgs {
                key: server_key(),
                value: ImportValue::Missing,
            })
            .await
            .unwrap(),
            StorageState::Missing
        );
        assert!(!config_path.exists());
        assert_eq!(
            client_storage_read(draft_key()).await.unwrap(),
            StorageState::Missing
        );
        assert!(draft_json_files(&data_dir).is_empty());
        assert_eq!(
            client_storage_import(ImportArgs {
                key: draft_key(),
                value: ImportValue::Missing,
            })
            .await
            .unwrap(),
            StorageState::Missing
        );
        assert!(draft_json_files(&data_dir).is_empty());
        assert_eq!(
            client_storage_import(ImportArgs {
                key: cleared_draft_storage_key(),
                value: ImportValue::Cleared,
            })
            .await
            .unwrap(),
            StorageState::Cleared
        );
        assert_eq!(
            client_storage_import(ImportArgs {
                key: cleared_draft_storage_key(),
                value: ImportValue::Value("stale legacy value".into()),
            })
            .await
            .unwrap(),
            StorageState::Cleared
        );
        assert_eq!(
            LocalStore::open_default()
                .unwrap()
                .load_draft_state(&core_cleared_draft_key)
                .unwrap(),
            StoredValue::Cleared
        );

        // Import legacy server and draft values, then verify the core store reads the same data.
        assert_eq!(
            client_storage_import(ImportArgs {
                key: server_key(),
                value: ImportValue::Value(SERVER_URL.into()),
            })
            .await
            .unwrap(),
            StorageState::Value(SERVER_URL.into())
        );
        assert_eq!(
            LocalStore::open_default()
                .unwrap()
                .server_setting()
                .unwrap(),
            StoredValue::Value(SERVER_URL.into())
        );
        assert_eq!(
            client_storage_import(ImportArgs {
                key: draft_key(),
                value: ImportValue::Value("draft imported from legacy".into()),
            })
            .await
            .unwrap(),
            StorageState::Value("draft imported from legacy".into())
        );
        assert_eq!(
            LocalStore::open_default()
                .unwrap()
                .load_draft_state(&core_draft_key)
                .unwrap(),
            StoredValue::Value("draft imported from legacy".into())
        );

        // Explicit clears persist tombstones; later legacy imports cannot resurrect either value.
        assert_eq!(
            client_storage_write(WriteArgs {
                key: server_key(),
                value: serde_json::Value::Null,
            })
            .await
            .unwrap(),
            StorageState::Cleared
        );
        assert_eq!(
            client_storage_import(ImportArgs {
                key: server_key(),
                value: ImportValue::Value(SERVER_URL.into()),
            })
            .await
            .unwrap(),
            StorageState::Cleared
        );
        assert_eq!(
            LocalStore::open_default()
                .unwrap()
                .server_setting()
                .unwrap(),
            StoredValue::Cleared
        );
        assert_eq!(
            client_storage_write(WriteArgs {
                key: draft_key(),
                value: serde_json::Value::Null,
            })
            .await
            .unwrap(),
            StorageState::Cleared
        );
        assert_eq!(
            client_storage_import(ImportArgs {
                key: draft_key(),
                value: ImportValue::Value("stale legacy draft".into()),
            })
            .await
            .unwrap(),
            StorageState::Cleared
        );
        assert_eq!(
            LocalStore::open_default()
                .unwrap()
                .load_draft_state(&core_draft_key)
                .unwrap(),
            StoredValue::Cleared
        );

        // Value writes are visible through the core API, not just through the bridge readback.
        assert_eq!(
            client_storage_write(WriteArgs {
                key: draft_key(),
                value: json!("latest draft"),
            })
            .await
            .unwrap(),
            StorageState::Value("latest draft".into())
        );
        assert_eq!(
            LocalStore::open_default()
                .unwrap()
                .load_draft_state(&core_draft_key)
                .unwrap(),
            StoredValue::Value("latest draft".into())
        );

        // A damaged draft record and an unknown future schema must fail closed on reads, writes,
        // and imports without replacing the bytes. Repeat for config, which also holds tombstones.
        let draft_path = draft_json_files(&data_dir)
            .into_iter()
            .find(|path| {
                fs::read(path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                    .is_some_and(|record| record["body"] == "latest draft")
            })
            .expect("latest draft record was written");
        verify_corrupt_and_future_are_preserved(
            &draft_path,
            [
                b"not json".as_slice(),
                br#"{"schema_version":2,"body":"future"}"#,
            ],
            draft_key(),
            "overwrite attempt",
        )
        .await;

        verify_corrupt_and_future_are_preserved(
            &config_path,
            [
                b"not json".as_slice(),
                br#"{"schema_version":2,"server_url":"https://future"}"#,
            ],
            server_key(),
            SERVER_URL,
        )
        .await;
    });
}

async fn verify_corrupt_and_future_are_preserved(
    path: &Path,
    invalid_records: [&[u8]; 2],
    key: StorageKey,
    replacement: &str,
) {
    for invalid in invalid_records {
        fs::write(path, invalid).expect("write test corruption");
        let original = fs::read(path).expect("read original bytes");
        assert!(client_storage_read(key.clone()).await.is_err());
        assert_eq!(fs::read(path).unwrap(), original);
        assert!(
            client_storage_write(WriteArgs {
                key: key.clone(),
                value: json!(replacement),
            })
            .await
            .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), original);
        assert!(
            client_storage_import(ImportArgs {
                key: key.clone(),
                value: ImportValue::Value(replacement.to_owned()),
            })
            .await
            .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), original);
    }
}

fn server_key() -> StorageKey {
    serde_json::from_value(json!({ "kind": "server" })).unwrap()
}

fn draft_key() -> StorageKey {
    serde_json::from_value(json!({
        "kind": "draft",
        "serverUrl": SERVER_URL,
        "userId": USER_ID,
        "place": "main"
    }))
    .unwrap()
}

fn core_draft_key() -> DraftKey {
    DraftKey {
        server: ServerUrl::parse(SERVER_URL).unwrap(),
        user_id: USER_ID.into(),
        place: DraftPlace::Main,
    }
}

/// 消去の確認に使う、別の利用者の下書き（メインチャットの下書きは 1 つの利用者につき 1 つだけなので）
const CLEAR_USER_ID: &str = "u-clear";

fn cleared_draft_storage_key() -> StorageKey {
    serde_json::from_value(json!({
        "kind": "draft",
        "serverUrl": SERVER_URL,
        "userId": CLEAR_USER_ID,
        "place": "main"
    }))
    .unwrap()
}

fn core_cleared_draft_key() -> DraftKey {
    DraftKey {
        server: ServerUrl::parse(SERVER_URL).unwrap(),
        user_id: CLEAR_USER_ID.into(),
        place: DraftPlace::Main,
    }
}

fn draft_json_files(data_dir: &Path) -> Vec<PathBuf> {
    let mut files = fs::read_dir(data_dir.join("drafts"))
        .expect("list draft directory")
        .map(|entry| entry.expect("read draft entry").path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}
