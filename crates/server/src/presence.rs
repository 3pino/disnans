//! セッションを開いている人の一覧（プレゼンス）。メモリだけで持ち、保存しない。
//!
//! 送り先は、そのセッションを開いている接続だけ（一覧を見ている人にだけ変化を知らせれば足りる）。
//! 同じユーザーの複数の端末は1人として数える。送る前に表（ロック）を持ったままにして、
//! 送る順番と中身の順番を一致させる（送信はキューに入れるだけで、ブロックしない）。

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Mutex;

use disnans_shared::ServerEvent;

use crate::hub::{ConnId, Hub};

#[derive(Default)]
pub struct Presence {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// セッション → 開いている接続（接続 → ユーザー）。
    by_session: HashMap<String, HashMap<ConnId, String>>,
    /// 接続 → 開いているセッション（切断のときに外すため）。
    by_conn: HashMap<ConnId, HashSet<String>>,
}

impl Presence {
    /// 接続がセッションを開いた。開いている人の一覧を、開いている接続全員（この接続を含む）に送る。
    pub fn open(&self, hub: &Hub, conn: ConnId, user_id: &str, session_id: &str) {
        let mut inner = self.lock();
        inner
            .by_session
            .entry(session_id.to_owned())
            .or_default()
            .insert(conn, user_id.to_owned());
        inner
            .by_conn
            .entry(conn)
            .or_default()
            .insert(session_id.to_owned());
        inner.announce(hub, session_id);
    }

    /// 接続がセッションを閉じた。閉じた接続には送らず、残りの人に一覧を送る。
    pub fn close(&self, hub: &Hub, conn: ConnId, session_id: &str) {
        let mut inner = self.lock();
        if inner.remove(conn, session_id) {
            inner.announce(hub, session_id);
        }
    }

    /// 接続が切れた。開いていたセッションをすべて閉じ、残りの人に一覧を送る。
    pub fn disconnect(&self, hub: &Hub, conn: ConnId) {
        let mut inner = self.lock();
        let Some(sessions) = inner.by_conn.remove(&conn) else {
            return;
        };
        for session_id in sessions {
            inner.remove_from_session(conn, &session_id);
            inner.announce(hub, &session_id);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // 中身は単純な表なので、毒が入っても読み直せる
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Inner {
    /// 接続の記録を外す。外したら true。
    fn remove(&mut self, conn: ConnId, session_id: &str) -> bool {
        let empty = match self.by_conn.get_mut(&conn) {
            Some(sessions) => {
                sessions.remove(session_id);
                sessions.is_empty()
            }
            None => false,
        };
        if empty {
            self.by_conn.remove(&conn);
        }
        self.remove_from_session(conn, session_id)
    }

    fn remove_from_session(&mut self, conn: ConnId, session_id: &str) -> bool {
        let Some(conns) = self.by_session.get_mut(session_id) else {
            return false;
        };
        let removed = conns.remove(&conn).is_some();
        if conns.is_empty() {
            self.by_session.remove(session_id);
        }
        removed
    }

    /// いま開いている人（ユーザー ID の重複なし・並び順は固定）と、送り先の接続。
    fn snapshot(&self, session_id: &str) -> (Vec<ConnId>, Vec<String>) {
        let Some(conns) = self.by_session.get(session_id) else {
            return (Vec::new(), Vec::new());
        };
        let users: BTreeSet<String> = conns.values().cloned().collect();
        (conns.keys().copied().collect(), users.into_iter().collect())
    }

    fn announce(&self, hub: &Hub, session_id: &str) {
        let (conns, user_ids) = self.snapshot(session_id);
        if conns.is_empty() {
            return;
        }
        let event = ServerEvent::SessionPresence {
            session_id: session_id.to_owned(),
            user_ids,
        };
        hub.send_to_conns(&conns, &event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_user_on_two_devices_counts_once() {
        let mut inner = Inner::default();
        inner
            .by_session
            .entry("S".into())
            .or_default()
            .insert(1, "alice".into());
        inner
            .by_session
            .get_mut("S")
            .unwrap()
            .insert(2, "alice".into());
        inner
            .by_session
            .get_mut("S")
            .unwrap()
            .insert(3, "bob".into());
        let (conns, users) = inner.snapshot("S");
        assert_eq!(conns.len(), 3);
        assert_eq!(users, ["alice", "bob"]);
    }

    #[test]
    fn closing_one_device_keeps_the_user_while_another_is_open() {
        let mut inner = Inner::default();
        inner.by_conn.insert(1, HashSet::from(["S".to_owned()]));
        inner.by_conn.insert(2, HashSet::from(["S".to_owned()]));
        inner.by_session.insert(
            "S".into(),
            HashMap::from([(1, "alice".to_owned()), (2, "alice".to_owned())]),
        );

        assert!(inner.remove(1, "S"));
        assert_eq!(inner.snapshot("S").1, ["alice"]);
        // 2 度目は何もしない
        assert!(!inner.remove(1, "S"));
        assert!(inner.remove(2, "S"));
        assert_eq!(inner.snapshot("S"), (Vec::new(), Vec::new()));
        assert!(inner.by_session.is_empty() && inner.by_conn.is_empty());
    }
}
