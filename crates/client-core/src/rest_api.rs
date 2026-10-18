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

    /// 自分の端末の一覧（`GET /api/me/devices`）
    pub async fn list_devices(&self) -> Result<Value, ReadFailure> {
        self.get_value("/api/me/devices").await
    }

    /// 端末を登録する、または名前を変える（`PUT /api/me/devices/{id}`）。冪等。
    pub async fn put_device(&self, id: &str, name: &str) -> Result<Value, ReadFailure> {
        let path = with_id("/api/me/devices/", id, "");
        send_write(
            self.write_request(reqwest::Method::PUT, &path)
                .json(&serde_json::json!({ "name": name })),
            true,
        )
        .await
    }

    /// 端末とその設定を消す（`DELETE /api/me/devices/{id}`）
    pub async fn delete_device(&self, id: &str) -> Result<Value, ReadFailure> {
        let path = with_id("/api/me/devices/", id, "");
        send_write(self.write_request(reqwest::Method::DELETE, &path), true).await
    }

    /// この端末の設定（`GET /api/me/devices/{id}/prefs`）。設定が無ければ 404
    pub async fn get_device_prefs(&self, id: &str) -> Result<Value, ReadFailure> {
        self.get_value(&with_id("/api/me/devices/", id, "/prefs"))
            .await
    }

    /// この端末の設定をまるごと置き換える（`PUT /api/me/devices/{id}/prefs`）。端末が未登録なら 404
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
mod tests {
    use super::*;
    use crate::ServerUrl;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    /// 1 回だけ応答するサーバー。受け取ったリクエストの 1 行目を返す。
    async fn one_shot(
        status: &'static str,
        body: &'static str,
    ) -> (RestClient, tokio::task::JoinHandle<String>) {
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
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            Some("alice"),
        )
        .unwrap();
        (client, task)
    }

    #[tokio::test]
    async fn get_bytes_returns_the_body_and_enforces_the_limit() {
        let (client, task) = one_shot("200 OK", "abc").await;
        assert_eq!(
            client.get_bytes("/api/avatars/x", 10).await.unwrap(),
            b"abc"
        );
        assert_eq!(task.await.unwrap(), "GET /api/avatars/x HTTP/1.1");

        let (client, _task) = one_shot("200 OK", "abcdef").await;
        let error = client.get_bytes("/api/avatars/x", 5).await.unwrap_err();
        assert_eq!(error.code, "too_large");

        let (client, _task) =
            one_shot("404 Not Found", r#"{"code":"not_found","message":"no"}"#).await;
        let error = client
            .get_bytes("/api/files/x/thumb", 10)
            .await
            .unwrap_err();
        assert_eq!(
            (error.status, error.code.as_str()),
            (Some(404), "not_found")
        );
    }

    #[test]
    fn path_segments_follow_encode_uri_component() {
        assert_eq!(encode_path_segment("01HZ-a_b.c!~*'()"), "01HZ-a_b.c!~*'()");
        assert_eq!(
            encode_path_segment("a/b?c#d&e=f+g"),
            "a%2Fb%3Fc%23d%26e%3Df%2Bg"
        );
        assert_eq!(encode_path_segment("a b%"), "a%20b%25");
        assert_eq!(encode_path_segment("日"), "%E6%97%A5");
    }

    #[test]
    fn messages_query_omits_empty_values_and_keeps_order() {
        assert_eq!(messages_path(&MessagesQuery::default()), "/api/messages");
        let path = messages_path(&MessagesQuery {
            before: Some("id+2".into()),
            limit: Some(25),
        });
        assert_eq!(path, "/api/messages?before=id%2B2&limit=25");
        let path = messages_path(&MessagesQuery {
            before: Some(String::new()),
            limit: Some(0),
        });
        assert_eq!(path, "/api/messages?limit=0");
    }

    #[test]
    fn search_query_uses_q_before_limit() {
        assert_eq!(
            search_path(&MessageSearchQuery::default()),
            "/api/messages/search"
        );
        let path = search_path(&MessageSearchQuery {
            q: Some("a b&c".into()),
            before: None,
            limit: Some(5),
        });
        assert_eq!(path, "/api/messages/search?q=a+b%26c&limit=5");
    }

    #[test]
    fn id_paths_are_encoded() {
        assert_eq!(session_path("s 1"), "/api/sessions/s%201");
    }

    #[tokio::test]
    async fn success_returns_the_json_value_unchanged() {
        let body = r#"{"unknown_field":{"nested":[1,null]},"id":"u1"}"#;
        let (client, server) = one_shot("200 OK", body).await;
        let value = client.get_value("/api/me").await.unwrap();
        assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
        let request = server.await.unwrap();
        assert_eq!(request, "GET /api/me HTTP/1.1");
    }

    #[tokio::test]
    async fn api_error_keeps_status_code_and_message() {
        let (client, server) = one_shot(
            "404 Not Found",
            r#"{"code":"not_found","message":"見つかりません"}"#,
        )
        .await;
        let failure = client.get_value("/api/sessions/x").await.unwrap_err();
        server.await.unwrap();
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({"status": 404, "code": "not_found", "message": "見つかりません"})
        );
    }

    #[tokio::test]
    async fn non_json_error_uses_http_code_and_reason_phrase() {
        let (client, server) = one_shot("502 Bad Gateway", "not json").await;
        let failure = client.get_value("/api/me").await.unwrap_err();
        server.await.unwrap();
        assert_eq!(failure.status, Some(502));
        assert_eq!(failure.code, "http_502");
        assert_eq!(failure.message, "Bad Gateway");
    }

    #[tokio::test]
    async fn redirect_is_an_error_not_followed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
        });
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            None,
        )
        .unwrap();
        let failure = client.get_value("/api/me").await.unwrap_err();
        task.await.unwrap();
        assert_eq!(failure.status, Some(302));
        assert_eq!(failure.code, "http_302");
    }

    #[tokio::test]
    async fn success_with_invalid_json_is_bad_response_with_status() {
        let (client, server) = one_shot("200 OK", "{").await;
        let failure = client.get_value("/api/me").await.unwrap_err();
        server.await.unwrap();
        assert_eq!(failure.status, Some(200));
        assert_eq!(failure.code, "bad_response");
    }

    #[tokio::test]
    async fn connection_refused_is_network_without_status() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            None,
        )
        .unwrap();
        let failure = client.get_value("/api/me").await.unwrap_err();
        assert_eq!(failure.status, None);
        assert_eq!(failure.code, "network");
        assert_eq!(failure.message, "ネットワークエラー");
    }

    #[test]
    fn failure_json_omits_missing_status() {
        assert_eq!(
            serde_json::to_value(ReadFailure::invalid_request("m")).unwrap(),
            serde_json::json!({"code": "invalid_request", "message": "m"})
        );
    }

    #[test]
    fn dev_user_problem_maps_to_invalid_request() {
        let failure = ReadFailure::from(ClientError::InvalidDevUser);
        assert_eq!(failure.code, "invalid_request");
        assert_eq!(failure.status, None);
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;
    use crate::ServerUrl;
    use futures_util::future::AbortHandle;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };

    /// 接続ごとの動作。
    #[derive(Clone, Copy)]
    enum Action {
        /// 本体まで読んで、この応答を返す（`keep_alive` なら接続を閉じない）。
        Reply {
            status: &'static str,
            body: &'static str,
            keep_alive: bool,
        },
        /// 本体まで読んで、応答せずに接続を閉じる（送信後の切断）。
        CutAfterRead,
        /// 本体まで読んで、応答せずに待つ（中止のテスト用）。
        Hang,
    }

    #[derive(Default)]
    struct Seen {
        connections: usize,
        requests: Vec<String>,
        bodies: Vec<Vec<u8>>,
    }

    /// 1 接続につき 1 要求を読む。`actions` の順に動作する（尽きたら最後の動作を繰り返す）。
    async fn scripted(actions: Vec<Action>) -> (RestClient, Arc<Mutex<Seen>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Seen::default()));
        let seen_task = seen.clone();
        tokio::spawn(async move {
            let mut index = 0;
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let action = actions[index.min(actions.len() - 1)];
                index += 1;
                seen_task.lock().unwrap().connections += 1;
                let seen = seen_task.clone();
                tokio::spawn(serve_one(socket, action, seen));
            }
        });
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            Some("alice"),
        )
        .unwrap();
        (client, seen)
    }

    async fn serve_one(mut socket: TcpStream, action: Action, seen: Arc<Mutex<Seen>>) {
        let (line, body) = read_request(&mut socket).await;
        {
            let mut seen = seen.lock().unwrap();
            seen.requests.push(line);
            seen.bodies.push(body);
        }
        match action {
            Action::Reply {
                status,
                body,
                keep_alive,
            } => {
                let connection = if keep_alive { "keep-alive" } else { "close" };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: {connection}\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
                if keep_alive {
                    // 応答のあと、サーバー側が接続を閉じる（次の要求は古い接続に乗ることになる）
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            Action::CutAfterRead => {
                // 何も返さず閉じる
            }
            Action::Hang => {
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
        }
    }

    /// 要求の 1 行目と本体（Content-Length まで）を読む。
    async fn read_request(socket: &mut TcpStream) -> (String, Vec<u8>) {
        let mut buf = Vec::new();
        let head_end;
        loop {
            let mut chunk = [0u8; 4096];
            let read = socket.read(&mut chunk).await.unwrap();
            assert!(read > 0, "client closed before sending the head");
            buf.extend_from_slice(&chunk[..read]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                head_end = pos + 4;
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let length = head
            .lines()
            .find_map(|l| {
                let (name, value) = l.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())?
            })
            .unwrap_or(0);
        while buf.len() < head_end + length {
            let mut chunk = [0u8; 4096];
            let read = socket.read(&mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..read]);
        }
        let body = buf[head_end..].to_vec();
        (head.lines().next().unwrap_or_default().to_owned(), body)
    }

    #[tokio::test]
    async fn json_write_sends_body_and_returns_the_value_unchanged() {
        let body = r#"{"id":"u1","extra":{"x":[null]}}"#;
        let (client, seen) = scripted(vec![Action::Reply {
            status: "200 OK",
            body,
            keep_alive: false,
        }])
        .await;
        let value = client
            .update_me(&serde_json::json!({"display_name": "Alice"}))
            .await
            .unwrap();
        assert_eq!(value, serde_json::from_str::<Value>(body).unwrap());
        let seen = seen.lock().unwrap();
        assert_eq!(seen.requests, vec!["PATCH /api/me HTTP/1.1"]);
        assert_eq!(seen.bodies[0], br#"{"display_name":"Alice"}"#);
    }

    #[tokio::test]
    async fn device_calls_use_the_device_paths_and_bodies() {
        let (client, seen) = scripted(vec![Action::Reply {
            status: "200 OK",
            body: r#"{"prefs":{"inputId":"x"},"updated_at":5}"#,
            keep_alive: false,
        }])
        .await;
        client
            .put_device_prefs("01J8", &serde_json::json!({"inputId": "x"}))
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.requests,
            vec!["PUT /api/me/devices/01J8/prefs HTTP/1.1"]
        );
        assert_eq!(seen.bodies[0], br#"{"prefs":{"inputId":"x"}}"#);
    }

    #[tokio::test]
    async fn device_not_found_keeps_status_and_code() {
        let (client, _seen) = scripted(vec![Action::Reply {
            status: "404 Not Found",
            body: r#"{"code":"not_found","message":"設定がありません"}"#,
            keep_alive: false,
        }])
        .await;
        let err = client.get_device_prefs("01J8").await.unwrap_err();
        assert_eq!(err.status, Some(404));
        assert_eq!(err.code, "not_found");
    }

    #[tokio::test]
    async fn empty_success_body_is_null() {
        let (client, _seen) = scripted(vec![Action::Reply {
            status: "204 No Content",
            body: "",
            keep_alive: false,
        }])
        .await;
        assert_eq!(client.delete_plugin("p1").await.unwrap(), Value::Null);
    }

    #[tokio::test]
    async fn api_error_on_write_keeps_status_code_and_message() {
        let (client, _seen) = scripted(vec![Action::Reply {
            status: "409 Conflict",
            body: r#"{"code":"version_conflict","message":"版が違います"}"#,
            keep_alive: false,
        }])
        .await;
        let failure = client
            .update_session("s1", &serde_json::json!({"version": 1}))
            .await
            .unwrap_err();
        assert_eq!(
            serde_json::to_value(&failure).unwrap(),
            serde_json::json!({"status": 409, "code": "version_conflict", "message": "版が違います"})
        );
    }

    #[tokio::test]
    async fn cut_after_send_on_post_is_unknown_outcome_and_sent_once() {
        let (client, seen) = scripted(vec![Action::CutAfterRead]).await;
        let failure = client
            .plugin_post_message("p1", &serde_json::json!({"text": "hi"}))
            .await
            .unwrap_err();
        assert_eq!(failure.status, None);
        assert_eq!(failure.code, "unknown_outcome");
        // 送り直していないこと（接続も要求も 1 回だけ）
        tokio::time::sleep(Duration::from_millis(200)).await;
        let seen = seen.lock().unwrap();
        assert_eq!(seen.connections, 1);
        assert_eq!(
            seen.requests,
            vec!["POST /api/plugins/p1/messages HTTP/1.1"]
        );
    }

    #[tokio::test]
    async fn cut_after_send_on_put_is_network_and_sent_once() {
        let (client, seen) = scripted(vec![Action::CutAfterRead]).await;
        let failure = client
            .set_prefs(&serde_json::json!({"enter_sends": true}))
            .await
            .unwrap_err();
        assert_eq!(failure.status, None);
        assert_eq!(failure.code, "network");
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(seen.lock().unwrap().connections, 1);
    }

    #[tokio::test]
    async fn refused_connection_on_post_is_network_not_unknown() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = RestClient::new(
            ServerUrl::parse(&format!("http://{address}")).unwrap(),
            None,
        )
        .unwrap();
        let failure = client.sample_notification().await.unwrap_err();
        assert_eq!(failure.code, "network");
        assert_eq!(failure.status, None);
    }

    /// 再利用した接続が、応答のあとにサーバーから閉じられていても、次の書込は二重に送られない。
    #[tokio::test]
    async fn write_after_keep_alive_close_is_not_resent() {
        let (client, seen) = scripted(vec![
            Action::Reply {
                status: "200 OK",
                body: r#"{"ok":1}"#,
                keep_alive: true,
            },
            Action::CutAfterRead,
        ])
        .await;
        client
            .create_session(&serde_json::json!({"title": "a"}))
            .await
            .unwrap();
        let failure = client
            .create_session(&serde_json::json!({"title": "b"}))
            .await
            .unwrap_err();
        assert_eq!(failure.code, "unknown_outcome");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let seen = seen.lock().unwrap();
        // 1 回目の要求と、2 回目の要求だけ。2 回目が再送されていれば 3 になる
        assert_eq!(seen.requests.len(), 2, "requests: {:?}", seen.requests);
        assert_eq!(seen.connections, 2);
    }

    #[tokio::test]
    async fn avatar_sends_one_multipart_part_named_file() {
        let (client, seen) = scripted(vec![Action::Reply {
            status: "200 OK",
            body: r#"{"id":"u1"}"#,
            keep_alive: false,
        }])
        .await;
        client
            .set_avatar(b"\x89PNG-bytes", "me \"x\".png", "image/png")
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.requests, vec!["PUT /api/me/avatar HTTP/1.1"]);
        let body = String::from_utf8_lossy(&seen.bodies[0]).into_owned();
        assert!(
            body.contains(r#"name="file"; filename="me %22x%22.png""#),
            "{body}"
        );
        assert!(body.contains("Content-Type: image/png"));
        assert!(seen.bodies[0].windows(10).any(|w| w == b"\x89PNG-bytes"));
    }

    #[tokio::test]
    async fn plugin_upload_puts_visibility_then_each_file() {
        let (client, seen) = scripted(vec![Action::Reply {
            status: "200 OK",
            body: r#"{"id":"p1"}"#,
            keep_alive: false,
        }])
        .await;
        let manifest = br#"{"name":"x"}"#;
        let main = b"body-js";
        let data = [manifest.as_slice(), main.as_slice()].concat();
        let split = manifest.len();
        client
            .create_plugin(
                "private",
                &data,
                &[
                    ("manifest.json".to_owned(), 0..split),
                    ("main.js".to_owned(), split..data.len()),
                ],
            )
            .await
            .unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.requests, vec!["POST /api/plugins HTTP/1.1"]);
        let body = String::from_utf8_lossy(&seen.bodies[0]).into_owned();
        let visibility = body.find(r#"name="visibility""#).unwrap();
        let manifest = body.find(r#"filename="manifest.json""#).unwrap();
        let main = body.find(r#"filename="main.js""#).unwrap();
        assert!(visibility < manifest && manifest < main);
        assert!(body.contains("private\r\n"));
        assert!(body.contains("{\"name\":\"x\"}"));
        assert!(body.contains("body-js"));
    }

    #[test]
    fn multipart_length_matches_the_flattened_body() {
        let boundary = "b-test";
        let data = vec![7u8; 10];
        let multipart = build_multipart(
            boundary,
            &[("visibility", "public")],
            &[FilePart {
                file_name: "a.txt",
                mime: "text/plain",
                range: 2..9,
            }],
        );
        let flat = flatten(&multipart, &data);
        assert_eq!(multipart.len(), flat.len() as u64);
        assert_eq!(
            multipart.content_type,
            "multipart/form-data; boundary=b-test"
        );
        assert!(flat.ends_with(b"--b-test--\r\n"));
    }

    #[test]
    fn boundaries_differ_between_calls() {
        let a = new_boundary();
        let b = new_boundary();
        assert_ne!(a, b);
        assert!(a.starts_with("disnans-") && a.len() == 8 + 32);
    }

    #[test]
    fn file_names_are_quoted_safely() {
        assert_eq!(quote_file_name("a\"b\r\nc"), "a%22b%0D%0Ac");
        assert_eq!(quote_file_name("日本.png"), "日本.png");
    }
    type Updates = Arc<Mutex<Vec<(u64, u64)>>>;

    fn progress_recorder() -> (Arc<dyn Fn(u64, u64) + Send + Sync>, Updates) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = seen.clone();
        let callback: Arc<dyn Fn(u64, u64) + Send + Sync> =
            Arc::new(move |loaded, total| recorder.lock().unwrap().push((loaded, total)));
        (callback, seen)
    }

    #[test]
    fn upload_pieces_keep_bytes_and_cap_the_chunk_size() {
        let data = vec![1u8; UPLOAD_CHUNK * 2 + 5];
        let multipart = build_multipart(
            "b",
            &[],
            &[FilePart {
                file_name: "a.bin",
                mime: "application/octet-stream",
                range: 0..data.len(),
            }],
        );
        let pieces = upload_pieces(&multipart);
        let mut rebuilt = Vec::new();
        for piece in &pieces {
            match piece {
                Segment::Bytes(bytes) => rebuilt.extend_from_slice(bytes),
                Segment::Data(range) => {
                    assert!(range.end - range.start <= UPLOAD_CHUNK);
                    rebuilt.extend_from_slice(&data[range.clone()]);
                }
            }
        }
        assert_eq!(rebuilt, flatten(&multipart, &data));
        assert!(pieces.len() >= 4);
    }

    #[tokio::test]
    async fn upload_streams_the_whole_file_with_monotonic_progress() {
        let (client, seen) = scripted(vec![Action::Reply {
            status: "200 OK",
            body: r#"{"id":"f1","file_name":"big.bin"}"#,
            keep_alive: false,
        }])
        .await;
        let data: Vec<u8> = (0..(UPLOAD_CHUNK * 3 + 17))
            .map(|i| (i % 251) as u8)
            .collect();
        let (progress, updates) = progress_recorder();
        let (_handle, registration) = AbortHandle::new_pair();
        let value = client
            .upload_file(
                Arc::new(data.clone()),
                "big.bin",
                "application/octet-stream",
                progress,
                registration,
            )
            .await
            .unwrap();
        assert_eq!(value["id"], "f1");

        let updates = updates.lock().unwrap();
        assert!(updates.len() >= 4);
        assert!(updates.windows(2).all(|w| w[0].0 <= w[1].0));
        let (last_loaded, total) = *updates.last().unwrap();
        assert_eq!(last_loaded, total);
        assert!(
            updates
                .iter()
                .all(|(loaded, t)| *loaded <= *t && *t == total)
        );

        let seen = seen.lock().unwrap();
        assert_eq!(seen.requests, vec!["POST /api/files HTTP/1.1"]);
        assert_eq!(seen.bodies[0].len() as u64, total);
        assert!(
            seen.bodies[0]
                .windows(data.len())
                .any(|w| w == data.as_slice())
        );
    }

    #[tokio::test]
    async fn aborting_an_upload_ends_it_as_aborted() {
        let (client, _seen) = scripted(vec![Action::Hang]).await;
        let (progress, _updates) = progress_recorder();
        let (handle, registration) = AbortHandle::new_pair();
        let task = tokio::spawn(async move {
            client
                .upload_file(
                    Arc::new(vec![3u8; 100]),
                    "a.bin",
                    "application/octet-stream",
                    progress,
                    registration,
                )
                .await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        handle.abort();
        let failure = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .expect("abort should end the upload promptly")
            .unwrap()
            .unwrap_err();
        assert_eq!(failure.code, "aborted");
        assert_eq!(failure.status, None);
    }

    #[tokio::test]
    async fn upload_cut_after_send_is_unknown_outcome_and_sent_once() {
        let (client, seen) = scripted(vec![Action::CutAfterRead]).await;
        let (progress, _updates) = progress_recorder();
        let (_handle, registration) = AbortHandle::new_pair();
        let failure = client
            .upload_file(
                Arc::new(vec![9u8; 2048]),
                "a.bin",
                "application/octet-stream",
                progress,
                registration,
            )
            .await
            .unwrap_err();
        assert_eq!(failure.code, "unknown_outcome");
        assert_eq!(failure.status, None);
        tokio::time::sleep(Duration::from_millis(200)).await;
        let seen = seen.lock().unwrap();
        assert_eq!(seen.connections, 1);
        assert_eq!(seen.requests, vec!["POST /api/files HTTP/1.1"]);
    }
}
