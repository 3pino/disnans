//! TUI のデバイス登録と、設定（ユーザー共通・デバイスごと）の読み書き。GUI と同じ規則:
//! - デバイス ID は `LocalStore` が surface `tui` ごとに決める。
//! - 起動時の登録は、サーバーの一覧に無いときだけ（名前は黙って書き換えない）。失敗しても起動は続ける。
//! - このデバイス自身は削除しない（この画面に削除は無い）。
//! - 保存は「読む → 1 項目だけ変える → まるごと書く」。ほかの項目（GUI や新しい版のもの）は残す。

use disnans_client_core::view::settings::{
    Scope, device_defaults, normalize_device_prefs, normalize_user_prefs,
};
use disnans_client_core::{LocalStore, ReadFailure, RestClient, Surface, host_os};
use serde_json::{Map, Value};

/// 読み込んだ設定とデバイスの情報。
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
    pub device_id: String,
    pub device_name: String,
    pub user: Value,
    pub device: Value,
}

/// このデバイスの既定の名前。
pub fn default_name() -> String {
    let os = match host_os() {
        "windows" => "Windows",
        "linux" => "Linux",
        _ => "このデバイス",
    };
    format!("{os} (TUI)")
}

fn failure(e: ReadFailure) -> String {
    e.message
}

/// 登録（無ければ）と設定の読み込み。ID が取れなければ設定は読まない。
pub async fn load(store: &LocalStore, rest: &RestClient) -> Result<Loaded, String> {
    let id = store.device_id(Surface::Tui).map_err(|e| e.to_string())?;
    let list = rest.list_devices().await.map_err(failure)?;
    let known = list.as_array().and_then(|items| {
        items
            .iter()
            .find(|d| d.get("device_id").and_then(Value::as_str) == Some(&id))
    });
    let name = match known {
        Some(d) => d
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        None => {
            let name = default_name();
            rest.put_device(&id, &name).await.map_err(failure)?;
            name
        }
    };
    let device = match rest.get_device_prefs(&id).await {
        Ok(v) => normalize_device_prefs(v.get("prefs").unwrap_or(&Value::Null)),
        Err(e) if e.status == Some(404) => device_defaults(),
        Err(e) => return Err(failure(e)),
    };
    let user = rest.get_value("/api/me/prefs").await.map_err(failure)?;
    Ok(Loaded {
        device_id: id,
        device_name: name,
        user: normalize_user_prefs(&user),
        device,
    })
}

/// 1 項目を保存し、保存後のオブジェクト全体を返す。
pub async fn save(
    rest: &RestClient,
    device_id: &str,
    scope: Scope,
    key: &str,
    value: Value,
) -> Result<Value, String> {
    match scope {
        Scope::User => {
            let mut prefs = object(rest.get_value("/api/me/prefs").await.map_err(failure)?);
            prefs.insert(key.to_owned(), value);
            let saved = rest
                .set_prefs(&Value::Object(prefs))
                .await
                .map_err(failure)?;
            Ok(normalize_user_prefs(&saved))
        }
        Scope::Device => {
            let mut prefs = match rest.get_device_prefs(device_id).await {
                Ok(v) => object(v.get("prefs").cloned().unwrap_or(Value::Null)),
                Err(e) if e.status == Some(404) => object(device_defaults()),
                Err(e) => return Err(failure(e)),
            };
            prefs.insert(key.to_owned(), value);
            let saved = rest
                .put_device_prefs(device_id, &normalize_device_prefs(&Value::Object(prefs)))
                .await
                .map_err(failure)?;
            Ok(normalize_device_prefs(
                saved.get("prefs").unwrap_or(&Value::Null),
            ))
        }
        Scope::Local => Err("このデバイスだけの設定は、この画面では変えられません".into()),
    }
}

/// デバイスの名前を変える（登録済みのこのデバイスだけ）。
pub async fn rename(rest: &RestClient, device_id: &str, name: &str) -> Result<(), String> {
    rest.put_device(device_id, name)
        .await
        .map(|_| ())
        .map_err(failure)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}
