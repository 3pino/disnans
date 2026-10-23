//! デスクトップの「最近の画像」（添付パネル）: ピクチャのフォルダの新しい画像の一覧と、サムネイル。
//!
//! 一覧はピクチャのフォルダの直下と、その直下のサブフォルダ（1 段）から拾い、更新の新しい順に並べる。
//! 本体は一覧の `id`（絶対パス）を既存のパス経路で読む（このモジュールは本体を返さない）。
//! Android の同名の機能は notifier プラグイン（写真アプリの MediaStore）。

use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::Engine;
use image::ImageDecoder;
use serde::Serialize;

/// サムネイルの長辺（px）
const THUMB_EDGE: u32 = 256;
/// 一覧の件数の上限（既定 20）
const MAX_LIMIT: usize = 60;
const DEFAULT_LIMIT: usize = 20;
/// 対象の拡張子（小文字）。縮小できない形式（`THUMBLESS`）は一覧に残し、サムネイルを null で返す（GUI が WebView で描く）
const EXTENSIONS: &[&str] = &[
    "png", "apng", "jpg", "jpeg", "jfif", "pjpeg", "webp", "gif", "bmp", "tif", "tiff", "ico",
    "qoi", "tga", "avif", "svg", "heic", "heif", "jxl",
];
/// 縮小できない形式（image クレートが読めない、または対応しない）
const THUMBLESS: &[&str] = &["avif", "svg", "heic", "heif", "jxl"];

#[derive(Serialize)]
pub struct RecentImage {
    /// 絶対パス（本体はこのパスを既存の経路で読む）
    id: String,
    name: String,
    mime: String,
    /// 更新の時刻（ms）
    modified: i64,
    width: Option<u32>,
    height: Option<u32>,
    /// 長辺 THUMB_EDGE の JPEG（data URL）。縮小できない形式は null
    thumb: Option<String>,
}

#[derive(Serialize)]
pub struct RecentImages {
    /// デスクトップは常に granted（OS の許可の仕組みが無い）
    permission: &'static str,
    images: Vec<RecentImage>,
}

/// 新しい画像の一覧（ピクチャのフォルダ）。`limit` は 1〜60（既定 20）
#[tauri::command]
pub async fn recent_images(limit: Option<usize>) -> Result<RecentImages, String> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    tauri::async_runtime::spawn_blocking(move || list(limit))
        .await
        .map_err(|e| format!("一覧を作れませんでした: {e}"))
}

fn list(limit: usize) -> RecentImages {
    let mut images = Vec::new();
    if let Some(root) = picture_dir() {
        let mut found = Vec::new();
        scan(&root, &mut found);
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                // シンボリックリンクは辿らない（循環を避ける）
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    scan(&entry.path(), &mut found);
                }
            }
        }
        found.sort_by(|a, b| b.1.cmp(&a.1));
        for (path, modified) in found {
            if images.len() >= limit {
                break;
            }
            images.push(describe(&path, modified));
        }
    }
    RecentImages {
        permission: "granted",
        images,
    }
}

/// ピクチャのフォルダ。無ければ ~/Pictures
fn picture_dir() -> Option<PathBuf> {
    dirs::picture_dir().or_else(|| dirs::home_dir().map(|home| home.join("Pictures")))
}

/// フォルダの直下の画像（拡張子で選ぶ）と、その更新の時刻（ms）を集める。読めないものは飛ばす
fn scan(dir: &Path, out: &mut Vec<(PathBuf, i64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        if !is_image(&path) {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        let ms = modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push((path, ms));
    }
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
}

fn is_image(path: &Path) -> bool {
    extension(path).is_some_and(|e| EXTENSIONS.contains(&e.as_str()))
}

fn mime_of(path: &Path) -> &'static str {
    match extension(path).as_deref() {
        Some("png") => "image/png",
        Some("apng") => "image/apng",
        Some("jpg" | "jpeg" | "jfif") => "image/jpeg",
        Some("pjpeg") => "image/pjpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        Some("tif" | "tiff") => "image/tiff",
        Some("ico") => "image/x-icon",
        Some("qoi") => "image/qoi",
        Some("tga") => "image/x-tga",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("heic") => "image/heic",
        Some("heif") => "image/heif",
        Some("jxl") => "image/jxl",
        _ => "application/octet-stream",
    }
}

/// 縮小できない形式か（拡張子で判断する）
fn thumbless(path: &Path) -> bool {
    extension(path).is_some_and(|e| THUMBLESS.contains(&e.as_str()))
}

/// 1 枚の説明。縮小できないものは寸法とサムネイルを None にして、一覧には残す
fn describe(path: &Path, modified: i64) -> RecentImage {
    let decoded = if thumbless(path) {
        None
    } else {
        thumb_of(path)
    };
    let (width, height, thumb) = match decoded {
        Some((w, h, data)) => (Some(w), Some(h), Some(data)),
        None => (None, None, None),
    };
    RecentImage {
        id: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "image".into()),
        mime: mime_of(path).to_owned(),
        modified,
        width,
        height,
        thumb,
    }
}

/// 縮小のサムネイル（data URL）と元の寸法。読めなければ None
fn thumb_of(path: &Path) -> Option<(u32, u32, String)> {
    // EXIF の向きを反映する（縦の写真が横にならないように）。向きが読めなければそのまま
    let mut decoder = image::ImageReader::open(path)
        .ok()?
        .with_guessed_format()
        .ok()?
        .into_decoder()
        .ok()?;
    let orientation = decoder.orientation().ok();
    let mut img = image::DynamicImage::from_decoder(decoder).ok()?;
    if let Some(orientation) = orientation {
        img.apply_orientation(orientation);
    }
    let (width, height) = (img.width(), img.height());
    let thumb = img.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let mut jpeg = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(thumb.to_rgb8())
        .write_to(&mut jpeg, image::ImageFormat::Jpeg)
        .ok()?;
    let data = base64::engine::general_purpose::STANDARD.encode(jpeg.into_inner());
    Some((width, height, format!("data:image/jpeg;base64,{data}")))
}
