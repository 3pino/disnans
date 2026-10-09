//! tailscaled の LocalAPI（unix ソケット）で、接続元のユーザーを調べる。

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use http_body_util::{BodyExt, Empty};
use hyper::{Request, StatusCode};
use hyper_util::rt::TokioIo;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use tokio::net::UnixStream;

/// whois の結果を覚えておく時間。同じ端末（IP）からのリクエストのたびに問い合わせないようにする。
const CACHE_TTL: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(5);

/// Tailscale のユーザー情報。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub login_name: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WhoIsResponse {
    user_profile: UserProfile,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct UserProfile {
    login_name: String,
    #[serde(default)]
    display_name: String,
    #[serde(default, rename = "ProfilePicURL")]
    profile_pic_url: String,
}

pub struct Tailscale {
    socket: PathBuf,
    cache: Mutex<HashMap<IpAddr, (Instant, Profile)>>,
}

impl Tailscale {
    pub fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// 接続元のユーザーを調べる。Tailscale の外からの接続など、分からなければ `Ok(None)`。
    /// tailscaled に問い合わせられなかったときは `Err`。
    pub async fn whois(&self, addr: SocketAddr) -> Result<Option<Profile>, String> {
        let ip = addr.ip().to_canonical();
        if let Some(profile) = self.cached(ip) {
            return Ok(Some(profile));
        }

        let profile = tokio::time::timeout(TIMEOUT, self.fetch(addr))
            .await
            .map_err(|_| "tailscaled の応答がタイムアウトしました".to_string())??;

        if let Some(profile) = &profile {
            self.lock().insert(ip, (Instant::now(), profile.clone()));
        }
        Ok(profile)
    }

    fn cached(&self, ip: IpAddr) -> Option<Profile> {
        let mut cache = self.lock();
        cache.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
        cache.get(&ip).map(|(_, p)| p.clone())
    }

    async fn fetch(&self, addr: SocketAddr) -> Result<Option<Profile>, String> {
        let stream = UnixStream::connect(&self.socket).await.map_err(|e| {
            format!(
                "tailscaled のソケット（{}）に接続できません: {e}",
                self.socket.display()
            )
        })?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| format!("tailscaled との通信に失敗しました: {e}"))?;
        tokio::spawn(async move {
            if let Err(err) = conn.await {
                tracing::debug!("tailscaled との接続が切れました: {err}");
            }
        });

        let query = utf8_percent_encode(&addr.to_string(), NON_ALPHANUMERIC).to_string();
        let req = Request::get(format!("/localapi/v0/whois?addr={query}"))
            .header(hyper::header::HOST, "local-tailscaled.sock")
            .body(Empty::<Bytes>::new())
            .map_err(|e| e.to_string())?;
        let res = sender
            .send_request(req)
            .await
            .map_err(|e| format!("tailscaled への問い合わせに失敗しました: {e}"))?;

        let status = res.status();
        let body = res
            .into_body()
            .collect()
            .await
            .map_err(|e| format!("tailscaled の応答を読めません: {e}"))?
            .to_bytes();

        match status {
            StatusCode::OK => {}
            // 該当する Tailscale のノードがない
            StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST => return Ok(None),
            _ => {
                return Err(format!(
                    "tailscaled がエラーを返しました（{status}）: {}",
                    String::from_utf8_lossy(&body)
                ));
            }
        }

        let whois: WhoIsResponse = serde_json::from_slice(&body)
            .map_err(|e| format!("tailscaled の応答を解釈できません: {e}"))?;
        Ok(Some(parse_profile(whois.user_profile)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<IpAddr, (Instant, Profile)>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn parse_profile(p: UserProfile) -> Profile {
    let display_name = if p.display_name.trim().is_empty() {
        default_display_name(&p.login_name)
    } else {
        p.display_name
    };
    Profile {
        display_name,
        avatar_url: Some(p.profile_pic_url).filter(|u| !u.is_empty()),
        login_name: p.login_name,
    }
}

/// ログイン名から表示名の初期値を作る（`alice@github` → `alice`）。
pub fn default_display_name(login_name: &str) -> String {
    login_name
        .split('@')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(login_name)
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whois_response() {
        let json = r#"{
            "Node": {"ID": 1, "Name": "phone.tailnet.ts.net."},
            "UserProfile": {"ID": 2, "LoginName": "alice@github", "DisplayName": "Alice", "ProfilePicURL": "https://example.com/a.png"},
            "CapMap": {}
        }"#;
        let whois: WhoIsResponse = serde_json::from_str(json).unwrap();
        assert_eq!(
            parse_profile(whois.user_profile),
            Profile {
                login_name: "alice@github".into(),
                display_name: "Alice".into(),
                avatar_url: Some("https://example.com/a.png".into()),
            }
        );
    }

    #[test]
    fn falls_back_to_login_name() {
        let json = r#"{"UserProfile": {"LoginName": "bob@example.com", "DisplayName": "", "ProfilePicURL": ""}}"#;
        let whois: WhoIsResponse = serde_json::from_str(json).unwrap();
        let profile = parse_profile(whois.user_profile);
        assert_eq!(profile.display_name, "bob");
        assert_eq!(profile.avatar_url, None);
    }
}
