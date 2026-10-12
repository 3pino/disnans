//! CLI subprocess と GUI bridge が共用する client-core ファイルの相互運用性。
//! ネットワークにも実ユーザーの設定にも触れない（全 subprocess を一時ディレクトリへ隔離）。

use std::{
    path::Path,
    process::{Command, Output},
};

use disnans_client_core::{DraftKey, DraftPlace, LocalStore, ServerUrl, StoreError, StoredValue};
use serde_json::Value;

fn run_cli(root: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_disnans"))
        .args(args)
        .env("DISNANS_CLIENT_CONFIG_DIR", root.join("config"))
        .env("DISNANS_CLIENT_DATA_DIR", root.join("data"))
        .env("XDG_CONFIG_HOME", root.join("xdg-config"))
        .env("XDG_DATA_HOME", root.join("xdg-data"))
        .env("APPDATA", root.join("appdata"))
        .env("LOCALAPPDATA", root.join("local-appdata"))
        .env("HOME", root.join("home"))
        .env("USERPROFILE", root.join("user-profile"))
        .env_remove("DISNANS_DEV")
        .env_remove("DISNANS_DATA_DIR")
        .current_dir(root)
        .output()
        .expect("一時環境から CLI を起動できること")
}

fn success(output: Output) -> String {
    assert!(
        output.status.success(),
        "exit={:?}, stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn show_json(root: &Path) -> Value {
    serde_json::from_str(&success(run_cli(root, &["config", "show", "--json"]))).unwrap()
}

#[test]
fn core_and_cli_read_and_write_the_same_config() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let core = LocalStore::open_at(root).unwrap();
    assert_eq!(core.server_setting().unwrap(), StoredValue::Missing);

    // GUI bridge が core に書いた接続先を、別プロセスの CLI がそのまま読む。
    core.set_server_url(Some("100.111.22.33:8080/")).unwrap();
    assert_eq!(show_json(root)["server_url"], "http://100.111.22.33:8080");
    assert_eq!(
        success(run_cli(root, &["config", "show"])),
        "http://100.111.22.33:8080\n"
    );

    // CLI による上書きも GUI bridge が使う core から読める。schema は同じファイル1つ。
    success(run_cli(
        root,
        &["config", "set-server", "node.tailnet.ts.net:8080/"],
    ));
    let expected = "http://node.tailnet.ts.net:8080";
    assert_eq!(
        core.server_setting().unwrap(),
        StoredValue::Value(expected.into())
    );
    let disk: Value =
        serde_json::from_slice(&std::fs::read(root.join("config/config.json")).unwrap()).unwrap();
    assert_eq!(disk["schema_version"], 1);
    assert_eq!(disk["server_url"], expected);
}

#[test]
fn missing_and_cleared_config_are_distinct_and_not_resurrected() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let core = LocalStore::open_at(root).unwrap();

    assert_eq!(core.server_setting().unwrap(), StoredValue::Missing);
    assert_eq!(show_json(root)["server_url"], Value::Null);
    assert_eq!(core.server_setting().unwrap(), StoredValue::Missing);
    assert!(!root.join("config/config.json").exists());

    core.set_server_url(None).unwrap();
    assert_eq!(core.server_setting().unwrap(), StoredValue::Cleared);
    assert_eq!(show_json(root)["server_url"], Value::Null);
    // GUI で以前使っていた localStorage の値をあとから再適用しない。
    assert!(!core.import_server_url_if_missing("old-node:8080").unwrap());
    assert_eq!(core.server_setting().unwrap(), StoredValue::Cleared);
    let disk: Value =
        serde_json::from_slice(&std::fs::read(root.join("config/config.json")).unwrap()).unwrap();
    assert_eq!(disk["schema_version"], 1);
    assert_eq!(disk["server_url"], Value::Null);

    success(run_cli(root, &["config", "set-server", "new-node:8080"]));
    assert_eq!(
        core.server_setting().unwrap(),
        StoredValue::Value("http://new-node:8080".into())
    );
}

#[test]
fn corrupt_or_unknown_config_is_never_overwritten_by_cli() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let core = LocalStore::open_at(root).unwrap();
    let path = root.join("config/config.json");

    for bytes in [
        b"{broken json".as_slice(),
        br#"{"schema_version":999,"server_url":null}"#.as_slice(),
    ] {
        std::fs::write(&path, bytes).unwrap();
        for args in [
            vec!["config", "show", "--json"],
            vec!["config", "set-server", "replacement:8080"],
        ] {
            let output = run_cli(root, &args);
            assert_eq!(output.status.code(), Some(1));
            assert!(output.stdout.is_empty());
            assert!(!output.stderr.is_empty());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
        assert!(matches!(
            core.server_setting(),
            Err(StoreError::Json(_) | StoreError::UnsupportedSchema(_))
        ));
    }
}

#[test]
fn cli_config_updates_do_not_overwrite_gui_drafts_or_clear_tombstones() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    let core = LocalStore::open_at(root).unwrap();
    let key = DraftKey {
        server: ServerUrl::parse("node:8080").unwrap(),
        user_id: "01-user".into(),
        place: DraftPlace::Main,
    };

    core.save_draft(&key, Some("GUIの下書き\n二行目")).unwrap();
    success(run_cli(root, &["config", "set-server", "node:8080"]));
    let another_core = LocalStore::open_at(root).unwrap();
    assert_eq!(
        another_core.load_draft_state(&key).unwrap(),
        StoredValue::Value("GUIの下書き\n二行目".into())
    );

    another_core.save_draft(&key, None).unwrap();
    success(run_cli(root, &["config", "show", "--json"]));
    assert_eq!(core.load_draft_state(&key).unwrap(), StoredValue::Cleared);
    assert!(!core.import_draft_if_missing(&key, "古い下書き").unwrap());
    assert_eq!(core.load_draft_state(&key).unwrap(), StoredValue::Cleared);
}
