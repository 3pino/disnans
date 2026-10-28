//! OS からのドロップ（ファイル・フォルダ）を、ドロップされたものの範囲だけで読めるようにする（デスクトップ）。
//!
//! 流れ: Linux の Tauri のドロップ（ネイティブ）で届いたパスを、ここで「ドロップ（session）」として覚える（`WindowEvent::DragDrop`）。
//! JS へは根の名前・ID・位置（物理ピクセル）を、ドロップしたウィンドウだけへ `os-drop` で送る。パスは JS に出さない。
//! JS が読むのは、覚えた根の中のファイルだけ（任意のパスは受けない）。
//! ドロップは同時に最大 `MAX_SESSIONS` まで覚える。覚えたばかりは「未取得」。列挙か読取を始めると「取得済み」になり、
//! `os_drop_release(id)` で外されるまで消えない。上限のときは、未取得のものだけを古い順に譲る（チャットのドロップは取得されないので、ここで譲られる）。
//! 取得済みしか無ければ新しいドロップは明示のエラーで拒む（既存のものは置き換えない）。時間では消さない。
//! 列挙と読取は非同期のコマンドで、ブロッキングの作業へ逃がす（メインを止めない）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, EventTarget, Manager};

use crate::os_drop_sessions::Sessions;
use crate::os_drop_walk::{self, ReadError, Root, WalkError};

/// ドロップを知らせるイベント（JS の listen と合わせる）
pub const DROP_EVENT: &str = "os-drop";
/// 同時に覚えるドロップの数の上限（未取得から譲る。全部が取得済みなら新しいドロップは拒む）
pub const MAX_SESSIONS: usize = 4;

pub struct OsDropState {
    next: AtomicU64,
    sessions: Mutex<Sessions<Arc<Vec<Root>>>>,
}

impl Default for OsDropState {
    fn default() -> Self {
        OsDropState {
            next: AtomicU64::new(0),
            sessions: Mutex::new(Sessions::new(MAX_SESSIONS)),
        }
    }
}

#[derive(Serialize, Clone)]
pub struct RootInfo {
    name: String,
    dir: bool,
}

/// ドロップの位置（物理ピクセル。JS で CSS ピクセルへ変える）
#[derive(Serialize, Clone, Copy)]
pub struct PhysicalPoint {
    pub x: f64,
    pub y: f64,
}

/// `os-drop` のペイロード。成功なら id と根、失敗なら error（id は無い）
#[derive(Serialize, Clone)]
pub struct OsDropEvent {
    id: Option<u64>,
    error: Option<String>,
    roots: Vec<RootInfo>,
    /// 根にできなかったもの（シンボリックリンク・読めないもの・名前の決まりに合わないもの）の名前
    skipped: Vec<String>,
    position: Option<PhysicalPoint>,
}

#[derive(Serialize)]
pub struct EntryOut {
    rel: String,
    dir: bool,
    size: u64,
}

#[derive(Serialize)]
pub struct ListingOut {
    entries: Vec<EntryOut>,
    skipped: Vec<String>,
}

/// 根を確かめて覚える（fs の正規化・メタデータを使うので、GUI のスレッドでは行わない）。
/// 戻り値は覚えた ID（失敗なら覚えていない）と、知らせる内容。
fn register(
    state: &OsDropState,
    paths: &[PathBuf],
) -> Result<(u64, Vec<RootInfo>, Vec<String>), String> {
    let (roots, skipped) = os_drop_walk::prepare_roots(paths).map_err(walk_message)?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let info: Vec<RootInfo> = roots
        .iter()
        .map(|r| RootInfo {
            name: r.name.clone(),
            dir: r.dir,
        })
        .collect();
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions
        .insert(id, Arc::new(roots))
        .map_err(|_| "ドロップが多すぎます。先に進行中の処理を終えてください".to_string())?;
    Ok((id, info, skipped))
}

/// 覚えたものを外す（知らせられなかったとき）
fn release(state: &OsDropState, id: u64) {
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
}

/// ドロップを覚えて、そのウィンドウへ知らせる（ウィンドウのイベントから呼ぶ）。
/// 根の確認と覚えること、知らせることは、ブロッキングの作業で行う（GUI のスレッドを塞がない）。
/// 知らせられなかった（ウィンドウが無くなった等）ときは、覚えたものを外す。
pub fn record(window: &tauri::Window, paths: &[PathBuf], position: Option<PhysicalPoint>) {
    let window = window.clone();
    let paths = paths.to_vec();
    // ハンドルを明示的に手放しても作業は継続する。GUI のイベントでは完了を待たない。
    drop(tauri::async_runtime::spawn_blocking(move || {
        let app = window.app_handle().clone();
        let state = app.state::<OsDropState>();
        let (id, payload) = match register(&state, &paths) {
            Ok((id, roots, skipped)) => (
                Some(id),
                OsDropEvent {
                    id: Some(id),
                    error: None,
                    roots,
                    skipped,
                    position,
                },
            ),
            Err(message) => (
                None,
                OsDropEvent {
                    id: None,
                    error: Some(message),
                    roots: Vec::new(),
                    skipped: Vec::new(),
                    position,
                },
            ),
        };
        // このウィンドウだけへ送る（他のウィンドウへは出さない）
        let sent = window.emit_to(
            EventTarget::webview_window(window.label()),
            DROP_EVENT,
            payload,
        );
        if let (Some(id), Err(_)) = (id, sent) {
            release(&state, id);
        }
    }));
}

/// 指定の ID のドロップの根（違う ID や終わったドロップは拒む）。使われたことを記録する
fn roots_of(app: &tauri::AppHandle, id: u64) -> Result<Arc<Vec<Root>>, String> {
    let state = app.state::<OsDropState>();
    let mut sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
    sessions
        .claim(id)
        .ok_or_else(|| "このドロップは終わっています".to_string())
}

fn walk_message(e: WalkError) -> String {
    match e {
        WalkError::TooManyRoots => "ドロップの項目が多すぎます".into(),
        WalkError::TooManyEntries => "項目が多すぎます".into(),
        WalkError::TooDeep => "フォルダが深すぎます".into(),
        WalkError::Changed => "ドロップの後に、フォルダが変わりました".into(),
        WalkError::Io(m) => format!("フォルダを読めません: {m}"),
    }
}

fn read_message(e: ReadError) -> String {
    match e {
        ReadError::Denied(m) => m,
        ReadError::NotFound => "ファイルが見つかりません".into(),
        ReadError::NotAFile => "ファイルではありません".into(),
        ReadError::TooLarge => "ファイルが大きすぎます".into(),
        ReadError::Io(m) => format!("ファイルを読めません: {m}"),
    }
}

/// ドロップされた根の中身（フォルダの中まで。シンボリックリンクは外す）
#[tauri::command]
pub async fn os_drop_list(app: tauri::AppHandle, id: u64) -> Result<ListingOut, String> {
    let roots = roots_of(&app, id)?;
    let listing = tauri::async_runtime::spawn_blocking(move || os_drop_walk::list(&roots))
        .await
        .map_err(|e| format!("列挙を完了できません: {e}"))?
        .map_err(walk_message)?;
    Ok(ListingOut {
        entries: listing
            .entries
            .into_iter()
            .map(|e| EntryOut {
                rel: e.rel,
                dir: e.dir,
                size: e.size,
            })
            .collect(),
        skipped: listing.skipped,
    })
}

/// ドロップされた根の中のファイルを 1 つ読む（バイナリのまま返す）。rel は根の名前から始まるパス
#[tauri::command]
pub async fn os_drop_read(
    app: tauri::AppHandle,
    id: u64,
    rel: String,
) -> Result<tauri::ipc::Response, String> {
    let roots = roots_of(&app, id)?;
    let bytes = tauri::async_runtime::spawn_blocking(move || os_drop_walk::read_file(&roots, &rel))
        .await
        .map_err(|e| format!("読み込みを完了できません: {e}"))?
        .map_err(read_message)?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// ドロップの終わり（送り終えた・やめた）。覚えた根を外す。二度目や存在しない ID は何もしない
#[tauri::command]
pub fn os_drop_release(app: tauri::AppHandle, id: u64) -> Result<(), String> {
    let state = app.state::<OsDropState>();
    state
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(id);
    Ok(())
}
