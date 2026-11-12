//! GUI の REST の Rust 移行（段1: 読取、段2: 書込、段3: 添付のアップロード）。契約は `.pi/step4-ipc-contract.md` §9・§10。
//!
//! 成功は JSON の値をそのまま返す（型付き構造体へ変換して再シリアライズしない）。
//! 失敗は `{ status?, code, message }` の [`ReadFailure`] にする。
//! 書込は自動リトライしない。非冪等（POST）が送信後に応答を得られなければ `unknown_outcome`。

use std::fmt;
use std::sync::Arc;

use futures_util::{
    future::{Abortable, Aborted},
    stream::{self, StreamExt},
};

/// アップロードの中止口（呼び出し側が持つ。`abort()` で中止する）。
pub use futures_util::future::AbortHandle as UploadAbortHandle;
/// アップロードに渡す中止の受け口（`RestClient::upload_file` の引数）。
pub use futures_util::future::AbortRegistration as UploadAbortRegistration;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rest::{ClientError, MessagesQuery, RestClient};

/// `GET /api/messages/search` の条件。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageSearchQuery {
    pub q: Option<String>,
    pub before: Option<String>,
    pub limit: Option<u32>,
}

/// 読取の失敗。`status` は HTTP の応答があったときだけ入る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadFailure {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
}

impl ReadFailure {
    fn new(status: Option<u16>, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
        }
    }

    /// 引数（サーバー URL・開発用ユーザー名）が使えない。通信は始めていない。
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(None, "invalid_request", message)
    }

    /// 利用者がアップロードを中止した。
    pub fn aborted() -> Self {
        Self::new(None, "aborted", "中止しました")
    }
}

impl fmt::Display for ReadFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} ({}): {}",
            self.code,
            self.status.unwrap_or(0),
            self.message
        )
    }
}

impl From<ClientError> for ReadFailure {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::InvalidDevUser => {
                Self::invalid_request("開発用のユーザー名が HTTP ヘッダーに使えません")
            }
            ClientError::Request(err) => transport_failure(&err, None),
            ClientError::Http {
                status,
                code,
                message,
            } => Self::new(Some(status.as_u16()), &code, message),
        }
    }
}

fn transport_failure(err: &reqwest::Error, status: Option<u16>) -> ReadFailure {
    if err.is_timeout() {
        ReadFailure::new(status, "timeout", "応答がありませんでした")
    } else {
        ReadFailure::new(status, "network", "ネットワークエラー")
    }
}

#[derive(Deserialize)]
struct ApiErrorBody {
    code: String,
    message: String,
}

/// 非 2xx の応答を、契約どおりの失敗にする。
fn http_failure(status: reqwest::StatusCode, body: &[u8]) -> ReadFailure {
    match serde_json::from_slice::<ApiErrorBody>(body) {
        Ok(error) => ReadFailure::new(Some(status.as_u16()), &error.code, error.message),
        Err(_) => ReadFailure::new(
            Some(status.as_u16()),
            &format!("http_{}", status.as_u16()),
            status.canonical_reason().unwrap_or("HTTP error"),
        ),
    }
}

/// パスの 1 区切り分を `encodeURIComponent` と同じ規則でエンコードする。
/// 非予約文字は `A-Za-z0-9 - _ . ! ~ * ' ( )` だけ残し、それ以外（UTF-8 の各バイトを含む）は `%XX` にする。
pub fn encode_path_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(char::from(byte)),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// 値のあるものだけを、`key=value` の列（`application/x-www-form-urlencoded`）にする。
fn query_string(pairs: &[(&str, Option<String>)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
            serializer.append_pair(key, value);
        }
    }
    serializer.finish()
}

fn with_query(path: &str, query: String) -> String {
    if query.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{query}")
    }
}

/// `GET /api/messages?…`（順序は `before`, `limit`）。
pub fn messages_path(query: &MessagesQuery) -> String {
    with_query(
        "/api/messages",
        query_string(&[
            ("before", query.before.clone()),
            ("limit", query.limit.map(|v| v.to_string())),
        ]),
    )
}

/// `GET /api/messages/search?…`（順序は `q`, `before`, `limit`）。
pub fn search_path(query: &MessageSearchQuery) -> String {
    with_query(
        "/api/messages/search",
        query_string(&[
            ("q", query.q.clone()),
            ("before", query.before.clone()),
            ("limit", query.limit.map(|v| v.to_string())),
        ]),
    )
}

/// `GET /api/sessions/{id}`。
pub fn session_path(id: &str) -> String {
    format!("/api/sessions/{}", encode_path_segment(id))
}

impl RestClient {
    /// 任意の GET の JSON を、そのまま値として返す。読取専用（呼び出し側が固定のパスを渡す）。
    /// パスは `messages_path` などの関数で作る。
    pub async fn get_value(&self, path: &str) -> Result<Value, ReadFailure> {
        let response = self
            .get_request(path)
            .send()
            .await
            .map_err(|err| transport_failure(&err, None))?;
        let status = response.status();
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(err) => return Err(transport_failure(&err, Some(status.as_u16()))),
        };
        if !status.is_success() {
            return Err(http_failure(status, &body));
        }
        serde_json::from_slice::<Value>(&body).map_err(|_| {
            ReadFailure::new(
                Some(status.as_u16()),
                "bad_response",
                "サーバーの応答を読めませんでした",
            )
        })
    }

    /// 任意の GET の本文をバイト列で返す（アバター `/api/avatars/{id}`、サムネイル `/api/files/{id}/thumb` など）。
    /// `max_bytes` を超えたら、読み切らずに `too_large` で失敗する。パスは `encode_path_segment` 済みのものを渡す。
    pub async fn get_bytes(&self, path: &str, max_bytes: usize) -> Result<Vec<u8>, ReadFailure> {
        let mut response = self
            .get_request(path)
            .send()
            .await
            .map_err(|err| transport_failure(&err, None))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.bytes().await.unwrap_or_default();
            return Err(http_failure(status, &body));
        }
        let too_large = || {
            ReadFailure::new(
                Some(status.as_u16()),
                "too_large",
                "応答が大きすぎるため読み込みません",
            )
        };
        if response
            .content_length()
            .is_some_and(|length| length > max_bytes as u64)
        {
            return Err(too_large());
        }
        let mut out = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if out.len() + chunk.len() > max_bytes {
                        return Err(too_large());
                    }
                    out.extend_from_slice(&chunk);
                }
                Ok(None) => return Ok(out),
                Err(err) => return Err(transport_failure(&err, Some(status.as_u16()))),
            }
        }
    }
}

// ---- 共有フォルダ（`/api/shared`） ----

/// 共有フォルダのパス（`a/b.txt`）を整える。区切りは `/` だけ。先頭・末尾・連続の `/` と `.` は捨て、
/// `..` や空の名前は拒否する（そのほかの検査はサーバーが行う）。空なら共有フォルダの直下。
pub fn shared_path(path: &str) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(format!("`..` は使えません: {path}")),
            part if part.contains('\\') => {
                return Err(format!("`\\` は使えません（区切りは `/`）: {path}"));
            }
            part => parts.push(part),
        }
    }
    Ok(parts.join("/"))
}

fn shared_url_path(path: &str) -> String {
    if path.is_empty() {
        return "/api/shared".to_owned();
    }
    let encoded: Vec<String> = path.split('/').map(encode_path_segment).collect();
    format!("/api/shared/{}", encoded.join("/"))
}

/// 共有フォルダのファイルの取得（本文は `chunk` で少しずつ読む。メモリに全部は載せない）。
pub struct SharedDownload {
    response: reqwest::Response,
}

impl SharedDownload {
    /// 本文の大きさ（応答に長さがあるとき）
    pub fn len(&self) -> Option<u64> {
        self.response.content_length()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == Some(0)
    }

    /// 次の断片。終わりなら `None`。
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, ReadFailure> {
        match self.response.chunk().await {
            Ok(chunk) => Ok(chunk.map(|c| c.to_vec())),
            Err(err) => Err(transport_failure(
                &err,
                Some(self.response.status().as_u16()),
            )),
        }
    }
}

fn shared_entry(value: Value) -> Result<disnans_shared::SharedEntry, ReadFailure> {
    serde_json::from_value(value)
        .map_err(|_| ReadFailure::new(None, "bad_response", "サーバーの応答を読めませんでした"))
}

impl RestClient {
    /// フォルダの中身（`GET /api/shared/{path}`。`path` が空なら直下）。ファイルのパスは `bad_response`
    pub async fn shared_list(
        &self,
        path: &str,
    ) -> Result<disnans_shared::SharedListing, ReadFailure> {
        let value = self.get_value(&shared_url_path(path)).await?;
        serde_json::from_value(value)
            .map_err(|_| ReadFailure::new(None, "bad_response", "フォルダの一覧ではありません"))
    }

    /// 項目 1 つの情報。無ければ `None`。親フォルダの一覧から探す（直下は共有フォルダ全体の一覧）。
    pub async fn shared_stat(
        &self,
        path: &str,
    ) -> Result<Option<disnans_shared::SharedEntry>, ReadFailure> {
        let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
        if name.is_empty() {
            return Ok(None);
        }
        match self.shared_list(parent).await {
            Ok(listing) => Ok(listing.entries.into_iter().find(|e| e.name == name)),
            Err(e) if e.status == Some(404) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// ファイルを取得する（`GET /api/shared/{path}`）。全体の時間制限は無い。
    pub async fn shared_get(&self, path: &str) -> Result<SharedDownload, ReadFailure> {
        self.download(&shared_url_path(path)).await
    }

    /// 任意の GET の本文を、断片で読めるように返す（時間制限なし・開発用ヘッダーあり）。
    /// `path` は符号化済みの API のパス（`/api/files/{id}`、`/api/shared/...`）。保存は呼び出し側が行う。
    pub async fn download(&self, path: &str) -> Result<SharedDownload, ReadFailure> {
        let response = self
            .upload_request(reqwest::Method::GET, path)
            .send()
            .await
            .map_err(|err| transport_failure(&err, None))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.bytes().await.unwrap_or_default();
            return Err(http_failure(status, &body));
        }
        Ok(SharedDownload { response })
    }

    /// 本文をそのパスのファイルにする（`PUT /api/shared/{path}`、作成・上書き）。`body` は逐次送る。
    /// 全体の時間制限は無い。自動リトライはしない。
    pub async fn shared_put(
        &self,
        path: &str,
        length: u64,
        body: reqwest::Body,
    ) -> Result<disnans_shared::SharedEntry, ReadFailure> {
        let response = self
            .upload_request(reqwest::Method::PUT, &shared_url_path(path))
            .header(reqwest::header::CONTENT_LENGTH, length.to_string())
            .body(body)
            .send()
            .await
            .map_err(|err| send_failure(&err, true))?;
        shared_entry(write_response(response).await?)
    }

    /// 削除（フォルダは中身ごと）。
    pub async fn shared_delete(&self, path: &str) -> Result<(), ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::DELETE, &shared_url_path(path)),
            true,
        )
        .await
        .map(|_| ())
    }

    /// フォルダの作成・移動・コピー（`POST /api/shared`）。結果の項目を返す。
    pub async fn shared_op(
        &self,
        op: &disnans_shared::SharedOp,
    ) -> Result<disnans_shared::SharedEntry, ReadFailure> {
        let value = send_write(
            self.write_request(reqwest::Method::POST, "/api/shared")
                .json(op),
            false,
        )
        .await?;
        shared_entry(value)
    }
}

// ---- 書込（段2） ----

/// 書込の送信失敗。非冪等（POST）は、送信後に応答が無ければ結果不明（`unknown_outcome`）にする。
/// 接続前の失敗（`is_connect`）は送られていないので、通常の `network` / `timeout` のまま。
fn send_failure(err: &reqwest::Error, idempotent: bool) -> ReadFailure {
    if !idempotent && !err.is_connect() && !err.is_builder() {
        ReadFailure::new(
            None,
            "unknown_outcome",
            "結果を確かめられませんでした（送信されたかは分かりません）",
        )
    } else {
        transport_failure(err, None)
    }
}

/// 書込の応答。2xx で本文が空なら `null`、JSON なら値をそのまま返す。
async fn write_response(response: reqwest::Response) -> Result<Value, ReadFailure> {
    let status = response.status();
    let body = match response.bytes().await {
        Ok(body) => body,
        Err(err) => return Err(transport_failure(&err, Some(status.as_u16()))),
    };
    if !status.is_success() {
        return Err(http_failure(status, &body));
    }
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    serde_json::from_slice::<Value>(&body).map_err(|_| {
        ReadFailure::new(
            Some(status.as_u16()),
            "bad_response",
            "サーバーの応答を読めませんでした",
        )
    })
}

/// 書込の送信（自動リトライはしない）。
async fn send_write(
    request: reqwest::RequestBuilder,
    idempotent: bool,
) -> Result<Value, ReadFailure> {
    let response = request
        .send()
        .await
        .map_err(|err| send_failure(&err, idempotent))?;
    write_response(response).await
}

/// `id` をパスに入れた書込のパス（`/api/...{id}...`）。
fn with_id(prefix: &str, id: &str, suffix: &str) -> String {
    format!("{prefix}{}{suffix}", encode_path_segment(id))
}

/// multipart/form-data の 1 区切り。`Data` は、添付のバイト列の範囲（コピーは送るときに行う）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Segment {
    Bytes(Vec<u8>),
    Data(std::ops::Range<usize>),
}

/// multipart の本体（Content-Type と、順に並んだ断片）。reqwest の multipart feature は使わない。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Multipart {
    pub content_type: String,
    pub segments: Vec<Segment>,
}

impl Multipart {
    pub fn len(&self) -> u64 {
        self.segments
            .iter()
            .map(|segment| match segment {
                Segment::Bytes(bytes) => bytes.len() as u64,
                Segment::Data(range) => (range.end - range.start) as u64,
            })
            .sum()
    }
}

/// 添付のファイル 1 つ分（`field` は必ず `file`）。`data` の `range` を本体にする。
pub(crate) struct FilePart<'a> {
    pub file_name: &'a str,
    pub mime: &'a str,
    pub range: std::ops::Range<usize>,
}

/// 区切り文字（boundary）。実行ごとに変わる乱数で作る（本体に現れないように）。
pub(crate) fn new_boundary() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut out = String::from("disnans-");
    for _ in 0..2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", hasher.finish()));
    }
    out
}

/// ファイル名を `Content-Disposition` の引用符の中に入れられる形にする（ブラウザと同じく `"` と改行を %XX にする）。
fn quote_file_name(name: &str) -> String {
    name.replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// 文字列のフィールドと添付の順に、multipart の本体を組み立てる。`file` フィールドを添付にする。
pub(crate) fn build_multipart(
    boundary: &str,
    text_fields: &[(&str, &str)],
    files: &[FilePart<'_>],
) -> Multipart {
    let mut segments = Vec::new();
    for (name, value) in text_fields {
        segments.push(Segment::Bytes(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .into_bytes(),
        ));
    }
    for file in files {
        segments.push(Segment::Bytes(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                quote_file_name(file.file_name),
                file.mime
            )
            .into_bytes(),
        ));
        segments.push(Segment::Data(file.range.clone()));
        segments.push(Segment::Bytes(b"\r\n".to_vec()));
    }
    segments.push(Segment::Bytes(format!("--{boundary}--\r\n").into_bytes()));
    Multipart {
        content_type: format!("multipart/form-data; boundary={boundary}"),
        segments,
    }
}

/// 断片を 1 つのバイト列にする（アバター・プラグインなど、進捗が要らない書込）。
pub(crate) fn flatten(multipart: &Multipart, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(multipart.len() as usize);
    for segment in &multipart.segments {
        match segment {
            Segment::Bytes(bytes) => out.extend_from_slice(bytes),
            Segment::Data(range) => out.extend_from_slice(&data[range.clone()]),
        }
    }
    out
}

/// 送信時の進捗を取るための断片の分け方。大きい添付は 64 KiB ずつに分ける。
pub(crate) const UPLOAD_CHUNK: usize = 64 * 1024;

/// 送信する断片（`Bytes` は見出しなどの小さな部分、`Data` は添付の範囲を `UPLOAD_CHUNK` 以下に分けたもの）。
pub(crate) fn upload_pieces(multipart: &Multipart) -> Vec<Segment> {
    let mut out = Vec::new();
    for segment in &multipart.segments {
        match segment {
            Segment::Bytes(bytes) => out.push(Segment::Bytes(bytes.clone())),
            Segment::Data(range) => {
                let mut start = range.start;
                while start < range.end {
                    let end = (start + UPLOAD_CHUNK).min(range.end);
                    out.push(Segment::Data(start..end));
                    start = end;
                }
            }
        }
    }
    out
}

/// `PUT /api/me/avatar` の multipart 本体（フィールド `file`）。
pub(crate) fn avatar_multipart(
    data_len: usize,
    file_name: &str,
    mime: &str,
    boundary: &str,
) -> Multipart {
    build_multipart(
        boundary,
        &[],
        &[FilePart {
            file_name,
            mime,
            range: 0..data_len,
        }],
    )
}

impl RestClient {
    pub async fn update_me(&self, body: &Value) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::PATCH, "/api/me")
                .json(body),
            true,
        )
        .await
    }

    pub async fn clear_avatar(&self) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::DELETE, "/api/me/avatar"),
            true,
        )
        .await
    }

    pub async fn set_prefs(&self, body: &Value) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::PUT, "/api/me/prefs")
                .json(body),
            true,
        )
        .await
    }

    /// 自分のデバイスの一覧（`GET /api/me/devices`）
    pub async fn list_devices(&self) -> Result<Value, ReadFailure> {
        self.get_value("/api/me/devices").await
    }

    /// デバイスを登録する、または名前を変える（`PUT /api/me/devices/{id}`）。冪等。
    pub async fn put_device(&self, id: &str, name: &str) -> Result<Value, ReadFailure> {
        let path = with_id("/api/me/devices/", id, "");
        send_write(
            self.write_request(reqwest::Method::PUT, &path)
                .json(&serde_json::json!({ "name": name })),
            true,
        )
        .await
    }

    /// デバイスとその設定を消す（`DELETE /api/me/devices/{id}`）
    pub async fn delete_device(&self, id: &str) -> Result<Value, ReadFailure> {
        let path = with_id("/api/me/devices/", id, "");
        send_write(self.write_request(reqwest::Method::DELETE, &path), true).await
    }

    /// このデバイスの設定（`GET /api/me/devices/{id}/prefs`）。設定が無ければ 404
    pub async fn get_device_prefs(&self, id: &str) -> Result<Value, ReadFailure> {
        self.get_value(&with_id("/api/me/devices/", id, "/prefs"))
            .await
    }

    /// このデバイスの設定をまるごと置き換える（`PUT /api/me/devices/{id}/prefs`）。デバイスが未登録なら 404
    pub async fn put_device_prefs(&self, id: &str, prefs: &Value) -> Result<Value, ReadFailure> {
        let path = with_id("/api/me/devices/", id, "/prefs");
        send_write(
            self.write_request(reqwest::Method::PUT, &path)
                .json(&serde_json::json!({ "prefs": prefs })),
            true,
        )
        .await
    }

    pub async fn mark_read(&self, body: &Value) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::PUT, "/api/me/read")
                .json(body),
            true,
        )
        .await
    }

    pub async fn update_session(&self, id: &str, body: &Value) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::PUT, &session_path(id))
                .json(body),
            true,
        )
        .await
    }

    pub async fn delete_plugin(&self, id: &str) -> Result<Value, ReadFailure> {
        let path = with_id("/api/plugins/", id, "");
        send_write(self.write_request(reqwest::Method::DELETE, &path), true).await
    }

    pub async fn sample_notification(&self) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::POST, "/api/notify/sample"),
            false,
        )
        .await
    }

    pub async fn plugin_post_message(&self, id: &str, body: &Value) -> Result<Value, ReadFailure> {
        let path = with_id("/api/plugins/", id, "/messages");
        send_write(
            self.write_request(reqwest::Method::POST, &path).json(body),
            false,
        )
        .await
    }

    pub async fn plugin_notify(&self, id: &str, body: &Value) -> Result<Value, ReadFailure> {
        let path = with_id("/api/plugins/", id, "/notify");
        send_write(
            self.write_request(reqwest::Method::POST, &path).json(body),
            false,
        )
        .await
    }

    pub async fn create_session(&self, body: &Value) -> Result<Value, ReadFailure> {
        send_write(
            self.write_request(reqwest::Method::POST, "/api/sessions")
                .json(body),
            false,
        )
        .await
    }

    /// アバターを設定する（`PUT /api/me/avatar`、multipart のフィールド `file`）。
    pub async fn set_avatar(
        &self,
        data: &[u8],
        file_name: &str,
        mime: &str,
    ) -> Result<Value, ReadFailure> {
        let multipart = avatar_multipart(data.len(), file_name, mime, &new_boundary());
        let body = flatten(&multipart, data);
        send_write(
            self.write_request(reqwest::Method::PUT, "/api/me/avatar")
                .header(reqwest::header::CONTENT_TYPE, multipart.content_type)
                .body(body),
            true,
        )
        .await
    }

    /// 添付をアップロードする（`POST /api/files`、multipart のフィールド `file`）。
    ///
    /// 送信のたびに `progress(loaded, total)` を呼ぶ（`loaded` は送信ストリームに渡したバイト数）。
    /// `abort` が中止されると `aborted` で終わる。自動リトライはしない。全体の時間制限は無い。
    pub async fn upload_file(
        &self,
        data: Arc<Vec<u8>>,
        file_name: &str,
        mime: &str,
        progress: Arc<dyn Fn(u64, u64) + Send + Sync>,
        abort: UploadAbortRegistration,
    ) -> Result<Value, ReadFailure> {
        let multipart = build_multipart(
            &new_boundary(),
            &[],
            &[FilePart {
                file_name,
                mime,
                range: 0..data.len(),
            }],
        );
        let total = multipart.len();
        let pieces = upload_pieces(&multipart);
        let mut loaded = 0u64;
        let body = stream::iter(pieces).map(move |piece| {
            let chunk = match piece {
                Segment::Bytes(bytes) => bytes,
                Segment::Data(range) => data[range].to_vec(),
            };
            loaded += chunk.len() as u64;
            progress(loaded, total);
            Ok::<Vec<u8>, std::io::Error>(chunk)
        });
        let request = self
            .upload_request(reqwest::Method::POST, "/api/files")
            .header(reqwest::header::CONTENT_TYPE, multipart.content_type)
            .header(reqwest::header::CONTENT_LENGTH, total.to_string())
            .body(reqwest::Body::wrap_stream(body));
        match Abortable::new(request.send(), abort).await {
            Err(Aborted) => Err(ReadFailure::aborted()),
            Ok(Err(err)) => Err(send_failure(&err, false)),
            Ok(Ok(response)) => write_response(response).await,
        }
    }

    /// プラグインを配布・更新する（`POST /api/plugins`）。`files` は `data` の範囲を順に並べたもの。
    pub async fn create_plugin(
        &self,
        visibility: &str,
        data: &[u8],
        files: &[(String, std::ops::Range<usize>)],
    ) -> Result<Value, ReadFailure> {
        let parts: Vec<FilePart<'_>> = files
            .iter()
            .map(|(name, range)| FilePart {
                file_name: name,
                mime: "application/octet-stream",
                range: range.clone(),
            })
            .collect();
        let multipart = build_multipart(&new_boundary(), &[("visibility", visibility)], &parts);
        let body = flatten(&multipart, data);
        send_write(
            self.write_request(reqwest::Method::POST, "/api/plugins")
                .header(reqwest::header::CONTENT_TYPE, multipart.content_type)
                .body(body),
            false,
        )
        .await
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod write_tests;
