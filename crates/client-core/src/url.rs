use std::fmt;

use unicode_normalization::UnicodeNormalization;
use url::Url;

/// An HTTP(S) base URL normalized with the same rules as the current GUI.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ServerUrl(String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlError(String);

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for UrlError {}

/// GUI-compatible URL normalization: NFKC, trim, add `http://` unless http(s) is present,
/// and strip trailing slashes.
pub fn normalize_server_url(input: &str) -> String {
    let mut value: String = input.nfkc().collect();
    value = value.trim().to_owned();
    if value.is_empty() {
        return value;
    }
    if !value
        .get(..7)
        .is_some_and(|s| s.eq_ignore_ascii_case("http://"))
        && !value
            .get(..8)
            .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
    {
        value.insert_str(0, "http://");
    }
    while value.ends_with('/') {
        value.pop();
    }
    value
}

impl ServerUrl {
    pub fn parse(input: &str) -> Result<Self, UrlError> {
        let unfolded: String = input.nfkc().collect();
        let explicit = unfolded.trim();
        if let Some((scheme, _)) = explicit.split_once("://")
            && !scheme.eq_ignore_ascii_case("http")
            && !scheme.eq_ignore_ascii_case("https")
        {
            return Err(UrlError(
                "サーバーURLはhttpまたはhttpsで指定してください".into(),
            ));
        }
        let normalized = normalize_server_url(input);
        if normalized.is_empty() {
            return Err(UrlError("サーバーURLが空です".into()));
        }
        let parsed =
            Url::parse(&normalized).map_err(|e| UrlError(format!("サーバーURLが不正です: {e}")))?;
        if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
            return Err(UrlError(
                "サーバーURLはhttpまたはhttpsで指定してください".into(),
            ));
        }
        let has_userinfo = normalized
            .split_once("://")
            .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
            .is_some_and(|authority| authority.contains('@'));
        if has_userinfo || !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(UrlError("サーバーURLに認証情報は指定できません".into()));
        }
        if parsed.query().is_some() || parsed.fragment().is_some() {
            return Err(UrlError(
                "サーバーURLにquery/fragmentは指定できません".into(),
            ));
        }
        Ok(Self(normalized))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Append an API path to the configured base URL without changing a user-supplied base path.
    pub fn http_url(&self, path: &str) -> String {
        append_path(&self.0, path)
    }

    /// WebSocket equivalent of `http_url` (`http`→`ws`, `https`→`wss`).
    pub fn ws_url(&self, path: &str) -> String {
        let mut value = self.0.clone();
        if value
            .get(..8)
            .is_some_and(|s| s.eq_ignore_ascii_case("https://"))
        {
            value.replace_range(..8, "wss://");
        } else {
            value.replace_range(..7, "ws://");
        }
        append_path(&value, path)
    }
}

fn append_path(base: &str, path: &str) -> String {
    format!(
        "{}{}",
        base.trim_end_matches('/'),
        if path.starts_with('/') {
            path.to_owned()
        } else {
            format!("/{path}")
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_matches_gui_examples() {
        assert_eq!(
            normalize_server_url(" homeserver:8080/ "),
            "http://homeserver:8080"
        );
        assert_eq!(normalize_server_url("https://a.b"), "https://a.b");
        assert_eq!(
            normalize_server_url("ｈｔｔｐ：／／１００．６４．０．１：８０８０"),
            "http://100.64.0.1:8080"
        );
        assert_eq!(normalize_server_url("  "), "");
    }

    #[test]
    fn builds_http_and_websocket_urls() {
        let server = ServerUrl::parse("https://host:8443/base/").unwrap();
        assert_eq!(server.http_url("/api/me"), "https://host:8443/base/api/me");
        assert_eq!(server.ws_url("/api/ws"), "wss://host:8443/base/api/ws");
        let server = ServerUrl::parse("host:8080").unwrap();
        assert_eq!(server.ws_url("api/ws"), "ws://host:8080/api/ws");
    }

    #[test]
    fn rejects_empty_unsupported_schemes_and_url_credentials_or_suffixes() {
        assert!(ServerUrl::parse("").is_err());
        assert!(ServerUrl::parse("ftp://host").is_err());
        assert!(ServerUrl::parse("https://user:pass@host").is_err());
        assert!(ServerUrl::parse("https://@host").is_err());
        assert!(ServerUrl::parse("https://host?query=1").is_err());
        assert!(ServerUrl::parse("https://host#fragment").is_err());
        assert!(ServerUrl::parse("http://host/base/path").is_ok());
    }
}
