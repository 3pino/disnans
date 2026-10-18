//! GUI の REST を Rust 側で行う IPC（段1: 読取、段2: 書込、段3: アップロード）。契約は `.pi/step4-ipc-contract.md`。
//!
//! 任意のパスは受け取らない。コマンドごとに決まったパスだけを行う。
//! 成功は JSON の値をそのまま返し（再シリアライズしない）、失敗は `{ status?, code, message }`。
//! 書込は自動リトライしない（`RestClient` の書込用クライアントは接続を再利用しない）。
//! 本体は Tauri に依存しない関数（`read_*` / `write_*` など）にあり、テストはそちらを呼ぶ。

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Arc, LazyLock, Mutex};

use base64::Engine;
use disnans_client_core::{
    MessageSearchQuery, MessagesQuery, ReadFailure, RestClient, ServerUrl, UploadAbortHandle,
    UploadAbortRegistration, messages_path, search_path, session_path,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeBody, JavaScriptChannelId, Request};

/// 全コマンドに共通の接続先。`server` は GUI の正規化済み URL、`dev_user` は開発用ユーザー（省略可）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Base {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessagesArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub before: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub id: String,
}

// ---- 書込（段2）の引数 ----

/// `body` だけを持つ書込（PATCH /api/me など）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BodyArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub body: Value,
}

/// `id` と `body` を持つ書込（PATCH /api/sessions/{id} など）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdBodyArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub id: String,
    pub body: Value,
}

/// 添付のアバター（PUT /api/me/avatar）。バイト列は raw body、このフィールドは `x-disnans-args` ヘッダー。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AvatarArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub file_name: String,
    #[serde(default)]
    pub mime: Option<String>,
}

/// プラグインの配布（POST /api/plugins）。raw body は `parts` の順に連結したもの。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePluginArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub visibility: String,
    pub parts: Vec<PluginPartArgs>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginPartArgs {
    pub name: String,
    pub size: usize,
}

/// raw body の書込で使うヘッダー（値は `encodeURIComponent(JSON.stringify(args))`）。
pub const ARGS_HEADER: &str = "x-disnans-args";

/// `x-disnans-args` を読む。無い・壊れている・未知のフィールドがある → `invalid_request`（通信はしない）。
pub fn decode_header_args<T: DeserializeOwned>(
    headers: &tauri::http::HeaderMap,
) -> Result<T, ReadFailure> {
    let raw = headers
        .get(ARGS_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ReadFailure::invalid_request("引数のヘッダーがありません"))?;
    let json = percent_decode(raw)
        .ok_or_else(|| ReadFailure::invalid_request("引数のヘッダーが読めません"))?;
    serde_json::from_str(&json)
        .map_err(|_| ReadFailure::invalid_request("引数のヘッダーが読めません"))
}

/// `%XX` だけを戻す（`+` は空白にしない。`encodeURIComponent` は `+` を `%2B` にする）。
pub fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

// ---- アップロード（段3） ----

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub upload_id: String,
    pub file_name: String,
    #[serde(default)]
    pub mime: Option<String>,
    /// `Channel` の `toJSON()` の値（`__CHANNEL__:N`）。進捗の送り先。
    pub on_progress: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadAbortArgs {
    pub upload_id: String,
}

/// 進捗の 1 項目（契約 §10.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UploadItem {
    pub kind: &'static str,
    pub loaded: u64,
    pub total: u64,
}

/// 進行中のアップロードの中止口。`start` の前に `abort` が届いたら、その ID は開始せず中止にする。
#[derive(Default)]
pub struct UploadRegistry {
    state: Mutex<UploadState>,
}

#[derive(Default)]
struct UploadState {
    active: HashMap<String, UploadAbortHandle>,
    /// 開始より先に届いた中止（次に同じ ID で始めるものを中止する）。
    cancelled: HashSet<String>,
}

/// 開始より先の中止を覚えておく上限（超えたら古いものは忘れる）。
const MAX_EARLY_ABORTS: usize = 1024;

impl UploadRegistry {
    fn lock(&self) -> std::sync::MutexGuard<'_, UploadState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 中止口を作って登録する。使用中の ID なら `invalid_request`。先に中止されていれば `aborted`。
    pub fn start(&self, id: &str) -> Result<UploadAbortRegistration, ReadFailure> {
        let mut state = self.lock();
        if state.cancelled.remove(id) {
            return Err(ReadFailure::aborted());
        }
        if state.active.contains_key(id) {
            return Err(ReadFailure::invalid_request("uploadId が使われています"));
        }
        let (handle, registration) = UploadAbortHandle::new_pair();
        state.active.insert(id.to_owned(), handle);
        Ok(registration)
    }

    pub fn finish(&self, id: &str) {
        self.lock().active.remove(id);
    }

    pub fn abort(&self, id: &str) {
        let mut state = self.lock();
        if let Some(handle) = state.active.get(id) {
            handle.abort();
            return;
        }
        if state.cancelled.len() >= MAX_EARLY_ABORTS {
            state.cancelled.clear();
        }
        state.cancelled.insert(id.to_owned());
    }
}

/// アプリ全体のアップロード（Tauri コマンドはこれを使う）。
static UPLOADS: LazyLock<UploadRegistry> = LazyLock::new(UploadRegistry::default);

/// 登録を必ず外す（future が途中で捨てられた場合も）。
struct ActiveUpload<'a> {
    registry: &'a UploadRegistry,
    id: &'a str,
}

impl Drop for ActiveUpload<'_> {
    fn drop(&mut self) {
        self.registry.finish(self.id);
    }
}

/// アップロード本体。`progress(loaded, total)` を送信のたびに呼ぶ。
pub async fn upload_file_raw(
    args: &UploadArgs,
    data: Arc<Vec<u8>>,
    progress: Arc<dyn Fn(u64, u64) + Send + Sync>,
    registry: &UploadRegistry,
) -> Result<Value, ReadFailure> {
    let client = client(&args.server, args.dev_user.as_deref())?;
    let abort = registry.start(&args.upload_id)?;
    let _active = ActiveUpload {
        registry,
        id: &args.upload_id,
    };
    let mime = args.mime.as_deref().unwrap_or("application/octet-stream");
    client
        .upload_file(data, &args.file_name, mime, progress, abort)
        .await
}

/// バイト列の本体。デスクトップは raw body（借りる）。Android は Tauri の IPC が raw body を渡せない
/// （`InvokeBody::Raw` は無く、常に JSON）ので、base64 の文字列（JSON の値）を受ける。それ以外は `invalid_request`。
pub fn raw_body(body: &InvokeBody) -> Result<Cow<'_, [u8]>, ReadFailure> {
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes.as_slice())),
        InvokeBody::Json(Value::String(text)) => base64::engine::general_purpose::STANDARD
            .decode(text)
            .map(Cow::Owned)
            .map_err(|_| ReadFailure::invalid_request("バイト列（base64）が不正です")),
        InvokeBody::Json(_) => Err(ReadFailure::invalid_request("バイト列の本体が必要です")),
    }
}

/// `server` と `devUser` から読取クライアントを作る。通信はまだしない。
fn client(server: &str, dev_user: Option<&str>) -> Result<RestClient, ReadFailure> {
    let url = ServerUrl::parse(server)
        .map_err(|_| ReadFailure::invalid_request("サーバー URL が不正です"))?;
    RestClient::new(url, dev_user).map_err(ReadFailure::from)
}

async fn read(server: &str, dev_user: Option<&str>, path: &str) -> Result<Value, ReadFailure> {
    client(server, dev_user)?.get_value(path).await
}

pub async fn read_me(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/me").await
}

pub async fn read_users(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/users").await
}

pub async fn read_prefs(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/me/prefs").await
}

pub async fn read_messages(args: &MessagesArgs) -> Result<Value, ReadFailure> {
    let path = messages_path(&MessagesQuery {
        before: args.before.clone(),
        limit: args.limit,
    });
    read(&args.server, args.dev_user.as_deref(), &path).await
}

pub async fn read_search_messages(args: &SearchArgs) -> Result<Value, ReadFailure> {
    let path = search_path(&MessageSearchQuery {
        q: args.q.clone(),
        before: args.before.clone(),
        limit: args.limit,
    });
    read(&args.server, args.dev_user.as_deref(), &path).await
}

pub async fn read_read_markers(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/me/read").await
}

pub async fn read_plugins(args: &Base) -> Result<Value, ReadFailure> {
    read(&args.server, args.dev_user.as_deref(), "/api/plugins").await
}

pub async fn read_session(args: &IdArgs) -> Result<Value, ReadFailure> {
    read(
        &args.server,
        args.dev_user.as_deref(),
        &session_path(&args.id),
    )
    .await
}

// ---- 書込（段2）の本体 ----

pub async fn update_me(args: &BodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .update_me(&args.body)
        .await
}

pub async fn clear_avatar(args: &Base) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .clear_avatar()
        .await
}

pub async fn set_prefs(args: &BodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .set_prefs(&args.body)
        .await
}

pub async fn mark_read(args: &BodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .mark_read(&args.body)
        .await
}

pub async fn update_session(args: &IdBodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .update_session(&args.id, &args.body)
        .await
}

pub async fn delete_plugin(args: &IdArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .delete_plugin(&args.id)
        .await
}

pub async fn sample_notification(args: &Base) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .sample_notification()
        .await
}

pub async fn plugin_post_message(args: &IdBodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .plugin_post_message(&args.id, &args.body)
        .await
}

pub async fn plugin_notify(args: &IdBodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .plugin_notify(&args.id, &args.body)
        .await
}

pub async fn create_session(args: &BodyArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .create_session(&args.body)
        .await
}

pub async fn set_avatar(args: &AvatarArgs, data: &[u8]) -> Result<Value, ReadFailure> {
    let mime = args.mime.as_deref().unwrap_or("application/octet-stream");
    client(&args.server, args.dev_user.as_deref())?
        .set_avatar(data, &args.file_name, mime)
        .await
}

/// 配布する。`parts` の `size` の合計が本体の長さと一致しなければ `invalid_request`。
pub async fn create_plugin(args: &CreatePluginArgs, data: &[u8]) -> Result<Value, ReadFailure> {
    if args.visibility != "public" && args.visibility != "private" {
        return Err(ReadFailure::invalid_request(
            "visibility は public か private です",
        ));
    }
    let mut files = Vec::with_capacity(args.parts.len());
    let mut offset = 0usize;
    for part in &args.parts {
        let end = offset
            .checked_add(part.size)
            .ok_or_else(|| ReadFailure::invalid_request("parts の大きさが合いません"))?;
        if part.name.is_empty() || part.name.contains(['/', '\\']) {
            return Err(ReadFailure::invalid_request("ファイル名が不正です"));
        }
        files.push((part.name.clone(), offset..end));
        offset = end;
    }
    if offset != data.len() {
        return Err(ReadFailure::invalid_request(
            "parts の大きさが本体と合いません",
        ));
    }
    client(&args.server, args.dev_user.as_deref())?
        .create_plugin(&args.visibility, data, &files)
        .await
}

// ---- Tauri コマンド（引数は 1 つの `args` オブジェクト。薄いラッパー） ----

#[tauri::command]
pub async fn api_me(args: Base) -> Result<Value, ReadFailure> {
    read_me(&args).await
}

#[tauri::command]
pub async fn api_users(args: Base) -> Result<Value, ReadFailure> {
    read_users(&args).await
}

#[tauri::command]
pub async fn api_prefs(args: Base) -> Result<Value, ReadFailure> {
    read_prefs(&args).await
}

#[tauri::command]
pub async fn api_messages(args: MessagesArgs) -> Result<Value, ReadFailure> {
    read_messages(&args).await.map(with_markdown)
}

#[tauri::command]
pub async fn api_search_messages(args: SearchArgs) -> Result<Value, ReadFailure> {
    read_search_messages(&args).await.map(with_markdown)
}

/// 履歴・検索の結果の各メッセージに、本文の構文木 `markdown` を足す（GUI の描画用。V3）
fn with_markdown(mut messages: Value) -> Value {
    disnans_client_core::view::markdown::add_to_messages(&mut messages);
    messages
}

#[tauri::command]
pub async fn api_read_markers(args: Base) -> Result<Value, ReadFailure> {
    read_read_markers(&args).await
}

#[tauri::command]
pub async fn api_plugins(args: Base) -> Result<Value, ReadFailure> {
    read_plugins(&args).await
}

#[tauri::command]
pub async fn api_session(args: IdArgs) -> Result<Value, ReadFailure> {
    read_session(&args).await
}

/// 添付（raw body）。メタは `x-disnans-args`。進捗は `onProgress` の Channel に送る。
#[tauri::command]
pub async fn api_upload_file(
    webview: tauri::Webview,
    request: Request<'_>,
) -> Result<Value, ReadFailure> {
    let args: UploadArgs = decode_header_args(request.headers())?;
    let channel: Channel<UploadItem> = JavaScriptChannelId::from_str(&args.on_progress)
        .map_err(|_| ReadFailure::invalid_request("進捗の送り先が不正です"))?
        .channel_on(webview);
    let data = Arc::new(raw_body(request.body())?.into_owned());
    let progress: Arc<dyn Fn(u64, u64) + Send + Sync> = Arc::new(move |loaded, total| {
        let _ = channel.send(UploadItem {
            kind: "progress",
            loaded,
            total,
        });
    });
    upload_file_raw(&args, data, progress, &UPLOADS).await
}

/// 中止（通信はしない）。使われていない ID への中止は、後から始まるその ID を中止する。
#[tauri::command]
pub fn api_upload_abort(args: UploadAbortArgs) -> Result<Value, ReadFailure> {
    UPLOADS.abort(&args.upload_id);
    Ok(Value::Null)
}

#[tauri::command]
pub async fn api_update_me(args: BodyArgs) -> Result<Value, ReadFailure> {
    update_me(&args).await
}

#[tauri::command]
pub async fn api_clear_avatar(args: Base) -> Result<Value, ReadFailure> {
    clear_avatar(&args).await
}

#[tauri::command]
pub async fn api_set_prefs(args: BodyArgs) -> Result<Value, ReadFailure> {
    set_prefs(&args).await
}

#[tauri::command]
pub async fn api_mark_read(args: BodyArgs) -> Result<Value, ReadFailure> {
    mark_read(&args).await
}

#[tauri::command]
pub async fn api_update_session(args: IdBodyArgs) -> Result<Value, ReadFailure> {
    update_session(&args).await
}

#[tauri::command]
pub async fn api_delete_plugin(args: IdArgs) -> Result<Value, ReadFailure> {
    delete_plugin(&args).await
}

#[tauri::command]
pub async fn api_sample_notification(args: Base) -> Result<Value, ReadFailure> {
    sample_notification(&args).await
}

#[tauri::command]
pub async fn api_plugin_post_message(args: IdBodyArgs) -> Result<Value, ReadFailure> {
    plugin_post_message(&args).await
}

#[tauri::command]
pub async fn api_plugin_notify(args: IdBodyArgs) -> Result<Value, ReadFailure> {
    plugin_notify(&args).await
}

#[tauri::command]
pub async fn api_create_session(args: BodyArgs) -> Result<Value, ReadFailure> {
    create_session(&args).await
}

/// raw body（バイト列）。メタは `x-disnans-args` ヘッダー。
#[tauri::command]
pub async fn api_set_avatar(request: Request<'_>) -> Result<Value, ReadFailure> {
    let args: AvatarArgs = decode_header_args(request.headers())?;
    let data = raw_body(request.body())?;
    set_avatar(&args, &data).await
}

/// raw body（`parts` の順に連結したバイト列）。メタは `x-disnans-args` ヘッダー。
#[tauri::command]
pub async fn api_create_plugin(request: Request<'_>) -> Result<Value, ReadFailure> {
    let args: CreatePluginArgs = decode_header_args(request.headers())?;
    let data = raw_body(request.body())?;
    create_plugin(&args, &data).await
}

// ---- 端末（ステップ8・V5）: /api/me/devices。端末 ID は client_device_id（LocalStore）が決める ----

/// 端末の登録・名前の変更（PUT /api/me/devices/{id}）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceRegisterArgs {
    pub server: String,
    #[serde(default)]
    pub dev_user: Option<String>,
    pub id: String,
    pub name: String,
}

/// 端末の設定の結果。`saved` が false は「まだ設定が無い」（または端末が未登録）。`prefs` は正規化済み。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePrefsView {
    pub prefs: Value,
    pub updated_at: Option<i64>,
    pub saved: bool,
}

fn device_prefs_view(value: &Value, saved: bool) -> DevicePrefsView {
    DevicePrefsView {
        prefs: disnans_client_core::view::settings::normalize_device_prefs(
            value.get("prefs").unwrap_or(&Value::Null),
        ),
        updated_at: value.get("updated_at").and_then(Value::as_i64),
        saved,
    }
}

pub async fn device_register(args: &DeviceRegisterArgs) -> Result<Value, ReadFailure> {
    client(&args.server, args.dev_user.as_deref())?
        .put_device(&args.id, &args.name)
        .await
}

/// この端末の設定を読む。設定が無い（404）ときは既定の値を `saved: false` で返す。
pub async fn device_prefs_read(args: &IdArgs) -> Result<DevicePrefsView, ReadFailure> {
    let client = client(&args.server, args.dev_user.as_deref())?;
    match client.get_device_prefs(&args.id).await {
        Ok(value) => Ok(device_prefs_view(&value, true)),
        Err(e) if e.status == Some(404) => Ok(device_prefs_view(&Value::Null, false)),
        Err(e) => Err(e),
    }
}

/// この端末の設定をまるごと書き換える。送る前に正規化する（型の合わない値は既定に、定義に無い項目は残す）。
pub async fn device_prefs_write(args: &IdBodyArgs) -> Result<DevicePrefsView, ReadFailure> {
    let prefs = disnans_client_core::view::settings::normalize_device_prefs(&args.body);
    let value = client(&args.server, args.dev_user.as_deref())?
        .put_device_prefs(&args.id, &prefs)
        .await?;
    Ok(device_prefs_view(&value, true))
}

/// 設定項目の定義（キー・保存先・型・既定値）。core の一覧が正（起動時に一度読む想定）
#[tauri::command]
pub fn api_settings_definitions() -> Value {
    disnans_client_core::view::settings::definitions_json()
}

#[tauri::command]
pub async fn api_device_register(args: DeviceRegisterArgs) -> Result<Value, ReadFailure> {
    device_register(&args).await
}

#[tauri::command]
pub async fn api_device_prefs_read(args: IdArgs) -> Result<DevicePrefsView, ReadFailure> {
    device_prefs_read(&args).await
}

#[tauri::command]
pub async fn api_device_prefs_write(args: IdBodyArgs) -> Result<DevicePrefsView, ReadFailure> {
    device_prefs_write(&args).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// 1 回だけ応答する接続先。受け取った 1 行目を返す。
    async fn one_shot(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let read = socket.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..read]).into_owned();
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            request.lines().next().unwrap_or_default().to_owned()
        });
        (format!("http://{address}"), task)
    }

    fn base(server: &str) -> Base {
        Base {
            server: server.to_owned(),
            dev_user: Some("alice".into()),
        }
    }

    #[tokio::test]
    async fn device_prefs_read_returns_normalized_prefs_and_reports_missing_as_unsaved() {
        let body =
            r#"{"prefs":{"inputId":"mic-1","orientation":"sideways","keep":1},"updated_at":7}"#;
        let (server, task) = one_shot("200 OK", body).await;
        let view = device_prefs_read(&IdArgs {
            server,
            dev_user: Some("alice".into()),
            id: "01J8".into(),
        })
        .await
        .unwrap();
        assert!(view.saved);
        assert_eq!(view.updated_at, Some(7));
        assert_eq!(view.prefs["inputId"], "mic-1");
        assert_eq!(
            view.prefs["orientation"], "auto",
            "invalid value -> default"
        );
        assert_eq!(view.prefs["keep"], 1, "unknown key kept");
        assert_eq!(
            task.await.unwrap(),
            "GET /api/me/devices/01J8/prefs HTTP/1.1"
        );

        let (server, _task) = one_shot(
            "404 Not Found",
            r#"{"code":"not_found","message":"設定がありません"}"#,
        )
        .await;
        let view = device_prefs_read(&IdArgs {
            server,
            dev_user: Some("alice".into()),
            id: "01J8".into(),
        })
        .await
        .unwrap();
        assert!(!view.saved);
        assert_eq!(view.updated_at, None);
        assert_eq!(
            view.prefs,
            disnans_client_core::view::settings::device_defaults()
        );
    }

    #[tokio::test]
    async fn device_prefs_write_normalizes_before_sending() {
        let (server, task) = one_shot(
            "200 OK",
            r#"{"prefs":{"hideNavigationBar":true},"updated_at":9}"#,
        )
        .await;
        let view = device_prefs_write(&IdBodyArgs {
            server,
            dev_user: Some("alice".into()),
            id: "01J8".into(),
            body: serde_json::json!({"hideNavigationBar": "yes", "deviceKind": "tablet"}),
        })
        .await
        .unwrap();
        assert!(view.saved);
        assert_eq!(view.updated_at, Some(9));
        assert_eq!(
            task.await.unwrap(),
            "PUT /api/me/devices/01J8/prefs HTTP/1.1"
        );
    }

    #[tokio::test]
    async fn success_returns_the_server_json_value() {
        let body = r#"[{"id":"u1","login_name":"alice","extra":{"x":null}}]"#;
        let (server, task) = one_shot("200 OK", body).await;
        let value = read_users(&base(&server)).await.unwrap();
        assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
        assert_eq!(task.await.unwrap(), "GET /api/users HTTP/1.1");
    }

    #[tokio::test]
    async fn api_error_is_returned_with_status_code_and_message() {
        let (server, task) = one_shot(
            "404 Not Found",
            r#"{"code":"not_found","message":"見つかりません"}"#,
        )
        .await;
        let failure = read_session(&IdArgs {
            server: server.clone(),
            dev_user: None,
            id: "s/1".into(),
        })
        .await
        .unwrap_err();
        assert_eq!(task.await.unwrap(), "GET /api/sessions/s%2F1 HTTP/1.1");
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({"status": 404, "code": "not_found", "message": "見つかりません"})
        );
    }

    #[test]
    fn history_and_search_results_carry_the_markdown_tree() {
        let messages =
            serde_json::json!([{"id": "m1", "body": "**a**"}, {"id": "m2", "body": "b"}]);
        let out = with_markdown(messages);
        assert_eq!(
            out[0]["markdown"],
            disnans_client_core::view::markdown::blocks_value("**a**")
        );
        assert_eq!(out[1]["markdown"][0]["type"], "paragraph");
        assert_eq!(out[1]["body"], "b");
    }

    #[tokio::test]
    async fn missing_optional_query_fields_are_not_sent() {
        let (server, task) = one_shot("200 OK", "[]").await;
        read_messages(&MessagesArgs {
            server,
            dev_user: None,
            before: None,
            limit: Some(3),
        })
        .await
        .unwrap();
        assert_eq!(task.await.unwrap(), "GET /api/messages?limit=3 HTTP/1.1");
    }

    #[tokio::test]
    async fn invalid_server_and_dev_user_fail_before_any_request() {
        let failure = read_me(&Base {
            server: "ftp://example.invalid".into(),
            dev_user: None,
        })
        .await
        .unwrap_err();
        assert_eq!(failure.code, "invalid_request");
        assert_eq!(failure.status, None);

        let failure = read_me(&Base {
            server: "http://127.0.0.1:9".into(),
            dev_user: Some("x\r\ny".into()),
        })
        .await
        .unwrap_err();
        assert_eq!(failure.code, "invalid_request");
        assert_eq!(failure.status, None);
    }

    #[test]
    fn args_reject_unknown_fields_and_accept_null_dev_user() {
        let ok: Base = serde_json::from_str(r#"{"server":"http://a","devUser":null}"#).unwrap();
        assert!(ok.dev_user.is_none());
        assert!(serde_json::from_str::<Base>(r#"{"server":"http://a","path":"/x"}"#).is_err());
        assert!(
            serde_json::from_str::<MessagesArgs>(r#"{"server":"http://a","path":"/x"}"#).is_err()
        );
        assert!(serde_json::from_str::<SearchArgs>(r#"{"server":"http://a","x":1}"#).is_err());
        assert!(serde_json::from_str::<IdArgs>(r#"{"server":"http://a"}"#).is_err());
    }

    fn encoded_args(json: &str) -> tauri::http::HeaderMap {
        let mut headers = tauri::http::HeaderMap::new();
        let value: String = json
            .bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        headers.insert(ARGS_HEADER, value.parse().unwrap());
        headers
    }

    #[test]
    fn percent_decode_restores_utf8_and_keeps_plus() {
        assert_eq!(percent_decode("%E6%97%A5+x%20y").as_deref(), Some("日+x y"));
        assert_eq!(percent_decode("%ZZ"), None);
        assert_eq!(percent_decode("%4"), None);
    }

    #[test]
    fn header_args_accept_encoded_japanese_and_reject_unknown_fields() {
        let headers = encoded_args(
            r#"{"server":"http://a","devUser":null,"fileName":"写真 1.png","mime":null}"#,
        );
        let args: AvatarArgs = decode_header_args(&headers).unwrap();
        assert_eq!(args.file_name, "写真 1.png");
        assert!(args.mime.is_none());

        let headers = encoded_args(r#"{"server":"http://a","fileName":"x","extra":1}"#);
        let failure = decode_header_args::<AvatarArgs>(&headers).unwrap_err();
        assert_eq!(failure.code, "invalid_request");

        let failure = decode_header_args::<AvatarArgs>(&tauri::http::HeaderMap::new()).unwrap_err();
        assert_eq!(failure.code, "invalid_request");
    }

    #[tokio::test]
    async fn json_write_uses_patch_and_encodes_the_plugin_id() {
        let (server, task) = one_shot("200 OK", r#"{"id":"u1"}"#).await;
        let value = update_me(&BodyArgs {
            server,
            dev_user: Some("alice".into()),
            body: serde_json::json!({"display_name": "A"}),
        })
        .await
        .unwrap();
        assert_eq!(value["id"], "u1");
        assert_eq!(task.await.unwrap(), "PATCH /api/me HTTP/1.1");

        let (server, task) = one_shot("204 No Content", "").await;
        let value = delete_plugin(&IdArgs {
            server,
            dev_user: None,
            id: "a/b".into(),
        })
        .await
        .unwrap();
        assert_eq!(value, Value::Null);
        assert_eq!(task.await.unwrap(), "DELETE /api/plugins/a%2Fb HTTP/1.1");
    }

    #[tokio::test]
    async fn plugin_parts_must_add_up_to_the_body_before_any_request() {
        let args = CreatePluginArgs {
            server: "http://127.0.0.1:9".into(),
            dev_user: None,
            visibility: "public".into(),
            parts: vec![PluginPartArgs {
                name: "manifest.json".into(),
                size: 3,
            }],
        };
        let failure = create_plugin(&args, b"abcd").await.unwrap_err();
        assert_eq!(failure.code, "invalid_request");

        let args = CreatePluginArgs {
            visibility: "everyone".into(),
            ..args
        };
        let failure = create_plugin(&args, b"abc").await.unwrap_err();
        assert_eq!(failure.code, "invalid_request");

        let args = CreatePluginArgs {
            visibility: "public".into(),
            parts: vec![PluginPartArgs {
                name: "../x".into(),
                size: 3,
            }],
            ..args
        };
        let failure = create_plugin(&args, b"abc").await.unwrap_err();
        assert_eq!(failure.code, "invalid_request");
    }

    #[tokio::test]
    async fn avatar_is_sent_as_one_multipart_file_part() {
        let (server, task) = one_shot("200 OK", r#"{"id":"u1"}"#).await;
        let args = AvatarArgs {
            server,
            dev_user: None,
            file_name: "avatar.webp".into(),
            mime: Some("image/webp".into()),
        };
        set_avatar(&args, b"WEBP").await.unwrap();
        assert_eq!(task.await.unwrap(), "PUT /api/me/avatar HTTP/1.1");
    }

    fn upload_args(server: &str, upload_id: &str) -> UploadArgs {
        UploadArgs {
            server: server.to_owned(),
            dev_user: None,
            upload_id: upload_id.to_owned(),
            file_name: "a.txt".into(),
            mime: None,
            on_progress: "__CHANNEL__:1".into(),
        }
    }

    fn no_progress() -> Arc<dyn Fn(u64, u64) + Send + Sync> {
        Arc::new(|_, _| {})
    }

    #[test]
    fn upload_registry_rejects_duplicates_and_releases_on_finish() {
        let registry = UploadRegistry::default();
        let _first = registry.start("u1").unwrap();
        assert_eq!(registry.start("u1").unwrap_err().code, "invalid_request");
        registry.finish("u1");
        assert!(registry.start("u1").is_ok());
    }

    #[test]
    fn abort_before_start_cancels_the_next_start_of_that_id() {
        let registry = UploadRegistry::default();
        registry.abort("early");
        assert_eq!(registry.start("early").unwrap_err().code, "aborted");
        // 一度だけ効く。次は普通に始まる
        assert!(registry.start("early").is_ok());
    }

    #[tokio::test]
    async fn upload_sends_the_bytes_and_returns_the_attachment() {
        let (server, task) = one_shot("200 OK", r#"{"id":"f1","file_name":"a.txt"}"#).await;
        let registry = UploadRegistry::default();
        let value = upload_file_raw(
            &upload_args(&server, "u-ok"),
            Arc::new(b"hello".to_vec()),
            no_progress(),
            &registry,
        )
        .await
        .unwrap();
        assert_eq!(value["id"], "f1");
        assert_eq!(task.await.unwrap(), "POST /api/files HTTP/1.1");
        // 終わったので同じ ID を再び使える
        assert!(registry.start("u-ok").is_ok());
    }

    #[tokio::test]
    async fn abort_before_start_fails_without_any_request() {
        // 接続先に誰もいない。中止されていれば接続しに行かない（network にならない）
        let registry = UploadRegistry::default();
        registry.abort("u-early");
        let failure = upload_file_raw(
            &upload_args("http://127.0.0.1:9", "u-early"),
            Arc::new(vec![1, 2, 3]),
            no_progress(),
            &registry,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, "aborted");
    }

    #[tokio::test]
    async fn invalid_server_releases_nothing_and_registers_nothing() {
        let registry = UploadRegistry::default();
        let failure = upload_file_raw(
            &upload_args("ftp://example.invalid", "u-bad"),
            Arc::new(vec![1]),
            no_progress(),
            &registry,
        )
        .await
        .unwrap_err();
        assert_eq!(failure.code, "invalid_request");
        assert!(registry.start("u-bad").is_ok());
    }

    #[tokio::test]
    async fn abort_during_upload_ends_it_and_frees_the_id() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        // 本体を読んで、応答せずに待つ
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 65536];
            loop {
                if socket.read(&mut buf).await.unwrap_or(0) == 0 {
                    break;
                }
            }
        });
        let registry = std::sync::Arc::new(UploadRegistry::default());
        let task_registry = registry.clone();
        let task = tokio::spawn(async move {
            upload_file_raw(
                &upload_args(&format!("http://{address}"), "u-live"),
                Arc::new(vec![5u8; 4096]),
                no_progress(),
                &task_registry,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        registry.abort("u-live");
        let failure = tokio::time::timeout(std::time::Duration::from_secs(5), task)
            .await
            .expect("abort should end the upload")
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.code, "aborted");
        assert!(registry.start("u-live").is_ok());
    }

    #[test]
    fn raw_body_takes_raw_bytes_as_they_are() {
        let body = InvokeBody::Raw(vec![0, 1, 255]);
        assert_eq!(&*raw_body(&body).unwrap(), &[0u8, 1, 255]);
    }

    #[test]
    fn raw_body_takes_base64_json_on_android() {
        // Android の IPC は raw body を渡せず、base64 の文字列（JSON の値）で来る
        let body = InvokeBody::Json(Value::String("AAH/".into()));
        assert_eq!(&*raw_body(&body).unwrap(), &[0u8, 1, 255]);
        let empty = InvokeBody::Json(Value::String(String::new()));
        assert!(raw_body(&empty).unwrap().is_empty());
    }

    #[test]
    fn raw_body_refuses_bad_base64_and_other_json() {
        let bad = InvokeBody::Json(Value::String("not base64!".into()));
        assert_eq!(raw_body(&bad).unwrap_err().code, "invalid_request");
        let array = InvokeBody::Json(serde_json::json!([1, 2, 3]));
        assert_eq!(raw_body(&array).unwrap_err().code, "invalid_request");
        let none = InvokeBody::Json(Value::Null);
        assert_eq!(raw_body(&none).unwrap_err().code, "invalid_request");
    }
}
