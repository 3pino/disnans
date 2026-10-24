//! TUI の状態と更新（通信・ターミナルに依存しない）。`update` は状態を変え、実行すべき `Effect` を返す。

use std::cmp::Ordering;
use std::collections::HashSet;

use crossterm::event::{KeyEvent, MouseEvent, MouseEventKind};
use disnans_shared::{Message, Reaction, User};

use std::collections::HashMap;

use jiff::tz::TimeZone;

use super::commands::{self, Bindings, Mode};
use super::device::Loaded;
use super::graphics::Placement;
use super::input::{Action, EnterKeys, Keymap};
use super::picture::Prepared;
use super::search::{Phase, Search};
use super::settings::{self, Editor, Save};
use super::suggest::{self, Suggest};
use super::textbuf::TextBuf;
use super::transcript::{self, Row};
use super::ui::modal::{Choice, Dialog, Menu, MenuItem, Modal, Outcome, Prompt, SettingsList};

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
    /// 設定（ユーザー共通・デバイス）の読み込み結果。
    Settings(Result<Box<Loaded>, String>),
    /// 1 つの設定を保存した結果（保存後のオブジェクト全体、または名前）。
    PrefSaved(Result<SavedPrefs, String>),
    /// 検索の応答。`append` は続きの取得。
    Search {
        seq: u64,
        append: bool,
        result: Result<Vec<Message>, String>,
    },
    SendResult {
        client_id: String,
        result: SendResult,
    },
    /// 下書きを保存できなかった。
    DraftError(String),
    /// 画面に出す知らせ（サーバーのエラーなど）。
    Notice(String),
    /// サーバーからの通知（メンション・返信など）。
    Notify {
        title: String,
        body: String,
        message_id: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum SavedPrefs {
    User(serde_json::Value),
    Device(serde_json::Value),
    Renamed(String),
}

#[derive(Debug, Clone)]
pub enum Event {
    Key(KeyEvent),
    Paste(String),
    Mouse(MouseEvent),
    Net(NetEvent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Send {
        client_id: String,
        body: String,
        /// 返信先のメッセージ ID。
        reply_to: Option<String>,
        /// 通知を送らない。
        silent: bool,
    },
    /// リアクションを付ける（`add`）か外す。結果は `reaction.updated` で届く。
    React {
        message_id: String,
        emoji: String,
        add: bool,
    },
    LoadOlder {
        before: String,
    },
    /// 検索（`seq` で応答を照合する。`before` があれば続き）。
    Search {
        seq: u64,
        query: String,
        before: Option<String>,
    },
    Refetch,
    /// 設定を 1 つ保存する（送った順に処理する）。
    SaveSetting {
        device_id: String,
        save: Save,
    },
    /// ターミナルのベルを鳴らす（通知）。
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
    /// 画像を出せるターミナルのときのセルの大きさ（ピクセル）。`None` なら画像は使わない。
    pub gfx: Option<(u16, u16)>,
    /// 画像（キーは取得先のパス）。
    pub images: HashMap<String, ImageState>,
    /// メッセージごとの画像の横スクロール（左端の画像の番号）。選択を外すと戻す。
    hscroll: HashMap<String, usize>,
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
    /// 操作モード（入力・メッセージ選択・リアクション入力）。
    pub mode: Mode,
    /// 選択モードで選んでいるメッセージの ID。
    pub selected: Option<String>,
    /// キーとコマンドの対応（後から設定で差し替えられる）。
    pub bindings: Bindings,
    /// モーダルのスタック。最上位だけが操作を受ける。
    pub modals: Vec<Modal>,
    /// 設定（読み込めるまで `None`）。
    pub settings: Option<Loaded>,
    /// 入力欄の補完（`@` `:` `/`）。
    pub suggest: Option<Suggest>,
    /// 補完で入れた `@表示名` と利用者 ID（送るとき `<@id>` に直す）。
    mentions: Vec<(String, String)>,
    /// 送信ボタンの領域（x, y, 幅, 高さ）。描画のたびに更新する。
    pub send_button: Option<(u16, u16, u16, u16)>,
    /// 最上位のモーダルを描いた領域（x, y, 幅, 高さ）と、Dialog のメッセージの行数。マウスの当たり判定に使う。
    pub modal_area: Option<(u16, u16, u16, u16, u16)>,
    /// 検索の状態。
    pub search: Search,
    /// 返信先のメッセージ ID（次の送信に付く）。
    pub reply_to: Option<String>,
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
            hscroll: HashMap::new(),
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
            mode: Mode::Input,
            selected: None,
            bindings: Bindings::default(),
            modals: Vec::new(),
            settings: None,
            suggest: None,
            mentions: Vec::new(),
            send_button: None,
            modal_area: None,
            search: Search::default(),
            reply_to: None,
            zone,
            viewport: (80, 20),
            scroll: 0,
            loading_initial: true,
            loading_older: false,
            refetching: false,
            reached_start: false,
            history_error: None,
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

    /// 画像を使う（ターミナルが対応している）。`cell` は 1 セルのピクセル数。
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
        self.with_media(|media| {
            transcript::timeline_for(
                &self.messages,
                &self.users,
                self.viewport.0,
                self.zone.as_ref(),
                self.gfx,
                self.me.as_ref().map(|u| u.id.as_str()),
                media,
            )
        })
    }

    /// 画像の状態とスクロールを引くもの（`f` に渡す。参照を返せないのでコールバックにする）。
    fn with_media<R>(&self, f: impl FnOnce(&transcript::Media) -> R) -> R {
        let embed = |key: &str| self.embed(key);
        let first = |id: &str| self.hscroll.get(id).copied().unwrap_or(0);
        f(&transcript::Media {
            embed: &embed,
            first: &first,
        })
    }

    /// 本文の画像の埋め込みの状態（まだ取得を始めていなければ、取得中として扱う）。
    fn embed(&self, key: &str) -> transcript::Embed {
        match self.images.get(key) {
            None | Some(ImageState::Loading) => transcript::Embed::Pending,
            Some(ImageState::Ready(p)) => transcript::Embed::Ready(p.rgba.width(), p.rgba.height()),
            Some(ImageState::Failed) => transcript::Embed::Failed,
        }
    }

    fn message_height(&self, message: &Message) -> usize {
        self.with_media(|media| {
            transcript::message_rows_for(
                message,
                &self.users,
                self.viewport.0,
                self.zone.as_ref(),
                self.gfx,
                self.me.as_ref().map(|u| u.id.as_str()),
                media,
            )
            .len()
        })
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
                if !self.modals.is_empty()
                    || (self.suggest.is_some()
                        && self.mode == Mode::Input
                        && matches!(
                            action,
                            Action::FocusButton
                                | Action::Up
                                | Action::Down
                                | Action::Send
                                | Action::Newline
                                | Action::Cancel
                        ))
                {
                    self.on_action(action, &mut effects);
                    return effects;
                }
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
                if matches!(action, Action::Send | Action::SendSilent)
                    && effects.iter().any(|e| matches!(e, Effect::Send { .. }))
                {
                    self.focus = Focus::Input;
                }
            }
            Event::Paste(text) => {
                if let Some(Modal::Prompt(p)) = self.modals.last_mut() {
                    p.text.insert_str(&text.replace(['\r', '\n'], " "));
                    return effects;
                }
                if !self.modals.is_empty() {
                    return effects;
                }
                if self.mode == Mode::Search && self.search.phase == Phase::Editing {
                    // 検索語は 1 行。改行は空白にする。
                    self.search
                        .query
                        .insert_str(&text.replace(['\r', '\n'], " "));
                    return effects;
                }
                if self.input_locked() || self.mode != Mode::Input {
                    return effects;
                }
                self.clear_transient();
                self.input.insert_str(&text);
                self.refresh_suggest();
                self.draft_changed(&mut effects);
            }
            Event::Mouse(mouse) => self.on_mouse(mouse, &mut effects),
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
    }

    fn draft_changed(&self, effects: &mut Vec<Effect>) {
        effects.push(Effect::SaveDraft(self.draft_value()));
    }

    pub fn draft_value(&self) -> Option<String> {
        (!self.input.is_empty()).then(|| self.input.as_str().to_owned())
    }

    fn on_action(&mut self, action: Action, effects: &mut Vec<Effect>) {
        if !self.modals.is_empty() {
            self.on_modal_action(action, effects);
            return;
        }
        if self.suggest.is_some() && self.mode == Mode::Input && self.on_suggest_action(&action) {
            self.draft_changed(effects);
            return;
        }
        match self.mode {
            Mode::Input => {}
            Mode::Select => {
                if commands::is_passthrough(&action) {
                    self.on_input_action(action, effects);
                } else if let Some(id) = self.bindings.command(self.mode, &action, false) {
                    self.run_command(id, effects);
                }
                return;
            }
            Mode::Search => {
                self.on_search_action(action, effects);
                return;
            }
        }
        match self
            .bindings
            .command(self.mode, &action, self.reply_to.is_some())
        {
            Some(
                id @ (commands::MESSAGE_SELECT
                | commands::MESSAGE_REPLY_CANCEL
                | commands::SEARCH_OPEN),
            ) => {
                self.run_command(id, effects);
            }
            _ => self.on_input_action(action, effects),
        }
    }

    fn open_search(&mut self) {
        self.selected = None;
        self.hscroll.clear();
        self.focus = Focus::Input;
        self.mode = Mode::Search;
        self.search.error = None;
        self.search.phase = if self.search.results.is_empty() {
            Phase::Editing
        } else {
            Phase::Browsing
        };
    }

    fn close_search(&mut self) {
        // 応答待ちなら捨てる（番号を進める）。
        self.search.seq += 1;
        self.search.loading_more = false;
        if self.search.phase == Phase::Loading {
            self.search.phase = Phase::Editing;
        }
        self.mode = Mode::Input;
    }

    /// 検索の中のキー。Esc は 1 段戻る（結果 → 入力 → 閉じる）。
    fn on_search_action(&mut self, action: Action, effects: &mut Vec<Effect>) {
        if matches!(action, Action::Quit) {
            self.on_input_action(action, effects);
            return;
        }
        match self.search.phase {
            Phase::Editing => {
                let q = &mut self.search.query;
                match action {
                    Action::Insert(c) => q.insert_char(c),
                    Action::Backspace => q.backspace(),
                    Action::Delete => q.delete(),
                    Action::Left => q.left(),
                    Action::Right => q.right(),
                    Action::Home => q.home(),
                    Action::End => q.end(),
                    Action::Send | Action::Newline => self.submit_search(effects),
                    Action::Cancel | Action::Search => self.close_search(),
                    _ => return,
                }
                if !matches!(action, Action::Send | Action::Newline) {
                    self.search.error = None;
                }
            }
            Phase::Loading => {
                if matches!(action, Action::Cancel) {
                    self.search.seq += 1;
                    self.search.phase = Phase::Editing;
                }
            }
            Phase::Detail => match action {
                Action::Up | Action::Insert('k') | Action::ScrollUp => {
                    self.search.detail_scroll = self.search.detail_scroll.saturating_sub(1);
                }
                Action::Down | Action::Insert('j') | Action::ScrollDown => {
                    self.search.detail_scroll += 1;
                }
                Action::PageUp => {
                    self.search.detail_scroll = self.search.detail_scroll.saturating_sub(10);
                }
                Action::PageDown => self.search.detail_scroll += 10,
                Action::Home | Action::ScrollTop => self.search.detail_scroll = 0,
                Action::Cancel | Action::Left | Action::Insert('h') | Action::Search => {
                    self.search.phase = Phase::Browsing;
                }
                _ => {}
            },
            Phase::Browsing => {
                let last = self.search.results.len().saturating_sub(1);
                match action {
                    Action::Up | Action::Insert('k') => {
                        self.search.cursor = self.search.cursor.saturating_sub(1);
                    }
                    Action::Down | Action::Insert('j') => {
                        if self.search.cursor >= last {
                            self.search_more(effects);
                        } else {
                            self.search.cursor += 1;
                        }
                    }
                    Action::PageUp => {
                        self.search.cursor = self.search.cursor.saturating_sub(10);
                    }
                    Action::PageDown => {
                        self.search.cursor = (self.search.cursor + 10).min(last);
                    }
                    Action::Home | Action::ScrollTop => self.search.cursor = 0,
                    Action::End | Action::ScrollBottom => self.search.cursor = last,
                    Action::Insert('n') => self.search_more(effects),
                    Action::Send | Action::Newline => self.jump_to_result(),
                    Action::Insert('d') | Action::Right => self.open_detail(),
                    Action::Insert('/') | Action::Cancel | Action::Search => {
                        self.search.error = None;
                        self.search.phase = Phase::Editing;
                    }
                    _ => {}
                }
            }
        }
    }

    fn submit_search(&mut self, effects: &mut Vec<Effect>) {
        match self.search.checked_query() {
            Err(reason) => self.search.error = Some(reason),
            Ok(query) => {
                self.search.seq += 1;
                self.search.phase = Phase::Loading;
                self.search.results.clear();
                self.search.cursor = 0;
                self.search.more = false;
                self.search.error = None;
                self.search.last_query = query.clone();
                effects.push(Effect::Search {
                    seq: self.search.seq,
                    query,
                    before: None,
                });
            }
        }
    }

    /// さらに古い結果を読む（最後の結果の ID より前）。
    fn search_more(&mut self, effects: &mut Vec<Effect>) {
        if !self.search.more || self.search.loading_more {
            return;
        }
        let Some(before) = self.search.results.last().map(|m| m.id.clone()) else {
            return;
        };
        self.search.seq += 1;
        self.search.loading_more = true;
        effects.push(Effect::Search {
            seq: self.search.seq,
            query: self.search.last_query.clone(),
            before: Some(before),
        });
    }

    /// 選んだ結果のメッセージへ移る（履歴に読み込み済みなら選択モードで）。
    fn jump_to_result(&mut self) {
        let Some(id) = self
            .search
            .results
            .get(self.search.cursor)
            .map(|m| m.id.clone())
        else {
            return;
        };
        if self.messages.iter().any(|m| m.id == id) {
            self.selected = Some(id);
            self.mode = Mode::Select;
            self.focus = Focus::Input;
            self.reveal_selected();
        } else {
            // 履歴に無い古い結果は、履歴へ混ぜず、本文だけを読み取り専用で見せる。
            self.open_detail();
        }
    }

    fn open_detail(&mut self) {
        if self.search.results.get(self.search.cursor).is_some() {
            self.search.detail_scroll = 0;
            self.search.phase = Phase::Detail;
        }
    }

    /// 選んでいるメッセージの画像の帯を、1 枚ぶん横へ動かす（`delta` は ±1）。
    fn scroll_images(&mut self, delta: isize) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let rows = self.rows();
        let Some(strip) = rows
            .iter()
            .filter(|r| r.message_id == id)
            .find_map(|r| r.strip)
        else {
            return;
        };
        let next = if delta < 0 {
            strip.first.saturating_sub(1)
        } else if strip.end < strip.total {
            strip.first + 1
        } else {
            strip.first
        };
        if next != strip.first {
            self.hscroll.insert(id, next);
            // 高さが変わり得る（画像ごとに高さが違う）ので、選択を見える位置に保つ
            self.reveal_selected();
        }
    }

    /// コマンド ID を実行する（キーとの対応は `commands::from_key`）。
    fn run_command(&mut self, id: &str, effects: &mut Vec<Effect>) {
        match id {
            commands::CHAT_SEND => self.send_pressed(false, effects),
            commands::CHAT_SEND_SILENT => self.send_pressed(true, effects),
            commands::MESSAGE_SELECT => {
                if let Some(last) = self.messages.last() {
                    self.selected = Some(last.id.clone());
                    self.mode = Mode::Select;
                    self.focus = Focus::Input;
                    self.reveal_selected();
                }
            }
            commands::MESSAGE_SELECT_PREV => self.move_selection(-1),
            commands::MESSAGE_SELECT_NEXT => self.move_selection(1),
            commands::MESSAGE_SELECT_CANCEL => {
                self.mode = Mode::Input;
                self.selected = None;
                self.hscroll.clear();
            }
            commands::SEARCH_OPEN => self.open_search(),
            commands::SEARCH_CLOSE => self.close_search(),
            commands::MESSAGE_IMAGES_PREV => self.scroll_images(-1),
            commands::MESSAGE_IMAGES_NEXT => self.scroll_images(1),
            commands::MESSAGE_REPLY => {
                if let Some(id) = self.selected.take() {
                    self.reply_to = Some(id);
                }
                self.mode = Mode::Input;
            }
            commands::MESSAGE_REPLY_CANCEL => self.reply_to = None,
            commands::MESSAGE_REACT => {
                self.modals.push(Modal::Prompt(Prompt {
                    title: "リアクション（絵文字）".into(),
                    command: commands::MESSAGE_REACT_APPLY.into(),
                    text: TextBuf::default(),
                }));
            }
            commands::MESSAGE_MENU => {
                let mut items = vec![
                    MenuItem::new("返信", commands::MESSAGE_REPLY),
                    MenuItem::new("絵文字でリアクション…", commands::MESSAGE_REACT),
                ];
                for (command, emoji) in commands::QUICK_REACTIONS {
                    items.push(MenuItem::new(&format!("{emoji} リアクション"), command));
                }
                items.push(MenuItem::new("設定を開く", commands::SETTINGS_OPEN));
                self.modals
                    .push(Modal::Menu(Menu::new("メッセージの操作", items)));
            }
            commands::SETTINGS_OPEN => self.open_settings(),
            edit if edit.starts_with("settings.edit.") => {
                if let Ok(index) = edit["settings.edit.".len()..].parse() {
                    self.edit_setting(index, effects);
                }
            }
            commands::CHAT_RESEND_CONFIRMED => self.send_checked(false, true, effects),
            commands::CHAT_RESEND_CONFIRMED_SILENT => self.send_checked(true, true, effects),
            quick => {
                if let Some((_, emoji)) = commands::QUICK_REACTIONS
                    .iter()
                    .find(|(command, _)| *command == quick)
                {
                    self.apply_reaction(emoji, effects);
                }
            }
        }
    }

    /// 補完の候補が出ているときのキー。扱ったら true（入力が変わったときは呼び出し側が下書きを保存する）。
    fn on_suggest_action(&mut self, action: &Action) -> bool {
        let Some(s) = self.suggest.as_mut() else {
            return false;
        };
        match action {
            Action::Up => s.step(-1),
            Action::Down => s.step(1),
            Action::Cancel => self.suggest = None,
            Action::FocusButton | Action::Send | Action::Newline => {
                let (chars, item) = (s.token_chars, s.current().clone());
                self.input.replace_before_cursor(chars, &item.insert);
                if let Some(id) = item.user_id {
                    let name = item.insert.trim_end().trim_start_matches('@').to_owned();
                    self.mentions.retain(|(n, _)| *n != name);
                    self.mentions.push((name, id));
                }
                self.refresh_suggest();
            }
            _ => return false,
        }
        true
    }

    fn refresh_suggest(&mut self) {
        self.suggest = if self.mode == Mode::Input && !self.input_locked() {
            suggest::detect(self.input.before_cursor(), &self.users)
        } else {
            None
        };
    }

    /// 最上位のモーダルへ操作を渡し、結果に応じてスタックから外してコマンドを実行する。
    fn on_modal_action(&mut self, action: Action, effects: &mut Vec<Effect>) {
        if matches!(action, Action::Quit) {
            self.modals.clear();
            self.on_input_action(action, effects);
            return;
        }
        let Some(top) = self.modals.last_mut() else {
            return;
        };
        let outcome = top.on_action(&action);
        self.finish_modal(outcome, effects);
    }

    fn finish_modal(&mut self, outcome: Outcome, effects: &mut Vec<Effect>) {
        match outcome {
            Outcome::Keep => {}
            Outcome::Close => {
                self.modals.pop();
            }
            Outcome::Run(command) => {
                self.modals.pop();
                self.run_command(&command, effects);
            }
            Outcome::Stay(command) => self.run_command(&command, effects),
            Outcome::Submit(command, text) => {
                self.modals.pop();
                if command == commands::MESSAGE_REACT_APPLY {
                    self.apply_reaction(text.trim(), effects);
                } else if let Some(Ok(index)) =
                    command.strip_prefix("settings.set.").map(str::parse)
                {
                    self.save_setting(index, &text, effects);
                }
            }
        }
    }

    /// マウス。ホイールはスクロール（モーダル中は項目の移動）、左クリックはモーダルの項目・ボタン、
    /// 入力欄・送信ボタンのフォーカス。モーダルの外のクリックは取消。
    fn on_mouse(&mut self, mouse: MouseEvent, effects: &mut Vec<Effect>) {
        let wheel = match mouse.kind {
            MouseEventKind::ScrollUp => Some((Action::ScrollUp, Action::Up)),
            MouseEventKind::ScrollDown => Some((Action::ScrollDown, Action::Down)),
            _ => None,
        };
        if let Some((scroll, step)) = wheel {
            let action = if self.modals.is_empty() { scroll } else { step };
            self.on_action(action, effects);
            return;
        }
        if !matches!(
            mouse.kind,
            MouseEventKind::Down(crossterm::event::MouseButton::Left)
        ) {
            return;
        }
        if self.modals.is_empty() {
            self.focus = match self.send_button {
                Some((x, y, w, h))
                    if (x..x + w).contains(&mouse.column) && (y..y + h).contains(&mouse.row) =>
                {
                    Focus::SendButton
                }
                _ => Focus::Input,
            };
            return;
        }
        let Some((x, y, w, h, message_rows)) = self.modal_area else {
            return;
        };
        let inside = (x..x + w).contains(&mouse.column) && (y..y + h).contains(&mouse.row);
        let Some(top) = self.modals.last_mut() else {
            return;
        };
        let outcome = if inside {
            // 枠 1 行 + 本体の内側 1 桁ぶんを引いた位置が、本体の左上。
            top.on_click(
                mouse.row.saturating_sub(y + 1),
                mouse.column.saturating_sub(x + 2),
                message_rows,
            )
        } else {
            top.on_action(&Action::Cancel)
        };
        self.finish_modal(outcome, effects);
    }

    /// 読み込んだ設定を画面の動作へ反映する（Enter キーの動作・キー割り当て）。
    fn apply_settings(&mut self, loaded: &Loaded) {
        self.keymap.enter_keys = EnterKeys::from_prefs(&loaded.user);
        let (bindings, warnings) = settings::bindings_from(&loaded.device);
        self.bindings = bindings;
        if !warnings.is_empty() {
            self.notice = Some(format!(
                "キー設定の一部を使えません: {}",
                warnings.join(" / ")
            ));
        }
    }

    fn open_settings(&mut self) {
        match &self.settings {
            Some(loaded) => {
                let len = settings::rows(loaded, &self.bindings).len();
                self.modals.push(Modal::Settings(SettingsList {
                    cursor: 0,
                    len,
                    visible: len,
                }));
            }
            None => self.notice = Some("設定をまだ読み込めていません".into()),
        }
    }

    fn edit_setting(&mut self, index: usize, effects: &mut Vec<Effect>) {
        let Some(loaded) = &self.settings else {
            return;
        };
        let rows = settings::rows(loaded, &self.bindings);
        let Some(row) = rows.get(index) else {
            return;
        };
        let command = format!("settings.set.{index}");
        match &row.editor {
            Editor::Toggle => {
                let next = if row.value == "オン" {
                    "オフ"
                } else {
                    "オン"
                };
                self.save_setting(index, next, effects);
            }
            Editor::Choice(options) => {
                let selected = options.iter().position(|o| *o == row.value).unwrap_or(0);
                self.modals.push(Modal::Choice(Choice::new(
                    &row.label,
                    &command,
                    options.clone(),
                    selected,
                )));
            }
            Editor::Text | Editor::Number { .. } | Editor::Keys | Editor::Name => {
                self.modals.push(Modal::Prompt(Prompt {
                    title: row.label.clone(),
                    command,
                    text: TextBuf::from_text(&settings::initial_text(row)),
                }));
            }
        }
    }

    fn save_setting(&mut self, index: usize, input: &str, effects: &mut Vec<Effect>) {
        let Some(loaded) = &self.settings else {
            return;
        };
        let rows = settings::rows(loaded, &self.bindings);
        let Some(row) = rows.get(index) else {
            return;
        };
        match settings::to_save(row, input, loaded) {
            Ok(save) => effects.push(Effect::SaveSetting {
                device_id: loaded.device_id.clone(),
                save,
            }),
            Err(reason) => self.notice = Some(reason),
        }
    }

    fn run_slash(&mut self, name: &str, effects: &mut Vec<Effect>) {
        match name {
            "search" => self.open_search(),
            "quit" => self.on_input_action(Action::Quit, effects),
            "settings" => self.open_settings(),
            _ => {}
        }
    }

    fn move_selection(&mut self, delta: isize) {
        let Some(current) = self
            .selected
            .as_ref()
            .and_then(|id| self.messages.iter().position(|m| &m.id == id))
        else {
            return;
        };
        let next = current
            .saturating_add_signed(delta)
            .min(self.messages.len() - 1);
        self.selected = Some(self.messages[next].id.clone());
        self.reveal_selected();
    }

    /// 選択中のメッセージが画面に入るようにスクロールする。
    fn reveal_selected(&mut self) {
        let Some(id) = self.selected.clone() else {
            return;
        };
        let rows = self.rows();
        let Some(first) = rows.iter().position(|r| r.message_id == id) else {
            return;
        };
        let last = rows
            .iter()
            .rposition(|r| r.message_id == id)
            .unwrap_or(first);
        let total = rows.len();
        let height = self.viewport.1.max(1);
        let end = total.saturating_sub(self.scroll);
        let start = end.saturating_sub(height);
        if first < start {
            self.scroll = total.saturating_sub((first + height).min(total));
        } else if last >= end {
            self.scroll = total.saturating_sub(last + 1);
        }
        self.scroll = self.scroll.min(total.saturating_sub(height));
    }

    /// 選んだメッセージへ、自分のリアクションを付ける（付いていれば外す）。
    fn apply_reaction(&mut self, emoji: &str, effects: &mut Vec<Effect>) {
        let Some(id) = self.selected.clone() else {
            self.mode = Mode::Input;
            return;
        };
        if emoji.is_empty() || emoji.len() > 64 || emoji.chars().any(char::is_control) {
            self.notice = Some("絵文字は 64 バイト以内で、空や制御文字を含めないでください".into());
            return;
        }
        if !matches!(self.conn, ConnState::Connected { .. }) {
            self.notice = Some("接続中ではないためリアクションできません".into());
            self.mode = Mode::Input;
            return;
        }
        let mine = self.me.as_ref().map(|me| me.id.clone());
        let add = !self.messages.iter().find(|m| m.id == id).is_some_and(|m| {
            m.reactions.iter().any(|r| {
                r.emoji == emoji && mine.as_ref().is_some_and(|me| r.user_ids.contains(me))
            })
        });
        effects.push(Effect::React {
            message_id: id,
            emoji: emoji.to_owned(),
            add,
        });
        self.mode = Mode::Input;
        self.selected = None;
    }

    fn on_input_action(&mut self, action: Action, effects: &mut Vec<Effect>) {
        match action {
            Action::Quit => {
                self.should_quit = true;
                effects.push(Effect::SaveDraftNow(self.draft_value()));
                effects.push(Effect::Quit);
            }
            Action::Send => self.send_pressed(false, effects),
            Action::SendSilent => self.send_pressed(true, effects),
            Action::Cancel => {}
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
                self.refresh_suggest();
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

    fn send_pressed(&mut self, silent: bool, effects: &mut Vec<Effect>) {
        self.send_checked(silent, false, effects);
    }

    fn send_checked(&mut self, silent: bool, confirmed: bool, effects: &mut Vec<Effect>) {
        if self.input_locked() {
            self.notice = Some("送信中です。確認を待っています".into());
            return;
        }
        let body = self.input.as_str().to_owned();
        if body.trim().is_empty() {
            self.notice = Some("本文が空です".into());
            return;
        }
        if let Some(command) = suggest::SLASH
            .iter()
            .find(|(name, _)| body.trim() == format!("/{name}"))
        {
            // 名前だけの `/settings` などは TUI のコマンド。本文としては送らない。
            self.input.clear();
            self.suggest = None;
            effects.push(Effect::SaveDraftNow(None));
            self.run_slash(command.0, effects);
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
        if matches!(self.send, SendState::Unknown { .. }) && !confirmed {
            // 初期の選択は「やめる」。送るには、送る側へ動かして決定する。
            self.modals.push(Modal::Dialog(Dialog::confirm(
                "二重投稿の確認",
                "前回の送信は結果が不明で、実は成功している可能性があります。送ると二重投稿になるかもしれません。",
                "やめる",
                "送る",
                if silent {
                    commands::CHAT_RESEND_CONFIRMED_SILENT
                } else {
                    commands::CHAT_RESEND_CONFIRMED
                },
            )));
            return;
        }
        self.notice = None;
        let client_id = (self.new_client_id)();
        self.send = SendState::Sending {
            client_id: client_id.clone(),
            body: body.clone(),
        };
        self.suggest = None;
        let wire = suggest::mentions_to_body(&body, &self.mentions);
        effects.push(Effect::Send {
            client_id,
            body: wire,
            reply_to: self.reply_to.clone(),
            silent,
        });
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
            NetEvent::Search {
                seq,
                append,
                result,
            } => {
                if seq != self.search.seq {
                    return;
                }
                match result {
                    Ok(found) => self.search.accept(found, append),
                    Err(reason) => {
                        self.search.loading_more = false;
                        self.search.error = Some(format!("検索できませんでした: {reason}"));
                        if !append {
                            self.search.phase = Phase::Editing;
                        }
                    }
                }
            }
            NetEvent::Prefs(keys) => self.keymap.enter_keys = keys,
            NetEvent::Settings(result) => match result {
                Ok(loaded) => {
                    self.apply_settings(&loaded);
                    self.settings = Some(*loaded);
                }
                Err(reason) => {
                    self.notice = Some(format!("設定を読み込めませんでした: {reason}"));
                }
            },
            NetEvent::PrefSaved(result) => match (result, self.settings.as_mut()) {
                (Ok(saved), Some(loaded)) => {
                    match saved {
                        SavedPrefs::User(v) => loaded.user = v,
                        SavedPrefs::Device(v) => loaded.device = v,
                        SavedPrefs::Renamed(name) => loaded.device_name = name,
                    }
                    let loaded = loaded.clone();
                    self.apply_settings(&loaded);
                    self.notice = Some("保存しました".into());
                }
                (Err(reason), _) => {
                    self.notice = Some(format!(
                        "保存できませんでした（変更は反映されていません）: {reason}"
                    ));
                }
                _ => {}
            },
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
            NetEvent::Notice(text) => self.notice = Some(text),
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
        self.reply_to = None;
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
                self.reply_to = None;
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
    use crate::tui::search::LIMIT;
    use crate::tui::transcript::tests_support::{message, user};
    use crossterm::event::{KeyCode, KeyModifiers, MouseEventKind};

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

    fn two_messages(app: &mut App) {
        connect(app, 1);
        for (id, n) in [("a", 1), ("b", 2)] {
            net(
                app,
                NetEvent::Created {
                    message: Box::new(msg(id, n, "text")),
                    client_id: None,
                },
            );
        }
    }

    #[test]
    fn select_mode_moves_and_reply_attaches_to_the_next_send_silently_with_alt_s() {
        let mut app = make();
        two_messages(&mut app);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(
            (app.mode, app.selected.as_deref()),
            (Mode::Select, Some("b"))
        );
        press(&mut app, KeyCode::Up, KeyModifiers::NONE);
        assert_eq!(app.selected.as_deref(), Some("a"));
        press(&mut app, KeyCode::Char('j'), KeyModifiers::NONE);
        press(&mut app, KeyCode::Char('k'), KeyModifiers::NONE);
        assert_eq!(app.selected.as_deref(), Some("a"));
        press(&mut app, KeyCode::Char('p'), KeyModifiers::NONE);
        assert_eq!(
            (app.mode, app.reply_to.as_deref()),
            (Mode::Input, Some("a"))
        );
        // 返信先がある間の Esc は、選択ではなく返信の取消。
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((app.mode, app.reply_to.clone()), (Mode::Input, None));
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        type_text(&mut app, "hi");
        let effects = press(&mut app, KeyCode::Char('s'), KeyModifiers::ALT);
        assert!(
            matches!(&effects[..], [Effect::Send { reply_to: Some(r), silent: true, body, .. }] if r == "b" && body == "hi"),
            "{effects:?}"
        );
    }

    #[test]
    fn search_flows_from_query_to_results_to_jump_and_back_with_esc() {
        let mut app = make();
        two_messages(&mut app);
        let ctrl_f = |app: &mut App| press(app, KeyCode::Char('f'), KeyModifiers::CONTROL);
        ctrl_f(&mut app);
        assert_eq!((app.mode, app.search.phase), (Mode::Search, Phase::Editing));
        // 空は検索せず、理由を出す
        let effects = press(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        assert!(effects.is_empty() && app.search.error.is_some());
        type_text(&mut app, "  foo bar ");
        let effects = press(&mut app, KeyCode::Char('s'), KeyModifiers::CONTROL);
        let seq = app.search.seq;
        assert_eq!(
            effects,
            [Effect::Search {
                seq,
                query: "foo bar".into(),
                before: None
            }]
        );
        assert_eq!(app.search.phase, Phase::Loading);
        // 古い番号の応答は捨てる
        let stale = NetEvent::Search {
            seq: seq - 1,
            append: false,
            result: Ok(vec![message("zzz", "u1", "x")]),
        };
        net(&mut app, stale);
        assert!(app.search.results.is_empty());
        let found = vec![
            message("b", "u1", "foo bar"),
            message("old", "u1", "bar foo"),
        ];
        net(
            &mut app,
            NetEvent::Search {
                seq,
                append: false,
                result: Ok(found),
            },
        );
        assert_eq!(app.search.phase, Phase::Browsing);
        press(&mut app, KeyCode::Down, KeyModifiers::NONE);
        assert_eq!(app.search.cursor, 1);
        // 履歴にない結果は、履歴へ混ぜず、本文の詳細（読み取り専用）を開く。Esc で結果へ戻る
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!((app.mode, app.search.phase), (Mode::Search, Phase::Detail));
        assert!(app.messages.iter().all(|m| m.id != "old"));
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((app.search.phase, app.search.cursor), (Phase::Browsing, 1));
        // Esc で語の編集へ 1 段戻り、もう一度で閉じる
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.search.phase, Phase::Editing);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(app.mode, Mode::Input);
        // 開き直すと前の結果から。履歴にある結果へは、選択モードで移る。
        ctrl_f(&mut app);
        assert_eq!(app.search.phase, Phase::Browsing);
        press(&mut app, KeyCode::Up, KeyModifiers::NONE);
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(
            (app.mode, app.selected.as_deref()),
            (Mode::Select, Some("b"))
        );
    }

    #[test]
    fn search_loads_older_results_only_when_more_exist() {
        let mut app = make();
        ctrl_f_and_search(&mut app);
        let seq = app.search.seq;
        let page: Vec<Message> = (0..LIMIT)
            .map(|i| message(&format!("m{i:03}"), "u1", "x"))
            .collect();
        net(
            &mut app,
            NetEvent::Search {
                seq,
                append: false,
                result: Ok(page),
            },
        );
        assert!(app.search.more);
        press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE);
        let effects = press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE);
        // 読み込み中は重ねて取らない
        assert!(effects.is_empty());
        let seq = app.search.seq;
        net(
            &mut app,
            NetEvent::Search {
                seq,
                append: true,
                result: Ok(vec![message("m049", "u1", "x"), message("m999", "u1", "x")]),
            },
        );
        assert_eq!(app.search.results.len(), LIMIT as usize + 1);
        assert!(!app.search.more);
        assert!(press(&mut app, KeyCode::Char('n'), KeyModifiers::NONE).is_empty());
    }

    fn ctrl_f_and_search(app: &mut App) {
        press(app, KeyCode::Char('f'), KeyModifiers::CONTROL);
        type_text(app, "x");
        press(app, KeyCode::Char('s'), KeyModifiers::CONTROL);
    }

    #[test]
    fn reactions_toggle_by_quick_key_or_typed_emoji() {
        let mut app = make();
        two_messages(&mut app);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        let effects = press(&mut app, KeyCode::Char('1'), KeyModifiers::NONE);
        assert_eq!(
            effects,
            [Effect::React {
                message_id: "b".into(),
                emoji: "👍".into(),
                add: true
            }]
        );
        assert_eq!(app.mode, Mode::Input);
        // 自分が付けた絵文字は、もう一度で外す。
        net(
            &mut app,
            NetEvent::Reactions {
                message_id: "b".into(),
                reactions: vec![Reaction {
                    emoji: "🔥".into(),
                    user_ids: vec!["u1".into()],
                }],
            },
        );
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut app, KeyCode::Char('r'), KeyModifiers::NONE);
        assert_eq!((app.mode, app.modals.len()), (Mode::Select, 1));
        type_text(&mut app, "🔥");
        let effects = press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(
            effects,
            [Effect::React {
                message_id: "b".into(),
                emoji: "🔥".into(),
                add: false
            }]
        );
        // 空のままでは送らず、理由を出して選択へ戻る。Esc はモーダルを閉じるだけ。
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut app, KeyCode::Char('r'), KeyModifiers::NONE);
        assert!(press(&mut app, KeyCode::Enter, KeyModifiers::NONE).is_empty());
        assert!(app.modals.is_empty() && app.notice.is_some());
        press(&mut app, KeyCode::Char('r'), KeyModifiers::NONE);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!((app.mode, app.modals.len()), (Mode::Select, 0));
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
            matches!(&effects[..], [Effect::Send { client_id, body, reply_to: None, silent: false }] if client_id == "cid1" && body == "hello")
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
        // 最初の送信キーは送らず、確認のダイアログ（既定は「やめる」）を出す。
        assert!(send_key(&mut app).is_empty());
        assert!(
            matches!(app.modals.last(), Some(Modal::Dialog(d)) if d.message.contains("二重投稿") && d.focus == 0)
        );
        // Esc で取り消すと、また確認から。入力は変わらない。
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.modals.is_empty());
        type_text(&mut app, "!");
        assert!(send_key(&mut app).is_empty());
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
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
        // 既定の「やめる」のまま Enter では送らない。「送る」へ動かして決定すると新しい client_id で送る。
        assert!(press(&mut app, KeyCode::Enter, KeyModifiers::NONE).is_empty());
        send_key(&mut app);
        press(&mut app, KeyCode::Right, KeyModifiers::NONE);
        let effects = press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(matches!(&effects[..], [Effect::Send { client_id, .. }] if client_id == "cid2"));
        assert!(app.modals.is_empty());
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

    #[test]
    fn message_menu_opens_runs_and_blocks_keys_to_the_screen_underneath() {
        let mut app = make();
        two_messages(&mut app);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut app, KeyCode::Char('m'), KeyModifiers::NONE);
        assert_eq!(app.modals.len(), 1);
        // 下の画面（選択の移動）へは届かない
        press(&mut app, KeyCode::Char('k'), KeyModifiers::NONE);
        assert_eq!(app.selected.as_deref(), Some("b"));
        // 貼り付けも無視する
        app.update(Event::Paste("x".into()));
        assert_eq!(app.input.as_str(), "");
        // 2 番目は絵文字入力。Prompt が積まれる
        press(&mut app, KeyCode::Down, KeyModifiers::NONE);
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(matches!(app.modals.last(), Some(Modal::Prompt(_))) && app.modals.len() == 1);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.modals.is_empty());
        // 先頭は返信
        press(&mut app, KeyCode::Char('m'), KeyModifiers::NONE);
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(
            (app.mode, app.reply_to.as_deref()),
            (Mode::Input, Some("b"))
        );
    }

    #[test]
    fn mouse_wheel_scrolls_and_clicks_hit_the_modal_or_close_it() {
        use crossterm::event::{MouseButton, MouseEvent};
        let mouse = |kind, column, row| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            })
        };
        let mut app = make();
        two_messages(&mut app);
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        press(&mut app, KeyCode::Char('m'), KeyModifiers::NONE);
        // 描画で決まる領域を仮に置く: x=10,y=5 幅30 高さ9
        app.modal_area = Some((10, 5, 30, 9, 0));
        // ホイールは項目の移動
        app.update(mouse(MouseEventKind::ScrollDown, 12, 6));
        let Some(Modal::Menu(m)) = app.modals.last() else {
            panic!()
        };
        assert_eq!(m.cursor, 1);
        // 外のクリックは取消
        app.update(mouse(MouseEventKind::Down(MouseButton::Left), 0, 0));
        assert!(app.modals.is_empty());
        // 内側のクリック: 枠の次の行が先頭の項目（返信）
        press(&mut app, KeyCode::Char('m'), KeyModifiers::NONE);
        app.modal_area = Some((10, 5, 30, 9, 0));
        app.update(mouse(MouseEventKind::Down(MouseButton::Left), 12, 6));
        assert_eq!(app.reply_to.as_deref(), Some("b"));
        // モーダルが無いとき、ホイールは履歴のスクロール
        assert!(app.modals.is_empty());
        app.update(mouse(MouseEventKind::ScrollUp, 0, 0));
    }

    #[test]
    fn suggest_completes_mentions_and_emoji_and_sends_ids() {
        let mut app = make();
        connect(&mut app, 1);
        app.users.push(User {
            id: "u9".into(),
            login_name: "zed@gh".into(),
            display_name: "Zed".into(),
            avatar_url: None,
            created_at: 0,
        });
        type_text(&mut app, "hi @ze");
        assert_eq!(app.suggest.as_ref().map(|s| s.items.len()), Some(1));
        // Esc は補完だけを閉じる（選択モードへは行かない）
        press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
        assert!(app.suggest.is_none() && app.mode == Mode::Input);
        type_text(&mut app, "r");
        press(&mut app, KeyCode::Backspace, KeyModifiers::NONE);
        assert!(app.suggest.is_some());
        // Enter（設定に関わらず）で決定。Tab は送信ボタンへ行かない
        press(&mut app, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(app.input.as_str(), "hi @Zed ");
        assert_eq!(app.focus, Focus::Input);
        type_text(&mut app, ":tad");
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(app.input.as_str(), "hi @Zed 🎉");
        let effects = send_key(&mut app);
        assert!(matches!(&effects[..], [Effect::Send { body, .. }] if body == "hi <@u9> 🎉"));
    }

    #[test]
    fn slash_names_run_tui_commands_and_are_not_sent() {
        let mut app = make();
        connect(&mut app, 1);
        type_text(&mut app, "/settings");
        let effects = send_key(&mut app);
        assert!(!effects.iter().any(|e| matches!(e, Effect::Send { .. })));
        assert!(app.input.is_empty());
        // 設定が未読込のあいだは案内だけ
        assert!(app.modals.is_empty() && app.notice.is_some());
        // 読み込めたら設定画面が開き、項目の変更が保存の指示になる
        net(
            &mut app,
            NetEvent::Settings(Ok(Box::new(Loaded {
                device_id: "dev".into(),
                device_name: "Linux (TUI)".into(),
                user: serde_json::json!({"theme": "system"}),
                device: serde_json::json!({}),
            }))),
        );
        type_text(&mut app, "/settings");
        send_key(&mut app);
        assert!(matches!(app.modals.last(), Some(Modal::Settings(_))));
        // 先頭は theme の選択肢
        press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(matches!(app.modals.last(), Some(Modal::Choice(_))));
        press(&mut app, KeyCode::Down, KeyModifiers::NONE);
        let effects = press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
        assert!(matches!(
            &effects[..],
            [Effect::SaveSetting { device_id, save: Save::Pref { key, .. } }]
                if device_id == "dev" && key == "theme"
        ));
        // 設定画面は残る。保存後の値で上書きされ、失敗時は反映されない
        assert!(matches!(app.modals.last(), Some(Modal::Settings(_))));
        net(&mut app, NetEvent::PrefSaved(Err("boom".into())));
        assert_eq!(app.settings.as_ref().unwrap().user["theme"], "system");
        net(
            &mut app,
            NetEvent::PrefSaved(Ok(SavedPrefs::User(serde_json::json!({"theme": "light"})))),
        );
        assert_eq!(app.settings.as_ref().unwrap().user["theme"], "light");
    }

    #[test]
    fn saved_key_settings_rebind_the_screen_keys() {
        let mut app = make();
        net(
            &mut app,
            NetEvent::Settings(Ok(Box::new(Loaded {
                device_id: "dev".into(),
                device_name: "n".into(),
                user: serde_json::json!({}),
                device: serde_json::json!({"tuiKeys": {"select": {"message.select.next": ["n"]}}}),
            }))),
        );
        assert_eq!(
            app.bindings
                .command(Mode::Select, &Action::Insert('n'), false),
            Some(commands::MESSAGE_SELECT_NEXT)
        );
    }
}
