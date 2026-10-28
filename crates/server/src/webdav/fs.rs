//! 共有フォルダのファイルシステム（WebDAV と REST `/api/shared` で共通に使う）。
//!
//! 場所は 2 つに分かれる:
//! - `attachments/`（ルートの直下の名前が予約）: 添付の一覧（DB）。中身・名前・有無を変えられる
//!   （[`crate::attachments`] が DB とファイルをそろえる）。直下だけで、中にフォルダは作れない。
//! - それ以外（`data/shared/` の中）: 実際のファイル。作成・上書き・移動・コピー・削除ができる。
//!
//! 安全のための決まり:
//! - パスは区切りごとに [`valid_name`] を通す（`..`・区切り文字・Windows で使えない名前は拒否）。
//! - シンボリックリンクは辿らない（途中のどの要素もリンクなら拒否）。一覧にも出さない。
//! - 共有フォルダへの書き込みは必ず一時ファイルに書いてから rename する。上書きでも既存の実体の中身は
//!   書き換えない（バックアップはハードリンクなので、中身を書き換えるとバックアップも変わるため）。
//! - 変更は `files.changed` で知らせる（WebDAV でも REST でも）。
//!
//! 公開の関数は、パスを「区切りの列」で受け取る（WebDAV の DavPath も REST のパスも、ここで区切りにする）。

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Buf, Bytes};
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream,
    OpenOptions, ReadDirMeta,
};
use disnans_shared::{ServerEvent, SharedTrashNode};
use futures_util::stream;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::attachments::{self, Put};
use crate::db;
use crate::state::SharedState;
use crate::store::files as store_files;
use crate::trash;
use crate::webdav::names::{TMP_PREFIX, is_internal, valid_name};
use crate::webdav::tree::{self, ATTACHMENTS_DIR, Entry, Item};

/// 共有フォルダへのアクセス。利用者（REST では本人、WebDAV では認証された本人）ごとに作る。
#[derive(Clone)]
pub struct SharedFs {
    state: SharedState,
    user_id: String,
}

/// 項目の情報（大きさ・更新時刻・種類）。
#[derive(Debug, Clone)]
pub struct Meta {
    pub dir: bool,
    pub len: u64,
    pub modified: SystemTime,
    /// 作成の時刻（添付は最初に投稿された時刻、未投稿はアップロードの時刻）。
    pub created: SystemTime,
}

impl Meta {
    fn dir() -> Self {
        Meta {
            dir: true,
            len: 0,
            modified: UNIX_EPOCH,
            created: UNIX_EPOCH,
        }
    }

    fn of_item(item: &Item) -> Self {
        // `posted_at_ms` は初回の投稿の時刻（未投稿はアップロードの時刻）。作成と更新は同じ（添付は中身を変えると更新だけ変わる）
        let at = UNIX_EPOCH + Duration::from_millis(item.posted_at_ms.max(0) as u64);
        Meta {
            dir: false,
            len: item.size,
            modified: at,
            created: at,
        }
    }

    pub(crate) fn of_std(m: &std::fs::Metadata) -> Self {
        let modified = m.modified().unwrap_or(UNIX_EPOCH);
        Meta {
            dir: m.is_dir(),
            len: if m.is_dir() { 0 } else { m.len() },
            modified,
            // 作成の時刻が取れない OS・ファイルシステムでは更新の時刻で代える
            created: m.created().unwrap_or(modified),
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
    fn created(&self) -> FsResult<SystemTime> {
        Ok(self.created)
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
    /// 添付のときだけ（添付の ID）。
    pub file_id: Option<String>,
    /// 投稿された添付のときだけ（添付したメッセージ）。
    pub message_id: Option<String>,
    /// 添付のときだけ（種類）。
    pub mime: Option<String>,
    /// ゴミ箱の仮想の名前空間の中の位置（ゴミ箱の中のものだけ）。
    pub trash: Option<SharedTrashNode>,
}

impl Listed {
    /// ゴミ箱（仮想の `.trash` の直下）の一覧の 1 件。
    pub(crate) fn for_trash(
        name: String,
        meta: Meta,
        mime: Option<String>,
        trash: SharedTrashNode,
    ) -> Self {
        // 削除された添付の ID・投稿は、ゴミ箱の一覧では出さない（ID で読ませないため）
        Listed {
            name,
            meta,
            file_id: None,
            message_id: None,
            mime,
            trash: Some(trash),
        }
    }

    fn dir(name: &str) -> Self {
        Listed {
            name: name.to_owned(),
            meta: Meta::dir(),
            file_id: None,
            message_id: None,
            mime: None,
            trash: None,
        }
    }
}

/// ファイルの中身を読むための場所（実際のファイル、または添付の実体）。
#[derive(Debug, Clone)]
pub struct ReadTarget {
    pub path: PathBuf,
    /// 添付のときだけ（保存されている種類）。共有フォルダのファイルは `None`。
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
    /// `attachments/` の中（添付）
    Attachments(Vec<String>),
    /// 実際のファイルの場所（区切りの列。空でない）
    Shared(Vec<String>),
    /// 仮想のゴミ箱（`.trash` の中の区切りの列。空ならゴミ箱の直下）
    Trash(Vec<String>),
}

fn area(segs: &[String]) -> Area {
    match segs.first() {
        None => Area::Root,
        Some(first) if first == ATTACHMENTS_DIR => Area::Attachments(segs.to_vec()),
        Some(_) => Area::Shared(segs.to_vec()),
    }
}

/// 添付の名前（`attachments/<名前>` の形だけ。フォルダの中のフォルダは無い）。
fn attachment_name(segs: &[String]) -> Option<&str> {
    match segs {
        [root, name]
            if root == ATTACHMENTS_DIR
                && valid_name(name)
                && !is_internal(name)
                && crate::attachment_names::is_clean(name) =>
        {
            Some(name)
        }
        _ => None,
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
        // 上書きしない移動に対応しない OS・ファイルシステム（安全のため動かさない）
        ErrorKind::Unsupported => FsError::NotImplemented,
        _ => FsError::GeneralFailure,
    }
}

/// アプリのエラーを dav-server のエラーに変える（添付の操作）。
fn app_err(e: crate::error::AppError) -> FsError {
    match e.status.as_u16() {
        404 => FsError::NotFound,
        409 => FsError::Exists,
        403 => FsError::Forbidden,
        _ => FsError::GeneralFailure,
    }
}

/// 拡張子から種類を決める（WebDAV で作ったファイル用。分からなければ octet-stream）。
pub fn guess_mime(name: &str) -> String {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    };
    mime.to_owned()
}

impl SharedFs {
    /// パスの区域。`.trash` は、仮想のゴミ箱が使えるときだけゴミ箱になる（使えなければ実際の項目）。
    async fn area_of(&self, segs: &[String]) -> Area {
        match segs.first() {
            Some(first)
                if first.eq_ignore_ascii_case(trash::NAMESPACE)
                    && trash::namespace_active(&self.state).await =>
            {
                Area::Trash(segs[1..].to_vec())
            }
            _ => area(segs),
        }
    }

    pub fn new(state: &SharedState, user_id: &str) -> Self {
        SharedFs {
            state: state.clone(),
            user_id: user_id.to_owned(),
        }
    }

    async fn items(&self) -> FsResult<Vec<Item>> {
        store_files::attachment_items(&self.state.pool)
            .await
            .map_err(|_| FsError::GeneralFailure)
    }

    pub(crate) fn notify(&self, segs: &[String]) {
        self.state
            .hub
            .broadcast(&ServerEvent::FilesChanged { path: rel(segs) });
    }

    /// 実際のファイルの場所。区切りごとに名前を確かめ、リンクがあれば拒否する。
    /// 書き込みなら拒否は 403（`write`）、読み取りなら 404（存在を隠す）。
    pub(crate) fn real_path(&self, segs: &[String], write: bool) -> FsResult<PathBuf> {
        let refuse = if write {
            FsError::Forbidden
        } else {
            FsError::NotFound
        };
        let mut p = self.state.config.shared_dir();
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
                file_id: None,
                message_id: None,
                mime: None,
                trash: None,
            });
        }
        Ok(out)
    }

    /// 添付の 1 つを、一覧（DB）から引く。
    async fn attachment(&self, name: &str) -> FsResult<Option<Item>> {
        Ok(self
            .items()
            .await?
            .into_iter()
            .find(|i| i.name.to_lowercase() == name.to_lowercase()))
    }

    /// 項目の一覧（フォルダの中身）。フォルダでなければ NotFound。
    pub async fn list(&self, segs: &[String]) -> FsResult<Vec<Listed>> {
        match self.area_of(segs).await {
            Area::Trash(rest) => self.list_trash(&rest).await,
            Area::Root => {
                let mut out = vec![Listed::dir(ATTACHMENTS_DIR)];
                if trash::namespace_active(&self.state).await {
                    out.push(Listed {
                        trash: Some(SharedTrashNode::Root),
                        ..Listed::dir(trash::NAMESPACE)
                    });
                }
                // 直下の実際の名前のうち、予約の `attachments` は見せない
                for e in self.shared_entries(&self.state.config.shared_dir())? {
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
                        let (file_id, message_id, mime, meta) = match &c.entry {
                            Entry::File(item) => (
                                Some(item.file_id.clone()),
                                item.message_id.clone(),
                                Some(item.mime.clone()),
                                Meta::of_item(item),
                            ),
                            Entry::Dir => (None, None, None, Meta::dir()),
                        };
                        Listed {
                            name: c.name,
                            meta,
                            file_id,
                            message_id,
                            mime,
                            trash: None,
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

    /// ゴミ箱の中の一覧: 直下は完了した項目（名前は決まりの名前）。項目の中は、フォルダの中身。
    async fn list_trash(&self, rest: &[String]) -> FsResult<Vec<Listed>> {
        match rest.split_first() {
            None => Ok(trash::ready_rows(&self.state)
                .await
                .map_err(trash::vfs_err)?
                .iter()
                .filter_map(|r| trash::top_listing(&self.state, r, true))
                .collect()),
            Some((alias, inner)) => {
                let row = trash::by_alias(&self.state, alias)
                    .await
                    .map_err(trash::vfs_err)?
                    .ok_or(FsError::NotFound)?;
                let dir = trash::real_of(&self.state, &row, inner)?;
                let m = std::fs::symlink_metadata(&dir).map_err(|e| io_err(&e))?;
                if !m.is_dir() {
                    return Err(FsError::NotFound);
                }
                // 中身はすべて、同じ項目の子孫
                let node = SharedTrashNode::Descendant { id: row.id.clone() };
                Ok(self
                    .shared_entries(&dir)?
                    .into_iter()
                    .map(|l| Listed {
                        trash: Some(node.clone()),
                        ..l
                    })
                    .collect())
            }
        }
    }

    /// 1 つの項目の情報。区切りが空なら共有フォルダそのもの。
    pub async fn stat(&self, segs: &[String]) -> FsResult<Listed> {
        // ゴミ箱の直下の一つだけは、名前から直接引く（全部の一覧を読まない）
        if let Area::Trash(rest) = self.area_of(segs).await
            && let [alias] = rest.as_slice()
        {
            let row = trash::by_alias(&self.state, alias)
                .await
                .map_err(trash::vfs_err)?
                .ok_or(FsError::NotFound)?;
            return trash::top_listing(&self.state, &row, true).ok_or(FsError::NotFound);
        }
        let Some((name, parent)) = segs.split_last() else {
            return Ok(Listed::dir(""));
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
        match self.area_of(segs).await {
            Area::Trash(rest) if rest.is_empty() => Err(FsError::Forbidden),
            Area::Trash(rest) => {
                let (alias, inner) = rest.split_first().ok_or(FsError::Forbidden)?;
                let row = trash::by_alias(&self.state, alias)
                    .await
                    .map_err(trash::vfs_err)?
                    .ok_or(FsError::NotFound)?;
                let path = trash::real_of(&self.state, &row, inner)?;
                let m = std::fs::symlink_metadata(&path).map_err(|e| io_err(&e))?;
                if m.is_dir() {
                    return Err(FsError::Forbidden);
                }
                Ok(ReadTarget {
                    path,
                    mime: trash::attachment_mime(&row),
                })
            }
            Area::Root => Err(FsError::Forbidden),
            Area::Attachments(segs) => {
                let name = attachment_name(&segs).ok_or(FsError::NotFound)?;
                let item = self.attachment(name).await?.ok_or(FsError::NotFound)?;
                Ok(ReadTarget {
                    path: crate::files::file_path(&self.state.config, &item.file_id),
                    mime: Some(item.mime),
                })
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

    /// フォルダを作る（既にあれば Exists）。`attachments` の中には作れない。
    pub async fn make_dir(&self, segs: &[String]) -> FsResult<()> {
        match self.area_of(segs).await {
            Area::Root | Area::Attachments(_) | Area::Trash(_) => Err(FsError::Forbidden),
            Area::Shared(segs) => {
                let (target, _parent) = self.new_target(&segs)?;
                std::fs::create_dir(&target).map_err(|e| io_err(&e))?;
                self.notify(&segs);
                Ok(())
            }
        }
    }

    /// 書き込み（作成・上書き）。`options` は PUT の形。
    /// 戻り値に書き込み、最後に `flush` すると本来の場所に入り、`files.changed` が流れる。
    /// `attachments/<名前>` は、同じ名前があれば中身を差し替え、なければ新しい添付にする。
    pub async fn write_file(
        &self,
        segs: &[String],
        options: OpenOptions,
    ) -> FsResult<Box<dyn DavFile>> {
        match self.area_of(segs).await {
            Area::Trash(_) => Err(FsError::Forbidden),
            Area::Shared(segs) => self.write_shared(&segs, options).await,
            Area::Attachments(segs) => {
                let name = attachment_name(&segs).ok_or(FsError::Forbidden)?.to_owned();
                let existing = self.attachment(&name).await?;
                if options.create_new && existing.is_some() {
                    return Err(FsError::Exists);
                }
                let tmp = self
                    .state
                    .config
                    .tmp_dir()
                    .join(format!("{}.upload", db::new_ulid()));
                // 一部だけ書き換える PUT（Content-Range など）は、今の中身を写してから
                let keep = existing.as_ref().filter(|_| !options.truncate);
                let prepared = match keep {
                    Some(item) => {
                        let src = crate::files::file_path(&self.state.config, &item.file_id);
                        tokio::fs::copy(&src, &tmp).await.map(|_| ())
                    }
                    None => tokio::fs::File::create(&tmp).await.map(|_| ()),
                };
                prepared.map_err(|e| {
                    let _ = std::fs::remove_file(&tmp);
                    io_err(&e)
                })?;
                let file = tokio::fs::OpenOptions::new()
                    .write(true)
                    .open(&tmp)
                    .await
                    .map_err(|e| {
                        let _ = std::fs::remove_file(&tmp);
                        io_err(&e)
                    })?;
                let mode = if options.create_new {
                    Put::CreateOnly
                } else {
                    Put::Overwrite
                };
                Ok(Box::new(WriteFile {
                    file,
                    tmp,
                    dest: Dest::Attachment { name, mode },
                    committed: false,
                    state: self.state.clone(),
                    user_id: self.user_id.clone(),
                }) as Box<dyn DavFile>)
            }
            Area::Root => Err(FsError::Forbidden),
        }
    }

    async fn write_shared(
        &self,
        segs: &[String],
        options: OpenOptions,
    ) -> FsResult<Box<dyn DavFile>> {
        let (target, parent) = self.writable_target(segs)?;
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
            dest: Dest::Shared {
                target,
                path: rel(segs),
            },
            committed: false,
            state: self.state.clone(),
            user_id: self.user_id.clone(),
        }) as Box<dyn DavFile>)
    }

    /// 削除。フォルダは `recursive` のときだけ中身ごと消す（そうでなければ空のときだけ）。
    /// `attachments/<名前>` は添付を消す（投稿されていれば「削除された」になる）。
    pub async fn remove(&self, segs: &[String], recursive: bool) -> FsResult<()> {
        match self.area_of(segs).await {
            Area::Root => Err(FsError::Forbidden),
            // ゴミ箱の項目（直下だけ）を完全に消す。中のものは消せない
            Area::Trash(rest) => {
                let [alias] = rest.as_slice() else {
                    return Err(FsError::Forbidden);
                };
                let row = trash::by_alias(&self.state, alias)
                    .await
                    .map_err(trash::vfs_err)?
                    .ok_or(FsError::NotFound)?;
                trash::purge(&self.state, &row.id)
                    .await
                    .map_err(trash::vfs_err)
            }
            Area::Attachments(segs) => {
                let name = attachment_name(&segs).ok_or(FsError::Forbidden)?;
                let item = self.attachment(name).await?.ok_or(FsError::NotFound)?;
                attachments::remove(&self.state, &item.file_id)
                    .await
                    .map_err(app_err)
            }
            Area::Shared(segs) => {
                let p = self.real_path(&segs, true)?;
                let m = std::fs::symlink_metadata(&p).map_err(|e| io_err(&e))?;
                if m.is_dir() {
                    if recursive {
                        remove_tree_blocking(p.clone()).await?;
                    } else {
                        std::fs::remove_dir(&p).map_err(|e| io_err(&e))?;
                    }
                } else {
                    std::fs::remove_file(&p).map_err(|e| io_err(&e))?;
                }
                self.notify(&segs);
                Ok(())
            }
        }
    }

    /// 移動（名前の変更も）。`attachments/` の中どうし（別名だけ変わる）か、共有フォルダの中どうし。
    /// `attachments/` と共有フォルダの間は動かせない（コピーする）。
    /// `overwrite` が false で同名のものがあれば `Exists`。
    pub async fn rename(&self, from: &[String], to: &[String], overwrite: bool) -> FsResult<()> {
        // ゴミ箱の項目は、元の場所へだけ戻せる（ほかの場所への移動は拒否）
        if let Area::Trash(rest) = self.area_of(from).await {
            return self.restore_from_trash(&rest, to).await;
        }
        match (self.area_of(from).await, self.area_of(to).await) {
            (Area::Attachments(from), Area::Attachments(to)) => {
                let from_name = attachment_name(&from).ok_or(FsError::Forbidden)?;
                let to_name = attachment_name(&to).ok_or(FsError::Forbidden)?;
                let item = self.attachment(from_name).await?.ok_or(FsError::NotFound)?;
                attachments::rename(&self.state, &item.file_id, to_name, overwrite)
                    .await
                    .map_err(app_err)
            }
            (Area::Shared(from), Area::Shared(to)) => {
                let src = self.real_path(&from, true)?;
                let src_meta = std::fs::symlink_metadata(&src).map_err(|e| io_err(&e))?;
                let dst = if src_meta.is_dir() {
                    // フォルダは上書き・マージしない。自分の中へは動かせない
                    let (dst, _parent) = self.new_target(&to)?;
                    if dst.starts_with(&src) {
                        return Err(FsError::Forbidden);
                    }
                    dst
                } else {
                    let (dst, _parent) = self.new_target(&to)?;
                    // 同じ名前のフォルダは、ファイルでも置き換えない（409）
                    if std::fs::symlink_metadata(&dst).is_ok_and(|m| m.is_dir()) {
                        return Err(FsError::Exists);
                    }
                    dst
                };
                // 同名があれば失敗する（上書きは overwrite のファイルだけ）。確かめと移動は一度に行う
                if src_meta.is_dir() || !overwrite {
                    crate::noreplace::rename_no_replace(&src, &dst).map_err(|e| io_err(&e))?;
                } else {
                    std::fs::rename(&src, &dst).map_err(|e| io_err(&e))?;
                }
                self.notify(&from);
                self.notify(&to);
                Ok(())
            }
            // 共有フォルダと添付の間は、コピーしてから消す
            _ => Err(FsError::Forbidden),
        }
    }

    /// ゴミ箱の項目を、元の場所（`original_path`）へ戻す。ほかの場所は 403。
    async fn restore_from_trash(&self, rest: &[String], to: &[String]) -> FsResult<()> {
        let [alias] = rest else {
            return Err(FsError::Forbidden);
        };
        let row = trash::by_alias(&self.state, alias)
            .await
            .map_err(trash::vfs_err)?
            .ok_or(FsError::NotFound)?;
        if to != trash::original_segs(&row).as_slice() {
            return Err(FsError::Forbidden);
        }
        trash::restore(&self.state, &row.id)
            .await
            .map(|_| ())
            .map_err(trash::vfs_err)
    }

    /// フォルダを再帰でコピーする（共有フォルダの中どうし）。同名があれば上書き・マージせず 409。
    /// 一時のフォルダに作ってから名前を付けるので、途中で失敗しても行き先に部分的な結果は残らない。
    async fn copy_dir(&self, src: &Path, to: &[String]) -> FsResult<()> {
        let (dst, parent) = self.new_target(to)?;
        if dst.starts_with(src) {
            return Err(FsError::Forbidden);
        }
        if std::fs::symlink_metadata(&dst).is_ok() {
            return Err(FsError::Exists);
        }
        let tmp = parent.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));
        let (src_owned, tmp_owned) = (src.to_owned(), tmp.clone());
        tokio::task::spawn_blocking(move || {
            crate::webdav::usage::copy_tree(&src_owned, &tmp_owned)
        })
        .await
        .map_err(|_| FsError::GeneralFailure)?
        .map_err(|e| io_err(&e))?;
        // 名前を付けるまでに同名が現れたら、一時のものを消して 409
        // 上書きしない移動（同名が今あれば失敗し、一時のものを消す）
        if let Err(e) = crate::noreplace::rename_no_replace(&tmp, &dst) {
            let _ = remove_tree_blocking(tmp).await;
            return Err(io_err(&e));
        }
        self.notify(to);
        Ok(())
    }

    /// コピー。元は共有フォルダのファイル、または添付。先は共有フォルダ、または `attachments/` の中（新しい添付）。
    /// `overwrite` の決まりは `rename` と同じ（添付の中身を差し替える形になる）。
    pub async fn copy(&self, from: &[String], to: &[String], overwrite: bool) -> FsResult<()> {
        match self.area_of(to).await {
            Area::Shared(to) => {
                // 元がフォルダなら、中身ごと（共有フォルダの中、またはゴミ箱の中のフォルダ）
                let src_dir = match self.area_of(from).await {
                    Area::Shared(from_segs) => {
                        let src = self.real_path(&from_segs, false)?;
                        let src_meta = std::fs::symlink_metadata(&src).map_err(|e| io_err(&e))?;
                        src_meta.is_dir().then_some(src)
                    }
                    Area::Trash(rest) if !rest.is_empty() => {
                        let row = trash::by_alias(&self.state, &rest[0])
                            .await
                            .map_err(trash::vfs_err)?
                            .ok_or(FsError::NotFound)?;
                        let src = trash::real_of(&self.state, &row, &rest[1..])?;
                        let src_meta = std::fs::symlink_metadata(&src).map_err(|e| io_err(&e))?;
                        src_meta.is_dir().then_some(src)
                    }
                    _ => None,
                };
                if let Some(src) = src_dir {
                    return self.copy_dir(&src, &to).await;
                }
                let src = self.read_target(from).await?.path;
                let (dst, parent) = self.new_target(&to)?;
                // 同じ名前のフォルダは、ファイルでも置き換えない（409）
                if std::fs::symlink_metadata(&dst).is_ok_and(|m| m.is_dir()) {
                    return Err(FsError::Exists);
                }
                let tmp = parent.join(format!("{TMP_PREFIX}{}", ulid::Ulid::new()));
                if let Err(e) = tokio::fs::copy(&src, &tmp).await {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(io_err(&e));
                }
                // 一時ファイルを作ってから名前を付ける（overwrite でなければ、同名があれば失敗する）
                let placed = if overwrite {
                    std::fs::rename(&tmp, &dst)
                } else {
                    crate::noreplace::rename_no_replace(&tmp, &dst)
                };
                placed.map_err(|e| {
                    let _ = std::fs::remove_file(&tmp);
                    io_err(&e)
                })?;
                self.notify(&to);
                Ok(())
            }
            Area::Attachments(to) => {
                let name = attachment_name(&to).ok_or(FsError::Forbidden)?.to_owned();
                let target = self.read_target(from).await?;
                let mime = match target.mime {
                    Some(m) => m,
                    None => guess_mime(&name),
                };
                let mode = if overwrite {
                    Put::Overwrite
                } else {
                    Put::CreateOnly
                };
                attachments::copy_in(&self.state, &self.user_id, &target.path, &name, mime, mode)
                    .await
                    .map_err(app_err)?;
                Ok(())
            }
            Area::Root | Area::Trash(_) => Err(FsError::Forbidden),
        }
    }
}

/// フォルダの中身ごと消すのを、非同期の処理の外（blocking の thread）で行う。
pub(crate) async fn remove_tree_blocking(dir: PathBuf) -> FsResult<()> {
    tokio::task::spawn_blocking(move || remove_tree(&dir))
        .await
        .map_err(|_| FsError::GeneralFailure)?
}

/// フォルダを中身ごと消す（リンクは辿らず、リンクそのものを消す）。
pub(crate) fn remove_tree(dir: &Path) -> FsResult<()> {
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

/// 書き込みの行き先。
#[derive(Debug)]
enum Dest {
    /// 共有フォルダのファイル（`target` に rename する。`path` は通知の相対パス）。
    Shared { target: PathBuf, path: String },
    /// 添付（別名 `name`。`mode` の決まりで作る・差し替える）。
    Attachment { name: String, mode: Put },
}

/// 書き込み中のファイル。一時ファイルに書き、`flush`（書き終わり）で行き先に入れる。
/// 途中で終わったら（コミットされなかったら）一時ファイルを消す。
struct WriteFile {
    file: tokio::fs::File,
    tmp: PathBuf,
    dest: Dest,
    committed: bool,
    state: SharedState,
    user_id: String,
}

impl std::fmt::Debug for WriteFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteFile")
            .field("tmp", &self.tmp)
            .field("dest", &self.dest)
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
            match &self.dest {
                Dest::Shared { target, path } => {
                    // 上書きでも、古い実体は触らず名前だけを差し替える（バックアップのハードリンクを守る）
                    std::fs::rename(&self.tmp, target).map_err(|e| io_err(&e))?;
                    self.committed = true;
                    self.state
                        .hub
                        .broadcast(&ServerEvent::FilesChanged { path: path.clone() });
                }
                Dest::Attachment { name, mode } => {
                    // 変換して、中身を差し替える or 新しい添付にする（一時ファイルは消費される）
                    let mime = guess_mime(name);
                    let tmp = self.tmp.clone();
                    attachments::put(&self.state, &self.user_id, tmp, name, mime, *mode)
                        .await
                        .map_err(app_err)?;
                    self.committed = true;
                }
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
            if let Area::Shared(s) = self.area_of(&segs).await {
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
        assert!(matches!(area(&["docs".into()]), Area::Shared(_)));
    }

    #[test]
    fn attachments_hold_only_one_level_of_plain_names() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            attachment_name(&s(&["attachments", "a.txt"])),
            Some("a.txt")
        );
        assert_eq!(attachment_name(&s(&["attachments", "a", "b"])), None);
        assert_eq!(attachment_name(&s(&["attachments", "CON"])), None);
        assert_eq!(attachment_name(&s(&["attachments", ".disnans-x"])), None);
    }

    #[test]
    fn change_paths_are_relative_and_slash_separated() {
        assert_eq!(rel(&["docs".into(), "a.txt".into()]), "docs/a.txt");
        assert_eq!(rel(&[]), "");
    }

    #[test]
    fn mime_is_guessed_from_the_extension() {
        assert_eq!(guess_mime("a.PNG"), "image/png");
        assert_eq!(guess_mime("noext"), "application/octet-stream");
    }
}
