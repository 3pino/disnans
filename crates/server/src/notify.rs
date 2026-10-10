//! 通知（メンション、スレッドへの返信）。
//!
//! 送り方は `Notifier` で抽象化しておき、後から FCM などを足せるようにする（SPEC 4.3）。
//! 今は WebSocket の接続に `ServerEvent::Notify` を流すだけ。

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
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

    /// 1人のユーザーの、1つの端末（IP アドレス）だけに通知を送る（サンプル通知用）。
    fn notify_device(&self, user_id: &str, ip: IpAddr, notification: &Notification);
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
        self.hub.send_to_user(user_id, &event(n));
    }

    fn notify_device(&self, user_id: &str, ip: IpAddr, n: &Notification) {
        self.hub.send_to_device(user_id, ip, &event(n));
    }
}

fn event(n: &Notification) -> ServerEvent {
    ServerEvent::Notify {
        title: n.title.clone(),
        body: n.body.clone(),
        message_id: n.message_id.clone(),
        thread_id: n.thread_id.clone(),
        sample: n.sample,
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

/// 通知の送り手。どの名前で通知の文言を作るかと、本人にも送るかを決める。
#[derive(Debug, Clone, Copy)]
pub enum Sender<'a> {
    /// ふつうの投稿。本人には通知しない。
    User,
    /// プラグインのボットとしての投稿（通知を送る指定があったとき）。文言はボットの名前で作り、
    /// 投稿した本人にも「{名前} からのメッセージ」を送る（通常の宛先に入っていればそちらを使う）。
    Bot(&'a str),
}

/// 新しいメッセージについて、誰にどんな通知を送るかを決める。
///
/// - メンションされた人
/// - スレッドへの返信なら、そのスレッドに関わっている人（`participants`: 起点の投稿者と返信した人）
/// - `Sender::Bot` のときは、投稿した本人
///
/// `Sender::User` では本人には送らない。1つのメッセージで同じ人に送るのは1回だけ（メンションを優先する）。
pub fn plan(
    message: &Message,
    users: &[User],
    participants: &[String],
    sender: Sender,
) -> Vec<(String, Notification)> {
    let names: HashMap<&str, &str> = users
        .iter()
        .map(|u| (u.id.as_str(), u.display_name.as_str()))
        .collect();
    let (author, self_title) = match sender {
        Sender::User => (
            names
                .get(message.author_id.as_str())
                .copied()
                .unwrap_or("だれか"),
            None,
        ),
        Sender::Bot(name) => (name, Some(format!("{name} からのメッセージ"))),
    };
    let body = preview(message, &names);

    let mut sent = HashSet::new();
    if matches!(sender, Sender::User) {
        sent.insert(message.author_id.as_str());
    }
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
    if let Some(title) = self_title.filter(|_| !sent.contains(message.author_id.as_str())) {
        push(&message.author_id, title);
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
            card: None,
            bot: None,
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
        let plan = plan(
            &msg,
            &users,
            &["B".into(), "C".into(), "A".into()],
            Sender::User,
        );

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
    fn bot_notifies_the_poster_with_the_bot_name() {
        let users = [user("A", "alice"), user("B", "bob")];
        let msg = message("A", None, "hello");
        let plan = plan(&msg, &users, &[], Sender::Bot("ダイス"));
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].0, "A");
        assert_eq!(plan[0].1.title, "ダイス からのメッセージ");
        assert_eq!(plan[0].1.body, "hello");
    }

    #[test]
    fn bot_uses_its_name_in_mention_and_thread_titles() {
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", Some("ROOT"), "<@B> 見て");
        // 投稿者（A）はスレッドの参加者に入っていないので、本人への通知になる
        let plan = plan(&msg, &users, &["C".into()], Sender::Bot("ダイス"));
        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![
                ("B", "ダイス さんからのメンション"),
                ("C", "ダイス さんがスレッドに返信"),
                ("A", "ダイス からのメッセージ"),
            ]
        );
    }

    #[test]
    fn bot_poster_gets_one_notification_even_if_mentioned() {
        let users = [user("A", "alice")];
        let msg = message("A", None, "<@A> 自分宛て");
        let plan = plan(&msg, &users, &[], Sender::Bot("ダイス"));
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].1.title, "ダイス さんからのメンション");
    }

    #[test]
    fn no_thread_notifications_in_main_chat() {
        let users = [user("A", "alice"), user("B", "bob")];
        let msg = message("A", None, "hello");
        assert!(plan(&msg, &users, &["B".into()], Sender::User).is_empty());
    }
}
