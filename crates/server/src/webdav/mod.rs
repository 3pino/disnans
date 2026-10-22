//! WebDAV（共有フォルダを、ネットワークドライブとしてエクスプローラー等からつなぐ）。
//!
//! `/dav/` の直下に `attachments/`（投稿された添付。読み取り専用）と、共有フォルダ（`data/shared/`）がある。
//! 設計は `docs/PLAN_FILES.md`。プロトコルの処理は dav-server クレートに任せる。

pub mod fs;
pub mod identity;
pub mod names;
pub mod tree;

use axum::Router;
use axum::extract::Request;
use axum::middleware::from_fn_with_state;
use axum::response::Response;
use axum::routing::any;
use dav_server::{DavHandler, DavMethodSet, memls::MemLs};

use crate::auth::{self, CurrentUser};
use crate::state::SharedState;

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

/// `/dav` 以下のルーター。ほかの `/api` と同じく、利用者を特定してから通す。
pub fn router(state: SharedState) -> Router<SharedState> {
    // ロックの表は全員で共有する（MemLs は複製しても中身は同じ表を指す）
    let locks = *MemLs::new();
    let state_for_auth = state.clone();
    let serve = move |CurrentUser(user): CurrentUser, req: Request| {
        let dav = handler(&state, &user.id, locks.clone());
        async move {
            // フォルダの DELETE は、dav-server が中身を先に一つずつ消す。共有フォルダの直下と
            // `attachments/` は、中身ごと消させない（403）
            if deletes_a_reserved_folder(&req) {
                return axum::response::IntoResponse::into_response((
                    axum::http::StatusCode::FORBIDDEN,
                    "この場所は消せません",
                ));
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
