//! 通知（メンション、スレッドへの返信）。
//!
//! 送り方は `Notifier` で抽象化しておき、後から FCM などを足せるようにする（SPEC 4.3）。
//! 今は WebSocket の接続に `ServerEvent::Notify` を流すだけ。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use disnans_shared::{Id, Message, ServerEvent, User};

use crate::hub::Hub;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notification {
    pub title: String,
    pub body: String,
    pub message_id: Option<Id>,
    pub thread_id: Option<Id>,
    /// 動作確認用のサンプル。
    pub sample: bool,
}

impl Notification {
    /// 「サンプル通知を送信」で送る通知。
    pub fn sample() -> Self {
        Self {
            title: "disnans".into(),
            body: "サンプル通知です。通知はこのように表示されます。".into(),
            message_id: None,
            thread_id: None,
            sample: true,
        }
    }
}

/// 通知の送り方。
pub trait Notifier: Send + Sync {
    /// 1人のユーザーに通知を送る。時間のかかる送り方をする実装は、中でタスクを起こすこと。
    fn notify(&self, user_id: &str, notification: &Notification);
}

/// そのユーザーの WebSocket のすべての接続に `notify` を流す。
pub struct WsNotifier {
    hub: Arc<Hub>,
}

impl WsNotifier {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self { hub }
    }
}

impl Notifier for WsNotifier {
    fn notify(&self, user_id: &str, n: &Notification) {
        self.hub.send_to_user(
            user_id,
            &ServerEvent::Notify {
                title: n.title.clone(),
                body: n.body.clone(),
                message_id: n.message_id.clone(),
                thread_id: n.thread_id.clone(),
                sample: n.sample,
            },
        );
    }
}

/// 本文に含まれるメンション（`<@user_id>`）のユーザー ID を、出てきた順に重複なしで返す。
pub fn parse_mentions(body: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("<@") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find('>') else { break };
        let id = &rest[..end];
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
            if !found.contains(&id) {
                found.push(id);
            }
            rest = &rest[end + 1..];
        }
    }
    found
}

/// 新しいメッセージについて、誰にどんな通知を送るかを決める。
///
/// - メンションされた人
/// - スレッドへの返信なら、そのスレッドに関わっている人（`participants`: 起点の投稿者と返信した人）
///
/// 本人には送らない。1つのメッセージで同じ人に送るのは1回だけ（メンションを優先する）。
pub fn plan(
    message: &Message,
    users: &[User],
    participants: &[String],
) -> Vec<(String, Notification)> {
    let names: HashMap<&str, &str> = users
        .iter()
        .map(|u| (u.id.as_str(), u.display_name.as_str()))
        .collect();
    let author = names
        .get(message.author_id.as_str())
        .copied()
        .unwrap_or("だれか");
    let body = preview(message, &names);

    let mut sent = HashSet::new();
    sent.insert(message.author_id.as_str());
    let mut out = Vec::new();
    let mut push = |user_id: &str, title: String| {
        out.push((
            user_id.to_owned(),
            Notification {
                title,
                body: body.clone(),
                message_id: Some(message.id.clone()),
                thread_id: message.thread_id.clone(),
                sample: false,
            },
        ));
    };

    for id in parse_mentions(&message.body) {
        if names.contains_key(id) && sent.insert(id) {
            push(id, format!("{author} さんからのメンション"));
        }
    }
    if message.thread_id.is_some() {
        for id in participants {
            if sent.insert(id.as_str()) {
                push(id, format!("{author} さんがスレッドに返信"));
            }
        }
    }
    out
}

/// 通知に出す本文。メンションを `@表示名` に置き換え、長すぎるものは切る。
fn preview(message: &Message, names: &HashMap<&str, &str>) -> String {
    const MAX_CHARS: usize = 100;

    let mut text = message.body.clone();
    for id in parse_mentions(&message.body) {
        if let Some(name) = names.get(id) {
            text = text.replace(&format!("<@{id}>"), &format!("@{name}"));
        }
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return if message.attachments.is_empty() {
            String::new()
        } else {
            "[添付ファイル]".into()
        };
    }
    if text.chars().count() > MAX_CHARS {
        let mut cut: String = text.chars().take(MAX_CHARS).collect();
        cut.push('…');
        cut
    } else {
        text
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str, name: &str) -> User {
        User {
            id: id.into(),
            login_name: format!("{name}@test"),
            display_name: name.into(),
            avatar_url: None,
            created_at: 0,
        }
    }

    fn message(author: &str, thread_id: Option<&str>, body: &str) -> Message {
        Message {
            id: "M1".into(),
            author_id: author.into(),
            thread_id: thread_id.map(Into::into),
            body: body.into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 0,
            edited_at: None,
            thread: None,
        }
    }

    #[test]
    fn parses_mentions() {
        assert_eq!(
            parse_mentions("hi <@A1> and <@B2>, <@A1> again"),
            vec!["A1", "B2"]
        );
        assert_eq!(parse_mentions("<@> <@a b> <@ok"), Vec::<&str>::new());
        assert_eq!(parse_mentions("<<@X>>"), vec!["X"]);
    }

    #[test]
    fn plans_mentions_and_thread_replies_once_each() {
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", Some("ROOT"), "<@B> <@A> <@ZZZ> 見て");
        let plan = plan(&msg, &users, &["B".into(), "C".into(), "A".into()]);

        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![
                ("B", "alice さんからのメンション"),
                ("C", "alice さんがスレッドに返信")
            ]
        );
        assert_eq!(plan[0].1.body, "@bob @alice <@ZZZ> 見て");
        assert_eq!(plan[0].1.thread_id.as_deref(), Some("ROOT"));
    }

    #[test]
    fn no_thread_notifications_in_main_chat() {
        let users = [user("A", "alice"), user("B", "bob")];
        let msg = message("A", None, "hello");
        assert!(plan(&msg, &users, &["B".into()]).is_empty());
    }
}
