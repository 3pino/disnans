//! `disnans plugin publish / list / remove`。プラグイン・テーマの配布を、非対話で行う。

use std::path::Path;

use disnans_client_core::dev_plugins::{self, ManifestInfo, parse_manifest};
use disnans_client_core::view::settings::device_defaults;
use disnans_client_core::{LocalStore, ReadFailure, RestClient, ServerUrl, Surface, host_os};
use serde_json::{Value, json};

use crate::args::{
    PluginAction, PluginDevdirArgs, PluginListArgs, PluginPublishArgs, PluginRemoveArgs,
};
use crate::{CliError, output};

/// 配布できるファイル名（サーバーと同じ。ここに無いものは送らない）。
const FILES: [&str; 5] = [
    "manifest.json",
    "main.js",
    "styles.css",
    "theme.css",
    "icon.svg",
];
/// サーバーの合計上限（5 MB）。超えるものは送る前に断る。
const MAX_TOTAL: usize = 5 * 1024 * 1024;

fn usage(message: impl Into<String>) -> CliError {
    CliError::Usage(message.into())
}

type Local = ManifestInfo;

fn read_manifest(bytes: &[u8]) -> Result<Local, CliError> {
    parse_manifest(bytes).map_err(usage)
}

/// ディレクトリから配布するファイルを集める。戻り値は（結合したデータ, 名前と範囲, manifest）。
#[allow(clippy::type_complexity)]
fn collect(
    dir: &Path,
) -> Result<(Vec<u8>, Vec<(String, std::ops::Range<usize>)>, Local), CliError> {
    if !dir.is_dir() {
        return Err(usage(format!(
            "ディレクトリではありません: {}",
            dir.display()
        )));
    }
    let mut data = Vec::new();
    let mut files = Vec::new();
    let mut local = None;
    for name in FILES {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        let bytes = std::fs::read(&path)
            .map_err(|e| usage(format!("{} を読めません: {e}", path.display())))?;
        if name == "manifest.json" {
            local = Some(read_manifest(&bytes)?);
        }
        let start = data.len();
        data.extend_from_slice(&bytes);
        files.push((name.to_owned(), start..data.len()));
    }
    let local = local.ok_or_else(|| usage("manifest.json がありません"))?;
    if data.len() > MAX_TOTAL {
        return Err(usage(format!(
            "ファイルの合計が大きすぎます（{} バイト。上限は 5 MB）",
            data.len()
        )));
    }
    let has = |name: &str| files.iter().any(|(n, _)| n == name);
    let required = if local.kind == "theme" {
        "theme.css"
    } else {
        "main.js"
    };
    if !has(required) {
        return Err(usage(format!(
            "{} がありません（type: {}）",
            required, local.kind
        )));
    }
    Ok((data, files, local))
}

pub async fn run(
    server: ServerUrl,
    dev_user: Option<&str>,
    action: PluginAction,
) -> Result<String, CliError> {
    match action {
        PluginAction::Publish(args) => publish(server, dev_user, args).await,
        PluginAction::List(opts) => list(server, dev_user, opts).await,
        PluginAction::Devdir(args) => devdir(server, dev_user, args).await,
        PluginAction::Remove(args) => remove(server, dev_user, args).await,
    }
}

/// 開発用フォルダ = このマシンの GUI（Surface::Tauri）のデバイス設定 `pluginsDevDir`（唯一の出どころ）。
/// GUI のデバイス ID が無ければ作らず、未設定として扱う。
async fn resolve_dev_dir(client: &RestClient) -> Option<String> {
    let id = LocalStore::open_default()
        .ok()?
        .existing_device_id(Surface::Tauri)
        .ok()??;
    let prefs = client.get_device_prefs(&id).await.ok()?;
    prefs
        .get("prefs")
        .and_then(|p| p.get("pluginsDevDir"))
        .and_then(Value::as_str)
        .filter(|d| !d.trim().is_empty())
        .map(str::to_owned)
}

/// GUI の既定のデバイス名（OS 名）。
fn default_device_name() -> &'static str {
    match host_os() {
        "windows" => "Windows",
        "linux" => "Linux",
        "android" => "Android",
        _ => "このデバイス",
    }
}

async fn devdir(
    server: ServerUrl,
    dev_user: Option<&str>,
    args: PluginDevdirArgs,
) -> Result<String, CliError> {
    let client = RestClient::new(server, dev_user)?;
    let show = |dir: Option<&str>, json: bool| -> Result<String, CliError> {
        if json {
            Ok(output::json_value(&json!({ "dir": dir }))?)
        } else {
            Ok(dir.map_or("未設定".to_owned(), output::escape_human))
        }
    };
    if args.path.is_none() && !args.clear {
        return show(resolve_dev_dir(&client).await.as_deref(), args.json);
    }
    let value = match &args.path {
        Some(path) => {
            let abs = std::path::absolute(path)
                .map_err(|e| usage(format!("パスを解決できません: {e}")))?;
            if !abs.is_dir() {
                return Err(usage(format!("フォルダがありません: {}", abs.display())));
            }
            let text = abs
                .to_str()
                .ok_or_else(|| usage("パスが UTF-8 ではありません"))?
                .to_owned();
            Value::String(text)
        }
        None => Value::Null,
    };
    // 書き込みだけ、GUI と同じ方法でデバイスを作る（登録 → GET → 1 キーだけ変えて PUT）。
    let store = LocalStore::open_default()?;
    let id = store.device_id(Surface::Tauri)?;
    client
        .put_device(&id, default_device_name())
        .await
        .map_err(CliError::Api)?;
    let mut prefs = match client.get_device_prefs(&id).await {
        Ok(body) => match body.get("prefs") {
            Some(Value::Object(map)) => Value::Object(map.clone()),
            _ => device_defaults(),
        },
        Err(e) if e.status == Some(404) => device_defaults(),
        Err(e) => return Err(CliError::Api(e)),
    };
    prefs["pluginsDevDir"] = value.clone();
    client
        .put_device_prefs(&id, &prefs)
        .await
        .map_err(CliError::Api)?;
    show(value.as_str(), args.json)
}

async fn list(
    server: ServerUrl,
    dev_user: Option<&str>,
    opts: PluginListArgs,
) -> Result<String, CliError> {
    let client = RestClient::new(server, dev_user)?;
    let remote = client
        .get_value("/api/plugins")
        .await
        .map_err(CliError::Api)?;
    let mut rows: Vec<Value> = Vec::new();
    match resolve_dev_dir(&client).await {
        None => eprintln!(
            "開発用フォルダが未設定です（`disnans plugin devdir <PATH>` か GUI の設定で指定）"
        ),
        Some(dir) => match dev_plugins::list(&dir) {
            Ok(entries) => {
                for entry in entries {
                    match entry.manifest {
                        Ok(m) => rows.push(json!({
                            "id": m.id, "version": m.version, "type": m.kind,
                            "source": "dev", "name": m.name, "folder": entry.folder,
                        })),
                        Err(e) => eprintln!("{}: {e}", entry.folder),
                    }
                }
            }
            Err(e) => eprintln!("{e}"),
        },
    }
    for item in remote.as_array().into_iter().flatten() {
        let get = |k: &str| item.get(k).cloned().unwrap_or(Value::Null);
        rows.push(json!({
            "id": get("id"), "version": get("version"), "type": get("type"),
            "source": get("visibility"), "name": get("name"),
        }));
    }
    rows.sort_by(|a, b| {
        a["id"].as_str().cmp(&b["id"].as_str()).then_with(|| {
            // 同じ id は dev を先に
            (a["source"] != "dev").cmp(&(b["source"] != "dev"))
        })
    });
    if opts.json {
        return Ok(output::json_value(&rows)?);
    }
    if rows.is_empty() {
        return Ok("プラグインはありません".to_owned());
    }
    let field = |item: &Value, key: &str| {
        output::escape_human(item.get(key).and_then(Value::as_str).unwrap_or(""))
    };
    Ok(rows
        .iter()
        .map(|r| {
            format!(
                "{}\t{}\t{}\t{}\t{}",
                field(r, "id"),
                field(r, "version"),
                field(r, "type"),
                field(r, "source"),
                field(r, "name")
            )
        })
        .collect::<Vec<_>>()
        .join("\n"))
}

/// 既存の公開状態（なければ `public`）。
async fn existing_visibility(client: &RestClient, id: &str) -> Result<Option<String>, ReadFailure> {
    let list = client.get_value("/api/plugins").await?;
    Ok(list.as_array().and_then(|items| {
        items
            .iter()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|item| item.get("visibility").and_then(Value::as_str))
            .map(str::to_owned)
    }))
}

async fn publish(
    server: ServerUrl,
    dev_user: Option<&str>,
    args: PluginPublishArgs,
) -> Result<String, CliError> {
    let client = RestClient::new(server, dev_user)?;
    let dir = match (&args.dir, &args.id) {
        (Some(dir), _) => dir.clone(),
        (None, Some(id)) => {
            let base = resolve_dev_dir(&client).await.ok_or_else(|| {
                usage("開発用フォルダが未設定です: `disnans plugin devdir <PATH>` か GUI の設定で指定してください（パスで送るなら --dir <PATH>）")
            })?;
            dev_plugins::find_by_id(&base, id).map_err(usage)?
        }
        (None, None) => return Err(usage("id か --dir を指定してください")),
    };
    let (data, files, local) = collect(&dir)?;
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    // 範囲の指定がなければ、既存の状態を保つ（なければ public）。
    let visibility = if args.private {
        "private".to_owned()
    } else if args.public {
        "public".to_owned()
    } else {
        existing_visibility(&client, &local.id)
            .await
            .map_err(CliError::Api)?
            .unwrap_or_else(|| "public".to_owned())
    };
    let mut report = json!({
        "id": local.id,
        "version": local.version,
        "name": local.name,
        "type": local.kind,
        "visibility": visibility,
        "files": names,
        "bytes": data.len(),
    });
    if args.dry_run {
        report["published"] = json!(false);
        return render(&report, args.json, "配布しません（--dry-run）");
    }
    let info = client
        .create_plugin(&visibility, &data, &files)
        .await
        .map_err(CliError::Api)?;
    report["published"] = json!(true);
    report["hash"] = info.get("hash").cloned().unwrap_or(Value::Null);
    report["server_version"] = info.get("version").cloned().unwrap_or(Value::Null);
    render(&report, args.json, "配布しました")
}

fn render(report: &Value, json: bool, headline: &str) -> Result<String, CliError> {
    if json {
        return Ok(output::json_value(report)?);
    }
    let s = |key: &str| output::escape_human(report[key].as_str().unwrap_or(""));
    Ok(format!(
        "{headline}: {} {} ({}, {}) [{}]",
        s("id"),
        s("version"),
        s("type"),
        s("visibility"),
        report["files"]
            .as_array()
            .map(|a| a
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", "))
            .unwrap_or_default()
    ))
}

async fn remove(
    server: ServerUrl,
    dev_user: Option<&str>,
    args: PluginRemoveArgs,
) -> Result<String, CliError> {
    let client = RestClient::new(server, dev_user)?;
    client
        .delete_plugin(&args.id)
        .await
        .map_err(CliError::Api)?;
    if args.json {
        Ok(output::json_value(
            &json!({ "id": args.id, "removed": true }),
        )?)
    } else {
        Ok(format!("{} を削除しました", output::escape_human(&args.id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn collects_existing_files_and_checks_required_ones() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(collect(dir.path()), Err(CliError::Usage(_))));
        write(
            dir.path(),
            "manifest.json",
            r#"{"id":"dice","version":"1.0.0","name":"Dice"}"#,
        );
        assert!(matches!(collect(dir.path()), Err(CliError::Usage(_))));
        write(dir.path(), "main.js", "1");
        write(dir.path(), "other.txt", "x");
        let (data, files, local) = collect(dir.path()).unwrap();
        assert_eq!(local.id, "dice");
        assert_eq!(local.kind, "plugin");
        let names: Vec<_> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["manifest.json", "main.js"]);
        assert_eq!(files[1].1.len(), 1);
        assert_eq!(data.len(), files[1].1.end);
    }

    #[test]
    fn themes_need_theme_css_and_bad_manifests_are_usage_errors() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "manifest.json",
            r#"{"id":"dark","version":"1","name":"Dark","type":"theme"}"#,
        );
        write(dir.path(), "main.js", "1");
        assert!(collect(dir.path()).is_err());
        write(dir.path(), "theme.css", "a{}");
        assert!(collect(dir.path()).is_ok());
        assert!(read_manifest(b"{").is_err());
        assert!(read_manifest(br#"{"id":"a"}"#).is_err());
    }
}
