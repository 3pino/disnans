//! 添付・共有フォルダのファイルを、ブラウザを経由せず直接保存する（Tauri 版）。
//!
//! - 取得は client-core の `RestClient::download`（開発用ヘッダー・証明書の設定は読取・書込と同じ。時間制限なし）。
//! - デスクトップ: ダウンロードフォルダへ、同じ名前を上書きせず保存する（`name (2).ext` と番号を付ける）。
//!   保存先は、取得が終わるまで予約しておき、途中で失敗したら消す（中途半端なファイルを残さない）。
//! - Android: いったんキャッシュの一時ファイルへ書き、Kotlin（apk-updater プラグイン）が MediaStore の Downloads へ移す。
//! - 「開く」は、この実行で保存したものだけ（ハンドルで引く）。任意のパスは開かない。
//!
//! 純粋な部分（パスの検査・ファイル名・型・番号付け）はテストする。保存先の実際の動作は OS で確かめる。

use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use disnans_client_core::{ReadFailure, RestClient, ServerUrl, SharedDownload};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State, Wry};

/// 保存できる大きさの上限（バイト）。これを超えるものは、取得を始める前か、途中で止める
pub const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 同じ名前を何番まで試すか（超えたら保存しない）
const MAX_NAME_TRIES: u32 = 1000;
/// 「開く」のために覚えておく、この実行で保存したものの数
const MAX_REMEMBERED: usize = 64;
/// ファイル名の長さの上限（文字数）
const MAX_NAME_CHARS: usize = 200;

// ---- 純粋な部分 ----

/// 取得してよい API のパスか（`/api/files/...` と `/api/shared/...` だけ。クエリ・区切りの `\`・`..` は使わない）
pub fn is_download_path(path: &str) -> bool {
    let allowed = path.starts_with("/api/files/") || path.starts_with("/api/shared/");
    allowed
        && path.len() <= 4096
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '?' | '#' | '\\'))
        && !path.split('/').any(|seg| seg == "." || seg == "..")
}

/// 保存名。区切り・Windows で使えない文字・制御文字は `_` にし、前後の空白と末尾の `.`・空白は捨てる。
/// 空・`.`・`..` は `download` にする。Windows の予約名（CON・NUL など）は先頭に `_` を付ける。
pub fn sanitize_name(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut name = replaced.trim().trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() || name == "." || name == ".." {
        name = "download".to_owned();
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if is_reserved_windows_name(&stem) {
        name = format!("_{name}");
    }
    truncate_keeping_extension(&name, MAX_NAME_CHARS)
}

fn is_reserved_windows_name(stem: &str) -> bool {
    matches!(stem, "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

/// 長すぎる名前を、拡張子を残して切る（拡張子が長すぎるときは、拡張子も切る）
fn truncate_keeping_extension(name: &str, max: usize) -> String {
    if name.chars().count() <= max {
        return name.to_owned();
    }
    let (stem, ext) = split_extension(name);
    let ext_len = ext.chars().count();
    if ext_len > 16 || ext_len >= max {
        return name.chars().take(max).collect();
    }
    let keep = max - ext_len;
    let mut out: String = stem.chars().take(keep).collect();
    out.push_str(ext);
    out
}

/// 拡張子（最後の `.` から後ろ。先頭の `.` だけのもの＝隠しファイルには拡張子が無い）
fn split_extension(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// n 番目の候補の名前（1 番目は元の名前）。`archive.tar.gz` → `archive.tar (2).gz`、`.bashrc` → `.bashrc (2)`、`docs` → `docs (2)`
pub fn candidate_name(name: &str, n: u32) -> String {
    if n <= 1 {
        return name.to_owned();
    }
    let (stem, ext) = split_extension(name);
    format!("{stem} ({n}){ext}")
}

/// ファイル名からの型（MIME）。分からないものは application/octet-stream
pub fn mime_for(name: &str) -> &'static str {
    let (_, ext) = split_extension(name);
    match ext.to_ascii_lowercase().as_str() {
        ".png" => "image/png",
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".pdf" => "application/pdf",
        ".txt" | ".log" | ".md" => "text/plain",
        ".csv" => "text/csv",
        ".json" => "application/json",
        ".zip" => "application/zip",
        ".mp4" => "video/mp4",
        ".webm" => "video/webm",
        ".mov" => "video/quicktime",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".wav" => "audio/wav",
        ".ogg" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// 空き容量が足りないことを表す OS のエラー番号（Linux は ENOSPC、Windows は ERROR_DISK_FULL・ERROR_HANDLE_DISK_FULL）
fn is_disk_full(raw: Option<i32>) -> bool {
    #[cfg(unix)]
    {
        raw == Some(28)
    }
    #[cfg(windows)]
    {
        matches!(raw, Some(112) | Some(39))
    }
}

fn fail(code: &str, message: &str) -> ReadFailure {
    ReadFailure {
        status: None,
        code: code.to_owned(),
        message: message.to_owned(),
    }
}

/// 書き込みの失敗を、固定の code と短い日本語にする（パスや OS の文言は出さない）
fn io_failure(err: &std::io::Error) -> ReadFailure {
    if err.kind() == ErrorKind::PermissionDenied {
        fail("permission", "保存先に書き込めませんでした")
    } else if is_disk_full(err.raw_os_error()) {
        fail("no_space", "保存先の空き容量が足りません")
    } else {
        fail("io", "保存できませんでした")
    }
}

// ---- 保存 ----

/// 同じ名前が無いことを確かめて、新しいファイルとして作る（作るのと予約は同時。上書きはしない）
fn reserve(dir: &Path, name: &str) -> Result<(PathBuf, File), ReadFailure> {
    for n in 1..=MAX_NAME_TRIES {
        let path = dir.join(candidate_name(name, n));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(io_failure(&err)),
        }
    }
    Err(fail("io", "保存先の名前が決まりませんでした"))
}

/// 本文を断片ごとに書く。上限を超えたら止める
async fn stream_to(download: &mut SharedDownload, file: &mut File) -> Result<(), ReadFailure> {
    let mut total: u64 = 0;
    while let Some(chunk) = download.chunk().await? {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            return Err(fail("too_large", "大きすぎるため保存しません"));
        }
        file.write_all(&chunk).map_err(|err| io_failure(&err))?;
    }
    file.flush().map_err(|err| io_failure(&err))
}

/// 保存したもの。デスクトップはパス、Android は MediaStore の uri（開くときに型も要る）
#[cfg(not(target_os = "android"))]
enum Saved {
    Path(PathBuf),
}

#[cfg(target_os = "android")]
enum Saved {
    Uri { uri: String, mime: String },
}

#[derive(Default)]
pub struct DownloadRegistry {
    items: Mutex<VecDeque<(String, Saved)>>,
    next: AtomicU64,
}

impl DownloadRegistry {
    fn remember(&self, saved: Saved) -> String {
        let handle = format!("dl{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let mut items = self.items.lock().unwrap_or_else(|e| e.into_inner());
        if items.len() >= MAX_REMEMBERED {
            items.pop_front();
        }
        items.push_back((handle.clone(), saved));
        handle
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    pub handle: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenArgs {
    pub handle: String,
}

fn client(server: &str, dev_user: Option<&str>) -> Result<RestClient, ReadFailure> {
    let url = ServerUrl::parse(server)
        .map_err(|_| ReadFailure::invalid_request("サーバー URL が不正です"))?;
    RestClient::new(url, dev_user).map_err(ReadFailure::from)
}

/// ファイルを取得して保存する。成功したら、「開く」のためのハンドルと保存した名前を返す
#[tauri::command]
pub async fn api_download(
    app: AppHandle<Wry>,
    registry: State<'_, DownloadRegistry>,
    args: DownloadArgs,
) -> Result<Downloaded, ReadFailure> {
    if !is_download_path(&args.path) {
        return Err(ReadFailure::invalid_request("取得できないパスです"));
    }
    let name = sanitize_name(&args.name);
    let mut download = client(&args.server, args.dev_user.as_deref())?
        .download(&args.path)
        .await?;
    if download.len().is_some_and(|len| len > MAX_DOWNLOAD_BYTES) {
        return Err(fail("too_large", "大きすぎるため保存しません"));
    }
    let (saved, saved_name) = save(&app, &mut download, &name).await?;
    let handle = registry.remember(saved);
    Ok(Downloaded {
        handle,
        name: saved_name,
    })
}

#[cfg(not(target_os = "android"))]
async fn save(
    _app: &AppHandle<Wry>,
    download: &mut SharedDownload,
    name: &str,
) -> Result<(Saved, String), ReadFailure> {
    let dir = dirs::download_dir()
        .ok_or_else(|| fail("no_dir", "ダウンロードフォルダが見つかりません"))?;
    let (path, saved_name) = save_into_dir(&dir, download, name).await?;
    Ok((Saved::Path(path), saved_name))
}

/// フォルダへ保存する（同じ名前は番号を付ける）。途中で失敗したら、書きかけのファイルは消す
#[cfg(not(target_os = "android"))]
async fn save_into_dir(
    dir: &Path,
    download: &mut SharedDownload,
    name: &str,
) -> Result<(PathBuf, String), ReadFailure> {
    fs::create_dir_all(dir).map_err(|err| io_failure(&err))?;
    let (path, mut file) = reserve(dir, name)?;
    if let Err(err) = stream_to(download, &mut file).await {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(err);
    }
    drop(file);
    let saved_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_owned());
    Ok((path, saved_name))
}

#[cfg(target_os = "android")]
async fn save(
    app: &AppHandle<Wry>,
    download: &mut SharedDownload,
    name: &str,
) -> Result<(Saved, String), ReadFailure> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| fail("io", "保存できませんでした"))?
        .join("downloads");
    fs::create_dir_all(&dir).map_err(|err| io_failure(&err))?;
    let (tmp, mut file) = reserve(&dir, "download.part")?;
    let streamed = stream_to(download, &mut file).await;
    drop(file);
    if let Err(err) = streamed {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    let mime = mime_for(name);
    let result = android_media::save(app, &tmp.to_string_lossy(), name, mime).await;
    let _ = fs::remove_file(&tmp);
    match result {
        Ok(saved) => Ok((
            Saved::Uri {
                uri: saved.uri,
                mime: mime.to_owned(),
            },
            saved.name,
        )),
        Err(code) => Err(save_failure(&code)),
    }
}

/// Kotlin（apk-updater プラグイン）の MediaStore 操作の呼び出し。JSON の形はここで決める。
/// 失敗は Kotlin が固定の code で返す（例外は投げない）。
#[cfg(target_os = "android")]
mod android_media {
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Manager, Wry};
    use tauri_plugin_apk_updater::MediaHandle;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SaveArgs<'a> {
        path: &'a str,
        name: &'a str,
        mime: &'a str,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SaveReply {
        uri: Option<String>,
        name: Option<String>,
        code: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OpenArgs<'a> {
        uri: &'a str,
        mime: &'a str,
    }

    #[derive(Deserialize)]
    struct OpenReply {
        code: Option<String>,
    }

    /// 保存の結果（uri と、MediaStore が付けた名前）。失敗は code
    pub struct Saved {
        pub uri: String,
        pub name: String,
    }

    pub async fn save(
        app: &AppHandle<Wry>,
        path: &str,
        name: &str,
        mime: &str,
    ) -> Result<Saved, String> {
        let handle = app.state::<MediaHandle<Wry>>();
        let reply: SaveReply = handle
            .0
            .run_mobile_plugin_async("saveDownload", SaveArgs { path, name, mime })
            .await
            .map_err(|_| "io".to_owned())?;
        match (reply.uri, reply.name) {
            (Some(uri), Some(name)) => Ok(Saved { uri, name }),
            _ => Err(reply.code.unwrap_or_else(|| "io".to_owned())),
        }
    }

    pub async fn open(app: &AppHandle<Wry>, uri: &str, mime: &str) -> Result<(), String> {
        let handle = app.state::<MediaHandle<Wry>>();
        let reply: OpenReply = handle
            .0
            .run_mobile_plugin_async("openDownload", OpenArgs { uri, mime })
            .await
            .map_err(|_| "io".to_owned())?;
        match reply.code {
            None => Ok(()),
            Some(code) => Err(code),
        }
    }
}

/// Kotlin 側の失敗の code を、短い日本語にする
#[cfg(target_os = "android")]
fn save_failure(code: &str) -> ReadFailure {
    match code {
        "no_space" => fail("no_space", "保存先の空き容量が足りません"),
        "permission" => fail("permission", "保存先に書き込めませんでした"),
        "unsupported" => fail(
            "unsupported",
            "この Android では保存できません（Android 10 以降が必要です）",
        ),
        _ => fail("io", "保存できませんでした"),
    }
}

/// 保存したものを開く。ハンドルが無ければ（この実行で保存したものでなければ）開かない
#[tauri::command]
pub async fn api_download_open(
    app: AppHandle<Wry>,
    registry: State<'_, DownloadRegistry>,
    args: OpenArgs,
) -> Result<(), ReadFailure> {
    let found = {
        let items = registry.items.lock().unwrap_or_else(|e| e.into_inner());
        items
            .iter()
            .find(|(h, _)| *h == args.handle)
            .map(|(_, s)| open_target(s))
    };
    let target = found.ok_or_else(|| {
        fail(
            "not_found",
            "ファイルが見つかりません（もう一度ダウンロードしてください）",
        )
    })?;
    open_saved(&app, target).await
}

/// 開く先（型つき）。デスクトップはパス、Android は uri と型
enum OpenTarget {
    #[cfg(not(target_os = "android"))]
    Path(PathBuf),
    #[cfg(target_os = "android")]
    Uri { uri: String, mime: String },
}

fn open_target(saved: &Saved) -> OpenTarget {
    match saved {
        #[cfg(not(target_os = "android"))]
        Saved::Path(path) => OpenTarget::Path(path.clone()),
        #[cfg(target_os = "android")]
        Saved::Uri { uri, mime } => OpenTarget::Uri {
            uri: uri.clone(),
            mime: mime.clone(),
        },
    }
}

#[cfg(not(target_os = "android"))]
async fn open_saved(app: &AppHandle<Wry>, target: OpenTarget) -> Result<(), ReadFailure> {
    use tauri_plugin_opener::OpenerExt;
    let OpenTarget::Path(path) = target;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| fail("open_failed", "開けるアプリがありませんでした"))
}

#[cfg(target_os = "android")]
async fn open_saved(app: &AppHandle<Wry>, target: OpenTarget) -> Result<(), ReadFailure> {
    let OpenTarget::Uri { uri, mime } = target;
    android_media::open(app, &uri, &mime)
        .await
        .map_err(|_| fail("open_failed", "開けるアプリがありませんでした"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_api_file_and_shared_paths_are_fetched() {
        assert!(is_download_path("/api/files/01HX"));
        assert!(is_download_path("/api/shared/a/b%20c.txt"));
        assert!(!is_download_path("/api/me"));
        assert!(!is_download_path("https://evil.example/api/files/x"));
        assert!(!is_download_path("/api/shared/../secret"));
        assert!(!is_download_path("/api/shared/a/./b"));
        assert!(!is_download_path("/api/files/x?dev_user=a"));
        assert!(!is_download_path("/api/shared/a\\b"));
        assert!(!is_download_path("/api/shared/a\nb"));
        assert!(!is_download_path("/api/files/x#frag"));
    }

    #[test]
    fn names_drop_separators_and_forbidden_characters() {
        assert_eq!(sanitize_name("photo.png"), "photo.png");
        assert_eq!(sanitize_name("a/b\\c.txt"), "a_b_c.txt");
        assert_eq!(sanitize_name("x:y*z?.txt"), "x_y_z_.txt");
        assert_eq!(sanitize_name("a\u{0}b\u{7f}.txt"), "a_b_.txt");
        assert_eq!(sanitize_name("  spaced.pdf  "), "spaced.pdf");
        assert_eq!(sanitize_name("name. "), "name");
    }

    #[test]
    fn empty_and_dot_names_fall_back() {
        assert_eq!(sanitize_name(""), "download");
        assert_eq!(sanitize_name("   "), "download");
        assert_eq!(sanitize_name("."), "download");
        assert_eq!(sanitize_name(".."), "download");
        assert_eq!(sanitize_name("..."), "download");
    }

    #[test]
    fn windows_reserved_names_are_prefixed() {
        assert_eq!(sanitize_name("CON"), "_CON");
        assert_eq!(sanitize_name("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_name("com3.log"), "_com3.log");
        assert_eq!(sanitize_name("LPT9"), "_LPT9");
        // 予約名ではないもの
        assert_eq!(sanitize_name("COM0"), "COM0");
        assert_eq!(sanitize_name("console.txt"), "console.txt");
    }

    #[test]
    fn long_names_keep_the_extension() {
        let long = format!("{}.pdf", "a".repeat(300));
        let out = sanitize_name(&long);
        assert_eq!(out.chars().count(), MAX_NAME_CHARS);
        assert!(out.ends_with(".pdf"));
        let no_ext = "b".repeat(300);
        assert_eq!(sanitize_name(&no_ext).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn numbering_splits_at_the_last_dot_and_keeps_dotfiles_whole() {
        assert_eq!(candidate_name("photo.png", 1), "photo.png");
        assert_eq!(candidate_name("photo.png", 2), "photo (2).png");
        assert_eq!(candidate_name("archive.tar.gz", 2), "archive.tar (2).gz");
        assert_eq!(candidate_name(".bashrc", 2), ".bashrc (2)");
        assert_eq!(candidate_name("docs", 2), "docs (2)");
    }

    #[test]
    fn mime_comes_from_the_extension() {
        assert_eq!(mime_for("a.PNG"), "image/png");
        assert_eq!(mime_for("a.pdf"), "application/pdf");
        assert_eq!(mime_for("a.tar.gz"), "application/octet-stream");
        assert_eq!(mime_for("noext"), "application/octet-stream");
        assert_eq!(mime_for(".png"), "application/octet-stream");
    }

    #[test]
    fn reserve_never_overwrites_and_numbers_the_name() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"old").unwrap();
        let (first, _f1) = reserve(dir.path(), "a.txt").unwrap();
        assert_eq!(first.file_name().unwrap(), "a (2).txt");
        let (second, _f2) = reserve(dir.path(), "a.txt").unwrap();
        assert_eq!(second.file_name().unwrap(), "a (3).txt");
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"old");
    }

    /// 一度だけ応答する HTTP の偽サーバー（`body` を返す。`declared` は Content-Length。`declared` が多いと途中で切れる）
    fn serve_once(status: &'static str, body: &'static [u8], declared: usize) -> String {
        use std::io::{Read, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body);
            }
        });
        format!("http://{addr}")
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn saves_the_body_and_numbers_a_taken_name() {
        let server = serve_once("200 OK", b"hello", 5);
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("note.txt"), b"keep").unwrap();
        let client = RestClient::new(ServerUrl::parse(&server).unwrap(), None).unwrap();
        let (path, name) = run(async {
            let mut download = client.download("/api/files/abc").await.unwrap();
            save_into_dir(dir.path(), &mut download, "note.txt")
                .await
                .unwrap()
        });
        assert_eq!(name, "note (2).txt");
        assert_eq!(fs::read(&path).unwrap(), b"hello");
        assert_eq!(fs::read(dir.path().join("note.txt")).unwrap(), b"keep");
    }

    #[test]
    fn a_failed_status_saves_nothing() {
        let body: &'static [u8] = b"{\"code\":\"not_found\",\"message\":\"x\"}";
        let server = serve_once("404 Not Found", body, body.len());
        let client = RestClient::new(ServerUrl::parse(&server).unwrap(), None).unwrap();
        let err = run(client.download("/api/files/missing"))
            .err()
            .expect("404 は失敗");
        assert_eq!(err.status, Some(404));
        assert_eq!(err.code, "not_found");
    }

    #[test]
    fn a_cut_off_body_leaves_no_partial_file() {
        // 10 バイト宣言して 3 バイトで切る
        let server = serve_once("200 OK", b"abc", 10);
        let dir = tempfile::tempdir().unwrap();
        let client = RestClient::new(ServerUrl::parse(&server).unwrap(), None).unwrap();
        let result = run(async {
            let mut download = client.download("/api/files/cut").await.unwrap();
            save_into_dir(dir.path(), &mut download, "cut.bin").await
        });
        assert!(result.is_err());
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            0,
            "書きかけのファイルを残さない"
        );
    }

    #[test]
    fn io_errors_map_to_fixed_codes() {
        let denied = std::io::Error::from(ErrorKind::PermissionDenied);
        assert_eq!(io_failure(&denied).code, "permission");
        let other = std::io::Error::from(ErrorKind::Other);
        assert_eq!(io_failure(&other).code, "io");
        #[cfg(unix)]
        assert_eq!(
            io_failure(&std::io::Error::from_raw_os_error(28)).code,
            "no_space"
        );
        #[cfg(windows)]
        assert_eq!(
            io_failure(&std::io::Error::from_raw_os_error(112)).code,
            "no_space"
        );
    }
}
