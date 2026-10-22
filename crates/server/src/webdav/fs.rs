//! 共有フォルダのファイルシステム（WebDAV と REST `/api/shared` で共通に使う）。
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
//! - 変更した項目ごとに `files.changed` を流す（WebDAV でも REST でも）。
//!
//! 公開の関数は、パスを「区切りの列」で受け取る（WebDAV の DavPath も REST のパスも、ここで区切りにする）。

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Buf, Bytes};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream,
    OpenOptions, ReadDirMeta,
};
use disnans_shared::ServerEvent;
use futures_util::stream;
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::config::Config;
use crate::files;
use crate::hub::Hub;
use crate::state::AppState;
use crate::store::files as store_files;
use crate::webdav::names::{TMP_PREFIX, is_internal, valid_name};
use crate::webdav::tree::{self, ATTACHMENTS_DIR, Entry, Item};

#[derive(Clone)]
pub struct SharedFs {
    pub config: Config,
    pub pool: SqlitePool,
    hub: Arc<Hub>,
}

/// 項目の情報（大きさ・更新時刻・種類）。
#[derive(Debug, Clone)]
pub struct Meta {
    pub dir: bool,
    pub len: u64,
    pub modified: SystemTime,
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

    /// 更新時刻（ミリ秒、UNIX 時間）。
    pub fn modified_ms(&self) -> i64 {
        self.modified
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
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

/// フォルダの中の 1 つの項目。
#[derive(Debug, Clone)]
pub struct Listed {
    pub name: String,
    pub meta: Meta,
    /// 添付のときだけ（添付したメッセージ）。
    pub message_id: Option<String>,
    /// 添付のときだけ（種類）。
    pub mime: Option<String>,
}

/// ファイルの中身を読むための場所（実際のファイル、または添付の実体）。
#[derive(Debug, Clone)]
pub struct ReadTarget {
    pub path: PathBuf,
    /// 添付のときだけ（保存されている種類）。共有フォルダのファイルは拡張子で決まる。
    pub mime: Option<String>,
}

/// 区切りの列を、共有フォルダの相対パス（`docs/a.txt`）にする。
pub fn rel(segs: &[String]) -> String {
    segs.join("/")
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

fn area(segs: &[String]) -> Area {
    match segs.first() {
        None => Area::Root,
        Some(first) if first == ATTACHMENTS_DIR => Area::Attachments(segs.to_vec()),
        Some(_) => Area::Shared(segs.to_vec()),
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
pub fn io_err(e: &std::io::Error) -> FsError {
    use std::io::ErrorKind;
    match e.kind() {
        ErrorKind::NotFound => FsError::NotFound,
        ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty => FsError::Exists,
        ErrorKind::PermissionDenied => FsError::Forbidden,
        _ => FsError::GeneralFailure,
    }
}

/// 仮想フォルダの中身を、データベースの一覧から引く。
fn virtual_entry<'a>(items: &'a [Item], segs: &[String]) -> Option<Entry<'a>> {
    let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
    tree::find(items, &refs)
}

impl SharedFs {
    pub fn new(state: &AppState) -> Self {
        SharedFs {
            config: state.config.clone(),
            pool: state.pool.clone(),
            hub: state.hub.clone(),
        }
    }

    async fn items(&self) -> FsResult<Vec<Item>> {
        store_files::posted_items(&self.pool)
            .await
            .map_err(|_| FsError::GeneralFailure)
    }

    fn notify(&self, segs: &[String]) {
        self.hub
            .broadcast(&ServerEvent::FilesChanged { path: rel(segs) });
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

    /// 新しいフォルダ・ファイルの場所（名前と親のフォルダだけ確かめる。既にあるかは作成側で決まる）。
    fn new_target(&self, segs: &[String]) -> FsResult<(PathBuf, PathBuf)> {
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

    /// 書き込み先（名前・親のフォルダ・リンクでないこと・フォルダでないこと）を確かめる。
    fn writable_target(&self, segs: &[String]) -> FsResult<(PathBuf, PathBuf)> {
        let (target, parent) = self.new_target(segs)?;
        if let Ok(m) = std::fs::symlink_metadata(&target)
            && m.is_dir()
        {
            return Err(FsError::Forbidden);
        }
        Ok((target, parent))
    }

    /// 共有フォルダの直下（仮想の `attachments` を含まない）の一覧。
    fn shared_entries(&self, dir: &Path) -> FsResult<Vec<Listed>> {
        let rd = std::fs::read_dir(dir).map_err(|e| io_err(&e))?;
        let mut out = Vec::new();
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
            out.push(Listed {
                name,
                meta: Meta::of_std(&m),
                message_id: None,
                mime: None,
            });
        }
        Ok(out)
    }

    /// 項目の一覧（フォルダの中身）。フォルダでなければ NotFound。
    pub async fn list(&self, segs: &[String]) -> FsResult<Vec<Listed>> {
        match area(segs) {
            Area::Root => {
                let mut out = vec![Listed {
                    name: ATTACHMENTS_DIR.into(),
                    meta: Meta::dir(),
                    message_id: None,
                    mime: None,
                }];
                // 直下の実際の名前のうち、予約の `attachments` は見せない
                for e in self.shared_entries(&self.config.shared_dir())? {
                    if e.name != ATTACHMENTS_DIR {
                        out.push(e);
                    }
                }
                Ok(out)
            }
            Area::Attachments(segs) => {
                let items = self.items().await?;
                let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
                let children = tree::children(&items, &refs).ok_or(FsError::NotFound)?;
                Ok(children
                    .into_iter()
                    .map(|c| {
                        let (message_id, mime) = match &c.entry {
                            Entry::File(item) => {
                                (Some(item.message_id.clone()), Some(item.mime.clone()))
                            }
                            Entry::Dir => (None, None),
                        };
                        Listed {
                            name: c.name,
                            meta: Meta::of_entry(&c.entry),
                            message_id,
                            mime,
                        }
                    })
                    .collect())
            }
            Area::Shared(segs) => {
                let dir = self.real_path(&segs, false)?;
                let m = std::fs::symlink_metadata(&dir).map_err(|e| io_err(&e))?;
                if !m.is_dir() {
                    return Err(FsError::NotFound);
                }
                self.shared_entries(&dir)
            }
        }
    }

    /// 1 つの項目の情報。区切りが空なら共有フォルダそのもの。
    pub async fn stat(&self, segs: &[String]) -> FsResult<Listed> {
        let Some((name, parent)) = segs.split_last() else {
            return Ok(Listed {
                name: String::new(),
                meta: Meta::dir(),
                message_id: None,
                mime: None,
            });
        };
        // 親の一覧から探す（添付の情報も一覧のほうが揃っている）
        self.list(parent)
            .await?
            .into_iter()
            .find(|l| l.name == *name)
            .ok_or(FsError::NotFound)
    }

    /// ファイルの中身の場所（フォルダや無いものは NotFound・Forbidden）。
    pub async fn read_target(&self, segs: &[String]) -> FsResult<ReadTarget> {
        match area(segs) {
            Area::Root => Err(FsError::Forbidden),
            Area::Attachments(segs) => {
                let items = self.items().await?;
                match virtual_entry(&items, &segs) {
                    Some(Entry::File(item)) => Ok(ReadTarget {
                        path: files::file_path(&self.config, &item.file_id),
                        mime: Some(item.mime.clone()),
                    }),
                    Some(Entry::Dir) => Err(FsError::Forbidden),
                    None => Err(FsError::NotFound),
                }
            }
            Area::Shared(segs) => {
                let p = self.real_path(&segs, false)?;
                let m = std::fs::symlink_metadata(&p).map_err(|e| io_err(&e))?;
                if m.is_dir() {
                    return Err(FsError::Forbidden);
                }
                Ok(ReadTarget {
                    path: p,
                    mime: None,
                })
            }
        }
    }

    /// フォルダを作る（既にあれば Exists）。
    pub async fn make_dir(&self, segs: &[String]) -> FsResult<()> {
        match area(segs) {
            // `attachments` の中も、その名前そのものも作れない
            Area::Root | Area::Attachments(_) => Err(FsError::Forbidden),
            Area::Shared(segs) => {
                let (target, _parent) = self.new_target(&segs)?;
                std::fs::create_dir(&target).map_err(|e| io_err(&e))?;
                self.notify(&segs);
                Ok(())
            }
        }
    }

    /// 共有フォルダのファイルへの書き込み（作成・上書き）。`options` は PUT の形。
    /// 戻り値に書き込み、最後に `flush` すると本来の名前になり、`files.changed` が流れる。
    pub async fn write_file(
        &self,
        segs: &[String],
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
            notify: Some((self.hub.clone(), segs)),
        }) as Box<dyn DavFile>)
    }

    /// 削除。フォルダは `recursive` のときだけ中身ごと消す（そうでなければ空のときだけ）。
    pub async fn remove(&self, segs: &[String], recursive: bool) -> FsResult<()> {
        let segs = match area(segs) {
            Area::Root | Area::Attachments(_) => return Err(FsError::Forbidden),
            Area::Shared(segs) => segs,
        };
        let p = self.real_path(&segs, true)?;
        let m = std::fs::symlink_metadata(&p).map_err(|e| io_err(&e))?;
        if m.is_dir() {
            if recursive {
                remove_tree(&p)?;
            } else {
                std::fs::remove_dir(&p).map_err(|e| io_err(&e))?;
            }
        } else {
            std::fs::remove_file(&p).map_err(|e| io_err(&e))?;
        }
        self.notify(&segs);
        Ok(())
    }

    /// 移動（名前の変更も）。両方とも共有フォルダの中。添付は動かせない。
    /// `overwrite` が false で同名のファイルがあれば `Exists`（true なら差し替える）。フォルダへは常に上書きしない。
    pub async fn rename(&self, from: &[String], to: &[String], overwrite: bool) -> FsResult<()> {
        let (Area::Shared(from), Area::Shared(to)) = (area(from), area(to)) else {
            return Err(FsError::Forbidden);
        };
        let src = self.real_path(&from, true)?;
        let (dst, _parent) = self.writable_target(&to)?;
        check_destination(&dst, overwrite)?;
        std::fs::rename(&src, &dst).map_err(|e| io_err(&e))?;
        self.notify(&from);
        self.notify(&to);
        Ok(())
    }

    /// コピー（ファイルだけ）。元は共有フォルダのファイル、または添付。`overwrite` の決まりは `rename` と同じ。
    pub async fn copy(&self, from: &[String], to: &[String], overwrite: bool) -> FsResult<()> {
        let Area::Shared(to) = area(to) else {
            return Err(FsError::Forbidden);
        };
        let src = self.read_target(from).await?.path;
        let (dst, parent) = self.writable_target(&to)?;
        check_destination(&dst, overwrite)?;
        let tmp = parent.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));
        if let Err(e) = tokio::fs::copy(&src, &tmp).await {
            let _ = std::fs::remove_file(&tmp);
            return Err(io_err(&e));
        }
        // 同じく、一時ファイルを作ってから名前を差し替える
        tokio::fs::rename(&tmp, &dst).await.map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            io_err(&e)
        })?;
        self.notify(&to);
        Ok(())
    }
}

/// 移動・コピーの行き先に同名のものがあるときの決まり。ファイルの上書きは `overwrite` のときだけ。
fn check_destination(dst: &Path, overwrite: bool) -> FsResult<()> {
    match std::fs::symlink_metadata(dst) {
        Ok(_) if !overwrite => Err(FsError::Exists),
        _ => Ok(()),
    }
}

/// フォルダを中身ごと消す（リンクは辿らず、リンクそのものを消す）。
fn remove_tree(dir: &Path) -> FsResult<()> {
    for entry in std::fs::read_dir(dir).map_err(|e| io_err(&e))? {
        let entry = entry.map_err(|e| io_err(&e))?;
        let path = entry.path();
        let is_dir = std::fs::symlink_metadata(&path)
            .map(|m| m.is_dir())
            .map_err(|e| io_err(&e))?;
        if is_dir {
            remove_tree(&path)?;
        } else {
            std::fs::remove_file(&path).map_err(|e| io_err(&e))?;
        }
    }
    std::fs::remove_dir(dir).map_err(|e| io_err(&e))
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
struct WriteFile {
    file: tokio::fs::File,
    tmp: PathBuf,
    target: PathBuf,
    committed: bool,
    /// コミットしたときに流す通知の宛先と、共有フォルダからの区切り。
    notify: Option<(Arc<Hub>, Vec<String>)>,
}

impl std::fmt::Debug for WriteFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteFile")
            .field("tmp", &self.tmp)
            .field("target", &self.target)
            .field("committed", &self.committed)
            .finish()
    }
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
            if let Some((hub, segs)) = &self.notify {
                hub.broadcast(&ServerEvent::FilesChanged { path: rel(segs) });
            }
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
            let segs = segments(path).ok_or(FsError::NotFound)?;
            if options.write || options.append {
                return self.write_file(&segs, options).await;
            }
            let target = self.read_target(&segs).await?;
            let file = tokio::fs::File::open(&target.path)
                .await
                .map_err(|e| io_err(&e))?;
            let m = file.metadata().await.map_err(|e| io_err(&e))?;
            Ok(Box::new(ReadFile {
                file,
                meta: Meta::of_std(&m),
            }) as Box<dyn DavFile>)
        })
    }

    fn read_dir<'a>(
        &'a self,
        path: &'a DavPath,
        _meta: ReadDirMeta,
    ) -> FsFuture<'a, FsStream<Box<dyn DavDirEntry>>> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::NotFound)?;
            let entries: Vec<FsResult<Box<dyn DavDirEntry>>> = self
                .list(&segs)
                .await?
                .into_iter()
                .map(|l| {
                    Ok(Box::new(DirEnt {
                        name: l.name,
                        meta: l.meta,
                    }) as Box<dyn DavDirEntry>)
                })
                .collect();
            let s: FsStream<Box<dyn DavDirEntry>> = Box::pin(stream::iter(entries));
            Ok(s)
        })
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::NotFound)?;
            let listed = self.stat(&segs).await?;
            Ok(Box::new(listed.meta) as Box<dyn DavMetaData>)
        })
    }

    fn create_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::Forbidden)?;
            self.make_dir(&segs).await
        })
    }

    fn remove_dir<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::Forbidden)?;
            // WebDAV の DELETE は、中身を先に一つずつ消してから呼ぶ（ここでは空のフォルダだけ）
            self.remove(&segs, false).await
        })
    }

    fn remove_file<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let segs = segments(path).ok_or(FsError::Forbidden)?;
            if let Area::Shared(s) = area(&segs) {
                let p = self.real_path(&s, true)?;
                if std::fs::symlink_metadata(&p)
                    .map_err(|e| io_err(&e))?
                    .is_dir()
                {
                    return Err(FsError::Forbidden);
                }
            }
            self.remove(&segs, false).await
        })
    }

    fn rename<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from = segments(from).ok_or(FsError::Forbidden)?;
            let to = segments(to).ok_or(FsError::Forbidden)?;
            // 上書きの可否は dav-server が Overwrite ヘッダーで決めて、先に宛先を消す
            SharedFs::rename(self, &from, &to, true).await
        })
    }

    fn copy<'a>(&'a self, from: &'a DavPath, to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async move {
            let from = segments(from).ok_or(FsError::NotFound)?;
            let to = segments(to).ok_or(FsError::Forbidden)?;
            SharedFs::copy(self, &from, &to, true).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn area_is_decided_by_the_first_segment() {
        assert!(matches!(area(&[]), Area::Root));
        assert!(matches!(
            area(&["attachments".into()]),
            Area::Attachments(_)
        ));
        assert!(matches!(
            area(&["attachments".into(), "a".into()]),
            Area::Attachments(_)
        ));
        assert!(matches!(area(&["docs".into()]), Area::Shared(_)));
    }

    #[test]
    fn change_paths_are_relative_and_slash_separated() {
        assert_eq!(rel(&["docs".into(), "a.txt".into()]), "docs/a.txt");
        assert_eq!(rel(&[]), "");
    }
}
