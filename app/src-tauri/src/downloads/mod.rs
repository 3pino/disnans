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
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

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
#[cfg(any(target_os = "android", test))]
pub fn mime_for(name: &str) -> &'static str {
    let (_, ext) = split_extension(name);
    disnans_shared::mime::for_extension(ext.trim_start_matches('.'))
        .unwrap_or("application/octet-stream")
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
#[cfg(target_os = "android")]
mod android;
#[cfg(not(target_os = "android"))]
mod desktop;

#[cfg(target_os = "android")]
use android::{open_saved, save};
#[cfg(not(target_os = "android"))]
use desktop::{open_saved, save};

#[cfg(test)]
mod tests;
