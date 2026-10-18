//! Process-boundary checks for the shared file store. Never uses platform-default directories.

use std::{
    fs,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use disnans_client_core::{DraftKey, DraftPlace, LocalStore, ServerUrl};

fn key(user: &str) -> DraftKey {
    DraftKey {
        server: ServerUrl::parse("localhost:8080").unwrap(),
        user_id: user.to_owned(),
        place: DraftPlace::Main,
    }
}

#[test]
fn malformed_configuration_is_not_overwritten_by_a_save() {
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::open_at(temp.path()).unwrap();
    store.set_server_url(Some("localhost:8080")).unwrap();
    let config = temp.path().join("config/config.json");
    let original = b"{this is not valid JSON";
    fs::write(&config, original).unwrap();

    assert!(store.server_url().is_err());
    assert!(store.set_server_url(Some("localhost:9090")).is_err());
    assert_eq!(fs::read(config).unwrap(), original);
}

struct TestChild(Option<Child>);

impl TestChild {
    fn spawn(root: &std::path::Path, writer: &str) -> Self {
        Self::from_command(
            Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "storage_writer_subprocess", "--nocapture"])
                .env("DISNANS_STORAGE_TEST_ROOT", root)
                .env("DISNANS_STORAGE_TEST_WRITER", writer),
        )
    }

    fn from_command(command: &mut Command) -> Self {
        Self(Some(
            command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ))
    }

    fn finished(&mut self) -> bool {
        self.0.as_mut().unwrap().try_wait().unwrap().is_some()
    }

    fn assert_success(mut self) {
        let output = self.0.take().unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "storage subprocess failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

impl Drop for TestChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[test]
fn concurrent_process_saves_are_complete_and_last_save_wins() {
    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::open_at(temp.path()).unwrap();
    let mut a = TestChild::spawn(temp.path(), "a");
    let mut b = TestChild::spawn(temp.path(), "b");
    let deadline = Instant::now() + Duration::from_secs(20);

    loop {
        if let Some(value) = store.load_draft(&key("shared")).unwrap() {
            assert!(value == "a".repeat(4096) || value == "b".repeat(4096));
        }
        // A reader sees a complete, valid configuration throughout replacement.
        if let Some(server) = store.server_url().unwrap() {
            ServerUrl::parse(&server).unwrap();
        }
        if a.finished() && b.finished() {
            break;
        }
        assert!(Instant::now() < deadline, "storage subprocess timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
    a.assert_success();
    b.assert_success();
    assert_eq!(store.load_draft(&key("a")).unwrap().as_deref(), Some("a"));
    assert_eq!(store.load_draft(&key("b")).unwrap().as_deref(), Some("b"));

    // A save after both processes finished is the definite winner, independent of clock time.
    store.save_draft(&key("shared"), Some("last save")).unwrap();
    store.set_server_url(Some("localhost:9999")).unwrap();
    assert_eq!(
        store.load_draft(&key("shared")).unwrap().as_deref(),
        Some("last save")
    );
    assert_eq!(
        store.server_url().unwrap().as_deref(),
        Some("http://localhost:9999")
    );
}

#[test]
fn storage_writer_subprocess() {
    // This test is also discovered by the normal runner; only the explicitly spawned instance writes.
    let Some(root) = std::env::var_os("DISNANS_STORAGE_TEST_ROOT") else {
        return;
    };
    let writer = std::env::var("DISNANS_STORAGE_TEST_WRITER").unwrap();
    assert!(writer == "a" || writer == "b");
    let store = LocalStore::open_at(root).unwrap();
    for _ in 0..32 {
        store
            .save_draft(&key("shared"), Some(&writer.repeat(4096)))
            .unwrap();
        store.save_draft(&key(&writer), Some(&writer)).unwrap();
        let server = if writer == "a" {
            "localhost:8001"
        } else {
            "localhost:8002"
        };
        store.set_server_url(Some(server)).unwrap();
    }
}

fn default_store_child(root: &std::path::Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "storage_default_path_subprocess", "--nocapture"])
        .env("DISNANS_STORAGE_DEFAULT_TEST_ROOT", root)
        .env("DISNANS_CLIENT_CONFIG_DIR", root.join("client-config"))
        .env("DISNANS_CLIENT_DATA_DIR", root.join("client-data"))
        .env_remove("HOME")
        .env_remove("USERPROFILE")
        .env_remove("APPDATA")
        .env_remove("LOCALAPPDATA")
        .env_remove("XDG_CONFIG_HOME")
        .env_remove("XDG_DATA_HOME")
        .current_dir(root);
    command
}

#[test]
fn explicit_directory_overrides_work_without_platform_default_environment() {
    let temp = tempfile::tempdir().unwrap();
    let mut command = default_store_child(temp.path());
    command.env("DISNANS_STORAGE_DEFAULT_TEST_EXPECT", "success");
    TestChild::from_command(&mut command).assert_success();
    assert!(temp.path().join("client-config/config.json").is_file());
    assert!(temp.path().join("client-data/drafts").is_dir());
    assert!(!temp.path().join(".config").exists());
    assert!(!temp.path().join("AppData").exists());
}

#[test]
fn invalid_explicit_directory_overrides_fail_instead_of_using_user_defaults() {
    for invalid in ["relative-directory", ""] {
        let temp = tempfile::tempdir().unwrap();
        let mut command = default_store_child(temp.path());
        command
            .env("DISNANS_CLIENT_CONFIG_DIR", invalid)
            .env("DISNANS_STORAGE_DEFAULT_TEST_EXPECT", "error")
            // Even if normal defaults exist, an explicitly invalid override must not use them.
            .env("HOME", temp.path().join("fallback-home"))
            .env("USERPROFILE", temp.path().join("fallback-home"))
            .env("APPDATA", temp.path().join("fallback-appdata"))
            .env("LOCALAPPDATA", temp.path().join("fallback-local"));
        TestChild::from_command(&mut command).assert_success();
        assert!(!temp.path().join("fallback-home").exists());
        assert!(!temp.path().join("fallback-appdata").exists());
        assert!(!temp.path().join("client-data").exists());
    }
}

#[test]
fn missing_default_directories_do_not_create_configuration_in_the_working_directory() {
    let temp = tempfile::tempdir().unwrap();
    let mut command = default_store_child(temp.path());
    command
        .env_remove("DISNANS_CLIENT_CONFIG_DIR")
        .env_remove("DISNANS_CLIENT_DATA_DIR")
        .env("DISNANS_STORAGE_DEFAULT_TEST_EXPECT", "error");
    TestChild::from_command(&mut command).assert_success();
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
}

#[test]
fn storage_default_path_subprocess() {
    let Some(root) = std::env::var_os("DISNANS_STORAGE_DEFAULT_TEST_ROOT") else {
        return;
    };
    match std::env::var("DISNANS_STORAGE_DEFAULT_TEST_EXPECT")
        .unwrap()
        .as_str()
    {
        "error" => assert!(LocalStore::open_default().is_err()),
        "success" => {
            let store = LocalStore::open_default().unwrap();
            store.set_server_url(Some("localhost:8080")).unwrap();
            assert_eq!(
                store.server_url().unwrap().as_deref(),
                Some("http://localhost:8080")
            );
            assert!(
                std::path::Path::new(&root)
                    .join("client-config/config.json")
                    .is_file()
            );
        }
        _ => panic!("unexpected default-store test mode"),
    }
}

#[cfg(unix)]
#[test]
fn dedicated_directories_and_all_files_have_private_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::open_at(temp.path()).unwrap();
    store.set_server_url(Some("localhost:8080")).unwrap();
    store
        .save_draft(&key("user"), Some("private text"))
        .unwrap();
    for dir in ["config", "data", "data/drafts"] {
        let path = temp.path().join(dir);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_file() {
                assert_eq!(
                    entry.metadata().unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
    }
}

#[test]
fn device_id_is_created_once_per_surface_and_survives_reopen() {
    use disnans_client_core::{Surface, is_valid_device_id};

    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::open_at(temp.path()).unwrap();
    let tauri = store.device_id(Surface::Tauri).unwrap();
    let tui = store.device_id(Surface::Tui).unwrap();
    assert!(is_valid_device_id(&tauri));
    assert_eq!(tauri.len(), 26, "ULID");
    assert_ne!(tauri, tui, "each surface has its own device");

    // 開き直しても同じ ID（再起動で端末が増えない）
    let reopened = LocalStore::open_at(temp.path()).unwrap();
    assert_eq!(reopened.device_id(Surface::Tauri).unwrap(), tauri);
    assert_eq!(reopened.device_id(Surface::Tui).unwrap(), tui);
    assert!(temp.path().join("config/devices.json").is_file());
}

#[test]
fn invalid_or_corrupt_device_file_is_an_error_and_is_not_replaced() {
    use disnans_client_core::Surface;

    let temp = tempfile::tempdir().unwrap();
    let store = LocalStore::open_at(temp.path()).unwrap();
    let path = temp.path().join("config/devices.json");

    let bad_id = br#"{"schema_version":1,"ids":{"tauri":"not/valid"}}"#;
    fs::write(&path, bad_id).unwrap();
    assert!(store.device_id(Surface::Tauri).is_err());
    assert_eq!(fs::read(&path).unwrap(), bad_id, "not replaced");

    let corrupt = b"{oops";
    fs::write(&path, corrupt).unwrap();
    assert!(store.device_id(Surface::Cli).is_err());
    assert_eq!(fs::read(&path).unwrap(), corrupt, "not replaced");

    let future = br#"{"schema_version":2,"ids":{}}"#;
    fs::write(&path, future).unwrap();
    assert!(store.device_id(Surface::Cli).is_err());
    assert_eq!(fs::read(&path).unwrap(), future, "not replaced");
}
