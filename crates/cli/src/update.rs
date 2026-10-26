//! `disnans update`: GitHub Releases の最新版を確認し、あれば入れる。
//!
//! GUI のアップデートと同じ `latest.json` を見る。入れ方は導入方法で変わる。
//! - Linux の `.deb`（`/usr/bin/disnans`）: 同じリリースの `.deb` を取得して `apt-get install`（root でなければ `sudo` 経由）。
//! - Windows: `latest.json` のインストーラ（NSIS）を取得して起動する（このコマンドは待たずに終わる）。
//! - それ以外（AppImage・ソースからのビルドなど）: 自動では入れず、案内だけ出す。
//!
//! 注意: 取得物の署名（minisign）はこのコマンドでは検証しない。信頼の根拠は HTTPS（OS の証明書ストア）と
//! GitHub のリリースだけ。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use disnans_client_core::ClientError;
use serde::Deserialize;

use crate::CliError;
use crate::args::UpdateArgs;

const LATEST_URL: &str = "https://github.com/3pino/disnans/releases/latest/download/latest.json";
const RELEASE_BASE: &str = "https://github.com/3pino/disnans/releases/download";
const TRUSTED_PREFIX: &str = "https://github.com/3pino/disnans/";
/// 取得する本体の大きさの上限。
const MAX_DOWNLOAD: u64 = 400 << 20;
const MAX_LATEST_JSON: usize = 1 << 20;

#[derive(Debug, Deserialize)]
struct Latest {
    version: String,
    #[serde(default)]
    platforms: HashMap<String, Platform>,
}

#[derive(Debug, Deserialize)]
struct Platform {
    url: String,
}

/// `1.2.3` / `v1.2.3` / `1.2.3-rc.1` の数字部分。読めなければ `None`。
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let core = text.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn is_newer(latest: &str, current: &str) -> Option<bool> {
    Some(parse_version(latest)? > parse_version(current)?)
}

#[derive(Debug, PartialEq, Eq)]
enum Method {
    Deb,
    WindowsSetup,
    /// 自動では入れられない。理由と案内。
    Manual(String),
}

/// 実行ファイルの場所と OS から、入れ方を決める。
fn detect_method(exe: &Path, os: &str, arch: &str) -> Method {
    if arch != "x86_64" {
        return Method::Manual(format!("{arch} 向けの配布物はありません"));
    }
    let has = |name: &str| exe.components().any(|c| c.as_os_str() == name);
    if has("target") && (has("debug") || has("release")) {
        return Method::Manual("ソースからのビルドです。git pull して再ビルドしてください".into());
    }
    match os {
        "windows" => Method::WindowsSetup,
        "linux" if exe.starts_with("/usr/bin") => Method::Deb,
        "linux" => Method::Manual(
            "/usr/bin にインストールした .deb ではないため、自動更新できません（AppImage などは GUI のアップデートか、リリースページから入れ直してください）"
                .into(),
        ),
        other => Method::Manual(format!("{other} には対応していません")),
    }
}

fn deb_url(version: &str) -> String {
    format!("{RELEASE_BASE}/v{version}/disnans_{version}_amd64.deb")
}

/// 取得先として信頼する URL か（`latest.json` の内容をそのまま使わない）。
fn trusted(url: &str) -> bool {
    url.starts_with(TRUSTED_PREFIX) && url.is_ascii() && !url.contains(char::is_whitespace)
}

fn file_name_of(url: &str) -> Option<String> {
    let name = url.rsplit('/').next()?;
    let ok = !name.is_empty()
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    ok.then(|| name.to_owned())
}

pub async fn run(args: UpdateArgs) -> Result<String, CliError> {
    let current = env!("CARGO_PKG_VERSION");
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("disnans-cli/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(ClientError::Request)?;

    let latest = fetch_latest(&client).await?;
    let newer = is_newer(&latest.version, current).ok_or_else(|| {
        CliError::Usage(format!(
            "バージョンを比較できません（最新: {}, 現在: {current}）",
            crate::output::escape_human(&latest.version)
        ))
    })?;
    if !newer {
        return Ok(format!("最新です（{current}）"));
    }
    let version = latest.version.trim_start_matches('v').to_owned();
    let summary = format!("新しいバージョン {version} があります（現在 {current}）");
    if args.check {
        return Ok(format!("{summary}\n`disnans update` で更新できます"));
    }

    let exe = std::env::current_exe().map_err(CliError::Io)?;
    let exe = exe.canonicalize().unwrap_or(exe);
    match detect_method(&exe, std::env::consts::OS, std::env::consts::ARCH) {
        Method::Manual(reason) => Ok(format!(
            "{summary}\n自動更新できません: {reason}\nhttps://github.com/3pino/disnans/releases/latest"
        )),
        Method::Deb => {
            let url = deb_url(&version);
            let dir = work_dir()?;
            let path = dir.join(format!("disnans_{version}_amd64.deb"));
            eprintln!("{summary}\nダウンロード中: {url}");
            let downloaded = download(&client, &url, &path).await;
            let result = match downloaded {
                Ok(()) => install_deb(&path),
                Err(e) => Err(e),
            };
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(&dir);
            result?;
            Ok(format!("{version} に更新しました"))
        }
        Method::WindowsSetup => {
            let url = latest
                .platforms
                .get("windows-x86_64")
                .map(|p| p.url.as_str())
                .filter(|u| trusted(u))
                .ok_or_else(|| {
                    CliError::Usage("latest.json に Windows 用のインストーラがありません".into())
                })?;
            let name = file_name_of(url).ok_or_else(|| {
                CliError::Usage("インストーラのファイル名を決められません".into())
            })?;
            let path = work_dir()?.join(name);
            eprintln!("{summary}\nダウンロード中: {url}");
            download(&client, url, &path).await?;
            // インストーラは自分で CLI を置き換えるので、起動したら待たずに終わる。
            Command::new(&path)
                .args(["/P", "/UPDATE"])
                .spawn()
                .map_err(CliError::Io)?;
            Ok(format!(
                "インストーラを起動しました（{version}）。完了後、新しいターミナルで `disnans --version` を確認してください"
            ))
        }
    }
}

async fn fetch_latest(client: &reqwest::Client) -> Result<Latest, CliError> {
    let response = client
        .get(LATEST_URL)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(ClientError::Request)?
        .error_for_status()
        .map_err(ClientError::Request)?;
    let body = response.bytes().await.map_err(ClientError::Request)?;
    if body.len() > MAX_LATEST_JSON {
        return Err(CliError::Usage("latest.json が大きすぎます".into()));
    }
    Ok(serde_json::from_slice(&body)?)
}

fn work_dir() -> Result<PathBuf, CliError> {
    let dir = std::env::temp_dir().join(format!("disnans-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(CliError::Io)?;
    Ok(dir)
}

async fn download(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), CliError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(ClientError::Request)?
        .error_for_status()
        .map_err(ClientError::Request)?;
    if response.content_length().is_some_and(|n| n > MAX_DOWNLOAD) {
        return Err(CliError::Usage("ダウンロードが大きすぎます".into()));
    }
    let mut file = std::fs::File::create(dest).map_err(CliError::Io)?;
    let mut total: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(ClientError::Request)? {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD {
            return Err(CliError::Usage("ダウンロードが大きすぎます".into()));
        }
        file.write_all(&chunk).map_err(CliError::Io)?;
    }
    file.flush().map_err(CliError::Io)?;
    Ok(())
}

fn is_root() -> bool {
    Command::new("id")
        .arg("-u")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "0")
        .unwrap_or(false)
}

fn install_deb(path: &Path) -> Result<(), CliError> {
    let mut command = if is_root() {
        Command::new("apt-get")
    } else {
        // root でなければ権限昇格の `sudo` を経由する（パスワードを聞かれることがある）。
        let mut elevated = Command::new("sudo");
        elevated.arg("apt-get");
        elevated
    };
    command.arg("install").arg("-y").arg(path);
    let status = command.status().map_err(CliError::Io)?;
    if status.success() {
        Ok(())
    } else {
        Err(CliError::Io(std::io::Error::other(format!(
            "apt-get install が失敗しました（{status}）"
        ))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_numerically_and_ignore_prerelease_suffixes() {
        assert_eq!(parse_version("v0.2.10"), Some((0, 2, 10)));
        assert_eq!(parse_version("1.0.0-rc.1"), Some((1, 0, 0)));
        assert_eq!(parse_version("1.0"), None);
        assert_eq!(parse_version("1.0.0.1"), None);
        assert_eq!(is_newer("0.2.10", "0.2.9"), Some(true));
        assert_eq!(is_newer("0.2.7", "0.2.7"), Some(false));
        assert_eq!(is_newer("0.1.9", "0.2.0"), Some(false));
        assert_eq!(is_newer("x", "0.2.0"), None);
    }

    #[test]
    fn install_method_depends_on_os_and_location() {
        let linux = |p: &str| detect_method(Path::new(p), "linux", "x86_64");
        assert_eq!(linux("/usr/bin/disnans"), Method::Deb);
        assert!(matches!(
            linux("/home/u/.local/bin/disnans"),
            Method::Manual(_)
        ));
        assert!(matches!(
            linux("/home/u/repos/disnans/target/release/disnans"),
            Method::Manual(_)
        ));
        assert!(matches!(
            detect_method(Path::new("/usr/bin/disnans"), "linux", "aarch64"),
            Method::Manual(_)
        ));
        assert_eq!(
            detect_method(Path::new("disnans.exe"), "windows", "x86_64"),
            Method::WindowsSetup
        );
    }

    #[test]
    fn download_urls_are_restricted_to_the_release_repository() {
        assert_eq!(
            deb_url("0.3.0"),
            "https://github.com/3pino/disnans/releases/download/v0.3.0/disnans_0.3.0_amd64.deb"
        );
        assert!(trusted(
            "https://github.com/3pino/disnans/releases/download/v1/x.exe"
        ));
        assert!(!trusted("https://evil.example/3pino/disnans/x.exe"));
        assert!(!trusted("http://github.com/3pino/disnans/x.exe"));
        assert_eq!(
            file_name_of(
                "https://github.com/3pino/disnans/releases/download/v1/disnans_1.0.0_x64-setup.exe"
            ),
            Some("disnans_1.0.0_x64-setup.exe".to_owned())
        );
        assert_eq!(file_name_of("https://github.com/3pino/disnans/a/.."), None);
        assert_eq!(file_name_of("https://github.com/3pino/disnans/a/"), None);
    }

    #[test]
    fn latest_json_has_the_updater_shape() {
        let json = r#"{"version":"0.3.0","notes":"x","platforms":{"windows-x86_64":{"signature":"s","url":"https://github.com/3pino/disnans/a.exe"}}}"#;
        let latest: Latest = serde_json::from_str(json).unwrap();
        assert_eq!(latest.version, "0.3.0");
        assert_eq!(
            latest.platforms["windows-x86_64"].url,
            "https://github.com/3pino/disnans/a.exe"
        );
    }
}
