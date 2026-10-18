//! TUI の状態と更新（通信・端末に依存しない）。`update` は状態を変え、実行すべき `Effect` を返す。

use std::cmp::Ordering;
use std::collections::HashSet;

use crossterm::event::KeyEvent;
use disnans_shared::{Message, Reaction, User};

use std::collections::HashMap;

use jiff::tz::TimeZone;

use super::graphics::Placement;
use super::input::{Action, EnterKeys, Keymap};
use super::picture::Prepared;
use super::textbuf::TextBuf;
use super::transcript::{self, Row};

/// 起動時・再取得時に読む件数。
pub const PAGE_SIZE: u32 = 50;
pub const REFETCH_SIZE: u32 = 100;
/// 本文の最大文字数（サーバーと同じ）。
pub const MAX_BODY_CHARS: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnState {
    Connecting,
    Connected {
        generation: u64,
    },
    Reconnecting {
        generation: u64,
        reason: String,
    },
    Failed {
        reason: String,
        http_status: Option<u16>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryPurpose {
    Initial,
    Older,
    Refetch,
}

/// `SendOutcome` を通信層から受け取るための単純な形。
#[derive(Debug, Clone)]
pub enum SendResult {
    Confirmed(Box<Message>),
    Rejected { code: String, message: String },
    NotSent { reason: String },
    Unknown { detail: String },
}

#[derive(Debug, Clone)]
pub enum NetEvent {
    /// 画像の取得・変換の結果。
    Image {
        key: String,
        result: Result<Box<Prepared>, String>,
    },
    Connecting,
    Connected {
        generation: u64,
        me: User,
        users: Vec<User>,
    },
    Gap {
        generation: u64,
        reason: String,
    },
    Failed {
        reason: String,
        http_status: Option<u16>,
    },
    Created {
        message: Box<Message>,
        client_id: Option<String>,
    },
    Updated(Box<Message>),
    Deleted {
        message_id: String,
    },
    Reactions {
        message_id: String,
        reactions: Vec<Reaction>,
    },
    UserUpdated(User),
    History {
        purpose: HistoryPurpose,
        result: Result<Vec<Message>, String>,
    },
    Prefs(EnterKeys),
    SendResult {
        client_id: String,
        result: SendResult,
    },
    /// 下書きを保存できなかった。
    DraftError(String),
    /// サーバーからの通知（メンション・返信など）。
    Notify {
        title: String,
        body: String,
        message_id: Option<String>,
    },
}

#[derive(Debug, Clone)]
pub enum Event {
    Key(KeyEvent),
    Paste(String),
    Net(NetEvent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Send {
        client_id: String,
        body: String,
    },
    LoadOlder {
        before: String,
    },
    Refetch,
    /// 端末のベルを鳴らす（通知）。
    Bell,
    /// 入力の変化。呼び出し側がまとめて（遅らせて）保存してよい。
    SaveDraft(Option<String>),
    /// 今すぐ保存（送信確定後の削除・終了時）。
    SaveDraftNow(Option<String>),
    Quit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendState {
    Idle,
    /// 送信して確認待ち。入力は編集できない。
    Sending {
        client_id: String,
        body: String,
    },
    /// 送信後に成否が分からない。再送しない。入力と下書きは残す。
    Unknown {
        client_id: String,
        body: String,
        detail: String,
    },
}

type IdSource = Box<dyn FnMut() -> String + Send>;

/// 画像の取得状態。
pub enum ImageState {
    Loading,
    Ready(Box<Prepared>),
    Failed,
}

/// キー入力の宛先。Tab で送信ボタン、Shift+Tab で入力欄に戻る。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Input,
    SendButton,
}

pub struct App {
    pub focus: Focus,
    /// 画像を出せる端末のときのセルの大きさ（ピクセル）。`None` なら画像は使わない。
    pub gfx: Option<(u16, u16)>,
    /// 画像（キーは取得先のパス）。
    pub images: HashMap<String, ImageState>,
    /// 取得を始めるべき画像（描画が見つけたもの）。
    pending_images: Vec<String>,
    /// 直近の描画で画像を出す場所。
    pub placements: Vec<Placement>,
    pub messages: Vec<Message>,
    pub users: Vec<User>,
    pub me: Option<User>,
    pub input: TextBuf,
    pub keymap: Keymap,
    pub conn: ConnState,
    pub send: SendState,
    /// 一時的な通知（次の操作で消える）。
    pub notice: Option<String>,
    /// サーバーからの通知（タイトル, 本文）。次の操作で消える。
    pub alert: Option<(String, String)>,
    /// 通知でベルを鳴らすか（`notifyBackend == "bell"`）。
    pub bell: bool,
    /// 表示済みの通知のメッセージ ID（再接続での再送を二重に出さない）。
    seen_notify: Vec<String>,
    pub should_quit: bool,
    /// 表示に使うタイムゾーン。`None` は UTC（`Z` 付き）。
    pub zone: Option<TimeZone>,
    /// 履歴の表示領域（桁・行）。描画のたびに更新する。
    pub viewport: (usize, usize),
    /// 最新から何行上を見ているか。0 は最新に追従。
    pub scroll: usize,
    pub loading_initial: bool,
    pub loading_older: bool,
    pub refetching: bool,
    pub reached_start: bool,
    /// 履歴の取得に失敗している（Ctrl+R で再取得）。
    pub history_error: Option<String>,
    confirm_resend: bool,
    new_client_id: IdSource,
}

impl App {
    pub fn new(
        draft: Option<String>,
        keymap: Keymap,
        zone: Option<TimeZone>,
        new_client_id: IdSource,
    ) -> Self {
        Self {
            focus: Focus::Input,
            gfx: None,
            images: HashMap::new(),
            pending_images: Vec::new(),
            placements: Vec::new(),
            messages: Vec::new(),
            users: Vec::new(),
            me: None,
            input: draft
                .as_deref()
                .map_or_else(TextBuf::default, TextBuf::from_text),
            keymap,
            conn: ConnState::Connecting,
            send: SendState::Idle,
            notice: None,
            alert: None,
            bell: false,
            seen_notify: Vec::new(),
            should_quit: false,
            zone,
            viewport: (80, 20),
            scroll: 0,
            loading_initial: true,
            loading_older: false,
            refetching: false,
            reached_start: false,
            history_error: None,
            confirm_resend: false,
            new_client_id,
        }
    }

    /// 終了後に標準エラーへ出す注意（送信結果が分からないまま終わる場合）。
    pub fn exit_note(&self) -> Option<String> {
        match &self.send {
            SendState::Idle => None,
            SendState::Sending { client_id, .. } | SendState::Unknown { client_id, .. } => {
                Some(format!(
                    "送信結果が確認できないまま終了しました。再送していません (client_id: {client_id})。\
                     `disnans messages` で確認してください。入力は下書きに残しています"
                ))
            }
        }
    }

    /// 履歴の表示領域を更新し、スクロール位置を収める。
    pub fn set_viewport(&mut self, width: usize, height: usize) {
        if self.viewport != (width, height) {
            self.viewport = (width, height);
        }
        self.scroll = self.scroll.min(self.max_scroll());
    }

    /// 画像を使う（端末が対応している）。`cell` は 1 セルのピクセル数。
    pub fn enable_images(&mut self, cell: (u16, u16)) {
        self.gfx = Some((cell.0.max(1), cell.1.max(1)));
    }

    /// 画像が必要になったことを知らせる。未取得なら取得を依頼する。
    pub fn want_image(&mut self, key: &str) {
        if !self.images.contains_key(key) {
            self.images.insert(key.to_owned(), ImageState::Loading);
            self.pending_images.push(key.to_owned());
        }
    }

    pub fn take_image_requests(&mut self) -> Vec<String> {
        std::mem::take(&mut self.pending_images)
    }

    pub fn ready_image(&self, key: &str) -> Option<&Prepared> {
        match self.images.get(key) {
            Some(ImageState::Ready(p)) => Some(p),
            _ => None,
        }
    }

    /// 投稿者の表示色（アバターの平均色）。アバターが無い・まだなら `None`。
    pub fn author_color(&self, author_id: &str) -> Option<(u8, u8, u8)> {
        let url = self
            .users
            .iter()
            .find(|u| u.id == author_id)?
            .avatar_url
            .as_deref()?;
        self.ready_image(url).map(|p| p.color)
    }

    pub fn rows(&self) -> Vec<Row> {
        transcript::timeline(
            &self.messages,
            &self.users,
            self.viewport.0,
            self.zone.as_ref(),
            self.gfx,
        )
    }

    fn message_height(&self, message: &Message) -> usize {
        transcript::message_rows(
            message,
            &self.users,
            self.viewport.0,
            self.zone.as_ref(),
            self.gfx,
        )
        .len()
    }

    fn total_rows(&self) -> usize {
        self.rows().len()
    }

    fn max_scroll(&self) -> usize {
        self.total_rows().saturating_sub(self.viewport.1)
    }

    pub fn update(&mut self, event: Event) -> Vec<Effect> {
        let mut effects = Vec::new();
        match event {
            Event::Key(key) => {
                let mut action = self.keymap.map(key);
                if self.focus == Focus::SendButton {
                    let plain = key.modifiers.is_empty()
                        && key.kind != crossterm::event::KeyEventKind::Release;
                    match (&action, key.code) {
                        // ボタン上では Enter / Space で送る（Enter の設定に関わらない）。
                        _ if plain
                            && matches!(
                                key.code,
                                crossterm::event::KeyCode::Enter
                                    | crossterm::event::KeyCode::Char(' ')
                            ) =>
                        {
                            action = Action::Send;
                        }
                        (Action::FocusButton, _) => action = Action::FocusInput,
                        (
                            Action::Insert(_)
                            | Action::Backspace
                            | Action::Delete
                            | Action::Newline
                            | Action::Left
                            | Action::Right
                            | Action::Up
                            | Action::Down
                            | Action::Home
                            | Action::End,
                            _,
                        ) => self.focus = Focus::Input,
                        _ => {}
                    }
                }
                match action {
                    Action::FocusButton => self.focus = Focus::SendButton,
                    Action::FocusInput => self.focus = Focus::Input,
                    _ => {}
                }
                self.on_action(action.clone(), &mut effects);
                if matches!(action, Action::Send)
                    && effects.iter().any(|e| matches!(e, Effect::Send { .. }))
                {
                    self.focus = Focus::Input;
                }
            }
            Event::Paste(text) => {
                if self.input_locked() {
                    return effects;
                }
                self.clear_transient();
                self.input.insert_str(&text);
                self.draft_changed(&mut effects);
            }
            Event::Net(net) => self.on_net(net, &mut effects),
        }
        effects
    }

    pub fn input_locked(&self) -> bool {
        matches!(self.send, SendState::Sending { .. })
    }

    fn clear_transient(&mut self) {
        self.notice = None;
        self.alert = None;
        self.confirm_resend = false;
    }

    fn draft_changed(&self, effects: &mut Vec<Effect>) {
        effects.push(Effect::SaveDraft(self.draft_value()));
    }

    pub fn draft_value(&self) -> Option<String> {
        (!self.input.is_empty()).then(|| self.input.as_str().to_owned())
    }

    fn on_action(&mut self, action: Action, effects: &mut Vec<Effect>) {
        // 再送の確認中に送信キー以外を押したら取り消す。
        if !matches!(action, Action::Send | Action::Ignore) {
            self.confirm_resend = false;
        }
        match action {
            Action::Quit => {
                self.should_quit = true;
                effects.push(Effect::SaveDraftNow(self.draft_value()));
                effects.push(Effect::Quit);
            }
            Action::Send => self.send_pressed(effects),
            Action::Refetch => self.start_refetch(effects),
            Action::PageUp => self.scroll_up(self.viewport.1.saturating_sub(1).max(1), effects),
            Action::PageDown => self.scroll_down(self.viewport.1.saturating_sub(1).max(1)),
            Action::ScrollUp => self.scroll_up(1, effects),
            Action::ScrollDown => self.scroll_down(1),
            Action::ScrollTop => self.scroll_up(usize::MAX, effects),
            Action::ScrollBottom => self.scroll = 0,
            Action::Ignore | Action::FocusButton | Action::FocusInput => {}
            edit => {
                if self.input_locked() {
                    return;
                }
                self.clear_transient();
                let before = self.input.as_str().to_owned();
                match edit {
                    Action::Insert(c) => self.input.insert_char(c),
                    Action::Newline => self.input.newline(),
                    Action::Backspace => self.input.backspace(),
                    Action::Delete => self.input.delete(),
                    Action::Left => self.input.left(),
                    Action::Right => self.input.right(),
                    Action::Up => self.input.up(),
                    Action::Down => self.input.down(),
                    Action::Home => self.input.home(),
                    Action::End => self.input.end(),
                    _ => {}
                }
                if self.input.as_str() != before {
                    self.draft_changed(effects);
                }
            }
        }
    }

    fn scroll_up(&mut self, lines: usize, effects: &mut Vec<Effect>) {
        let max = self.max_scroll();
        self.scroll = self.scroll.saturating_add(lines).min(max);
        // 先頭まで1画面以内に近づいたら古い履歴を読む。
        let rows_above = max - self.scroll;
        if rows_above <= self.viewport.1
            && !self.loading_older
            && !self.loading_initial
            && !self.reached_start
            && let Some(oldest) = self.messages.first()
        {
            self.loading_older = true;
            effects.push(Effect::LoadOlder {
                before: oldest.id.clone(),
            });
        }
    }

    fn scroll_down(&mut self, lines: usize) {
        self.scroll = self.scroll.saturating_sub(lines);
    }

    fn start_refetch(&mut self, effects: &mut Vec<Effect>) {
        if !self.refetching {
            self.refetching = true;
            self.history_error = None;
            effects.push(Effect::Refetch);
        }
    }

    fn send_pressed(&mut self, effects: &mut Vec<Effect>) {
        if self.input_locked() {
            self.notice = Some("送信中です。確認を待っています".into());
            return;
        }
        let body = self.input.as_str().to_owned();
        if body.trim().is_empty() {
            self.notice = Some("本文が空です".into());
            return;
        }
        let chars = body.chars().count();
        if chars > MAX_BODY_CHARS {
            self.notice = Some(format!("本文が長すぎます ({chars}/{MAX_BODY_CHARS} 文字)"));
            return;
        }
        if !matches!(self.conn, ConnState::Connected { .. }) {
            self.notice = Some("接続中ではないため送信できません。入力は残してあります".into());
            return;
        }
        if matches!(self.send, SendState::Unknown { .. }) && !self.confirm_resend {
            self.confirm_resend = true;
            self.notice = Some(
                "前回の送信は結果が不明で、実は成功している可能性があります。\
                 送ると二重投稿になるかもしれません。もう一度送信キーを押すと送ります（他のキーで取消）"
                    .into(),
            );
            return;
        }
        self.confirm_resend = false;
        self.notice = None;
        let client_id = (self.new_client_id)();
        self.send = SendState::Sending {
            client_id: client_id.clone(),
            body: body.clone(),
        };
        effects.push(Effect::Send { client_id, body });
    }

    fn on_net(&mut self, event: NetEvent, effects: &mut Vec<Effect>) {
        match event {
            NetEvent::Image { key, result } => {
                let state = match result {
                    Ok(image) => ImageState::Ready(image),
                    Err(_) => ImageState::Failed,
                };
                self.images.insert(key, state);
            }
            NetEvent::Connecting => {
                if !matches!(self.conn, ConnState::Failed { .. }) && self.me.is_none() {
                    self.conn = ConnState::Connecting;
                }
            }
            NetEvent::Connected {
                generation,
                me,
                users,
            } => {
                self.me = Some(me);
                self.users = users;
                self.conn = ConnState::Connected { generation };
                // 再接続後は、切断中に失われたかもしれない分を再取得する。
                if generation >= 2 {
                    self.start_refetch(effects);
                }
            }
            NetEvent::Gap { generation, reason } => {
                if reason == "lagged" {
                    // 購読は生きたまま取りこぼしたので、すぐ再取得できる。
                    self.start_refetch(effects);
                } else {
                    self.conn = ConnState::Reconnecting { generation, reason };
                }
            }
            NetEvent::Failed {
                reason,
                http_status,
            } => {
                self.conn = ConnState::Failed {
                    reason,
                    http_status,
                };
            }
            NetEvent::Created { message, client_id } => {
                if let Some(id) = &client_id {
                    self.resolve_sent(id, effects);
                }
                self.insert_live(*message);
            }
            NetEvent::Updated(message) => {
                if let Some(slot) = self.messages.iter_mut().find(|m| m.id == message.id) {
                    *slot = *message;
                }
            }
            NetEvent::Deleted { message_id } => {
                self.messages.retain(|m| m.id != message_id);
            }
            NetEvent::Reactions {
                message_id,
                reactions,
            } => {
                if let Some(slot) = self.messages.iter_mut().find(|m| m.id == message_id) {
                    slot.reactions = reactions;
                }
            }
            NetEvent::UserUpdated(user) => match self.users.iter_mut().find(|u| u.id == user.id) {
                Some(slot) => *slot = user,
                None => self.users.push(user),
            },
            NetEvent::History { purpose, result } => self.on_history(purpose, result),
            NetEvent::Prefs(keys) => self.keymap.enter_keys = keys,
            NetEvent::SendResult { client_id, result } => {
                self.on_send_result(&client_id, result, effects);
            }
            NetEvent::Notify {
                title,
                body,
                message_id,
                ..
            } => {
                if let Some(id) = &message_id {
                    if self.seen_notify.contains(id) {
                        return;
                    }
                    self.seen_notify.push(id.clone());
                    if self.seen_notify.len() > 128 {
                        self.seen_notify.remove(0);
                    }
                }
                // 再接続での再送分も、まだ見ていなければ出す（文言はサーバーのまま。表示時に無害化する）。
                self.alert = Some((title, body));
                if self.bell {
                    effects.push(Effect::Bell);
                }
            }
            NetEvent::DraftError(reason) => {
                self.notice = Some(format!(
                    "下書きを保存できません: {}",
                    super::sanitize::inline(&reason)
                ));
            }
        }
    }

    /// 自分の `client_id` 付きの投稿が届いた（`Sending` 中でも `Unknown` 後でも成功とみなす）。
    fn resolve_sent(&mut self, client_id: &str, effects: &mut Vec<Effect>) {
        let body = match &self.send {
            SendState::Sending {
                client_id: id,
                body,
            }
            | SendState::Unknown {
                client_id: id,
                body,
                ..
            } if id == client_id => body.clone(),
            _ => return,
        };
        self.send = SendState::Idle;
        if self.input.as_str() == body {
            self.input.clear();
            effects.push(Effect::SaveDraftNow(None));
            self.notice = None;
        } else {
            self.notice = Some("前回の送信が確認できました（入力欄には別の本文があります）".into());
        }
    }

    fn on_send_result(&mut self, client_id: &str, result: SendResult, effects: &mut Vec<Effect>) {
        let (id, body) = match &self.send {
            SendState::Sending {
                client_id: id,
                body,
            } => (id.clone(), body.clone()),
            _ => return,
        };
        if id != client_id {
            return;
        }
        match result {
            SendResult::Confirmed(message) => {
                self.send = SendState::Idle;
                self.insert_live(*message);
                self.input.clear();
                self.notice = None;
                effects.push(Effect::SaveDraftNow(None));
            }
            SendResult::Rejected { code, message } => {
                self.send = SendState::Idle;
                self.notice = Some(format!(
                    "サーバーが投稿を受け付けませんでした ({}): {}。入力は残してあります",
                    super::sanitize::inline(&code),
                    super::sanitize::inline(&message)
                ));
            }
            SendResult::NotSent { reason } => {
                self.send = SendState::Idle;
                self.notice = Some(format!(
                    "送信していません: {}。入力は残してあります",
                    super::sanitize::inline(&reason)
                ));
            }
            SendResult::Unknown { detail } => {
                self.send = SendState::Unknown {
                    client_id: id,
                    body: body.clone(),
                    detail,
                };
                effects.push(Effect::SaveDraftNow(Some(body)));
            }
        }
    }

    /// WebSocket で届いた（または送信確認で得た）メッセージを入れる。既にあれば置き換える。
    fn insert_live(&mut self, message: Message) {
        if let Some(slot) = self.messages.iter_mut().find(|m| m.id == message.id) {
            *slot = message;
            return;
        }
        let height = self.message_height(&message);
        let position = self
            .messages
            .partition_point(|m| compare(m, &message) != Ordering::Greater);
        let at_end = position == self.messages.len();
        self.messages.insert(position, message);
        // 上を読んでいるときは、新着で表示位置が動かないようにする。
        if self.scroll > 0 && at_end {
            self.scroll += height;
        }
    }

    fn on_history(&mut self, purpose: HistoryPurpose, result: Result<Vec<Message>, String>) {
        match purpose {
            HistoryPurpose::Initial => self.loading_initial = false,
            HistoryPurpose::Older => self.loading_older = false,
            HistoryPurpose::Refetch => self.refetching = false,
        }
        let page = match result {
            Ok(page) => page,
            Err(reason) => {
                let reason = super::sanitize::inline(&reason);
                self.history_error = Some(match purpose {
                    HistoryPurpose::Older => format!("古い履歴を読めませんでした: {reason}"),
                    _ => format!("履歴を読めませんでした: {reason} (Ctrl+R で再取得)"),
                });
                return;
            }
        };
        self.history_error = None;
        match purpose {
            HistoryPurpose::Initial => {
                self.reached_start = page.len() < PAGE_SIZE as usize;
                self.merge_page(page, false);
            }
            HistoryPurpose::Older => {
                self.reached_start = page.len() < PAGE_SIZE as usize;
                self.merge_page(page, false);
            }
            HistoryPurpose::Refetch => self.merge_page(page, true),
        }
    }

    /// 取得したページを既存のメッセージへ重複なく取り込む。
    /// `prune` なら、取得範囲内にあるのにサーバーに無いもの（切断中に削除された）を取り除く。
    fn merge_page(&mut self, page: Vec<Message>, prune: bool) {
        if page.is_empty() {
            return;
        }
        let ids: HashSet<&str> = page.iter().map(|m| m.id.as_str()).collect();
        if prune {
            let lo = page
                .iter()
                .min_by(|a, b| compare(a, b))
                .expect("non-empty")
                .clone();
            let hi = page
                .iter()
                .max_by(|a, b| compare(a, b))
                .expect("non-empty")
                .clone();
            self.messages.retain(|m| {
                ids.contains(m.id.as_str())
                    || compare(m, &lo) == Ordering::Less
                    || compare(m, &hi) == Ordering::Greater
            });
        }
        for message in page {
            match self.messages.iter_mut().find(|m| m.id == message.id) {
                Some(slot) => *slot = message,
                None => self.messages.push(message),
            }
        }
        self.messages.sort_by(compare);
    }
}

fn compare(a: &Message, b: &Message) -> Ordering {
    (a.created_at, &a.id).cmp(&(b.created_at, &b.id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tui::transcript::tests_support::{message, user};
    use crossterm::event::{KeyCode, KeyModifiers};

    fn make() -> App {
        let mut n = 0;
        App::new(
            None,
            Keymap::new(EnterKeys::default(), true),
            None,
            Box::new(move || {
                n += 1;
                format!("cid{n}")
            }),
        )
    }

    fn msg(id: &str, at: i64, body: &str) -> Message {
        let mut m = message(id, "u1", body);
        m.created_at = at;
        m
    }

    fn net(app: &mut App, event: NetEvent) -> Vec<Effect> {
        app.update(Event::Net(event))
    }

    fn connect(app: &mut App, generation: u64) -> Vec<Effect> {
        net(
            app,
            NetEvent::Connected {
                generation,
                me: user("u1", "A"),
                users: vec![user("u1", "A")],
            },
        )
    }

    fn type_text(app: &mut App, text: &str) {
        for c in text.chars() {
            app.update(Event::Key(KeyEvent::new(
                KeyCode::Char(c),
                KeyModifiers::NONE,
            )));
        }
    }

    fn press(app: &mut App, code: KeyCode, mods: KeyModifiers) -> Vec<Effect> {
        app.update(Event::Key(KeyEvent::new(code, mods)))
    }

    fn send_key(app: &mut App) -> Vec<Effect> {
        press(app, KeyCode::Enter, KeyModifiers::CONTROL)
    }

    fn ids(app: &App) -> Vec<&str> {
        app.messages.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn history_merge_dedupes_sorts_and_detects_the_start() {
        let mut app = make();
        net(
            &mut app,
            NetEvent::History {
                purpose: HistoryPurpose::Initial,
                result: Ok(vec![msg("b", 2, "2"), msg("c", 3, "3")]),
            },
        );
        assert!(app.reached_start && !app.loading_initial);
        net(
            &mut app,
            NetEvent::Created {
                message: Box::new(msg("c", 3, "again")),
                client_id: None,
            },
        );
        net(
            &mut app,
            NetEvent::History {
                purpose: HistoryPurpose::Older,
                result: Ok(vec![msg("a", 1, "1"), msg("b", 2, "2")]),
            },
        );
        assert_eq!(ids(&app), ["a", "b", "c"]);
        assert_eq!(app.messages[2].body, "again");
    }

    #[test]
    fn notify_shows_an_alert_rings_the_bell_once_per_message_and_clears_on_key() {
        let mut app = make();
        app.bell = true;
        let notify = |id: &str, _replayed: bool| NetEvent::Notify {
            title: "題".into(),
            body: "本文".into(),
            message_id: Some(id.into()),
        };
        let effects = app.update(Event::Net(notify("m1", false)));
        assert_eq!(effects, [Effect::Bell]);
        assert_eq!(app.alert, Some(("題".into(), "本文".into())));
        assert!(app.update(Event::Net(notify("m1", true))).is_empty());
        app.bell = false;
        assert!(app.update(Event::Net(notify("m2", false))).is_empty());
        assert!(app.alert.is_some());
        app.update(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE)));
        assert!(app.alert.is_none());
    }

    #[test]
    fn updates_deletes_and_reactions_apply_by_id() {
        let mut app = make();
        net(
            &mut app,
            NetEvent::Created {
                message: Box::new(msg("a", 1, "old")),
                client_id: None,
            },
        );
        net(&mut app, NetEvent::Updated(Box::new(msg("a", 1, "new"))));
        assert_eq!(app.messages[0].body, "new");
        net(
            &mut app,
            NetEvent::Reactions {
                message_id: "a".into(),
                reactions: vec![Reaction {
                    emoji: "x".into(),
                    user_ids: vec!["u".into()],
                }],
            },
        );
        assert_eq!(app.messages[0].reactions.len(), 1);
        net(
            &mut app,
            NetEvent::Deleted {
                message_id: "a".into(),
            },
        );
        assert!(app.messages.is_empty());
    }

    #[test]
    fn sending_locks_input_and_confirmation_clears_it_and_the_draft() {
        let mut app = make();
        connect(&mut app, 1);
        type_text(&mut app, "hello");
        let effects = send_key(&mut app);
        assert!(
            matches!(&effects[..], [Effect::Send { client_id, body }] if client_id == "cid1" && body == "hello")
        );
        // 送信中は編集も二重送信もできない。
        type_text(&mut app, "x");
        assert!(send_key(&mut app).is_empty());
        assert_eq!(app.input.as_str(), "hello");
        let effects = net(
            &mut app,
            NetEvent::SendResult {
                client_id: "cid1".into(),
                result: SendResult::Confirmed(Box::new(msg("m1", 5, "hello"))),
            },
        );
        assert!(effects.contains(&Effect::SaveDraftNow(None)));
        assert!(app.input.is_empty());
        assert_eq!(app.send, SendState::Idle);
        assert_eq!(ids(&app), ["m1"]);
    }

    #[test]
    fn own_created_event_before_the_ack_confirms_once() {
        let mut app = make();
        connect(&mut app, 1);
        type_text(&mut app, "hi");
        send_key(&mut app);
        net(
            &mut app,
            NetEvent::Created {
                message: Box::new(msg("m1", 5, "hi")),
                client_id: Some("cid1".into()),
            },
        );
        assert!(app.input.is_empty());
        assert_eq!(app.send, SendState::Idle);
        net(
            &mut app,
            NetEvent::SendResult {
                client_id: "cid1".into(),
                result: SendResult::Confirmed(Box::new(msg("m1", 5, "hi"))),
            },
        );
        assert_eq!(ids(&app), ["m1"]);
    }

    #[test]
    fn rejected_and_not_sent_keep_the_input_and_show_a_reason() {
        for result in [
            SendResult::Rejected {
                code: "empty_message".into(),
                message: "空".into(),
            },
            SendResult::NotSent {
                reason: "切断中".into(),
            },
        ] {
            let mut app = make();
            connect(&mut app, 1);
            type_text(&mut app, "keep");
            send_key(&mut app);
            net(
                &mut app,
                NetEvent::SendResult {
                    client_id: "cid1".into(),
                    result,
                },
            );
            assert_eq!(app.input.as_str(), "keep");
            assert_eq!(app.send, SendState::Idle);
            assert!(app.notice.is_some());
        }
    }

    #[test]
    fn unknown_keeps_input_never_resends_and_later_created_resolves_it() {
        let mut app = make();
        connect(&mut app, 1);
        type_text(&mut app, "maybe");
        send_key(&mut app);
        let effects = net(
            &mut app,
            NetEvent::SendResult {
                client_id: "cid1".into(),
                result: SendResult::Unknown {
                    detail: "timeout".into(),
                },
            },
        );
        assert!(effects.contains(&Effect::SaveDraftNow(Some("maybe".into()))));
        assert!(matches!(app.send, SendState::Unknown { .. }));
        // 最初の送信キーは送らず確認だけ。
        assert!(send_key(&mut app).is_empty());
        assert!(app.notice.as_deref().unwrap().contains("二重投稿"));
        // 別のキーで取り消すと、また確認から。
        type_text(&mut app, "!");
        assert!(send_key(&mut app).is_empty());
        // 同じ client_id の created が後から届いたら確定扱い。
        net(
            &mut app,
            NetEvent::Created {
                message: Box::new(msg("m1", 5, "maybe!")),
                client_id: Some("cid1".into()),
            },
        );
        assert_eq!(app.send, SendState::Idle);
        assert!(app.notice.as_deref().unwrap().contains("確認できました"));
        assert_eq!(app.input.as_str(), "maybe!");
    }

    #[test]
    fn explicit_resend_after_unknown_uses_a_new_client_id() {
        let mut app = make();
        connect(&mut app, 1);
        type_text(&mut app, "x");
        send_key(&mut app);
        net(
            &mut app,
            NetEvent::SendResult {
                client_id: "cid1".into(),
                result: SendResult::Unknown { detail: "t".into() },
            },
        );
        send_key(&mut app);
        let effects = send_key(&mut app);
        assert!(matches!(&effects[..], [Effect::Send { client_id, .. }] if client_id == "cid2"));
    }

    #[test]
    fn sending_is_refused_when_empty_too_long_or_disconnected() {
        let mut app = make();
        connect(&mut app, 1);
        assert!(send_key(&mut app).is_empty());
        type_text(&mut app, "   ");
        assert!(send_key(&mut app).is_empty());
        let mut app2 = app_with_long_input();
        connect(&mut app2, 1);
        assert!(send_key(&mut app2).is_empty());
        assert!(app2.notice.as_deref().unwrap().contains("長すぎ"));
        let mut app3 = make();
        type_text(&mut app3, "x");
        assert!(send_key(&mut app3).is_empty());
        assert!(app3.notice.as_deref().unwrap().contains("接続中ではない"));
    }

    fn app_with_long_input() -> App {
        let mut a = make();
        a.input = TextBuf::from_text(&"a".repeat(MAX_BODY_CHARS + 1));
        a
    }

    #[test]
    fn reconnect_refetches_and_prunes_messages_deleted_while_away() {
        let mut app = make();
        connect(&mut app, 1);
        for (id, at) in [("a", 1), ("b", 2), ("c", 3)] {
            net(
                &mut app,
                NetEvent::Created {
                    message: Box::new(msg(id, at, id)),
                    client_id: None,
                },
            );
        }
        let effects = net(
            &mut app,
            NetEvent::Gap {
                generation: 1,
                reason: "closed".into(),
            },
        );
        assert!(effects.is_empty());
        assert!(matches!(app.conn, ConnState::Reconnecting { .. }));
        let effects = connect(&mut app, 2);
        assert_eq!(effects, [Effect::Refetch]);
        net(
            &mut app,
            NetEvent::History {
                purpose: HistoryPurpose::Refetch,
                result: Ok(vec![msg("a", 1, "a"), msg("c", 3, "c"), msg("d", 4, "d")]),
            },
        );
        assert_eq!(ids(&app), ["a", "c", "d"]);
        assert!(!app.refetching);
    }

    #[test]
    fn lagged_refetches_immediately_without_changing_the_connection_state() {
        let mut app = make();
        connect(&mut app, 1);
        let effects = net(
            &mut app,
            NetEvent::Gap {
                generation: 1,
                reason: "lagged".into(),
            },
        );
        assert_eq!(effects, [Effect::Refetch]);
        assert!(matches!(app.conn, ConnState::Connected { .. }));
        // 取得中の重複要求は出さない。
        assert!(
            net(
                &mut app,
                NetEvent::Gap {
                    generation: 1,
                    reason: "lagged".into()
                }
            )
            .is_empty()
        );
    }

    #[test]
    fn refetch_failure_is_shown_and_ctrl_r_retries() {
        let mut app = make();
        connect(&mut app, 2);
        net(
            &mut app,
            NetEvent::History {
                purpose: HistoryPurpose::Refetch,
                result: Err("boom".into()),
            },
        );
        assert!(app.history_error.as_deref().unwrap().contains("Ctrl+R"));
        let effects = press(&mut app, KeyCode::Char('r'), KeyModifiers::CONTROL);
        assert_eq!(effects, [Effect::Refetch]);
        assert!(app.history_error.is_none());
    }

    #[test]
    fn failed_connection_is_terminal_and_quit_still_works() {
        let mut app = make();
        net(
            &mut app,
            NetEvent::Failed {
                reason: "403".into(),
                http_status: Some(403),
            },
        );
        type_text(&mut app, "x");
        assert!(send_key(&mut app).is_empty());
        let effects = press(&mut app, KeyCode::Char('q'), KeyModifiers::CONTROL);
        assert!(effects.contains(&Effect::Quit) && app.should_quit);
    }

    #[test]
    fn scrolling_follows_the_tail_and_loads_older_history_near_the_top() {
        let mut app = make();
        app.loading_initial = false;
        app.set_viewport(40, 5);
        for i in 0..30 {
            net(
                &mut app,
                NetEvent::Created {
                    message: Box::new(msg(&format!("m{i:02}"), i, "x")),
                    client_id: None,
                },
            );
        }
        assert_eq!(app.scroll, 0);
        let effects = press(&mut app, KeyCode::PageUp, KeyModifiers::NONE);
        assert!(effects.is_empty() && app.scroll == 4);
        // 読んでいる最中の新着で位置が動かない。
        net(
            &mut app,
            NetEvent::Created {
                message: Box::new(msg("zz", 99, "x")),
                client_id: None,
            },
        );
        assert_eq!(app.scroll, 4 + 1);
        let effects = press(&mut app, KeyCode::Home, KeyModifiers::CONTROL);
        assert_eq!(
            effects,
            [Effect::LoadOlder {
                before: "m00".into()
            }]
        );
        assert!(app.loading_older);
        // 読み込み中は重ねて要求しない。
        assert!(press(&mut app, KeyCode::PageUp, KeyModifiers::NONE).is_empty());
        press(&mut app, KeyCode::End, KeyModifiers::CONTROL);
        assert_eq!(app.scroll, 0);
    }

    #[test]
    fn typing_requests_a_debounced_draft_save_and_quit_saves_now() {
        let mut app = make();
        let effects = press(&mut app, KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(effects, [Effect::SaveDraft(Some("a".into()))]);
        let effects = press(&mut app, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!(effects, [Effect::SaveDraft(None)]);
        type_text(&mut app, "z");
        let effects = press(&mut app, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(
            effects,
            [Effect::SaveDraftNow(Some("z".into())), Effect::Quit]
        );
    }

    #[test]
    fn prefs_change_the_enter_behaviour_without_blocking_input() {
        let mut app = make();
        type_text(&mut app, "x");
        assert!(
            press(&mut app, KeyCode::Enter, KeyModifiers::NONE)
                .iter()
                .all(|e| matches!(e, Effect::SaveDraft(_)))
        );
        assert_eq!(app.input.as_str(), "x\n");
        net(
            &mut app,
            NetEvent::Prefs(EnterKeys::from_prefs(
                &serde_json::json!({"enterKeys": {"enter": "send"}}),
            )),
        );
        connect(&mut app, 1);
        let effects = press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(matches!(&effects[..], [Effect::Send { .. }]));
    }

    #[test]
    fn paste_keeps_newlines_and_is_ignored_while_sending() {
        let mut app = make();
        connect(&mut app, 1);
        app.update(Event::Paste("a\r\nb".into()));
        assert_eq!(app.input.as_str(), "a\nb");
        send_key(&mut app);
        app.update(Event::Paste("zzz".into()));
        assert_eq!(app.input.as_str(), "a\nb");
    }

    #[test]
    fn exit_note_warns_when_a_send_is_unresolved() {
        let mut app = make();
        assert!(app.exit_note().is_none());
        connect(&mut app, 1);
        type_text(&mut app, "x");
        send_key(&mut app);
        assert!(app.exit_note().unwrap().contains("cid1"));
    }

    #[test]
    fn tab_moves_focus_to_the_send_button_and_enter_sends_from_there() {
        let mut app = make();
        connect(&mut app, 1);
        type_text(&mut app, "hi");
        press(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(app.focus, Focus::SendButton);
        // 既定の Enter は改行だが、ボタン上では送信。
        let effects = press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(matches!(&effects[..], [Effect::Send { body, .. }] if body == "hi"));
        assert_eq!(app.focus, Focus::Input);
    }

    #[test]
    fn shift_tab_and_typing_return_to_the_input() {
        let mut app = make();
        type_text(&mut app, "a");
        press(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        press(&mut app, KeyCode::BackTab, KeyModifiers::SHIFT);
        assert_eq!(app.focus, Focus::Input);
        press(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        type_text(&mut app, "b");
        assert_eq!((app.focus, app.input.as_str()), (Focus::Input, "ab"));
        press(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        press(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(app.focus, Focus::Input);
    }

    #[test]
    fn avatar_color_comes_from_the_loaded_avatar_image() {
        let mut app = make();
        let mut u = user("u1", "A");
        u.avatar_url = Some("/api/avatars/x".into());
        app.users.push(u);
        assert_eq!(app.author_color("u1"), None);
        app.want_image("/api/avatars/x");
        assert_eq!(app.take_image_requests(), ["/api/avatars/x"]);
        app.want_image("/api/avatars/x");
        assert!(app.take_image_requests().is_empty());
        let mut png = Vec::new();
        image::RgbaImage::from_pixel(4, 4, image::Rgba([0, 0, 90, 255]))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let prepared =
            crate::tui::picture::prepare(&png, crate::tui::picture::Kind::Avatar).unwrap();
        net(
            &mut app,
            NetEvent::Image {
                key: "/api/avatars/x".into(),
                result: Ok(Box::new(prepared)),
            },
        );
        let (r, g, b) = app.author_color("u1").unwrap();
        assert!(b > r && b > g && b > 140);
    }
}
