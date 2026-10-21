//! WebDAV の利用者の特定。
//!
//! Tailscale Serve は TLS を終端して loopback の disnans へ中継する。その場合、接続元は
//! いつもループバック（127.0.0.1 / ::1）になり、whois で人を決められない。そこで Serve が付ける
//! `Tailscale-User-*` ヘッダーを使う。ただし信じるのは「接続元がループバックのとき」だけ。
//! 外（Tailscale の IP など）から来たヘッダーは、クライアントが勝手に付けられるので無視する。

use std::net::IpAddr;

use axum::http::HeaderMap;

use crate::tailscale::{Profile, default_display_name};

/// Serve が付けるログイン名（例 `alice@example.com`）。
pub const LOGIN_HEADER: &str = "tailscale-user-login";
/// Serve が付ける表示名。
pub const NAME_HEADER: &str = "tailscale-user-name";
/// Serve が付けるプロフィール画像の URL。
pub const PIC_HEADER: &str = "tailscale-user-profile-pic";

const MAX_LOGIN_BYTES: usize = 256;

/// 接続元がループバックで、Serve のヘッダーがあれば、その利用者を返す。
/// それ以外（外からのヘッダー、ヘッダーなし、不正な値）は None（呼び出し側は whois で決める）。
pub fn serve_profile(peer: IpAddr, headers: &HeaderMap) -> Option<Profile> {
    if !peer.is_loopback() {
        return None;
    }
    let login = header_text(headers, LOGIN_HEADER)?;
    if login.is_empty()
        || login.len() > MAX_LOGIN_BYTES
        || login.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let display_name = header_text(headers, NAME_HEADER)
        .filter(|n| !n.is_empty() && n.len() <= MAX_LOGIN_BYTES && !n.chars().any(char::is_control))
        .unwrap_or_else(|| default_display_name(&login));
    // 画像は https の URL だけ使う（それ以外の値は捨てる）
    let avatar_url =
        header_text(headers, PIC_HEADER).filter(|u| u.starts_with("https://") && u.len() <= 2048);
    Some(Profile {
        login_name: login,
        display_name,
        avatar_url,
    })
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(name)?.to_str().ok()?;
    decode_header_value(raw).map(|s| s.trim().to_owned())
}

/// Serve のヘッダーの値を読む。Serve は値を RFC 2047 の encoded-word（`=?utf-8?q?...?=`）にする
/// （Go の mime.QEncoding）。ASCII だけの値も符号化されうるので、符号化されていれば decode する。
/// 符号化されていても UTF-8 の Q 符号化でなければ None（Tailscale の仕様: UTF-8 でなければ空）。
pub fn decode_header_value(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if !raw.starts_with("=?") {
        return Some(raw.to_owned());
    }
    // 空白で区切られた encoded-word を、続けて読む
    let mut out = String::new();
    for word in raw.split_ascii_whitespace() {
        out.push_str(&decode_encoded_word(word)?);
    }
    Some(out)
}

/// `=?utf-8?q?text?=` を 1 つ読む。
fn decode_encoded_word(word: &str) -> Option<String> {
    let inner = word.strip_prefix("=?")?.strip_suffix("?=")?;
    let mut parts = inner.splitn(3, '?');
    let charset = parts.next()?;
    let encoding = parts.next()?;
    let text = parts.next()?;
    if !(charset.eq_ignore_ascii_case("utf-8") || charset.eq_ignore_ascii_case("utf8")) {
        return None;
    }
    if !encoding.eq_ignore_ascii_case("q") {
        return None;
    }
    let bytes = q_decode(text)?;
    String::from_utf8(bytes).ok()
}

/// RFC 2047 の Q 符号化。`_` は空白、`=XX` は 16 進の 1 バイト。
fn q_decode(text: &str) -> Option<Vec<u8>> {
    let src = text.as_bytes();
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0;
    while i < src.len() {
        match src[i] {
            b'_' => out.push(b' '),
            b'=' => {
                let hex = src.get(i + 1..i + 3)?;
                let hi = (hex[0] as char).to_digit(16)?;
                let lo = (hex[1] as char).to_digit(16)?;
                out.push((hi * 16 + lo) as u8);
                i += 2;
            }
            b => out.push(b),
        }
        i += 1;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn headers(login: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(l) = login {
            h.insert(LOGIN_HEADER, HeaderValue::from_str(l).unwrap());
        }
        h
    }

    #[test]
    fn loopback_peer_with_serve_headers_is_trusted() {
        let mut h = headers(Some("alice@example.com"));
        h.insert(NAME_HEADER, HeaderValue::from_static("Alice A"));
        h.insert(
            PIC_HEADER,
            HeaderValue::from_static("https://pic.example/a.png"),
        );
        let p = serve_profile(IpAddr::V4(Ipv4Addr::LOCALHOST), &h).unwrap();
        assert_eq!(p.login_name, "alice@example.com");
        assert_eq!(p.display_name, "Alice A");
        assert_eq!(p.avatar_url.as_deref(), Some("https://pic.example/a.png"));
        assert!(serve_profile(IpAddr::V6(Ipv6Addr::LOCALHOST), &h).is_some());
    }

    #[test]
    fn headers_from_other_peers_are_ignored() {
        let h = headers(Some("mallory@example.com"));
        assert!(serve_profile(IpAddr::V4(Ipv4Addr::new(100, 83, 29, 24)), &h).is_none());
        assert!(serve_profile(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5)), &h).is_none());
    }

    #[test]
    fn missing_or_bad_login_is_rejected() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        assert!(serve_profile(lo, &headers(None)).is_none());
        assert!(serve_profile(lo, &headers(Some(""))).is_none());
        assert!(serve_profile(lo, &headers(Some("a b@x"))).is_none());
        let long = "a".repeat(MAX_LOGIN_BYTES + 1);
        assert!(serve_profile(lo, &headers(Some(&long))).is_none());
    }

    #[test]
    fn encoded_values_are_decoded() {
        // 非 ASCII の表示名は必ず符号化される
        assert_eq!(
            decode_header_value("=?utf-8?q?Alice_=E3=82=A2?=").as_deref(),
            Some("Alice ア")
        );
        // ASCII だけの値も符号化されうる
        assert_eq!(
            decode_header_value("=?utf-8?q?alice=40example.com?=").as_deref(),
            Some("alice@example.com")
        );
        assert_eq!(
            decode_header_value("=?UTF-8?Q?bob?=").as_deref(),
            Some("bob")
        );
        // 符号化されていない値はそのまま
        assert_eq!(
            decode_header_value("plain value").as_deref(),
            Some("plain value")
        );
        // 複数の encoded-word は続けて読む
        assert_eq!(
            decode_header_value("=?utf-8?q?a?= =?utf-8?q?=E3=81=82?=").as_deref(),
            Some("aあ")
        );
        // UTF-8 でなければ None（空扱い）
        assert_eq!(decode_header_value("=?iso-8859-1?q?caf=E9?="), None);
        // B 符号化や壊れた値も None
        assert_eq!(decode_header_value("=?utf-8?b?YWJj?="), None);
        assert_eq!(decode_header_value("=?utf-8?q?=ZZ?="), None);
        assert_eq!(decode_header_value("=?utf-8?q?=E3=8?="), None);
    }

    #[test]
    fn serve_headers_with_encoded_values_are_read() {
        let mut h = HeaderMap::new();
        h.insert(
            LOGIN_HEADER,
            HeaderValue::from_static("=?utf-8?q?alice=40example.com?="),
        );
        h.insert(
            NAME_HEADER,
            HeaderValue::from_static("=?utf-8?q?Alice_=E3=82=A2?="),
        );
        let p = serve_profile(IpAddr::V4(Ipv4Addr::LOCALHOST), &h).unwrap();
        assert_eq!(p.login_name, "alice@example.com");
        assert_eq!(p.display_name, "Alice ア");
        let mut bad = HeaderMap::new();
        bad.insert(
            LOGIN_HEADER,
            HeaderValue::from_static("=?iso-8859-1?q?caf=E9?="),
        );
        assert!(serve_profile(IpAddr::V4(Ipv4Addr::LOCALHOST), &bad).is_none());
    }

    #[test]
    fn display_name_defaults_and_non_https_picture_is_dropped() {
        let lo = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let mut h = headers(Some("bob@example.com"));
        h.insert(
            PIC_HEADER,
            HeaderValue::from_static("http://insecure/x.png"),
        );
        let p = serve_profile(lo, &h).unwrap();
        assert_eq!(p.display_name, default_display_name("bob@example.com"));
        assert_eq!(p.avatar_url, None);
    }
}
