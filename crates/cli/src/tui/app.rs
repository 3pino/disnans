//! TUI の状態と更新（通信・ターミナルに依存しない）。`update` は状態を変え、実行すべき `Effect` を返す。

use std::cmp::Ordering;
use std::collections::HashSet;

use crossterm::event::{KeyEvent, MouseEvent, MouseEventKind};
use disnans_shared::limits::MAX_BODY_CHARS;
use disnans_shared::{Message, Reaction, User};

use std::collections::HashMap;

use jiff::tz::TimeZone;

use super::commands::{self, Bindings, Mode};
use super::device::Loaded;
use super::graphics::Placement;
use super::input::{Action, EnterKeys, Keymap};
use super::picture::Prepared;
use super::search::{Phase, Search};
use super::settings::{self, Editor, Page, Save, Target};
use super::suggest::{self, Suggest};
use super::textbuf::TextBuf;
use super::transcript::{self, Row};
use super::ui::modal::{Choice, Dialog, Menu, MenuItem, Modal, Outcome, Prompt};
use disnans_client_core::view::ui::{
    NAV_CHAT_ID, NAV_SEARCH_ID, NAV_SETTINGS_ID, SETTINGS_TOP, tui_nav_items,
};

/// 起動時・再取得時に読む件数。
pub const PAGE_SIZE: u32 = 50;
pub const REFETCH_SIZE: u32 = 100;

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

/// 画面（チャットの代わりに全体を使う）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Chat,
    Settings,
}

/// 設定画面の状態（ページ・選択行）。行の中身は `settings.rs` が現在の値から作る。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettingsView {
    pub page: Page,
    pub cursor: usize,
}

/// キー入力の宛先。Tab で送信ボタン、Shift+Tab で入力欄に戻る。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Focus {
    Input,
    SendButton,
    /// 下の画面切替バー（`App::nav_items` の番号）。
    Nav(usize),
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
    /// 画面切替バーの位置（行, 幅）。描画で決まる。
    pub navbar: Option<(u16, u16)>,
    pub screen: Screen,
    pub settings_view: SettingsView,
    /// 設定の一覧の本体（左上 y・高さ・先頭の行の番号）。描画で決まる。
    pub settings_area: Option<(u16, u16, usize)>,
    /// 一覧の各画面行が指す設定の行番号（見出しは `None`）。
    pub settings_rows_at: Vec<Option<usize>>,
    /// 設定（読み込めるまで `None`）。
    pub settings: Option<Loaded>,
    /// 接続先（設定画面に出す）。
    pub server: String,
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
            navbar: None,
            screen: Screen::Chat,
            settings_view: SettingsView {
                page: SETTINGS_TOP,
                cursor: 0,
            },
            settings_area: None,
            settings_rows_at: Vec::new(),
            settings: None,
            server: String::new(),
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
                if let Focus::Nav(index) = self.focus {
                    match self.bindings.command(Mode::Nav, &action, false) {
                        Some(command) => self.run_nav(command, index, &mut effects),
                        None if self.screen == Screen::Settings => {}
                        None if matches!(
                            action,
                            Action::Insert(_) | Action::Backspace | Action::Delete
                        ) =>
                        {
                            self.focus = Focus::Input;
                            self.on_action(action, &mut effects);
                        }
                        None => self.on_action(action, &mut effects),
                    }
                    return effects;
                }
                if self.screen == Screen::Settings {
                    self.on_settings_screen_action(action, &mut effects);
                    return effects;
                }
                if self.mode == Mode::Input
                    && self.focus == Focus::Input
                    && self.suggest.is_none()
                    && self.bindings.command(Mode::Input, &action, false)
                        == Some(commands::NAV_FOCUS)
                    && self.input_on_last_line()
                {
                    self.focus = Focus::Nav(self.current_nav());
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
            Event::Paste(_) if self.screen == Screen::Settings => {}
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
        if self.suggest.is_some()
            && self.mode == Mode::Input
            && self.on_suggest_action(&action, effects)
        {
            self.draft_changed(effects);
            return;
        }
        match self.mode {
            Mode::Input | Mode::Nav | Mode::Settings => {}
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
    fn on_suggest_action(&mut self, action: &Action, effects: &mut Vec<Effect>) -> bool {
        let Some(s) = self.suggest.as_mut() else {
            return false;
        };
        match action {
            Action::Up => s.step(-1),
            Action::Down => s.step(1),
            Action::Cancel => self.suggest = None,
            Action::FocusButton | Action::Send | Action::Newline
                if s.kind == suggest::Kind::Slash =>
            {
                // Enter の設定（改行など）に関わらず、選んだコマンドをそのまま実行する。
                let name = s.current().insert.trim_start_matches('/').to_owned();
                self.input.clear();
                self.suggest = None;
                effects.push(Effect::SaveDraftNow(None));
                self.run_slash(&name, effects);
                return true;
            }
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
            if self.modals.is_empty() && self.screen == Screen::Settings {
                self.on_settings_screen_action(step, effects);
                return;
            }
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
            if let Some((_, width)) = self.navbar.filter(|(y, _)| *y == mouse.row) {
                // 幅の等分は view.rs の navbar_line と同じ割り方
                let count = self.nav_items().len().max(1);
                let column = usize::from(mouse.column);
                let index = (0..count)
                    .find(|i| column < usize::from(width) * (i + 1) / count)
                    .unwrap_or(count - 1);
                self.focus = Focus::Nav(index);
                self.activate_nav(index, effects);
                return;
            }
            if self.screen == Screen::Settings {
                if let Some((top, height, _)) = self.settings_area
                    && (top..top + height).contains(&mouse.row)
                    && let Some(Some(index)) = self
                        .settings_rows_at
                        .get(usize::from(mouse.row - top))
                        .copied()
                {
                    self.settings_view.cursor = index;
                    self.edit_setting(index, effects);
                }
                return;
            }
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
        if self.settings.is_none() {
            self.notice = Some("設定をまだ読み込めていません".into());
            return;
        }
        if self.mode == Mode::Search {
            self.close_search();
        }
        self.screen = Screen::Settings;
        self.mode = Mode::Input;
        self.selected = None;
        self.open_settings_page(SETTINGS_TOP, None);
        self.suggest = None;
        self.focus = Focus::Input;
    }

    /// ページを開き、カーソルを `at` の行（無ければ最初の選べる行）に置く。
    fn open_settings_page(&mut self, page: Page, at: Option<usize>) {
        self.settings_view = SettingsView { page, cursor: 0 };
        let rows = self.settings_rows();
        self.settings_view.cursor = at
            .filter(|i| rows.get(*i).is_some_and(settings::Row::selectable))
            .or_else(|| rows.iter().position(settings::Row::selectable))
            .unwrap_or(0);
    }

    /// 今のページの行（木から作る）。
    pub fn settings_rows(&self) -> Vec<settings::Row> {
        self.settings.as_ref().map_or_else(Vec::new, |l| {
            settings::rows(
                l,
                &self.bindings,
                self.settings_view.page,
                settings::Info {
                    server: &self.server,
                    version: env!("CARGO_PKG_VERSION"),
                },
            )
        })
    }

    /// 設定の全画面でのキー。モーダル（選択肢・入力）が開いている間は呼ばれない。
    fn on_settings_screen_action(&mut self, action: Action, effects: &mut Vec<Effect>) {
        if matches!(action, Action::Quit) {
            self.on_action(action, effects);
            return;
        }
        let rows = self.settings_rows();
        let cursor = self.settings_view.cursor;
        match self.bindings.command(Mode::Settings, &action, false) {
            Some(commands::SETTINGS_PREV) => {
                if let Some(i) = (0..cursor).rev().find(|i| rows[*i].selectable()) {
                    self.settings_view.cursor = i;
                }
            }
            Some(commands::SETTINGS_NEXT) => {
                match (cursor + 1..rows.len()).find(|i| rows[*i].selectable()) {
                    Some(i) => self.settings_view.cursor = i,
                    None => self.focus = Focus::Nav(self.current_nav()),
                }
            }
            Some(commands::SETTINGS_ACTIVATE) => self.edit_setting(cursor, effects),
            Some(commands::SETTINGS_BACK) => self.settings_back(),
            _ => {}
        }
    }

    /// サブページなら一覧へ（開いた行に戻る）、一覧ならチャットへ戻る。
    fn settings_back(&mut self) {
        let page = self.settings_view.page;
        if page == SETTINGS_TOP {
            self.screen = Screen::Chat;
            self.focus = Focus::Input;
        } else {
            self.settings_view.page = SETTINGS_TOP;
            let at = self
                .settings_rows()
                .iter()
                .position(|r| r.target == Target::Page(page));
            self.open_settings_page(SETTINGS_TOP, at);
        }
    }

    fn edit_setting(&mut self, index: usize, effects: &mut Vec<Effect>) {
        let rows = self.settings_rows();
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
                let labels: Vec<String> = options.iter().map(|o| o.label.to_owned()).collect();
                let selected = labels.iter().position(|o| *o == row.value).unwrap_or(0);
                self.modals.push(Modal::Choice(Choice::new(
                    &row.label, &command, labels, selected,
                )));
            }
            Editor::Open => {
                if let Target::Page(page) = row.target {
                    self.open_settings_page(page, None);
                }
            }
            Editor::Number { .. } | Editor::Keys | Editor::Name => {
                self.modals.push(Modal::Prompt(Prompt {
                    title: row.label.clone(),
                    command,
                    text: TextBuf::from_text(&row.input),
                }));
            }
            Editor::Static | Editor::Note => {}
        }
    }

    fn save_setting(&mut self, index: usize, input: &str, effects: &mut Vec<Effect>) {
        let Some(loaded) = &self.settings else {
            return;
        };
        let rows = self.settings_rows();
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

    /// カーソルが入力欄の最後の行（改行で区切った行）にあるか。
    fn input_on_last_line(&self) -> bool {
        !self.input.as_str()[self.input.before_cursor().len()..].contains('\n')
    }

    /// 下の画面切替バーの項目（ID・表示名）。並びと表示名は GUI と同じユーザー共通の設定（`navBarItems`・`navBarLabels`）。
    /// 設定を読めるまでは既定（Chat・Settings）。
    pub fn nav_items(&self) -> Vec<(&'static str, String)> {
        let empty = serde_json::Value::Null;
        tui_nav_items(self.settings.as_ref().map_or(&empty, |l| &l.user))
    }

    /// 今の画面にあたるバーの項目の番号。
    pub fn current_nav(&self) -> usize {
        let current = if self.screen == Screen::Settings {
            NAV_SETTINGS_ID
        } else if self.mode == Mode::Search {
            NAV_SEARCH_ID
        } else {
            NAV_CHAT_ID
        };
        let items = self.nav_items();
        items
            .iter()
            .position(|(id, _)| *id == current)
            .or_else(|| items.iter().position(|(id, _)| *id == NAV_CHAT_ID))
            .unwrap_or(0)
    }

    fn run_nav(&mut self, command: &str, index: usize, effects: &mut Vec<Effect>) {
        let last = self.nav_items().len().saturating_sub(1);
        match command {
            commands::NAV_PREV => self.focus = Focus::Nav(index.saturating_sub(1)),
            commands::NAV_NEXT => self.focus = Focus::Nav((index + 1).min(last)),
            commands::NAV_BACK => self.focus = Focus::Input,
            commands::NAV_ACTIVATE => self.activate_nav(index, effects),
            _ => {}
        }
    }

    fn activate_nav(&mut self, index: usize, _effects: &mut Vec<Effect>) {
        let Some((id, _)) = self.nav_items().get(index).cloned() else {
            return;
        };
        match id {
            NAV_SETTINGS_ID if self.screen == Screen::Settings => self.focus = Focus::Input,
            NAV_SETTINGS_ID => self.open_settings(),
            NAV_SEARCH_ID => {
                self.screen = Screen::Chat;
                self.open_search();
            }
            _ => {
                if self.mode == Mode::Search {
                    self.close_search();
                }
                self.screen = Screen::Chat;
                self.focus = Focus::Input;
            }
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
            Action::Newline
                if suggest::SLASH
                    .iter()
                    .any(|(name, _)| self.input.as_str() == format!("/{name}")) =>
            {
                // 入力が `/settings` などの名前だけなら、Enter の設定（改行）に関わらず実行する。
                self.send_pressed(false, effects);
            }
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
mod tests;
