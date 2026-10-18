//! Desktop IPC bridge for the shared client config and draft files.
//!
//! Filesystem I/O is blocking and is always run on Tauri's blocking pool. This module accepts
//! logical keys only; callers cannot provide arbitrary filesystem paths.

use serde::{Deserialize, Deserializer, Serialize, de};
use serde_json::Value as JsonValue;

use disnans_client_core::{
    DraftKey, DraftPlace, LocalStore, ServerUrl, StoreError, StoredValue, Surface,
};

/// Android のデータの置き場（アプリのデータの中）。起動時に 1 回だけ決める。デスクトップは使わない（既定の場所を使う）
#[cfg(target_os = "android")]
static APP_DATA_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

/// Android の起動時に、アプリのデータの場所を渡す（HOME が無いので、既定の場所は使えない）
#[cfg(target_os = "android")]
pub fn use_app_data_root(root: std::path::PathBuf) {
    let _ = APP_DATA_ROOT.set(root);
}

/// 共有の設定と下書きを開く。Android は app_data_dir、それ以外は既定の場所（従来どおり）
fn open_store() -> Result<LocalStore, StoreError> {
    #[cfg(target_os = "android")]
    {
        if let Some(root) = APP_DATA_ROOT.get() {
            return LocalStore::open_at(root);
        }
    }
    LocalStore::open_default()
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StorageKey {
    Server,
    Draft {
        server_url: String,
        user_id: String,
        place: String,
    },
}

impl StorageKey {
    fn validate(self) -> Result<ValidatedKey, String> {
        match self {
            Self::Server => Ok(ValidatedKey::Server),
            Self::Draft {
                server_url,
                user_id,
                place,
            } => {
                let server = ServerUrl::parse(&server_url).map_err(|e| e.to_string())?;
                validate_identifier(&user_id, "userId")?;
                // スレッドは廃止。place は "main" だけ（旧スレッドの下書きは読まない）
                if place != "main" {
                    return Err("place must be 'main'".into());
                }
                let place = DraftPlace::Main;
                Ok(ValidatedKey::Draft(DraftKey {
                    server,
                    user_id,
                    place,
                }))
            }
        }
    }
}

fn validate_identifier(value: &str, field: &str) -> Result<(), String> {
    if !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control) {
        Ok(())
    } else {
        Err(format!(
            "{field} must be a non-empty identifier of at most 256 bytes"
        ))
    }
}

enum ValidatedKey {
    Server,
    Draft(DraftKey),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", content = "value", rename_all = "lowercase")]
pub enum StorageState {
    Missing,
    Value(String),
    Cleared,
}

impl From<StoredValue<String>> for StorageState {
    fn from(value: StoredValue<String>) -> Self {
        match value {
            StoredValue::Missing => Self::Missing,
            StoredValue::Value(value) => Self::Value(value),
            StoredValue::Cleared => Self::Cleared,
        }
    }
}

/// Import args are nested so serde can distinguish a missing value field from explicit JSON null.
#[derive(Debug, Default)]
pub enum ImportValue {
    #[default]
    Missing,
    Cleared,
    Value(String),
}
impl<'de> Deserialize<'de> for ImportValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        match JsonValue::deserialize(deserializer)? {
            JsonValue::Null => Ok(Self::Cleared),
            JsonValue::String(value) => Ok(Self::Value(value)),
            _ => Err(de::Error::custom("value must be a string or null")),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportArgs {
    pub key: StorageKey,
    #[serde(default)]
    pub value: ImportValue,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteArgs {
    pub key: StorageKey,
    /// Required: string saves; null explicitly clears. Omitted/undefined is an IPC argument error.
    pub value: JsonValue,
}

/// このデバイス（Tauri の surface）のデバイス ID。無ければ ULID を作って保存する。
#[tauri::command]
pub async fn client_device_id() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = open_store().map_err(store_error)?;
        store.device_id(Surface::Tauri).map_err(store_error)
    })
    .await
    .map_err(|e| format!("storage task failed: {e}"))?
}

#[tauri::command]
pub async fn client_storage_read(key: StorageKey) -> Result<StorageState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = key.validate()?;
        let store = open_store().map_err(store_error)?;
        read_state(&store, key)
    })
    .await
    .map_err(|e| format!("storage task failed: {e}"))?
}

/// Missing `value` is a no-op; null imports a tombstone; string imports only if no shared
/// setting/draft (including an existing tombstone) is present. Returns authoritative state.
#[tauri::command]
pub async fn client_storage_import(args: ImportArgs) -> Result<StorageState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = args.key.validate()?;
        let store = open_store().map_err(store_error)?;
        match (key, args.value) {
            (key, ImportValue::Missing) => read_state(&store, key),
            (ValidatedKey::Server, ImportValue::Value(value)) => {
                store
                    .import_server_setting_if_missing(Some(&value))
                    .map_err(store_error)?;
                read_state(&store, ValidatedKey::Server)
            }
            (ValidatedKey::Draft(key), ImportValue::Value(value)) => {
                store
                    .import_draft_if_missing(&key, &value)
                    .map_err(store_error)?;
                read_state(&store, ValidatedKey::Draft(key))
            }
            (ValidatedKey::Draft(key), ImportValue::Cleared) => {
                // Empty legacy draft content is a core-supported tombstone import.
                store
                    .import_draft_if_missing(&key, "")
                    .map_err(store_error)?;
                read_state(&store, ValidatedKey::Draft(key))
            }
            (ValidatedKey::Server, ImportValue::Cleared) => {
                store
                    .import_server_setting_if_missing(None)
                    .map_err(store_error)?;
                read_state(&store, ValidatedKey::Server)
            }
        }
    })
    .await
    .map_err(|e| format!("storage task failed: {e}"))?
}

#[tauri::command]
pub async fn client_storage_write(args: WriteArgs) -> Result<StorageState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = args.key.validate()?;
        let store = open_store().map_err(store_error)?;
        match (key, args.value) {
            (ValidatedKey::Server, JsonValue::String(value)) => {
                store.set_server_url(Some(&value)).map_err(store_error)?;
                read_state(&store, ValidatedKey::Server)
            }
            (ValidatedKey::Server, JsonValue::Null) => {
                store.set_server_url(None).map_err(store_error)?;
                read_state(&store, ValidatedKey::Server)
            }
            (ValidatedKey::Draft(key), JsonValue::String(value)) => {
                store.save_draft(&key, Some(&value)).map_err(store_error)?;
                read_state(&store, ValidatedKey::Draft(key))
            }
            (ValidatedKey::Draft(key), JsonValue::Null) => {
                store.save_draft(&key, None).map_err(store_error)?;
                read_state(&store, ValidatedKey::Draft(key))
            }
            (_, _) => Err("value must be a string or null".into()),
        }
    })
    .await
    .map_err(|e| format!("storage task failed: {e}"))?
}

fn read_state(store: &LocalStore, key: ValidatedKey) -> Result<StorageState, String> {
    let value = match key {
        ValidatedKey::Server => store.server_setting(),
        ValidatedKey::Draft(key) => store.load_draft_state(&key),
    }
    .map_err(store_error)?;
    Ok(value.into())
}

fn store_error(error: StoreError) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    #[test]
    fn key_dto_accepts_only_logical_known_keys() {
        let server: StorageKey = serde_json::from_str(r#"{"kind":"server"}"#).unwrap();
        assert!(matches!(server.validate(), Ok(ValidatedKey::Server)));

        let opaque: StorageKey = serde_json::from_str(
            r#"{"kind":"draft","serverUrl":"https://host/base","userId":"u1","place":"main"}"#,
        )
        .unwrap();
        assert!(matches!(opaque.validate(), Ok(ValidatedKey::Draft(_))));
        let ulid: StorageKey = serde_json::from_str(&format!(
            r#"{{"kind":"draft","serverUrl":"https://host/base","userId":"{ULID}","place":"main"}}"#
        ))
        .unwrap();
        assert!(matches!(ulid.validate(), Ok(ValidatedKey::Draft(_))));
        // 旧スレッドの下書き（thread:…）は受け付けない
        let thread: StorageKey = serde_json::from_str(
            r#"{"kind":"draft","serverUrl":"https://host/base","userId":"u1","place":"thread:m1"}"#,
        )
        .unwrap();
        assert!(thread.validate().is_err());
        assert!(
            serde_json::from_str::<StorageKey>(r#"{"kind":"file","path":"/tmp/secret"}"#).is_err()
        );
    }

    #[test]
    fn rejects_bad_server_user_and_place() {
        let bad = format!(
            r#"{{"kind":"draft","serverUrl":"https://user:pass@host","userId":"{ULID}","place":"main"}}"#
        );
        assert!(
            serde_json::from_str::<StorageKey>(&bad)
                .unwrap()
                .validate()
                .is_err()
        );
        let bad = r#"{"kind":"draft","serverUrl":"https://host","userId":"","place":"main"}"#;
        assert!(
            serde_json::from_str::<StorageKey>(bad)
                .unwrap()
                .validate()
                .is_err()
        );
        let bad = format!(
            r#"{{"kind":"draft","serverUrl":"https://host","userId":"{ULID}","place":"thread:"}}"#
        );
        assert!(
            serde_json::from_str::<StorageKey>(&bad)
                .unwrap()
                .validate()
                .is_err()
        );
        let bad = r#"{"kind":"draft","serverUrl":"https://host","userId":"u\n1","place":"main"}"#;
        assert!(
            serde_json::from_str::<StorageKey>(bad)
                .unwrap()
                .validate()
                .is_err()
        );
    }

    #[test]
    fn state_wire_shape_matches_shared_storage_adapter() {
        assert_eq!(
            serde_json::to_value(StorageState::Missing).unwrap(),
            serde_json::json!({"state":"missing"})
        );
        assert_eq!(
            serde_json::to_value(StorageState::Value("draft".into())).unwrap(),
            serde_json::json!({"state":"value","value":"draft"})
        );
        assert_eq!(
            serde_json::to_value(StorageState::Cleared).unwrap(),
            serde_json::json!({"state":"cleared"})
        );
    }

    #[test]
    fn import_value_distinguishes_absent_from_explicit_clear() {
        let missing: ImportArgs = serde_json::from_str(r#"{"key":{"kind":"server"}}"#).unwrap();
        assert!(matches!(missing.value, ImportValue::Missing));
        let cleared: ImportArgs =
            serde_json::from_str(r#"{"key":{"kind":"server"},"value":null}"#).unwrap();
        assert!(matches!(cleared.value, ImportValue::Cleared));
        let value: ImportArgs =
            serde_json::from_str(r#"{"key":{"kind":"server"},"value":"http://host"}"#).unwrap();
        assert!(matches!(value.value, ImportValue::Value(_)));
        let invalid = r#"{"key":{"kind":"server"},"value":false}"#;
        assert!(serde_json::from_str::<ImportArgs>(invalid).is_err());
        assert!(serde_json::from_str::<WriteArgs>(r#"{"key":{"kind":"server"}}"#).is_err());
    }
}
