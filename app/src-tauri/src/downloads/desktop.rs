//! デスクトップ（Windows・Linux）の保存と開く。保存先は既定のフォルダ（ダウンロード）

use super::*;

#[cfg(not(target_os = "android"))]
pub(super) async fn save(
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
pub(super) async fn save_into_dir(
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

#[cfg(not(target_os = "android"))]
pub(super) async fn open_saved(
    app: &AppHandle<Wry>,
    target: OpenTarget,
) -> Result<(), ReadFailure> {
    use tauri_plugin_opener::OpenerExt;
    let OpenTarget::Path(path) = target;
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|_| fail("open_failed", "開けるアプリがありませんでした"))
}
