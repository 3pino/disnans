//! WebDAV（共有フォルダを、ネットワークドライブとしてエクスプローラー等からつなぐ）。
//!
//! 第 1 段は読み取り専用。`/dav/` の直下に `attachments/`（投稿された添付）だけがあり、書き込みは拒否する。
//! 設計は `docs/PLAN_FILES.md`。プロトコルの処理は dav-server クレートに任せる。

pub mod fs;
pub mod identity;
pub mod tree;

use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::middleware::from_fn_with_state;
use axum::response::Response;
use axum::routing::any;
use dav_server::{DavHandler, DavMethodSet, memls::MemLs};

use crate::auth::{self, CurrentUser};
use crate::state::SharedState;

/// dav-server に許可するメソッド。書き込み系（PUT・DELETE・MKCOL・MOVE・COPY・PROPPATCH）は入れない（405）。
const METHODS: &[&str] = &["OPTIONS", "PROPFIND", "GET", "HEAD", "LOCK", "UNLOCK"];
/// URL の先頭（`/dav`）。dav-server に渡す前に取り除く。
const PREFIX: &str = "/dav";

/// dav-server のハンドラーを作る（読み取り専用の共有フォルダ）。
pub fn handler(state: &SharedState) -> DavHandler {
    let fs = fs::SharedFs {
        config: state.config.clone(),
        pool: state.pool.clone(),
    };
    DavHandler::builder()
        .filesystem(Box::new(fs))
        .locksystem(MemLs::new())
        .strip_prefix(PREFIX)
        .principal("disnans")
        .methods(DavMethodSet::from_vec(METHODS.to_vec()).expect("メソッドの名前"))
        .build_handler()
}

/// `/dav` 以下のルーター。ほかの `/api` と同じく、利用者を特定してから通す。
pub fn router(state: SharedState) -> Router<SharedState> {
    let dav = Arc::new(handler(&state));
    let serve = move |_user: CurrentUser, req: Request| {
        let dav = dav.clone();
        async move {
            let res: Response<dav_server::body::Body> = dav.handle(req).await;
            res.map(axum::body::Body::new)
        }
    };
    Router::new()
        .route("/dav", any(serve.clone()))
        .route("/dav/", any(serve.clone()))
        .route("/dav/{*rest}", any(serve))
        .layer(from_fn_with_state(state, auth::middleware))
}
