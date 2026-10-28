//! WebDAV（共有フォルダを、ネットワークドライブとしてエクスプローラー等からつなぐ）。
//!
//! `/dav/` の直下に `attachments/`（添付の仮想フォルダ。中のファイルは変更可能）と、共有フォルダ（`data/shared/`）がある。
//! 設計は `docs/api/shared-folder.md`。プロトコルの処理は dav-server クレートに任せる。

pub mod fs;
pub mod identity;
pub mod names;
pub mod tree;
pub mod usage;

use axum::Router;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::from_fn_with_state;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use dav_server::{DavHandler, DavMethodSet, memls::MemLs};

use crate::auth::{self, CurrentUser};
use crate::state::SharedState;
use crate::trash;

/// dav-server に許可するメソッド。PROPPATCH は入れない（405）。書き込みは fs.rs の決まりで守る。
const METHODS: &[&str] = &[
    "OPTIONS", "PROPFIND", "GET", "HEAD", "PUT", "MKCOL", "DELETE", "MOVE", "COPY", "LOCK",
    "UNLOCK",
];
/// URL の先頭（`/dav`）。dav-server に渡す前に取り除く。
const PREFIX: &str = "/dav";

/// dav-server のハンドラーを作る。利用者（`user_id`）ごとに作る。ロックの表は `locks` で共有する。
fn handler(state: &SharedState, user_id: &str, locks: MemLs) -> DavHandler {
    let fs = fs::SharedFs::new(state, user_id);
    DavHandler::builder()
        .filesystem(Box::new(fs))
        .locksystem(Box::new(locks))
        .strip_prefix(PREFIX)
        .principal("disnans")
        .methods(DavMethodSet::from_vec(METHODS.to_vec()).expect("メソッドの名前"))
        .build_handler()
}

/// DELETE で、共有フォルダの直下そのもの（`/dav`）か、`attachments` フォルダを指しているか。
/// パスは一つずつ取り出して比べる（`..` があれば、安全のため同じく拒否する）。
fn deletes_a_reserved_folder(req: &Request) -> bool {
    if req.method() != axum::http::Method::DELETE {
        return false;
    }
    let raw = req.uri().path();
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8_lossy();
    let segs: Vec<&str> = decoded.split('/').filter(|s| !s.is_empty()).collect();
    if segs.contains(&"..") {
        return true;
    }
    match segs.as_slice() {
        ["dav"] => true,
        ["dav", name] => *name == tree::ATTACHMENTS_DIR,
        _ => false,
    }
}

fn forbidden_response() -> Response {
    (StatusCode::FORBIDDEN, "この場所は変えられません").into_response()
}

/// dav-server の失敗を、HTTP の状態にする（ゴミ箱の直接の処理で使う）。
fn fs_status(e: dav_server::fs::FsError) -> StatusCode {
    use dav_server::fs::FsError;
    match e {
        FsError::NotFound => StatusCode::NOT_FOUND,
        FsError::Forbidden => StatusCode::FORBIDDEN,
        FsError::Exists => StatusCode::CONFLICT,
        FsError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        FsError::InsufficientStorage => StatusCode::INSUFFICIENT_STORAGE,
        FsError::NotImplemented => StatusCode::NOT_IMPLEMENTED,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// パスを、正規の区切りの列にする（パーセントを戻し、`.` を捨て、`..` は一つ前に戻す）。
/// dav-server が実際に使うパスと同じになるように、デコードは一度だけ行う。
fn canonical_segments(raw: &str) -> Vec<String> {
    let decoded = percent_encoding::percent_decode_str(raw).decode_utf8_lossy();
    let mut out: Vec<String> = Vec::new();
    for part in decoded.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other.to_owned()),
        }
    }
    out
}

/// `Destination` ヘッダー（絶対の URL か、パス）の、パスの部分。
fn destination_path(value: &str) -> &str {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"));
    match rest {
        // 絶対の URL: 最初の `/` より後ろがパス（無ければルート）
        Some(after) => after.find('/').map_or("/", |i| &after[i..]),
        None => value,
    }
}

/// マウントの接頭辞（`/dav`）の後ろの区切り。`/dav` の外のものは None。
fn mount_relative(segs: &[String]) -> Option<&[String]> {
    match segs.split_first() {
        Some((first, rest)) if first == "dav" => Some(rest),
        _ => None,
    }
}

/// 有効な仮想のゴミ箱の中のパスか（実際の `.trash` は普通の項目なので対象外）。
async fn in_active_trash(state: &SharedState, rel: &[String]) -> bool {
    rel.first()
        .is_some_and(|f| f.eq_ignore_ascii_case(trash::NAMESPACE))
        && trash::namespace_active(state).await
}

/// ゴミ箱（仮想の `.trash`）に関わる要求の決まり。
enum TrashRequest {
    /// 普通に処理する
    Normal,
    /// ゴミ箱の項目を完全に消す（直下の一つだけ）。中身を一つずつ消させない
    Purge(String),
    /// ゴミ箱の中の変更（直下そのもの・中身の削除）は拒否
    Forbidden,
}

/// DELETE の決まり（ゴミ箱の中のものだけ）。`rel` は `/dav` の後ろ。
async fn trash_delete(state: &SharedState, rel: &[String]) -> TrashRequest {
    if !in_active_trash(state, rel).await {
        return TrashRequest::Normal;
    }
    match rel {
        [_, alias] => TrashRequest::Purge(alias.clone()),
        _ => TrashRequest::Forbidden,
    }
}

/// `/dav` 以下のルーター。ほかの `/api` と同じく、利用者を特定してから通す。
pub fn router(state: SharedState) -> Router<SharedState> {
    // ロックの表は全員で共有する（MemLs は複製しても中身は同じ表を指す）
    let locks = *MemLs::new();
    let state_for_auth = state.clone();
    let serve = move |CurrentUser(user): CurrentUser, mut req: Request| {
        let dav = handler(&state, &user.id, locks.clone());
        let state = state.clone();
        async move {
            // フォルダの DELETE は、dav-server が中身を先に一つずつ消す。共有フォルダの直下と
            // `attachments/` は、中身ごと消させない（403）
            if deletes_a_reserved_folder(&req) {
                return forbidden_response();
            }
            let segs = canonical_segments(req.uri().path());
            if let Some(rel) = mount_relative(&segs) {
                match req.method().as_str() {
                    "DELETE" => match trash_delete(&state, rel).await {
                        TrashRequest::Forbidden => return forbidden_response(),
                        TrashRequest::Purge(alias) => {
                            // ゴミ箱の項目を完全に消す（dav-server の再帰は通さない）
                            let fs = fs::SharedFs::new(&state, &user.id);
                            let path = [trash::NAMESPACE.to_owned(), alias];
                            return match fs.remove(&path, true).await {
                                Ok(()) => axum::http::StatusCode::NO_CONTENT.into_response(),
                                Err(e) => fs_status(e).into_response(),
                            };
                        }
                        TrashRequest::Normal => {}
                    },
                    "MOVE" | "COPY" => {
                        // dav-server は Overwrite: T のとき、宛先を先に消してから動かす（中身ごと）。
                        // ゴミ箱の中が元でも先でも、その先消しを許さない: Overwrite を F にして、
                        // 同名があれば 412 で止める（宛先の中身は消えない）。実際の `.trash` は普通の項目
                        let dest = req
                            .headers()
                            .get("destination")
                            .and_then(|v| v.to_str().ok())
                            .map(|v| canonical_segments(destination_path(v)))
                            .unwrap_or_default();
                        let mut touches = false;
                        if let Some(r) = mount_relative(&segs) {
                            touches = in_active_trash(&state, r).await;
                        }
                        if !touches && let Some(r) = mount_relative(&dest) {
                            touches = in_active_trash(&state, r).await;
                        }
                        if touches {
                            req.headers_mut()
                                .insert("overwrite", axum::http::HeaderValue::from_static("F"));
                        }
                    }
                    _ => {}
                }
            }
            let res: Response<dav_server::body::Body> = dav.handle(req).await;
            res.map(axum::body::Body::new)
        }
    };
    Router::new()
        .route("/dav", any(serve.clone()))
        .route("/dav/", any(serve.clone()))
        .route("/dav/{*rest}", any(serve))
        .layer(from_fn_with_state(state_for_auth, auth::middleware))
}
