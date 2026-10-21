// 自動更新の結合テスト。GitHub の代わりに、ローカルの偽サーバーへ向ける（本番の URL には通信しない）。
// 新しいバイナリの代わりに、`--version` に答えるシェルスクリプトを使う。
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::extract::State;
use axum::response::IntoResponse;
use axum::routing::get;
use disnans_server::update::{ASSET_NAME, Updater, sha256_hex};

struct Fake {
    release: String,
    bin: Vec<u8>,
    sha: String,
    hits: AtomicUsize,
}

async fn release_handler(State(f): State<Arc<Fake>>) -> impl IntoResponse {
    f.hits.fetch_add(1, Ordering::SeqCst);
    f.release.clone()
}
async fn bin_handler(State(f): State<Arc<Fake>>) -> Vec<u8> {
    f.bin.clone()
}
async fn sha_handler(State(f): State<Arc<Fake>>) -> String {
    f.sha.clone()
}

/// `--version` で `version_line` を返すシェルスクリプト
fn script(version_line: &str) -> Vec<u8> {
    format!("#!/bin/sh\necho '{version_line}'\n").into_bytes()
}

fn release_json(base: &str, tag: &str, prerelease: bool) -> String {
    format!(
        r#"{{"tag_name":"{tag}","draft":false,"prerelease":{prerelease},"assets":[
            {{"name":"{ASSET_NAME}","browser_download_url":"{base}/bin"}},
            {{"name":"{ASSET_NAME}.sha256","browser_download_url":"{base}/sha"}}
        ]}}"#
    )
}

/// 一時ディレクトリに「今のバイナリ」を置く
fn current_exe(dir: &Path) -> PathBuf {
    let exe = dir.join("disnans-server");
    std::fs::write(&exe, b"OLD BINARY").unwrap();
    std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
    exe
}

/// 偽のリリース API（/release・/bin・/sha）を立てて、/release の URL を返す。
/// 本文はベース URL に依存するので、先にポートを決めてから作る。
async fn start(
    tag: &str,
    bin: Vec<u8>,
    sha_override: Option<String>,
    prerelease: bool,
) -> (String, Arc<Fake>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let sha = sha_override.unwrap_or_else(|| format!("{}  {ASSET_NAME}\n", sha256_hex(&bin)));
    let fake = Arc::new(Fake {
        release: release_json(&base, tag, prerelease),
        bin,
        sha,
        hits: AtomicUsize::new(0),
    });
    let app = Router::new()
        .route("/release", get(release_handler))
        .route("/bin", get(bin_handler))
        .route("/sha", get(sha_handler))
        .with_state(fake.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("{base}/release"), fake)
}

#[tokio::test]
async fn newer_release_replaces_the_binary_and_keeps_prev() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    let (url, _fake) = start("v0.3.0", script("disnans-server 0.3.0"), None, false).await;
    let up = Updater::new(url, "0.2.0", exe.clone()).unwrap();

    assert_eq!(up.check_once().await.unwrap(), Some("0.3.0".into()));
    assert_eq!(std::fs::read(&exe).unwrap(), script("disnans-server 0.3.0"));
    assert_eq!(
        std::fs::read(dir.path().join("disnans-server.prev")).unwrap(),
        b"OLD BINARY"
    );
    let mode = std::fs::metadata(&exe).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o755);
    assert!(
        !dir.path().join("disnans-server.update").exists(),
        "一時ファイルは残らない"
    );
}

#[tokio::test]
async fn same_or_older_release_does_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    let (url, fake) = start("v0.2.0", script("disnans-server 0.2.0"), None, false).await;
    let up = Updater::new(url, "0.2.0", exe.clone()).unwrap();
    assert_eq!(up.check_once().await.unwrap(), None);
    assert_eq!(std::fs::read(&exe).unwrap(), b"OLD BINARY");
    assert_eq!(
        fake.hits.load(Ordering::SeqCst),
        1,
        "確認は行うが、資産は取らない"
    );
    assert!(!dir.path().join("disnans-server.prev").exists());
}

#[tokio::test]
async fn prerelease_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    let (url, _fake) = start("v0.3.0", script("disnans-server 0.3.0"), None, true).await;
    let up = Updater::new(url, "0.2.0", exe.clone()).unwrap();
    assert_eq!(up.check_once().await.unwrap(), None);
    assert_eq!(std::fs::read(&exe).unwrap(), b"OLD BINARY");
}

#[tokio::test]
async fn sha_mismatch_keeps_the_current_binary() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    let wrong = format!("{}  {ASSET_NAME}\n", "0".repeat(64));
    let (url, _fake) = start("v0.3.0", script("disnans-server 0.3.0"), Some(wrong), false).await;
    let up = Updater::new(url, "0.2.0", exe.clone()).unwrap();
    let err = up.check_once().await.unwrap_err();
    assert!(err.contains("sha256"), "{err}");
    assert_eq!(std::fs::read(&exe).unwrap(), b"OLD BINARY");
    assert!(!dir.path().join("disnans-server.update").exists());
}

#[tokio::test]
async fn wrong_version_output_is_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    // 資産は正しいが、起動すると別の版を答える
    let (url, _fake) = start("v0.3.0", script("disnans-server 0.2.9"), None, false).await;
    let up = Updater::new(url, "0.2.0", exe.clone()).unwrap();
    let err = up.check_once().await.unwrap_err();
    assert!(err.contains("--version"), "{err}");
    assert_eq!(std::fs::read(&exe).unwrap(), b"OLD BINARY");
    assert!(!dir.path().join("disnans-server.update").exists());
    assert!(!dir.path().join("disnans-server.prev").exists());
}

#[tokio::test]
async fn gives_up_on_a_version_after_three_failures() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    let wrong = format!("{}  {ASSET_NAME}\n", "0".repeat(64));
    let (url, fake) = start("v0.3.0", script("disnans-server 0.3.0"), Some(wrong), false).await;
    let up = Updater::new(url, "0.2.0", exe).unwrap();
    for _ in 0..3 {
        assert!(up.check_once().await.is_err());
    }
    let hits = fake.hits.load(Ordering::SeqCst);
    // 諦めたあとは資産を取りに行かず、「新しい版はない」と同じ扱い（確認だけ行う）
    assert_eq!(up.check_once().await.unwrap(), None);
    assert_eq!(fake.hits.load(Ordering::SeqCst), hits + 1);
}

#[tokio::test]
async fn unreachable_server_is_an_error_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    let exe = current_exe(dir.path());
    let up = Updater::new("http://127.0.0.1:9/release".into(), "0.2.0", exe.clone()).unwrap();
    assert!(up.check_once().await.is_err());
    assert_eq!(std::fs::read(&exe).unwrap(), b"OLD BINARY");
}
