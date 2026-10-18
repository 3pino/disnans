use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use crate::ServerUrl;

const STORAGE_SCHEMA: u32 = 1;

#[derive(Debug)]
pub enum StoreError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidUrl(crate::UrlError),
    UnsupportedSchema(u32),
}
impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "storage I/O error: {e}"),
            Self::Json(e) => write!(f, "storage JSON error: {e}"),
            Self::InvalidUrl(e) => write!(f, "invalid stored server URL: {e}"),
            Self::UnsupportedSchema(v) => write!(f, "unsupported storage schema version: {v}"),
        }
    }
}
impl std::error::Error for StoreError {}
impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::Json(e)
    }
}
impl From<crate::UrlError> for StoreError {
    fn from(e: crate::UrlError) -> Self {
        Self::InvalidUrl(e)
    }
}

/// The persisted state distinguishes a missing value from an explicit clear (tombstone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoredValue<T> {
    Missing,
    Value(T),
    Cleared,
}

/// 下書きの場所。メインチャットだけ（スレッド廃止。旧スレッドの下書きは読まない）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftPlace {
    Main,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftKey {
    pub server: ServerUrl,
    pub user_id: String,
    pub place: DraftPlace,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigFile {
    schema_version: u32,
    server_url: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DraftFile {
    schema_version: u32,
    body: Option<String>,
}

/// Shared local configuration and draft storage. All methods do synchronous filesystem I/O.
pub struct LocalStore {
    config_dir: PathBuf,
    data_dir: PathBuf,
}

impl LocalStore {
    /// Open platform-default locations, honoring absolute test/embedding overrides.
    pub fn open_default() -> Result<Self, StoreError> {
        let config_override = absolute_override("DISNANS_CLIENT_CONFIG_DIR")?;
        let data_override = absolute_override("DISNANS_CLIENT_DATA_DIR")?;
        let defaults = if config_override.is_none() || data_override.is_none() {
            Some(platform_defaults()?)
        } else {
            None
        };
        let (default_config, default_data) = defaults.unwrap_or_default();
        let config_dir = config_override.unwrap_or(default_config);
        let data_dir = data_override.unwrap_or(default_data);
        Self::open_at_paths(config_dir, data_dir)
    }

    /// Open isolated paths (primarily for tests and embedding applications).
    pub fn open_at(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::open_at_paths(root.as_ref().join("config"), root.as_ref().join("data"))
    }

    fn open_at_paths(config_dir: PathBuf, data_dir: PathBuf) -> Result<Self, StoreError> {
        create_private_dir(&config_dir)?;
        create_private_dir(&data_dir)?;
        create_private_dir(&data_dir.join("drafts"))?;
        Ok(Self {
            config_dir,
            data_dir,
        })
    }

    /// Current value; both missing and explicitly cleared return `None`.
    pub fn server_url(&self) -> Result<Option<String>, StoreError> {
        match self.server_setting()? {
            StoredValue::Value(value) => Ok(Some(value)),
            StoredValue::Missing | StoredValue::Cleared => Ok(None),
        }
    }

    /// Read the stored state without collapsing missing and explicitly cleared.
    pub fn server_setting(&self) -> Result<StoredValue<String>, StoreError> {
        let _lock = FileLock::acquire(&self.config_dir.join("config.lock"))?;
        let Some(config) = self.read_config()? else {
            return Ok(StoredValue::Missing);
        };
        Ok(match config.server_url {
            Some(value) => StoredValue::Value(value),
            None => StoredValue::Cleared,
        })
    }

    /// Explicitly set or clear the server URL. Clear is persisted as a tombstone.
    pub fn set_server_url(&self, url: Option<&str>) -> Result<(), StoreError> {
        let value = url
            .map(ServerUrl::parse)
            .transpose()?
            .map(|u| u.as_str().to_owned());
        let _lock = FileLock::acquire(&self.config_dir.join("config.lock"))?;
        // Fail closed on corrupt/unknown data; never replace it with a fresh config.
        let _ = self.read_config()?;
        self.write_config(value)
    }

    /// Import a legacy value only if no shared config has ever been written, including a clear.
    /// Returns `true` only when the value was imported.
    pub fn import_server_url_if_missing(&self, url: &str) -> Result<bool, StoreError> {
        self.import_server_setting_if_missing(Some(url))
    }

    /// Import a legacy setting, including an explicit clear, without replacing existing data.
    /// `None` is a tombstone; callers with no legacy setting should only read the current state.
    pub fn import_server_setting_if_missing(&self, url: Option<&str>) -> Result<bool, StoreError> {
        let value = url
            .map(ServerUrl::parse)
            .transpose()?
            .map(|url| url.as_str().to_owned());
        let _lock = FileLock::acquire(&self.config_dir.join("config.lock"))?;
        if self.read_config()?.is_some() {
            return Ok(false);
        }
        self.write_config(value)?;
        Ok(true)
    }

    /// Load a draft while preserving the distinction between no record and an explicit clear.
    pub fn load_draft_state(&self, key: &DraftKey) -> Result<StoredValue<String>, StoreError> {
        let path = self.draft_path(key);
        let _lock = FileLock::acquire(&path.with_extension("lock"))?;
        let Some(record) = read_draft_file(&path)? else {
            return Ok(StoredValue::Missing);
        };
        Ok(match record.body {
            Some(body) => StoredValue::Value(body),
            None => StoredValue::Cleared,
        })
    }

    /// Convenience view that returns `None` for a missing draft or a tombstone.
    pub fn load_draft(&self, key: &DraftKey) -> Result<Option<String>, StoreError> {
        match self.load_draft_state(key)? {
            StoredValue::Value(body) => Ok(Some(body)),
            StoredValue::Missing | StoredValue::Cleared => Ok(None),
        }
    }

    /// Save content or an explicit clear (tombstone). Whitespace-only content is a clear.
    pub fn save_draft(&self, key: &DraftKey, body: Option<&str>) -> Result<(), StoreError> {
        let path = self.draft_path(key);
        let _lock = FileLock::acquire(&path.with_extension("lock"))?;
        // Do not silently replace corrupt or future-version data.
        let _ = read_draft_file(&path)?;
        write_draft_file(
            &path,
            body.filter(|s| !s.trim().is_empty()).map(str::to_owned),
        )
    }

    /// Import legacy draft content only when no shared record exists. Empty/whitespace legacy
    /// content is stored as a tombstone so it cannot later be resurrected from localStorage.
    pub fn import_draft_if_missing(&self, key: &DraftKey, body: &str) -> Result<bool, StoreError> {
        let path = self.draft_path(key);
        let _lock = FileLock::acquire(&path.with_extension("lock"))?;
        if read_draft_file(&path)?.is_some() {
            return Ok(false);
        }
        write_draft_file(&path, (!body.trim().is_empty()).then(|| body.to_owned()))?;
        Ok(true)
    }

    fn read_config(&self) -> Result<Option<ConfigFile>, StoreError> {
        let path = self.config_dir.join("config.json");
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        let config: ConfigFile = serde_json::from_slice(&bytes)?;
        check_schema(config.schema_version)?;
        if let Some(url) = &config.server_url {
            // Also reject stale/malformed values rather than passing them to reqwest.
            ServerUrl::parse(url)?;
        }
        Ok(Some(config))
    }

    fn write_config(&self, server_url: Option<String>) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec(&ConfigFile {
            schema_version: STORAGE_SCHEMA,
            server_url,
        })?;
        atomic_replace(&self.config_dir.join("config.json"), &bytes)?;
        Ok(())
    }

    fn draft_path(&self, key: &DraftKey) -> PathBuf {
        let mut hasher = Sha256::new();
        hash_part(&mut hasher, key.server.as_str().as_bytes());
        hash_part(&mut hasher, key.user_id.as_bytes());
        match &key.place {
            DraftPlace::Main => hash_part(&mut hasher, b"main"),
        }
        let name = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        self.data_dir.join("drafts").join(format!("{name}.json"))
    }
}

fn check_schema(version: u32) -> Result<(), StoreError> {
    if version == STORAGE_SCHEMA {
        Ok(())
    } else {
        Err(StoreError::UnsupportedSchema(version))
    }
}

fn read_draft_file(path: &Path) -> Result<Option<DraftFile>, StoreError> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let record: DraftFile = serde_json::from_slice(&bytes)?;
    check_schema(record.schema_version)?;
    Ok(Some(record))
}

fn write_draft_file(path: &Path, body: Option<String>) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec(&DraftFile {
        schema_version: STORAGE_SCHEMA,
        body,
    })?;
    atomic_replace(path, &bytes)?;
    Ok(())
}

fn hash_part(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

/// Create missing directory components privately without changing permissions on existing dirs.
fn create_private_dir(path: &Path) -> Result<(), StoreError> {
    if path.is_dir() {
        return Ok(());
    }
    if path.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "storage path is not a directory",
        )
        .into());
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        create_private_dir(parent)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
    #[cfg(not(unix))]
    {
        match fs::create_dir(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

fn atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path
        .parent()
        .expect("storage files have parent directories");
    let mut temp = NamedTempFile::new_in(parent)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    // tempfile's persist implementation handles replacement of an existing destination on Windows.
    temp.persist(path).map_err(|e| StoreError::Io(e.error))?;
    sync_parent(path)?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent(path: &Path) -> Result<(), StoreError> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}
#[cfg(not(unix))]
fn sync_parent(_: &Path) -> Result<(), StoreError> {
    Ok(())
}

/// `File::lock` is an OS advisory lock (released automatically when the file is dropped).
struct FileLock {
    _file: File,
}
impl FileLock {
    fn acquire(path: &Path) -> Result<Self, StoreError> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.lock()?;
        Ok(Self { _file: file })
    }
}

fn absolute_override(name: &str) -> Result<Option<PathBuf>, StoreError> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{name} must be an absolute path"),
        )
        .into());
    }
    Ok(Some(path))
}

fn platform_defaults() -> Result<(PathBuf, PathBuf), StoreError> {
    #[cfg(target_os = "windows")]
    {
        let appdata = absolute_environment_path("APPDATA");
        let local = absolute_environment_path("LOCALAPPDATA");
        let profile = absolute_environment_path("USERPROFILE");
        let config_base = appdata.or_else(|| profile.as_ref().map(|p| p.join("AppData/Roaming")));
        let data_base = local.or_else(|| profile.as_ref().map(|p| p.join("AppData/Local")));
        let config = config_base.ok_or_else(|| missing_home_error("APPDATA/USERPROFILE"))?;
        let data = data_base.ok_or_else(|| missing_home_error("LOCALAPPDATA/USERPROFILE"))?;
        Ok((config.join("disnans"), data.join("disnans")))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = absolute_environment_path("HOME");
        let config = absolute_environment_path("XDG_CONFIG_HOME")
            .or_else(|| home.as_ref().map(|p| p.join(".config")))
            .ok_or_else(|| missing_home_error("XDG_CONFIG_HOME/HOME"))?;
        let data = absolute_environment_path("XDG_DATA_HOME")
            .or_else(|| home.as_ref().map(|p| p.join(".local/share")))
            .ok_or_else(|| missing_home_error("XDG_DATA_HOME/HOME"))?;
        Ok((config.join("disnans"), data.join("disnans")))
    }
}

fn absolute_environment_path(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(std::env::var_os(name)?);
    path.is_absolute().then_some(path)
}

fn missing_home_error(name: &str) -> StoreError {
    StoreError::Io(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        format!("no absolute {name} directory is available"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(server: &str, user: &str, place: DraftPlace) -> DraftKey {
        DraftKey {
            server: ServerUrl::parse(server).unwrap(),
            user_id: user.into(),
            place,
        }
    }

    #[test]
    fn config_round_trip_clear_and_import_does_not_resurrect() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        assert_eq!(store.server_setting().unwrap(), StoredValue::Missing);
        assert!(
            store
                .import_server_url_if_missing("homeserver:8080")
                .unwrap()
        );
        assert_eq!(
            store.server_url().unwrap().as_deref(),
            Some("http://homeserver:8080")
        );
        assert!(
            !store
                .import_server_url_if_missing("localhost:9000")
                .unwrap()
        );
        store.set_server_url(None).unwrap();
        assert_eq!(store.server_setting().unwrap(), StoredValue::Cleared);
        assert!(
            !store
                .import_server_url_if_missing("localhost:9000")
                .unwrap()
        );
    }

    #[test]
    fn equivalent_canonical_server_urls_share_the_same_draft() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        let input = DraftKey {
            server: ServerUrl::parse("HTTPS://Bücher.Example:443/Base Path/").unwrap(),
            user_id: "u1".into(),
            place: DraftPlace::Main,
        };
        let canonical = DraftKey {
            server: ServerUrl::parse("https://xn--bcher-kva.example/Base%20Path").unwrap(),
            user_id: "u1".into(),
            place: DraftPlace::Main,
        };
        store.save_draft(&input, Some("same server")).unwrap();
        assert_eq!(
            store.load_draft(&canonical).unwrap().as_deref(),
            Some("same server")
        );
    }

    #[test]
    fn importing_an_explicit_clear_does_not_replace_an_existing_setting() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        assert!(store.import_server_setting_if_missing(None).unwrap());
        assert_eq!(store.server_setting().unwrap(), StoredValue::Cleared);
        assert!(
            !store
                .import_server_url_if_missing("localhost:8080")
                .unwrap()
        );

        store.set_server_url(Some("localhost:9090")).unwrap();
        assert!(!store.import_server_setting_if_missing(None).unwrap());
        assert_eq!(
            store.server_url().unwrap().as_deref(),
            Some("http://localhost:9090")
        );
    }

    #[test]
    fn malformed_config_is_preserved_by_reads_writes_and_import() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        let path = dir.path().join("config/config.json");
        fs::write(&path, b"{broken").unwrap();
        assert!(store.server_url().is_err());
        assert!(store.set_server_url(Some("localhost:8080")).is_err());
        assert!(
            store
                .import_server_url_if_missing("localhost:8080")
                .is_err()
        );
        assert_eq!(fs::read(path).unwrap(), b"{broken");
    }

    #[test]
    fn drafts_are_separated_and_clear_is_not_resurrected() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        let a = key("server-a", "user", DraftPlace::Main);
        let b = key("server-b", "user", DraftPlace::Main);
        let c = key("server-a", "other-user", DraftPlace::Main);
        store.save_draft(&a, Some("hello")).unwrap();
        assert_eq!(store.load_draft(&a).unwrap().as_deref(), Some("hello"));
        for other in [&b, &c] {
            assert_eq!(store.load_draft(other).unwrap(), None);
        }
        store.save_draft(&a, None).unwrap();
        assert_eq!(store.load_draft_state(&a).unwrap(), StoredValue::Cleared);
        assert!(
            !store
                .import_draft_if_missing(&a, "legacy stale text")
                .unwrap()
        );
    }

    #[test]
    fn imports_draft_only_if_absent_and_blank_import_is_tombstone() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        let k = key("server", "user", DraftPlace::Main);
        assert!(store.import_draft_if_missing(&k, "legacy").unwrap());
        assert!(!store.import_draft_if_missing(&k, "newer legacy").unwrap());
        assert_eq!(store.load_draft(&k).unwrap().as_deref(), Some("legacy"));
        let blank = key("server", "user2", DraftPlace::Main);
        assert!(store.import_draft_if_missing(&blank, " \n").unwrap());
        assert_eq!(
            store.load_draft_state(&blank).unwrap(),
            StoredValue::Cleared
        );
    }

    #[test]
    fn unknown_schema_is_an_error_and_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        let path = dir.path().join("config/config.json");
        let data = br#"{"schema_version":999,"server_url":null}"#;
        fs::write(&path, data).unwrap();
        assert!(store.server_url().is_err());
        assert!(store.set_server_url(Some("localhost:8080")).is_err());
        assert_eq!(fs::read(path).unwrap(), data);
    }

    #[test]
    fn corrupt_draft_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalStore::open_at(dir.path()).unwrap();
        let draft_key = key("localhost:8080", "user", DraftPlace::Main);
        let path = store.draft_path(&draft_key);
        fs::write(&path, b"{broken").unwrap();
        assert!(store.load_draft(&draft_key).is_err());
        assert!(store.save_draft(&draft_key, Some("replacement")).is_err());
        assert_eq!(fs::read(path).unwrap(), b"{broken");
    }
}
