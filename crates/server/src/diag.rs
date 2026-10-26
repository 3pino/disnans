//! 障害の切り分けのための記録。
//!
//! - HTTP: 5xx・遅いリクエスト（5 秒超え）・クライアントが応答を待たずに切ったものだけを記録する。
//!   トークン・Authorization・クエリ文字列は出さない（パスだけ）。
//! - WebSocket: 切断の理由（クライアントの閉じる合図・応答なし・送信エラー・サーバー都合）と継続時間、接続元の種別。
//! - 接続元の IP アドレスそのものは記録しない（種別だけ）。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::Request;
use axum::http::{StatusCode, Uri};
use axum::middleware::Next;
use axum::response::Response;

/// これを超えたリクエストは遅延として記録する。
pub const SLOW_REQUEST: Duration = Duration::from_secs(5);

/// 記録するリクエストの種類（記録しないものは `None`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpNote {
    ServerError,
    Slow,
}

/// 応答の状態と所要時間から、記録するかを決める。5xx を優先する。
pub fn http_note(status: StatusCode, elapsed: Duration) -> Option<HttpNote> {
    if status.is_server_error() {
        Some(HttpNote::ServerError)
    } else if elapsed > SLOW_REQUEST {
        Some(HttpNote::Slow)
    } else {
        None
    }
}

/// ログに出すパス。クエリ（`?` 以降）と `#` 以降は含めない。
pub fn log_path(uri: &Uri) -> String {
    let path = uri.path();
    let cut = path.find(['?', '#']).unwrap_or(path.len());
    path[..cut].to_owned()
}

/// 接続元の種類。IP アドレスそのものは出さず、この種類だけを出す。
/// Tailscale Serve 経由（接続元はループバック）は「ローカル」になる。
pub fn addr_kind(ip: IpAddr) -> &'static str {
    match ip {
        IpAddr::V4(v4) => v4_kind(v4),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4_kind(v4),
            None if v6.is_loopback() => "ローカル",
            None if is_tailscale_v6(v6) => "tailscale",
            None => "その他",
        },
    }
}

fn v4_kind(ip: Ipv4Addr) -> &'static str {
    if ip.is_loopback() {
        "ローカル"
    } else if is_tailscale_v4(ip) {
        "tailscale"
    } else {
        "その他"
    }
}

/// Tailscale の IPv4 は 100.64.0.0/10。
fn is_tailscale_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0xc0) == 64
}

/// Tailscale の IPv6 は fd7a:115c:a1e0::/48。
fn is_tailscale_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0
}

/// WebSocket の切断の理由。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsEnd {
    /// クライアントが閉じる合図（close フレーム）を送ってきた。
    ClientClose { code: Option<u16>, reason: String },
    /// 閉じる合図なしに接続が途切れた（アプリが落ちた・回線が切れた）。
    ClientGone,
    /// 受信のエラー（接続が壊れた）。
    ReadError(String),
    /// 応答がないので切った（最後に受け取ってからの時間）。
    IdleTimeout { idle: Duration },
    /// 送信のエラー（書き込みに失敗した）。
    WriteError(String),
    /// サーバー都合（送信が詰まったので外した、または終了・再起動の処理）。
    ServerSide,
}

impl WsEnd {
    /// 通常の切断（クライアントの正常な終了）なら情報のレベル、それ以外は警告。
    pub fn is_warning(&self) -> bool {
        match self {
            WsEnd::ClientClose { code, .. } => !matches!(code, None | Some(1000 | 1001)),
            WsEnd::ClientGone => false,
            WsEnd::ReadError(_)
            | WsEnd::IdleTimeout { .. }
            | WsEnd::WriteError(_)
            | WsEnd::ServerSide => true,
        }
    }

    /// ログに出す説明（日本語）。
    pub fn describe(&self) -> String {
        match self {
            WsEnd::ClientClose { code, reason } => {
                let code = code.map_or_else(|| "なし".to_owned(), |c| c.to_string());
                let reason = clean_reason(reason);
                if reason.is_empty() {
                    format!("クライアントから閉じられました（コード {code}）")
                } else {
                    format!("クライアントから閉じられました（コード {code}、理由 {reason}）")
                }
            }
            WsEnd::ClientGone => "クライアントの接続が閉じる合図なしに途切れました".to_owned(),
            WsEnd::ReadError(e) => format!("受信エラーで切断しました: {e}"),
            WsEnd::IdleTimeout { idle } => {
                format!(
                    "応答がないので切断しました（最後に受け取ってから {} 秒）",
                    idle.as_secs()
                )
            }
            WsEnd::WriteError(e) => format!("送信エラーで切断しました: {e}"),
            WsEnd::ServerSide => {
                "サーバー都合で切断しました（送信が詰まった、または終了・再起動）".to_owned()
            }
        }
    }
}

/// クライアントが送った理由の文字列を、ログに出せる形にする（制御文字を除き、長さを抑える）。
fn clean_reason(raw: &str) -> String {
    const MAX_CHARS: usize = 60;
    raw.chars()
        .filter(|c| !c.is_control())
        .take(MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// リクエストのユーザー（ログ用）。認証のミドルウェアが決めたら入れる。
#[derive(Debug, Clone, Default)]
pub struct UserSlot(Arc<Mutex<Option<String>>>);

impl UserSlot {
    pub fn set(&self, login_name: &str) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(login_name.to_owned());
    }

    pub fn get(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .unwrap_or_else(|| "-".to_owned())
    }
}

/// 応答を送る前に（クライアントが先に切って）処理が止まったことを記録するための印。
/// 正常に応答できたら `disarm` する。
struct Unfinished {
    armed: bool,
    method: String,
    path: String,
    start: Instant,
    user: UserSlot,
}

impl Drop for Unfinished {
    fn drop(&mut self) {
        if self.armed {
            tracing::info!(
                method = %self.method,
                path = %self.path,
                ms = self.start.elapsed().as_millis() as u64,
                user = %self.user.get(),
                "クライアントが応答を待たずに切断しました（本文の送信の途中を含む）"
            );
        }
    }
}

/// すべての HTTP リクエストを見て、5xx・遅延・途中切断だけを記録するミドルウェア。
pub async fn observe(mut req: Request, next: Next) -> Response {
    let method = req.method().to_string();
    let path = log_path(req.uri());
    let start = Instant::now();
    let user = UserSlot::default();
    req.extensions_mut().insert(user.clone());
    let mut guard = Unfinished {
        armed: true,
        method: method.clone(),
        path: path.clone(),
        start,
        user: user.clone(),
    };

    let res = next.run(req).await;
    guard.armed = false;

    let elapsed = start.elapsed();
    let status = res.status();
    let ms = elapsed.as_millis() as u64;
    match http_note(status, elapsed) {
        Some(HttpNote::ServerError) => tracing::warn!(
            method = %method,
            path = %path,
            status = status.as_u16(),
            ms,
            user = %user.get(),
            "サーバーエラーを返しました"
        ),
        Some(HttpNote::Slow) => tracing::warn!(
            method = %method,
            path = %path,
            status = status.as_u16(),
            ms,
            user = %user.get(),
            "遅いリクエストです（5 秒を超えました）"
        ),
        None => {}
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_and_fragment_are_removed_from_logged_path() {
        let uri: Uri = "/api/files/abc?token=secret&dev_user=x#frag"
            .parse()
            .unwrap();
        assert_eq!(log_path(&uri), "/api/files/abc");
        let plain: Uri = "/api/messages".parse().unwrap();
        assert_eq!(log_path(&plain), "/api/messages");
        let root: Uri = "/?x=1".parse().unwrap();
        assert_eq!(log_path(&root), "/");
    }

    #[test]
    fn server_errors_and_slow_requests_are_noted_and_others_are_not() {
        let ok = Duration::from_millis(10);
        assert_eq!(
            http_note(StatusCode::INTERNAL_SERVER_ERROR, ok),
            Some(HttpNote::ServerError)
        );
        assert_eq!(
            http_note(StatusCode::BAD_GATEWAY, ok),
            Some(HttpNote::ServerError)
        );
        // 5xx は遅さより優先（遅くても 5xx のまま）
        assert_eq!(
            http_note(StatusCode::SERVICE_UNAVAILABLE, Duration::from_secs(9)),
            Some(HttpNote::ServerError)
        );
        assert_eq!(
            http_note(StatusCode::OK, Duration::from_secs(6)),
            Some(HttpNote::Slow)
        );
        // ちょうど 5 秒は遅延ではない（5 秒を超えたもの）
        assert_eq!(http_note(StatusCode::OK, SLOW_REQUEST), None);
        // 通常運用の 401 / 403 / 404 は記録しない
        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
        ] {
            assert_eq!(http_note(status, ok), None);
        }
    }

    #[test]
    fn address_kind_names_only_the_category() {
        assert_eq!(addr_kind("100.101.102.103".parse().unwrap()), "tailscale");
        assert_eq!(addr_kind("100.64.0.1".parse().unwrap()), "tailscale");
        assert_eq!(addr_kind("100.127.255.254".parse().unwrap()), "tailscale");
        // 100.64.0.0/10 の外は tailscale ではない
        assert_eq!(addr_kind("100.128.0.1".parse().unwrap()), "その他");
        assert_eq!(addr_kind("100.63.255.255".parse().unwrap()), "その他");
        assert_eq!(addr_kind("127.0.0.1".parse().unwrap()), "ローカル");
        assert_eq!(addr_kind("::1".parse().unwrap()), "ローカル");
        assert_eq!(addr_kind("fd7a:115c:a1e0::1".parse().unwrap()), "tailscale");
        assert_eq!(addr_kind("fd7a:115c:a1e1::1".parse().unwrap()), "その他");
        assert_eq!(
            addr_kind("::ffff:100.100.1.1".parse().unwrap()),
            "tailscale"
        );
        assert_eq!(addr_kind("192.168.1.10".parse().unwrap()), "その他");
        assert_eq!(addr_kind("2001:db8::1".parse().unwrap()), "その他");
    }

    #[test]
    fn disconnect_levels_separate_normal_closes_from_problems() {
        assert!(
            !WsEnd::ClientClose {
                code: Some(1000),
                reason: String::new()
            }
            .is_warning()
        );
        assert!(
            !WsEnd::ClientClose {
                code: Some(1001),
                reason: String::new()
            }
            .is_warning()
        );
        assert!(
            !WsEnd::ClientClose {
                code: None,
                reason: String::new()
            }
            .is_warning()
        );
        assert!(
            WsEnd::ClientClose {
                code: Some(1011),
                reason: String::new()
            }
            .is_warning()
        );
        assert!(!WsEnd::ClientGone.is_warning());
        assert!(WsEnd::ReadError("x".into()).is_warning());
        assert!(
            WsEnd::IdleTimeout {
                idle: Duration::from_secs(90)
            }
            .is_warning()
        );
        assert!(WsEnd::WriteError("x".into()).is_warning());
        assert!(WsEnd::ServerSide.is_warning());
    }

    #[test]
    fn disconnect_descriptions_name_the_reason_and_idle_seconds() {
        let idle = WsEnd::IdleTimeout {
            idle: Duration::from_millis(91_500),
        }
        .describe();
        assert!(idle.contains("応答がない"), "{idle}");
        assert!(idle.contains("91 秒"), "{idle}");
        let close = WsEnd::ClientClose {
            code: Some(1001),
            reason: "bye\n\u{7}".into(),
        }
        .describe();
        assert!(close.contains("コード 1001"), "{close}");
        assert!(close.contains("理由 bye"), "{close}");
        assert!(!close.contains('\n'));
        let none = WsEnd::ClientClose {
            code: None,
            reason: String::new(),
        }
        .describe();
        assert!(none.contains("コード なし"), "{none}");
        assert!(WsEnd::ServerSide.describe().contains("サーバー都合"));
    }

    #[test]
    fn long_client_reasons_are_cut() {
        let long = "a".repeat(200);
        let text = WsEnd::ClientClose {
            code: Some(1000),
            reason: long,
        }
        .describe();
        assert!(text.chars().filter(|c| *c == 'a').count() == 60, "{text}");
    }

    #[test]
    fn user_slot_defaults_to_dash_until_set() {
        let slot = UserSlot::default();
        assert_eq!(slot.get(), "-");
        slot.set("alice@example.ts.net");
        assert_eq!(slot.get(), "alice@example.ts.net");
    }
}
