//! `disnans plugin publish / list / remove`。プラグイン・テーマの配布を、非対話で行う。

use std::path::Path;

use disnans_client_core::{ReadFailure, RestClient, ServerUrl};
use serde_json::{Value, json};

use crate::args::{PluginAction, PluginPublishArgs, PluginRemoveArgs};
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

/// manifest から読んだ、表示用の情報。
#[derive(Debug, PartialEq, Eq)]
struct Local {
    id: String,
    version: String,
    name: String,
    kind: String,
}

fn usage(message: impl Into<String>) -> CliError {
    CliError::Usage(message.into())
}

/// `manifest.json` の id / version / name / type を読む（細かい検査はサーバーが行う）。
fn read_manifest(bytes: &[u8]) -> Result<Local, CliError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|e| usage(format!("manifest.json を読めません: {e}")))?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let need = |key: &str| {
        text(key)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| usage(format!("manifest.json に `{key}` がありません")))
    };
    Ok(Local {
        id: need("id")?,
        version: need("version")?,
        name: need("name")?,
        kind: text("type").unwrap_or_else(|| "plugin".into()),
    })
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
        PluginAction::List(opts) => {
            let client = RestClient::new(server, dev_user)?;
            let list = client
                .get_value("/api/plugins")
                .await
                .map_err(CliError::Plugin)?;
            if opts.json {
                Ok(output::json_value(&list)?)
            } else {
                Ok(human_list(&list))
            }
        }
        PluginAction::Remove(args) => remove(server, dev_user, args).await,
    }
}

fn human_list(list: &Value) -> String {
    let Some(items) = list.as_array().filter(|a| !a.is_empty()) else {
        return "プラグインはありません".to_owned();
    };
    let field = |item: &Value, key: &str| {
        output::escape_human(item.get(key).and_then(Value::as_str).unwrap_or(""))
    };
    items
        .iter()
        .map(|item| {
            format!(
                "{}\t{}\t{}\t{}\t{}",
                field(item, "id"),
                field(item, "version"),
                field(item, "type"),
                field(item, "visibility"),
                field(item, "name")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    let (data, files, local) = collect(&args.dir)?;
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    let client = RestClient::new(server, dev_user)?;
    // 範囲の指定がなければ、既存の状態を保つ（なければ public）。
    let visibility = if args.private {
        "private".to_owned()
    } else if args.public {
        "public".to_owned()
    } else {
        existing_visibility(&client, &local.id)
            .await
            .map_err(CliError::Plugin)?
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
        .map_err(CliError::Plugin)?;
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
        .map_err(CliError::Plugin)?;
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
