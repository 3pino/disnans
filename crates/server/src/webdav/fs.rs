//! dav-server に渡す、共有フォルダのファイルシステム。
//!
//! 場所は 2 つに分かれる:
//! - `attachments/`（ルートの直下の名前が予約）: 投稿された添付を [`tree`] で見せる仮想フォルダ。読み取りだけ。
//! - それ以外（`data/shared/` の中）: 実際のファイル。作成・上書き・移動・コピー・削除ができる。
//!
//! 安全のための決まり:
//! - パスは区切りごとに [`valid_name`] を通す（`..`・区切り文字・Windows で使えない名前は拒否）。
//! - シンボリックリンクは辿らない（途中のどの要素もリンクなら拒否）。一覧にも出さない。
//! - 書き込みは必ず一時ファイルに書いてから rename する。上書きでも既存の実体の中身は書き換えない
//!   （バックアップはハードリンクなので、中身を書き換えるとバックアップも変わってしまうため）。

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Buf, Bytes};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream,
    OpenOptions, ReadDirMeta,
};
use futures_util::stream;
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::config::Config;
use crate::files;
use crate::store::files as store_files;
use crate::webdav::names::{TMP_PREFIX, is_internal, valid_name};
use crate::webdav::tree::{self, ATTACHMENTS_DIR, Entry, Item};

#[derive(Clone)]
pub struct SharedFs {
    pub config: Config,
    pub pool: SqlitePool,
}

/// パスが指す場所の種類。
enum Area {
    /// 共有フォルダそのもの
    Root,
    /// `attachments/` の中（仮想。読み取りだけ）
    Attachments(Vec<String>),
    /// 実際のファイルの場所（区切りの列。空でない）
    Shared(Vec<String>),
}

fn area(segs: Vec<String>) -> Area {
    match segs.first() {
        None => Area::Root,
        Some(first) if first == ATTACHMENTS_DIR => Area::Attachments(segs),
        Some(_) => Area::Shared(segs),
    }
}

/// 1 つのパスが何か（仮想フォルダの中身、または実際のファイル）。
#[derive(Debug, Clone)]
enum Node {
    Dir,
    /// 投稿された添付（仮想）
    Attachment(Item),
}

#[derive(Debug, Clone)]
struct Meta {
    dir: bool,
    len: u64,
    modified: SystemTime,
}

impl Meta {
    fn dir() -> Self {
        Meta {
            dir: true,
            len: 0,
            modified: UNIX_EPOCH,
        }
    }

    fn of_item(item: &Item) -> Self {
        Meta {
            dir: false,
            len: item.size,
            modified: UNIX_EPOCH + Duration::from_millis(item.posted_at_ms.max(0) as u64),
        }
    }

    fn of_std(m: &std::fs::Metadata) -> Self {
        Meta {
            dir: m.is_dir(),
            len: if m.is_dir() { 0 } else { m.len() },
            modified: m.modified().unwrap_or(UNIX_EPOCH),
        }
    }

    fn of_entry(entry: &Entry<'_>) -> Self {
        match entry {
            Entry::Dir => Meta::dir(),
            Entry::File(item) => Meta::of_item(item),
        }
    }
}

impl DavMetaData for Meta {
    fn len(&self) -> u64 {
        self.len
    }
    fn modified(&self) -> FsResult<SystemTime> {
        Ok(self.modified)
    }
    fn is_dir(&self) -> bool {
        self.dir
    }
}

/// パス（デコード済み）を区切りの列にする。UTF-8 でなければ None。
fn segments(path: &DavPath) -> Option<Vec<String>> {
    let text = std::str::from_utf8(path.as_bytes()).ok()?;
    Some(
        text.split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// I/O のエラーを dav-server のエラーに変える。
fn io_err(e: &std::io::Error) -> FsError {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::NotFound => FsError::NotFound,
        ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => FsError::Exists,
        ErrorKind::PermissionDenied => FsError::Forbidden,
        _ => FsError::GeneralFailure,
    }
}

/// 仮想フォルダの中身を、データベースの一覧から引く。
fn virtual_node(items: &[Item], segs: &[String]) -> FsResult<Node> {
    let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
    match tree::find(items, &refs).ok_or(FsError::NotFound)? {
        Entry::Dir => Ok(Node::Dir),
        Entry::File(item) => Ok(Node::Attachment(item.clone())),
    }
}

impl SharedFs {
    async fn items(&self) -> FsResult<Vec<Item>> {
        store_files::posted_items(&self.pool)
            .await
            .map_err(|_| FsError::GeneralFailure)
    }

    /// 実際のファイルの場所。区切りごとに名前を確かめ、リンクがあれば拒否する。
    /// 書き込みなら拒否は 403（`write`）、読み取りなら 404（存在を隠す）。
    fn real_path(&self, segs: &[String], write: bool) -> FsResult<PathBuf> {
        let refuse = if write {
            FsError::Forbidden
        } else {
            FsError::NotFound
        };
        let mut p = self.config.shared_dir();
        for s in segs {
            if !valid_name(s) {
                return Err(refuse);
            }
            p.push(s);
            if let Ok(m) = std::fs::symlink_metadata(&p)
                && m.file_type().is_symlink()
            {
                return Err(refuse);
            }
        }
        Ok(p)
    }

    /// 書き込み先（名前・親のフォルダ・リンクでないこと）を確かめる。戻り値は（先のパス、親のパス）。
    fn writable_target(&self, segs: &[String]) -> FsResult<(PathBuf, PathBuf)> {
        let (name, parent_segs) = segs.split_last().ok_or(FsError::Forbidden)?;
        if !valid_name(name) {
            return Err(FsError::Forbidden);
        }
        let parent = self.real_path(parent_segs, true)?;
        match std::fs::symlink_metadata(&parent) {
            Ok(m) if m.is_dir() => {}
            _ => return Err(FsError::NotFound),
        }
        let target = self.real_path(segs, true)?;
        if let Ok(m) = std::fs::symlink_metadata(&target)
            && m.is_dir()
        {
            return Err(FsError::Forbidden);
        }
        Ok((target, parent))
    }

    /// 新しいフォルダの場所（名前と親のフォルダだけ確かめる。既にあるかは作成側で決まる）。
    fn new_dir_target(&self, segs: &[String]) -> FsResult<(PathBuf, PathBuf)> {
        let (name, parent_segs) = segs.split_last().ok_or(FsError::Forbidden)?;
        if !valid_name(name) {
            return Err(FsError::Forbidden);
        }
        let parent = self.real_path(parent_segs, true)?;
        match std::fs::symlink_metadata(&parent) {
            Ok(m) if m.is_dir() => {}
            _ => return Err(FsError::NotFound),
        }
        let target = self.real_path(segs, true)?;
        Ok((target, parent))
    }

    /// 共有フォルダの直下（仮想の `attachments` を含む）の一覧。
    fn shared_entries(&self, dir: &Path) -> FsResult<Vec<Box<dyn DavDirEntry>>> {
        let rd = std::fs::read_dir(dir).map_err(|e| io_err(&e))?;
        let mut out: Vec<Box<dyn DavDirEntry>> = Vec::new();
        for entry in rd {
            let entry = entry.map_err(|e| io_err(&e))?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if is_internal(&name) {
                continue;
            }
            let Ok(m) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            // リンクは見せない（辿らないので、中身も見せない）
            if m.file_type().is_symlink() {
                continue;
            }
            out.push(Box::new(DirEnt {
                name,
                meta: Meta::of_std(&m),
            }));
        }
        Ok(out)
    }
}

struct DirEnt {
    name: String,
    meta: Meta,
}

impl DavDirEntry for DirEnt {
    fn name(&self) -> Vec<u8> {
        self.name.clone().into_bytes()
    }

    fn metadata(&'_ self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = self.meta.clone();
        Box::pin(async move { Ok(Box::new(meta) as Box<dyn DavMetaData>) })
    }
}

/// 開いた実体（読み取り専用）。
#[derive(Debug)]
struct ReadFile {
    file: tokio::fs::File,
    meta: Meta,
}

impl DavFile for ReadFile {
    fn metadata(&'_ mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        let meta = self.meta.clone();
        Box::pin(async move { Ok(Box::new(meta) as Box<dyn DavMetaData>) })
    }

    fn write_buf(&'_ mut self, _buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn write_bytes(&'_ mut self, _buf: Bytes) -> FsFuture<'_, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn read_bytes(&'_ mut self, count: usize) -> FsFuture<'_, Bytes> {
        Box::pin(async move {
            let mut buf = vec![0u8; count];
            let n = self.file.read(&mut buf).await.map_err(|e| io_err(&e))?;
            buf.truncate(n);
            Ok(Bytes::from(buf))
        })
    }

    fn seek(&'_ mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        Box::pin(async move { self.file.seek(pos).await.map_err(|e| io_err(&e)) })
    }

    fn flush(&'_ mut self) -> FsFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

/// 書き込み中のファイル。一時ファイルに書き、`flush`（書き終わり）で本来の名前に rename する。
/// 途中で終わったら（コミットされなかったら）一時ファイルを消す。
#[derive(Debug)]
struct WriteFile {
    file: tokio::fs::File,
    tmp: PathBuf,
    target: PathBuf,
    committed: bool,
}

impl Drop for WriteFile {
    fn drop(&mut self) {
        if !self.committed {
            let _ = std::fs::remove_file(&self.tmp);
        }
    }
}

impl DavFile for WriteFile {
    fn metadata(&'_ mut self) -> FsFuture<'_, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let m = self.file.metadata().await.map_err(|e| io_err(&e))?;
            Ok(Box::new(Meta::of_std(&m)) as Box<dyn DavMetaData>)
        })
    }

    fn write_buf(&'_ mut self, mut buf: Box<dyn Buf + Send>) -> FsFuture<'_, ()> {
        Box::pin(async move {
            while buf.has_remaining() {
                let n = {
                    let chunk = buf.chunk();
                    self.file.write_all(chunk).await.map_err(|e| io_err(&e))?;
                    chunk.len()
                };
                buf.advance(n);
            }
            Ok(())
        })
    }

    fn write_bytes(&'_ mut self, buf: Bytes) -> FsFuture<'_, ()> {
        Box::pin(async move { self.file.write_all(&buf).await.map_err(|e| io_err(&e)) })
    }

    fn read_bytes(&'_ mut self, _count: usize) -> FsFuture<'_, Bytes> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn seek(&'_ mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        Box::pin(async move { self.file.seek(pos).await.map_err(|e| io_err(&e)) })
    }

    fn flush(&'_ mut self) -> FsFuture<'_, ()> {
        Box::pin(async move {
            if self.committed {
                return Ok(());
            }
            self.file.flush().await.map_err(|e| io_err(&e))?;
            self.file.sync_all().await.map_err(|e| io_err(&e))?;
            // 上書きでも、古い実体は触らず名前だけを差し替える（バックアップのハードリンクを守る）
            std::fs::rename(&self.tmp, &self.target).map_err(|e| io_err(&e))?;
            self.committed = true;
            Ok(())
        })
    }
}

impl DavFileSystem for SharedFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        Box::pin(async move {
            let writing = options.write || options.append;
            let segs = segments(path).ok_or(FsError::NotFound)?;
            if writing {
                return self.open_write(segs, options).await;
            }
            match area(segs) {
                Area::Root => Err(FsError::Forbidden),
                Area::Attachments(segs) => {
                    let items = self.items().await?;
                    match virtual_node(&items, &segs)? {
                        Node::Attachment(item) => {
                            let p = files::file_path(&self.config, &item.file_id);
                            let file = tokio::fs::File::open(p).await.map_err(|e| io_err(&e))?;
                            Ok(Box::new(ReadFile {
                                file,
                                meta: Meta::of_item(&item),
                            }) as Box<dyn DavFile>)
                        }
                        _ => Err(FsError::Forbidden),
                    }
                }
                Area::Shared(segs) => {
                    let p = self.real_path(&segs, false)?;
                    let m = std::fs::symlink_metadata(&p).map_err(|e| io_err(&e))?;
                    if m.is_dir() {
                        return Err(FsError::Forbidden);
                    }
                    let file = tokio::fs::File::open(&p).await.map_err(|e| io_err(&e))?;
                    Ok(Box::new(ReadFile {
                        file,
                        meta: Meta::of_std(&m),
                    }) as Box<dyn DavFile>)
                }
            }
        })
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::NotFound)?;
            let entries: Vec<FsResult<Box<dyn DavDirEntry>>> = match area(segs) {
                Area::Root => {
                    let mut out: Vec<FsResult<Box<dyn DavDirEntry>>> = vec![Ok(Box::new(DirEnt {
                        name: ATTACHMENTS_DIR.into(),
                        meta: Meta::dir(),
                    }))];
                    // 直下の実際の名前のうち、予約の `attachments` は見せない
                    for e in self.shared_entries(&self.config.shared_dir())? {
                        let name = String::from_utf8_lossy(&e.name()).into_owned();
                        if name != ATTACHMENTS_DIR {
                            out.push(Ok(e));
                        }
                    }
                    out
                }
                Area::Attachments(segs) => {
                    let items = self.items().await?;
                    let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
                    tree::children(&items, &refs)
                        .ok_or(FsError::NotFound)?
                        .into_iter()
                        .map(|c| {
                            Ok(Box::new(DirEnt {
                                name: c.name,
                                meta: Meta::of_entry(&c.entry),
                            }) as Box<dyn DavDirEntry>)
                        })
                        .collect()
                }
                Area::Shared(segs) => {
                    let dir = self.real_path(&segs, false)?;
                    let m = std::fs::symlink_metadata(&dir).map_err(|e| io_err(&e))?;
                    if !m.is_dir() {
                        return Err(FsError::NotFound);
                    }
                    self.shared_entries(&dir)?.into_iter().map(Ok).collect()
                }
            };
            let s: FsStream<Box<dyn DavDirEntry>> = Box::pin(stream::iter(entries));
            Ok(s)
        })
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::NotFound)?;
            let meta = match area(segs) {
                Area::Root => Meta::dir(),
                Area::Attachments(segs) => {
                    let items = self.items().await?;
                    match virtual_node(&items, &segs)? {
                        Node::Dir => Meta::dir(),
                        Node::Attachment(item) => Meta::of_item(&item),
                    }
                }
                Area::Shared(segs) => {
                    let p = self.real_path(&segs, false)?;
                    let m = std::fs::symlink_metadata(&p).map_err(|e| io_err(&e))?;
                    Meta::of_std(&m)
                }
            };
            Ok(Box::new(meta) as Box<dyn DavMetaData>)
        })
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::Forbidden)?;
            match area(segs) {
                // `attachments` の中も、その名前そのものも作れない
                Area::Root | Area::Attachments(_) => Err(FsError::Forbidden),
                Area::Shared(segs) => {
                    let (target, _parent) = self.new_dir_target(&segs)?;
                    std::fs::create_dir(&target).map_err(|e| io_err(&e))
                }
            }
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::Forbidden)?;
            match area(segs) {
                Area::Root | Area::Attachments(_) => Err(FsError::Forbidden),
                Area::Shared(segs) => {
                    let p = self.real_path(&segs, true)?;
                    std::fs::remove_dir(&p).map_err(|e| io_err(&e))
                }
            }
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::Forbidden)?;
            match area(segs) {
                Area::Root | Area::Attachments(_) => Err(FsError::Forbidden),
                Area::Shared(segs) => {
                    let p = self.real_path(&segs, true)?;
                    std::fs::remove_file(&p).map_err(|e| io_err(&e))
                }
            }
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from = segments(from).ok_or(FsError::Forbidden)?;
            let to = segments(to).ok_or(FsError::Forbidden)?;
            let (Area::Shared(from), Area::Shared(to)) = (area(from), area(to)) else {
                // 添付（仮想）も、共有フォルダの直下の名前も動かせない
                return Err(FsError::Forbidden);
            };
            let src = self.real_path(&from, true)?;
            let (dst, _parent) = self.writable_target(&to)?;
            std::fs::rename(&src, &dst).map_err(|e| io_err(&e))
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from = segments(from).ok_or(FsError::NotFound)?;
            let to = segments(to).ok_or(FsError::Forbidden)?;
            let Area::Shared(to) = area(to) else {
                return Err(FsError::Forbidden);
            };
            // 元は、添付（仮想）か共有フォルダのファイル
            let src = match area(from) {
                Area::Root => return Err(FsError::Forbidden),
                Area::Attachments(segs) => {
                    let items = self.items().await?;
                    match virtual_node(&items, &segs)? {
                        Node::Attachment(item) => files::file_path(&self.config, &item.file_id),
                        _ => return Err(FsError::Forbidden),
                    }
                }
                Area::Shared(segs) => {
                    let p = self.real_path(&segs, false)?;
                    let m = std::fs::symlink_metadata(&p).map_err(|e| io_err(&e))?;
                    if m.is_dir() {
                        return Err(FsError::Forbidden);
                    }
                    p
                }
            };
            let (dst, parent) = self.writable_target(&to)?;
            let tmp = parent.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));
            if let Err(e) = tokio::fs::copy(&src, &tmp).await {
                let _ = std::fs::remove_file(&tmp);
                return Err(io_err(&e));
            }
            // 同じく、一時ファイルを作ってから名前を差し替える
            tokio::fs::rename(&tmp, &dst).await.map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                io_err(&e)
            })
        })
    }
}

impl SharedFs {
    /// 書き込みを開く（PUT など）。既存の実体は書き換えず、一時ファイルに書く。
    async fn open_write(
        &self,
        segs: Vec<String>,
        options: OpenOptions,
    ) -> FsResult<Box<dyn DavFile>> {
        let Area::Shared(segs) = area(segs) else {
            return Err(FsError::Forbidden);
        };
        let (target, parent) = self.writable_target(&segs)?;
        let exists = match std::fs::symlink_metadata(&target) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(io_err(&e)),
        };
        if options.create_new && exists {
            return Err(FsError::Exists);
        }
        if !options.create && !exists {
            return Err(FsError::NotFound);
        }
        let tmp = parent.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));
        if exists && !options.truncate {
            // 一部だけ書き換える PUT（Content-Range など）は、今の中身を一時ファイルに写してから
            if let Err(e) = std::fs::copy(&target, &tmp) {
                let _ = std::fs::remove_file(&tmp);
                return Err(io_err(&e));
            }
        } else if let Err(e) = std::fs::File::create_new(&tmp) {
            return Err(io_err(&e));
        }
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&tmp)
            .await
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                io_err(&e)
            })?;
        Ok(Box::new(WriteFile {
            file,
            tmp,
            target,
            committed: false,
        }) as Box<dyn DavFile>)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_is_decided_by_the_first_segment() {
        assert!(matches!(area(vec![]), Area::Root));
        assert!(matches!(
            area(vec!["attachments".into()]),
            Area::Attachments(_)
        ));
        assert!(matches!(
            area(vec!["attachments".into(), "a".into()]),
            Area::Attachments(_)
        ));
        assert!(matches!(area(vec!["docs".into()]), Area::Shared(_)));
    }
}
