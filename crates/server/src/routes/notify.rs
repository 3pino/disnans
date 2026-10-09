//! `/api/notify/sample`。

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::StatusCode;

use crate::auth::CurrentUser;
use crate::notify::Notification;
use crate::state::SharedState;

/// 自分にサンプルの通知を送る（通知が届くかの確認用）。
///
/// 送るのは、ボタンを押した端末（リクエストと同じ IP アドレスからの接続）だけ。
/// Android では WebView と通知用の常駐サービスの両方が、同じ端末からつないでいる。
pub async fn sample(
    State(state): State<SharedState>,
    CurrentUser(user): CurrentUser,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> StatusCode {
    state
        .notifier
        .notify_device(&user.id, addr.ip(), &Notification::sample());
    StatusCode::NO_CONTENT
}
