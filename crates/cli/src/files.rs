//! `disnans files ls / get / put / rm / mv / cp / mkdir`。共有フォルダ（`/api/shared`）を非対話で扱う。
//! 大きなファイルでも、取得・送信は少しずつ流す（メモリに全部は載せない）。

use std::io::Write;
use std::path::{Path, PathBuf};

use disnans_client_core::{ReadFailure, RestClient, ServerUrl, shared_path};
use disnans_shared::{SharedEntry, SharedKind, SharedListing, SharedOp};
use jiff::{Timestamp, tz::TimeZone};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::args::{
    FilesAction, FilesGetArgs, FilesLsArgs, FilesMkdirArgs, FilesMoveArgs, FilesPutArgs,
    FilesRmArgs,
};
use crate::{CliError, output};

const CHUNK: usize = 64 * 1024;

fn usage(message: impl Into<String>) -> CliError {
    CliError::Usage(message.into())
}

fn api(e: ReadFailure) -> CliError {
    CliError::Api(e)
}

fn not_found(path: &str) -> CliError {
    CliError::Api(ReadFailure {
        status: Some(404),
        code: "not_found".to_owned(),
        message: format!("共有フォルダに `{path}` がありません"),
    })
}

/// 引数のパスを整える。`allow_root` でなければ空（直下）は拒否する。
fn norm(path: &str, allow_root: bool) -> Result<String, CliError> {
    let path = shared_path(path).map_err(usage)?;
    if path.is_empty() && !allow_root {
        return Err(usage("共有フォルダの直下そのものは指定できません"));
    }
    Ok(path)
}

fn base_name(path: &Path) -> Result<String, CliError> {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(str::to_owned)
        .ok_or_else(|| usage(format!("ファイル名を決められません: {}", path.display())))
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

fn time_text(ms: i64) -> String {
    Timestamp::from_millisecond(ms).map_or_else(
        |_| "-".to_owned(),
        |t| {
            t.to_zoned(TimeZone::system())
                .strftime("%Y-%m-%d %H:%M")
                .to_string()
        },
    )
}

fn entry_line(e: &SharedEntry) -> String {
    let (mark, suffix) = match e.kind {
        SharedKind::Dir => ('d', "/"),
        SharedKind::File => ('-', ""),
    };
    format!(
        "{mark} {:>12}  {}  {}{suffix}",
        e.size,
        time_text(e.modified),
        output::escape_human(&e.name)
    )
}

fn json_of<T: serde::Serialize>(value: &T) -> Result<String, CliError> {
    output::json_value(value).map_err(CliError::Json)
}

pub async fn run(
    server: ServerUrl,
    dev_user: Option<&str>,
    action: FilesAction,
) -> Result<String, CliError> {
    match action {
        FilesAction::Ls(args) => ls(RestClient::new(server, dev_user)?, args).await,
        FilesAction::Put(args) => put(RestClient::new(server, dev_user)?, args).await,
        FilesAction::Rm(args) => rm(RestClient::new(server, dev_user)?, args).await,
        FilesAction::Mv(args) => op(RestClient::new(server, dev_user)?, args, true).await,
        FilesAction::Cp(args) => op(RestClient::new(server, dev_user)?, args, false).await,
        FilesAction::Mkdir(args) => mkdir(RestClient::new(server, dev_user)?, args).await,
        FilesAction::Get(_) => Err(usage("`files get` は直接実行するコマンドです")),
    }
}

async fn ls(client: RestClient, args: FilesLsArgs) -> Result<String, CliError> {
    let path = norm(args.path.as_deref().unwrap_or(""), true)?;
    let listing = if path.is_empty() {
        client.shared_list("").await.map_err(api)?
    } else {
        match client.shared_stat(&path).await.map_err(api)? {
            None => return Err(not_found(&path)),
            Some(e) if e.kind == SharedKind::Dir => client.shared_list(&path).await.map_err(api)?,
            Some(e) => SharedListing {
                path: path.clone(),
                entries: vec![e],
            },
        }
    };
    if args.json {
        return json_of(&listing);
    }
    if listing.entries.is_empty() {
        return Ok("（空）".to_owned());
    }
    Ok(listing
        .entries
        .iter()
        .map(entry_line)
        .collect::<Vec<_>>()
        .join("\n"))
}

pub async fn get(
    server: ServerUrl,
    dev_user: Option<&str>,
    args: &FilesGetArgs,
) -> Result<(), CliError> {
    let client = RestClient::new(server, dev_user)?;
    let path = norm(&args.path, false)?;
    let to_stdout = args.dest.as_deref() == Some("-");
    // 保存先は、サーバーへ行く前に決めて確かめる。
    let dest: Option<PathBuf> = if to_stdout {
        None
    } else {
        let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
        let mut dest = args
            .dest
            .as_ref()
            .map_or_else(|| PathBuf::from(&name), PathBuf::from);
        if dest.is_dir() {
            dest = dest.join(&name);
        }
        if dest.exists() && !args.force {
            return Err(usage(format!(
                "{} が既にあります。上書きするなら --force を付けてください",
                dest.display()
            )));
        }
        Some(dest)
    };
    match client.shared_stat(&path).await.map_err(api)? {
        None => return Err(not_found(&path)),
        Some(e) if e.kind == SharedKind::Dir => {
            return Err(usage(format!(
                "`{path}` はフォルダです（ファイルだけ取得できます）"
            )));
        }
        Some(_) => {}
    }
    let mut download = client.shared_get(&path).await.map_err(api)?;
    let Some(dest) = dest else {
        let mut out = std::io::stdout().lock();
        while let Some(chunk) = download.chunk().await.map_err(api)? {
            match out.write_all(&chunk) {
                Ok(()) => {}
                // `| head` などで閉じられたら、静かに終わる。
                Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => return Ok(()),
                Err(e) => return Err(CliError::Io(e)),
            }
        }
        out.flush().map_err(CliError::Io)?;
        return Ok(());
    };
    // 途中で失敗した部分ファイルを本物に見せないため、一時の名前に書いてから差し替える。
    let part = PathBuf::from(format!("{}.disnans-part", dest.display()));
    let written = write_download(&mut download, &part).await;
    let total = match written {
        Ok(total) => total,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
    };
    if let Err(e) = tokio::fs::rename(&part, &dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(CliError::Io(e));
    }
    eprintln!("保存しました: {} ({total} バイト)", dest.display());
    Ok(())
}

async fn write_download(
    download: &mut disnans_client_core::SharedDownload,
    part: &Path,
) -> Result<u64, CliError> {
    let mut file = tokio::fs::File::create(part).await.map_err(CliError::Io)?;
    let mut total = 0u64;
    while let Some(chunk) = download.chunk().await.map_err(api)? {
        total += chunk.len() as u64;
        file.write_all(&chunk).await.map_err(CliError::Io)?;
    }
    file.flush().await.map_err(CliError::Io)?;
    Ok(total)
}

async fn put(client: RestClient, args: FilesPutArgs) -> Result<String, CliError> {
    let meta = std::fs::metadata(&args.local)
        .map_err(|e| usage(format!("{} を読めません: {e}", args.local.display())))?;
    if !meta.is_file() {
        return Err(usage(format!(
            "{} はファイルではありません",
            args.local.display()
        )));
    }
    let name = base_name(&args.local)?;
    let given = args.path.as_deref().unwrap_or("");
    let mut path = norm(given, true)?;
    // 省略・末尾 `/`・既存のフォルダなら、その中に同じ名前で置く。
    let mut existing = if path.is_empty() {
        None
    } else {
        client.shared_stat(&path).await.map_err(api)?
    };
    if path.is_empty()
        || given.ends_with('/')
        || existing.as_ref().is_some_and(|e| e.kind == SharedKind::Dir)
    {
        path = join(&path, &name);
        existing = client.shared_stat(&path).await.map_err(api)?;
    }
    if let Some(e) = &existing {
        if e.kind == SharedKind::Dir {
            return Err(usage(format!("`{path}` はフォルダです")));
        }
        if !args.force {
            return Err(usage(format!(
                "`{path}` が既にあります。上書きするなら --force を付けてください"
            )));
        }
    }
    let length = meta.len();
    let file = tokio::fs::File::open(&args.local)
        .await
        .map_err(CliError::Io)?;
    let stream = futures_util::stream::unfold(file, |mut file| async move {
        let mut buf = vec![0u8; CHUNK];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<Vec<u8>, std::io::Error>(buf), file))
            }
            Err(e) => Some((Err(e), file)),
        }
    });
    let entry = client
        .shared_put(&path, length, reqwest::Body::wrap_stream(stream))
        .await
        .map_err(api)?;
    if args.json {
        return json_of(&entry);
    }
    Ok(format!(
        "送信しました: {} ({} バイト)",
        output::escape_human(&entry.path),
        entry.size
    ))
}

async fn rm(client: RestClient, args: FilesRmArgs) -> Result<String, CliError> {
    let path = norm(&args.path, false)?;
    match client.shared_stat(&path).await.map_err(api)? {
        None => return Err(not_found(&path)),
        Some(e) if e.kind == SharedKind::Dir && !args.recursive => {
            return Err(usage(format!(
                "`{path}` はフォルダです。中身ごと消すなら -r を付けてください"
            )));
        }
        Some(_) => {}
    }
    client.shared_delete(&path).await.map_err(api)?;
    if args.json {
        return json_of(&json!({ "path": path, "removed": true }));
    }
    Ok(format!("削除しました: {}", output::escape_human(&path)))
}

async fn op(client: RestClient, args: FilesMoveArgs, is_move: bool) -> Result<String, CliError> {
    let from = norm(&args.from, false)?;
    let to = norm(&args.to, false)?;
    let request = if is_move {
        SharedOp::Move { from, to }
    } else {
        SharedOp::Copy { from, to }
    };
    let entry = client.shared_op(&request).await.map_err(api)?;
    if args.json {
        return json_of(&entry);
    }
    let verb = if is_move {
        "移動しました"
    } else {
        "コピーしました"
    };
    Ok(format!("{verb}: {}", output::escape_human(&entry.path)))
}

async fn mkdir(client: RestClient, args: FilesMkdirArgs) -> Result<String, CliError> {
    let path = norm(&args.path, false)?;
    let entry = client
        .shared_op(&SharedOp::Mkdir { path })
        .await
        .map_err(api)?;
    if args.json {
        return json_of(&entry);
    }
    Ok(format!(
        "作成しました: {}/",
        output::escape_human(&entry.path)
    ))
}
