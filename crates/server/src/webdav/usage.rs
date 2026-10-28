//! 共有フォルダの大きさの集計と、フォルダの再帰コピー。どちらも実ファイルだけを対象にする。
//!
//! - シンボリックリンクは辿らず、集計からも除外する（コピーでは、リンクがあればコピーを拒否する）。
//! - 書き込みの途中のファイル（[`is_internal`]）は見せないので、集計にもコピーにも入れない。
//! - 呼び出し側は `spawn_blocking` の中で使う（大きなフォルダでは I/O が長い）。

use std::path::Path;

use super::names::is_internal;

/// 集計の結果。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub size: u64,
    pub files: u64,
    /// 配下のフォルダ数（起点のフォルダ自身は含まない）。
    pub dirs: u64,
}

impl Usage {
    pub fn add(&mut self, other: Usage) {
        self.size += other.size;
        self.files += other.files;
        self.dirs += other.dirs;
    }
}

/// 起点がファイルなら 1 ファイル、フォルダなら配下の合計。`skip` は起点の直下で数えない名前（ルートの `attachments` など）。
pub fn usage(path: &Path, skip: &[&str]) -> std::io::Result<Usage> {
    let m = std::fs::symlink_metadata(path)?;
    if m.file_type().is_symlink() {
        return Ok(Usage::default());
    }
    if m.is_file() {
        return Ok(Usage {
            size: m.len(),
            files: 1,
            dirs: 0,
        });
    }
    let mut total = Usage::default();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if is_internal(&name) || skip.contains(&name.as_ref()) {
            continue;
        }
        let child = entry.path();
        let cm = std::fs::symlink_metadata(&child)?;
        if cm.file_type().is_symlink() {
            continue;
        }
        if cm.is_dir() {
            total.dirs += 1;
            total.add(usage(&child, &[])?);
        } else if cm.is_file() {
            total.files += 1;
            total.size += cm.len();
        }
    }
    Ok(total)
}

/// フォルダを再帰でコピーする（`dst` は無いこと）。途中で失敗したら `dst` を消す（部分的な結果を残さない）。
/// リンクがあれば拒否する（コピーの中身を黙って欠けさせない）。書き込みの途中のファイルは入れない。
pub fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir(dst)?;
    match copy_children(src, dst) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_dir_all(dst);
            Err(e)
        }
    }
}

fn copy_children(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        if is_internal(&name_text) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let m = std::fs::symlink_metadata(&from)?;
        if m.file_type().is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "シンボリックリンクはコピーできません",
            ));
        } else if m.is_dir() {
            std::fs::create_dir(&to)?;
            copy_children(&from, &to)?;
        } else if m.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
