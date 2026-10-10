//! WebSocket の接続の一覧と、イベントの配信。
//!
//! 1人のユーザーが複数の接続（スマホと PC など）を持つことがある。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::Utf8Bytes;
use disnans_shared::ServerEvent;
use tokio::sync::mpsc;

/// 接続ごとの ID（プロセス内で一意）。
pub type ConnId = u64;

/// 1接続あたりの送信待ちの上限。これを超えるほど詰まった接続は切断する
/// （クライアントは再接続して履歴を取り直す）。
const QUEUE_SIZE: usize = 1024;

struct Conn {
    user_id: String,
    /// 接続元の IP アドレス。Tailscale では端末ごとに決まるので、端末の識別に使う。
    ip: IpAddr,
    tx: mpsc::Sender<Utf8Bytes>,
}

#[derive(Default)]
pub struct Hub {
    next_id: AtomicU64,
    conns: Mutex<HashMap<ConnId, Conn>>,
}

impl Hub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 接続を登録する。`first` は、ほかのどのイベントよりも先に届けたいイベント（`hello`）。
    pub fn register(
        &self,
        user_id: &str,
        ip: IpAddr,
        first: &ServerEvent,
    ) -> (ConnId, mpsc::Receiver<Utf8Bytes>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(QUEUE_SIZE);
        // 空のキューなので必ず入る
        let _ = tx.try_send(encode(first));
        self.lock().insert(
            id,
            Conn {
                user_id: user_id.to_owned(),
                ip,
                tx,
            },
        );
        (id, rx)
    }

    pub fn unregister(&self, id: ConnId) {
        self.lock().remove(&id);
    }

    /// 全員に配信する。
    pub fn broadcast(&self, event: &ServerEvent) {
        self.deliver(event, |_, _| true);
    }

    /// 指定した接続以外の全員に配信する。
    pub fn broadcast_except(&self, event: &ServerEvent, except: ConnId) {
        self.deliver(event, |id, _| id != except);
    }

    /// 指定したユーザー以外の全員（そのユーザーのすべての接続を除く）に配信する。
    pub fn broadcast_except_user(&self, event: &ServerEvent, except: &str) {
        self.deliver(event, |_, c| c.user_id != except);
    }

    pub fn send_to_conn(&self, conn: ConnId, event: &ServerEvent) {
        self.deliver(event, |id, _| id == conn);
    }

    /// 指定した接続だけに送る。
    pub fn send_to_conns(&self, conns: &[ConnId], event: &ServerEvent) {
        self.deliver(event, |id, _| conns.contains(&id));
    }

    /// そのユーザーのすべての接続に送る。
    pub fn send_to_user(&self, user_id: &str, event: &ServerEvent) {
        self.deliver(event, |_, c| c.user_id == user_id);
    }

    /// そのユーザーの、指定した端末（IP アドレス）からの接続だけに送る。
    pub fn send_to_device(&self, user_id: &str, ip: IpAddr, event: &ServerEvent) {
        self.deliver(event, |_, c| c.user_id == user_id && c.ip == ip);
    }

    /// 指定した接続に送るが、送信待ちが半分以上たまっている接続には送らずに捨てる（切断しない）。
    /// 通話の音声のように、遅れて届くより捨てたほうがよいもの用。
    pub fn send_lossy_to_conns(&self, conns: &[ConnId], event: &ServerEvent) {
        self.deliver_with(event, |id, _| conns.contains(&id), true);
    }

    fn deliver(&self, event: &ServerEvent, filter: impl Fn(ConnId, &Conn) -> bool) {
        self.deliver_with(event, filter, false);
    }

    fn deliver_with(
        &self,
        event: &ServerEvent,
        filter: impl Fn(ConnId, &Conn) -> bool,
        lossy: bool,
    ) {
        let text = encode(event);
        let mut conns = self.lock();
        let mut dead = Vec::new();
        for (&id, conn) in conns.iter().filter(|(id, c)| filter(**id, c)) {
            if lossy && conn.tx.capacity() < QUEUE_SIZE / 2 {
                continue;
            }
            if let Err(err) = conn.tx.try_send(text.clone()) {
                if matches!(err, mpsc::error::TrySendError::Full(_)) {
                    tracing::warn!(conn = id, user = %conn.user_id, "送信が詰まったので切断します");
                }
                dead.push(id);
            }
        }
        // 送信側を落とすと、その接続の書き込みタスクが終わってソケットが閉じる
        for id in dead {
            conns.remove(&id);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ConnId, Conn>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn encode(event: &ServerEvent) -> Utf8Bytes {
    // ServerEvent は必ず JSON にできる
    serde_json::to_string(event).unwrap_or_default().into()
}
