//! 通話（みんな共通の1部屋）の参加者の管理と、シグナリング・音声の中継。
//!
//! 参加者は WebSocket の接続ごとに1つ。サーバーが参加者の一覧を持つので、接続が切れれば自動で外れ、
//! 通話から外す（kick）も確実に届く。メディア（音声・映像）自体はサーバーを通らない
//! （WebRTC を使えない環境の音声だけは `call.emit` で中継する）。

use std::collections::HashMap;
use std::sync::Mutex;

use axum::http::StatusCode;
use disnans_shared::{CallMember, CallStatus, ServerEvent};

use crate::chat::Actor;
use crate::error::{AppError, AppResult};
use crate::hub::{ConnId, Hub};

/// `call.emit` の payload の上限。
const MAX_PAYLOAD_BYTES: usize = 64 * 1024;
const MAX_EVENT_NAME_CHARS: usize = 64;
const MAX_PEER_CHARS: usize = 64;
const MAX_DEVICE_CHARS: usize = 32;

struct Member {
    peer: String,
    user_id: String,
    status: CallStatus,
}

#[derive(Default)]
pub struct Calls {
    members: Mutex<HashMap<ConnId, Member>>,
}

impl Calls {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<ConnId, Member>> {
        self.members.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 参加者の一覧（接続の古い順ではなく、peer の順で安定させる）。
    fn snapshot(members: &HashMap<ConnId, Member>) -> ServerEvent {
        let mut list: Vec<CallMember> = members
            .values()
            .map(|m| CallMember {
                peer: m.peer.clone(),
                user_id: m.user_id.clone(),
                status: m.status.clone(),
            })
            .collect();
        list.sort_by(|a, b| a.peer.cmp(&b.peer));
        ServerEvent::CallState { members: list }
    }

    /// 接続した直後に送る一覧。通話に誰もいなければ `None`。
    pub fn state_for_new_conn(&self) -> Option<ServerEvent> {
        let members = self.lock();
        if members.is_empty() {
            None
        } else {
            Some(Self::snapshot(&members))
        }
    }

    pub fn join(
        &self,
        hub: &Hub,
        actor: &Actor<'_>,
        peer: String,
        status: CallStatus,
    ) -> AppResult<()> {
        let conn = require_conn(actor)?;
        validate_peer(&peer)?;
        let status = validate_status(status)?;
        let mut members = self.lock();
        if members.iter().any(|(c, m)| *c != conn && m.peer == peer) {
            return Err(AppError::bad_request(
                "peer_in_use",
                "その接続 ID はすでに使われています",
            ));
        }
        members.insert(
            conn,
            Member {
                peer,
                user_id: actor.user.id.clone(),
                status,
            },
        );
        hub.broadcast(&Self::snapshot(&members));
        Ok(())
    }

    /// 通話から外す。参加していなければ何もしない。外したら一覧を配る。
    pub fn leave(&self, hub: &Hub, conn: ConnId) {
        let mut members = self.lock();
        if members.remove(&conn).is_some() {
            hub.broadcast(&Self::snapshot(&members));
        }
    }

    pub fn update(&self, hub: &Hub, actor: &Actor<'_>, status: CallStatus) -> AppResult<()> {
        let conn = require_conn(actor)?;
        let status = validate_status(status)?;
        let mut members = self.lock();
        let Some(me) = members.get_mut(&conn) else {
            return Err(not_in_call());
        };
        if me.status == status {
            return Ok(());
        }
        me.status = status;
        hub.broadcast(&Self::snapshot(&members));
        Ok(())
    }

    /// 参加者 `peer` を通話から外す。外されたその接続に `call.kicked` を送る。
    pub fn kick(&self, hub: &Hub, actor: &Actor<'_>, peer: &str) -> AppResult<()> {
        let conn = require_conn(actor)?;
        let mut members = self.lock();
        let Some(me) = members.get(&conn) else {
            return Err(not_in_call());
        };
        let by = me.user_id.clone();
        let Some(target) = members
            .iter()
            .find(|(_, m)| m.peer == peer)
            .map(|(c, _)| *c)
        else {
            return Err(AppError::bad_request(
                "peer_not_found",
                "その参加者は通話にいません",
            ));
        };
        if target == conn {
            return Err(AppError::bad_request(
                "invalid_kick",
                "自分を通話から外すことはできません",
            ));
        }
        members.remove(&target);
        hub.send_to_conn(target, &ServerEvent::CallKicked { by });
        hub.broadcast(&Self::snapshot(&members));
        Ok(())
    }

    /// 参加者から、ほかの参加者全員へ中継する（保存しない）。
    pub fn emit(
        &self,
        hub: &Hub,
        actor: &Actor<'_>,
        name: String,
        payload: serde_json::Value,
    ) -> AppResult<()> {
        let conn = require_conn(actor)?;
        if name.is_empty() || name.chars().count() > MAX_EVENT_NAME_CHARS {
            return Err(AppError::bad_request(
                "invalid_event_name",
                format!("イベント名は 1〜{MAX_EVENT_NAME_CHARS} 文字にしてください"),
            ));
        }
        let size = serde_json::to_string(&payload)
            .map(|s| s.len())
            .unwrap_or(usize::MAX);
        if size > MAX_PAYLOAD_BYTES {
            return Err(AppError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                format!("payload は {} KB までです", MAX_PAYLOAD_BYTES / 1024),
            ));
        }
        let members = self.lock();
        let Some(me) = members.get(&conn) else {
            return Err(not_in_call());
        };
        let event = ServerEvent::CallEvent {
            peer: me.peer.clone(),
            from: me.user_id.clone(),
            name,
            payload,
        };
        let targets: Vec<ConnId> = members.keys().copied().filter(|c| *c != conn).collect();
        hub.send_to_conns(&targets, &event);
        Ok(())
    }
}

fn require_conn(actor: &Actor<'_>) -> AppResult<ConnId> {
    actor.conn.ok_or_else(|| {
        AppError::bad_request("ws_only", "通話は WebSocket の接続からだけ操作できます")
    })
}

fn not_in_call() -> AppError {
    AppError::bad_request("not_in_call", "通話に参加していません")
}

fn validate_peer(peer: &str) -> AppResult<()> {
    let ok = !peer.is_empty()
        && peer.chars().count() <= MAX_PEER_CHARS
        && peer
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(AppError::bad_request(
            "invalid_peer",
            format!(
                "接続 ID は英数字・ハイフン・アンダースコアの 1〜{MAX_PEER_CHARS} 文字にしてください"
            ),
        ))
    }
}

fn validate_status(mut status: CallStatus) -> AppResult<CallStatus> {
    if let Some(device) = &status.device
        && device.chars().count() > MAX_DEVICE_CHARS
    {
        return Err(AppError::bad_request(
            "invalid_status",
            "端末の種類が長すぎます",
        ));
    }
    if status.device.as_deref() == Some("") {
        status.device = None;
    }
    Ok(status)
}
