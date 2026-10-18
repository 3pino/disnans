//! 通知（メンション、スレッドへの返信）。
//!
//! 送り方は `Notifier` で抽象化しておき、後から FCM などを足せるようにする（SPEC 4.3）。
//! 今は WebSocket の接続に `ServerEvent::Notify` を流すだけ。

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
    /// メインチャットの一般の投稿による通知（投稿者以外の全員）。再送の対象にしない。
    /// メンション・返信・スレッドの通知を、大量の一般の投稿で押し出さないため。
    pub general: bool,
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
            general: false,
        }
    }
}

/// 接続が切れていた間の通知を、接続し直したときに再送するための保持期間（ユーザーごと）。
pub const REPLAY_WINDOW: Duration = Duration::from_secs(10 * 60);
/// 再送のために保持する件数（ユーザーごと。古いものから捨てる）。
pub const REPLAY_LIMIT: usize = 50;

/// 通知の送り方。
pub trait Notifier: Send + Sync {
    /// 1人のユーザーに通知を送る。時間のかかる送り方をする実装は、中でタスクを起こすこと。
    fn notify(&self, user_id: &str, notification: &Notification);

    /// 1人のユーザーの、1つの端末（IP アドレス）だけに通知を送る（サンプル通知用）。
    fn notify_device(&self, user_id: &str, ip: IpAddr, notification: &Notification);

    /// 接続し直したユーザーに再送する、直近の通知（古い順）。既読かどうかは呼び出し側で確かめる。
    fn recent(&self, user_id: &str) -> Vec<Notification>;
}

/// そのユーザーの WebSocket のすべての接続に `notify` を流す。
/// 送った通知は [`REPLAY_WINDOW`] の間、ユーザーごとに [`REPLAY_LIMIT`] 件まで覚えておく（サンプルと一般の投稿の通知は覚えない）。
pub struct WsNotifier {
    hub: Arc<Hub>,
    recent: Mutex<HashMap<String, VecDeque<(Instant, Notification)>>>,
}

impl WsNotifier {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self {
            hub,
            recent: Mutex::new(HashMap::new()),
        }
    }

    fn record(&self, user_id: &str, n: &Notification, now: Instant) {
        if n.sample || n.general {
            return;
        }
        let mut map = self.lock();
        let queue = map.entry(user_id.to_owned()).or_default();
        prune(queue, now);
        queue.push_back((now, n.clone()));
        while queue.len() > REPLAY_LIMIT {
            queue.pop_front();
        }
    }

    fn recent_at(&self, user_id: &str, now: Instant) -> Vec<Notification> {
        let mut map = self.lock();
        let Some(queue) = map.get_mut(user_id) else {
            return Vec::new();
        };
        prune(queue, now);
        let out = queue.iter().map(|(_, n)| n.clone()).collect();
        if queue.is_empty() {
            map.remove(user_id);
        }
        out
    }

    fn lock(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<String, VecDeque<(Instant, Notification)>>> {
        self.recent.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 保持期間を過ぎたものを前から捨てる（古い順に入っている）
fn prune(queue: &mut VecDeque<(Instant, Notification)>, now: Instant) {
    while let Some((at, _)) = queue.front() {
        if now.saturating_duration_since(*at) > REPLAY_WINDOW {
            queue.pop_front();
        } else {
            break;
        }
    }
}

impl Notifier for WsNotifier {
    fn notify(&self, user_id: &str, n: &Notification) {
        self.record(user_id, n, Instant::now());
        self.hub.send_to_user(user_id, &event(n));
    }

    fn notify_device(&self, user_id: &str, ip: IpAddr, n: &Notification) {
        self.hub.send_to_device(user_id, ip, &event(n));
    }

    fn recent(&self, user_id: &str) -> Vec<Notification> {
        self.recent_at(user_id, Instant::now())
    }
}

fn event(n: &Notification) -> ServerEvent {
    ServerEvent::Notify {
        title: n.title.clone(),
        body: n.body.clone(),
        message_id: n.message_id.clone(),
        thread_id: n.thread_id.clone(),
        sample: n.sample,
        replayed: false,
    }
}

/// 接続し直したときに、1件を再送するイベント。
pub fn replay_event(n: &Notification) -> ServerEvent {
    match event(n) {
        ServerEvent::Notify {
            title,
            body,
            message_id,
            thread_id,
            sample,
            ..
        } => ServerEvent::Notify {
            title,
            body,
            message_id,
            thread_id,
            sample,
            replayed: true,
        },
        other => other,
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
    /// 投稿した本人にもボットの名前で通知する（通常の宛先に入っていればそちらを使う）。
    Bot(&'a str),
}

/// 新しいメッセージについて、誰にどんな通知を送るかを決める。
///
/// - メンションされた人
/// - スレッドへの返信なら、そのスレッドに関わっている人（`participants`: 起点の投稿者と返信した人）
/// - `Sender::Bot` のときは、投稿した本人
///
/// `reply_author` は返信先の作者。返信なら、その人にも通知する。
///
/// `Sender::User` では本人には送らない。1つのメッセージで同じ人に送るのは1回だけ（メンションを優先する）。
pub fn plan(
    message: &Message,
    users: &[User],
    participants: &[String],
    reply_author: Option<&str>,
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
        Sender::Bot(name) => (name, Some(name.to_owned())),
    };
    let body = preview(message, &names);

    let mut sent = HashSet::new();
    if matches!(sender, Sender::User) {
        sent.insert(message.author_id.as_str());
    }
    let mut out = Vec::new();
    let mut push = |user_id: &str, title: String, general: bool| {
        out.push((
            user_id.to_owned(),
            Notification {
                title,
                body: body.clone(),
                message_id: Some(message.id.clone()),
                thread_id: message.thread_id.clone(),
                sample: false,
                general,
            },
        ));
    };

    for id in parse_mentions(&message.body) {
        if names.contains_key(id) && sent.insert(id) {
            push(id, format!("{author} mentioned you"), false);
        }
    }
    if let Some(id) = reply_author
        && names.contains_key(id)
        && sent.insert(id)
    {
        push(id, format!("{author} replied to you"), false);
    }
    if message.thread_id.is_some() {
        for id in participants {
            if sent.insert(id.as_str()) {
                push(id, format!("{author} replied to you"), false);
            }
        }
    }
    // メインのチャットの投稿は、投稿者以外の全員に通知する（メンションや返信に当たる人は、上で優先して送り済み）。
    // ボットの投稿も同じく全員に送る。ただし投稿した本人は、下の本人宛ての通知を1件だけ受け取る。
    // この通知は再送の対象にしない
    if message.thread_id.is_none() {
        for u in users {
            if matches!(sender, Sender::Bot(_)) && u.id == message.author_id {
                continue;
            }
            if sent.insert(u.id.as_str()) {
                push(&u.id, author.to_owned(), true);
            }
        }
    }
    if let Some(title) = self_title.filter(|_| !sent.contains(message.author_id.as_str())) {
        push(&message.author_id, title, false);
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
            reply_to: None,
            reply_preview: None,
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
            None,
            Sender::User,
        );

        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![("B", "alice mentioned you"), ("C", "alice replied to you")]
        );
        assert_eq!(plan[0].1.body, "@bob @alice <@ZZZ> 見て");
        assert_eq!(plan[0].1.thread_id.as_deref(), Some("ROOT"));
    }

    #[test]
    fn notifies_reply_target_unless_self_or_already_notified() {
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", None, "了解");
        // メインチャットなので、返信先（B）のほかに C にも一般の通知が届く
        let p = plan(&msg, &users, &[], Some("B"), Sender::User);
        let targets: Vec<_> = p
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(targets, vec![("B", "alice replied to you"), ("C", "alice")]);
        // 自分への返信でも、本人には送らない（ほかの人には届く）
        let p = plan(&msg, &users, &[], Some("A"), Sender::User);
        assert!(p.iter().all(|(u, _)| u != "A"));
        assert_eq!(p.len(), 2);
        // メンション済みの人には1回だけ（メンションの文言を優先する）
        let msg = message("A", None, "<@B> 了解");
        let p = plan(&msg, &users, &[], Some("B"), Sender::User);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].1.title, "alice mentioned you");
        assert_eq!(p[1].1.title, "alice");
    }

    #[test]
    fn bot_main_chat_post_reaches_everyone_and_the_poster_once() {
        // ボットの投稿（notify:true）は全員に届く。投稿した本人にはボットの名前で1件だけ送る
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", None, "hello");
        let plan = plan(&msg, &users, &[], None, Sender::Bot("ダイス"));
        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![("B", "ダイス"), ("C", "ダイス"), ("A", "ダイス"),]
        );
        assert!(plan.iter().all(|(_, n)| n.body == "hello"));
        assert_eq!(plan.iter().filter(|(_, n)| n.general).count(), 2);
    }

    #[test]
    fn bot_uses_its_name_in_mention_and_thread_titles() {
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", Some("ROOT"), "<@B> 見て");
        // 投稿者（A）はスレッドの参加者に入っていないので、本人への通知になる
        let plan = plan(&msg, &users, &["C".into()], None, Sender::Bot("ダイス"));
        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![
                ("B", "ダイス mentioned you"),
                ("C", "ダイス replied to you"),
                ("A", "ダイス"),
            ]
        );
    }

    #[test]
    fn bot_poster_gets_one_notification_even_if_mentioned() {
        let users = [user("A", "alice")];
        let msg = message("A", None, "<@A> 自分宛て");
        let plan = plan(&msg, &users, &[], None, Sender::Bot("ダイス"));
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].1.title, "ダイス mentioned you");
    }

    #[test]
    fn main_chat_post_notifies_everyone_but_the_author() {
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", None, "hello");
        let plan = plan(&msg, &users, &[], None, Sender::User);
        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str(), n.body.as_str()))
            .collect();
        assert_eq!(
            targets,
            vec![("B", "alice", "hello"), ("C", "alice", "hello"),]
        );
        // メインチャットでは thread_id を持たない。一般の通知は再送の対象外（general）
        assert!(plan.iter().all(|(_, n)| n.thread_id.is_none() && n.general));
    }

    #[test]
    fn main_chat_mention_keeps_the_mention_title() {
        let users = [user("A", "alice"), user("B", "bob"), user("C", "carol")];
        let msg = message("A", None, "<@C> 見て");
        let plan = plan(&msg, &users, &[], None, Sender::User);
        let targets: Vec<_> = plan
            .iter()
            .map(|(u, n)| (u.as_str(), n.title.as_str()))
            .collect();
        assert_eq!(targets, vec![("C", "alice mentioned you"), ("B", "alice"),]);
        // メンションは再送の対象、一般の通知は対象外
        assert!(!plan[0].1.general);
        assert!(plan[1].1.general);
    }
}

#[cfg(test)]
mod replay_tests {
    use super::*;

    fn note(id: &str) -> Notification {
        Notification {
            title: "t".into(),
            body: id.into(),
            message_id: Some(id.into()),
            thread_id: None,
            sample: false,
            general: false,
        }
    }

    fn notifier() -> WsNotifier {
        WsNotifier::new(Arc::new(Hub::new()))
    }

    fn bodies(list: &[Notification]) -> Vec<&str> {
        list.iter().map(|n| n.body.as_str()).collect()
    }

    #[test]
    fn keeps_notifications_in_order_per_user() {
        let n = notifier();
        let now = Instant::now();
        n.record("alice", &note("a1"), now);
        n.record("bob", &note("b1"), now);
        n.record("alice", &note("a2"), now);
        assert_eq!(bodies(&n.recent_at("alice", now)), ["a1", "a2"]);
        assert_eq!(bodies(&n.recent_at("bob", now)), ["b1"]);
        assert!(n.recent_at("carol", now).is_empty());
    }

    #[test]
    fn drops_notifications_older_than_the_window() {
        let n = notifier();
        let base = Instant::now();
        n.record("alice", &note("old"), base);
        n.record("alice", &note("new"), base + Duration::from_secs(60));
        // ちょうど保持期間の端は残し、それを過ぎたものから消える
        let edge = base + REPLAY_WINDOW;
        assert_eq!(bodies(&n.recent_at("alice", edge)), ["old", "new"]);
        let later = base + REPLAY_WINDOW + Duration::from_millis(1);
        assert_eq!(bodies(&n.recent_at("alice", later)), ["new"]);
        let much_later = base + REPLAY_WINDOW + Duration::from_secs(61);
        assert!(n.recent_at("alice", much_later).is_empty());
    }

    #[test]
    fn keeps_only_the_newest_up_to_the_limit() {
        let n = notifier();
        let now = Instant::now();
        for i in 0..REPLAY_LIMIT + 5 {
            n.record("alice", &note(&format!("m{i:03}")), now);
        }
        let kept = n.recent_at("alice", now);
        assert_eq!(kept.len(), REPLAY_LIMIT);
        assert_eq!(kept.first().unwrap().body, "m005");
        assert_eq!(
            kept.last().unwrap().body,
            format!("m{:03}", REPLAY_LIMIT + 4)
        );
    }

    #[test]
    fn general_notifications_are_not_kept() {
        let n = notifier();
        let now = Instant::now();
        let mut general = note("一般");
        general.general = true;
        n.record("alice", &general, now);
        n.record("alice", &note("メンション"), now);
        // 一般の投稿の通知が多くても、メンションは押し出されない
        for i in 0..REPLAY_LIMIT * 2 {
            let mut g = note(&format!("g{i}"));
            g.general = true;
            n.record("alice", &g, now);
        }
        assert_eq!(bodies(&n.recent_at("alice", now)), ["メンション"]);
    }

    #[test]
    fn samples_are_not_kept() {
        let n = notifier();
        let now = Instant::now();
        let mut sample = Notification::sample();
        sample.message_id = None;
        n.record("alice", &sample, now);
        assert!(n.recent_at("alice", now).is_empty());
    }

    #[test]
    fn replay_event_is_marked_and_live_event_is_not() {
        let n = note("x");
        match replay_event(&n) {
            ServerEvent::Notify { replayed, .. } => assert!(replayed),
            other => panic!("{other:?}"),
        }
        match event(&n) {
            ServerEvent::Notify { replayed, .. } => assert!(!replayed),
            other => panic!("{other:?}"),
        }
    }
}
