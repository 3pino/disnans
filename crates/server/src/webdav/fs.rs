//! dav-server に渡す、共有フォルダのファイルシステム（読み取り専用）。
//!
//! 中身は [`tree`] が決める（`attachments/` の仮想フォルダ）。実体のファイルは `data/files/` にある。
//! 書き込み系は全部 403（`Forbidden`）。ハンドラーの許可するメソッドを絞っているので、実際には
//! PUT などは 405 で先に止まる（ここは二重の守り）。

use std::io::SeekFrom;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use dav_server::davpath::DavPath;
use dav_server::fs::{
    DavDirEntry, DavFile, DavFileSystem, DavMetaData, FsError, FsFuture, FsResult, FsStream,
    OpenOptions, ReadDirMeta,
};
use futures_util::stream;
use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::config::Config;
use crate::files;
use crate::store::files as store_files;
use crate::webdav::tree::{self, Entry, Item};

#[derive(Clone)]
pub struct SharedFs {
    pub config: Config,
    pub pool: SqlitePool,
}

/// 1 つのパスが何か（フォルダ、または投稿された添付）。
#[derive(Debug, Clone)]
enum Node {
    Dir,
    File(Item),
}

#[derive(Debug, Clone)]
struct Meta {
    dir: bool,
    len: u64,
    modified: SystemTime,
}

impl Meta {
    fn of(node: &Node) -> Self {
        match node {
            Node::Dir => Meta {
                dir: true,
                len: 0,
                modified: UNIX_EPOCH,
            },
            Node::File(item) => Meta {
                dir: false,
                len: item.size,
                modified: UNIX_EPOCH + Duration::from_millis(item.posted_at_ms.max(0) as u64),
            },
        }
    }

    fn of_entry(entry: &Entry<'_>) -> Self {
        match entry {
            Entry::Dir => Meta::of(&Node::Dir),
            Entry::File(item) => Meta::of(&Node::File((*item).clone())),
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

/// パス（共有フォルダからの、デコード済み）を、空でない区切りの列にする。UTF-8 でなければ None。
fn segments(path: &DavPath) -> Option<Vec<String>> {
    let text = std::str::from_utf8(path.as_bytes()).ok()?;
    Some(
        text.split('/')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

fn node_at(items: &[Item], path: &DavPath) -> FsResult<Node> {
    let segs = segments(path).ok_or(FsError::NotFound)?;
    let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
    match tree::find(items, &refs).ok_or(FsError::NotFound)? {
        Entry::Dir => Ok(Node::Dir),
        Entry::File(item) => Ok(Node::File(item.clone())),
    }
}

impl SharedFs {
    async fn items(&self) -> FsResult<Vec<Item>> {
        store_files::posted_items(&self.pool)
            .await
            .map_err(|_| FsError::GeneralFailure)
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

/// 開いた添付（読み取り専用）。実体は `data/files/<ID>`。
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

    fn write_buf(&'_ mut self, _buf: Box<dyn bytes::Buf + Send>) -> FsFuture<'_, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn write_bytes(&'_ mut self, _buf: Bytes) -> FsFuture<'_, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn read_bytes(&'_ mut self, count: usize) -> FsFuture<'_, Bytes> {
        Box::pin(async move {
            let mut buf = vec![0u8; count];
            let n = self
                .file
                .read(&mut buf)
                .await
                .map_err(|_| FsError::GeneralFailure)?;
            buf.truncate(n);
            Ok(Bytes::from(buf))
        })
    }

    fn seek(&'_ mut self, pos: SeekFrom) -> FsFuture<'_, u64> {
        Box::pin(async move {
            self.file
                .seek(pos)
                .await
                .map_err(|_| FsError::GeneralFailure)
        })
    }

    fn flush(&'_ mut self) -> FsFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

impl DavFileSystem for SharedFs {
    fn open<'a>(
        &'a self,
        path: &'a DavPath,
        options: OpenOptions,
    ) -> FsFuture<'a, Box<dyn DavFile>> {
        Box::pin(async move {
            if options.write
                || options.append
                || options.truncate
                || options.create
                || options.create_new
            {
                return Err(FsError::Forbidden);
            }
            let items = self.items().await?;
            match node_at(&items, path)? {
                // 読めるのは添付（ファイル）だけ
                Node::Dir => Err(FsError::Forbidden),
                Node::File(item) => {
                    let p = files::file_path(&self.config, &item.file_id);
                    let file = tokio::fs::File::open(p).await.map_err(|e| {
                        if e.kind() == std::io::ErrorKind::NotFound {
                            FsError::NotFound
                        } else {
                            FsError::GeneralFailure
                        }
                    })?;
                    Ok(Box::new(ReadFile {
                        file,
                        meta: Meta::of(&Node::File(item)),
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
            let items = self.items().await?;
            let segs = segments(path).ok_or(FsError::NotFound)?;
            let refs: Vec<&str> = segs.iter().map(String::as_str).collect();
            // フォルダでなければ（ファイルの中など）None になる
            let children = tree::children(&items, &refs).ok_or(FsError::NotFound)?;
            let entries: Vec<FsResult<Box<dyn DavDirEntry>>> = children
                .into_iter()
                .map(|c| {
                    Ok(Box::new(DirEnt {
                        name: c.name,
                        meta: Meta::of_entry(&c.entry),
                    }) as Box<dyn DavDirEntry>)
                })
                .collect();
            let s: FsStream<Box<dyn DavDirEntry>> = Box::pin(stream::iter(entries));
            Ok(s)
        })
    }

    fn metadata<'a>(&'a self, path: &'a DavPath) -> FsFuture<'a, Box<dyn DavMetaData>> {
        Box::pin(async move {
            let items = self.items().await?;
            let node = node_at(&items, path)?;
            Ok(Box::new(Meta::of(&node)) as Box<dyn DavMetaData>)
        })
    }

    // 書き込み系は全部 403
    fn create_dir<'a>(&'a self, _path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn remove_dir<'a>(&'a self, _path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn remove_file<'a>(&'a self, _path: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn rename<'a>(&'a self, _from: &'a DavPath, _to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn copy<'a>(&'a self, _from: &'a DavPath, _to: &'a DavPath) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn set_modified<'a>(&'a self, _path: &'a DavPath, _tm: SystemTime) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }

    fn set_accessed<'a>(&'a self, _path: &'a DavPath, _tm: SystemTime) -> FsFuture<'a, ()> {
        Box::pin(async { Err(FsError::Forbidden) })
    }
}
