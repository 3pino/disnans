//! 通信・ターミナル・下書き保存をつなぐイベントループ。画面の状態は `app` が持つ。

use std::io::{self, IsTerminal, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crossterm::event::{self, KeyEventKind};
use disnans_client_core::view::settings::Scope;
use disnans_client_core::{
    ChatSession, ClientEvent, ConnectOptions, DraftKey, DraftPlace, LocalStore, MessagesQuery,
    RestClient, SendOutcome, SendRequest, ServerUrl, StoredValue, WatchItem, new_client_id,
};
use disnans_shared::ServerEvent;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::layout::Rect;
use tokio::sync::mpsc::{UnboundedSender, unbounded_channel};
use tokio::time::Instant;

use super::app::{
    App, Effect, Event, HistoryPurpose, NetEvent, PAGE_SIZE, REFETCH_SIZE, SavedPrefs, SendResult,
};
use super::device;
use super::graphics::{self, Graphics, Protocol};
use super::input::{EnterKeys, Keymap};
use super::picture;
use super::settings::Save;
use super::terminal::TerminalGuard;
use super::ui::theme;
use super::view;
use crate::{CliError, live};

/// 下書きを保存するまでの待ち（連続入力をまとめる）。
const DRAFT_DEBOUNCE: Duration = Duration::from_millis(500);

pub async fn run(server: ServerUrl, dev_user: Option<String>) -> Result<(), CliError> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(CliError::Usage(
            "tui はターミナル（TTY）で実行してください。パイプやリダイレクトでは使えません".into(),
        ));
    }
    let ack_timeout = live::ack_timeout()?;
    let rest = Arc::new(RestClient::new(server.clone(), dev_user.as_deref())?);
    // 下書きの保存先（ユーザーごと）を決めるため、先に自分の情報を取る。認証の失敗もここで分かる。
    let me = rest.me().await?;
    let mut session = ChatSession::start(
        &server,
        ConnectOptions {
            dev_user,
            ..ConnectOptions::default()
        },
    )
    .await?;

    let (store, key, draft, draft_warning) = open_draft(&server, &me.id);
    let mut app = App::new(
        draft,
        Keymap::new(EnterKeys::default(), false),
        crate::timefmt::system_zone(),
        Box::new(new_client_id),
    );
    app.notice = draft_warning;
    // 通知の方針は共通の表（client-core の platform）から読む。
    app.bell = disnans_client_core::terminal_info(disnans_client_core::Surface::Tui)
        .capabilities
        .notify_backend
        == "bell";

    let guard = TerminalGuard::enter().map_err(CliError::Io)?;
    app.keymap.enhanced = guard.enhanced_keys;
    let mut terminal = Terminal::new(CrosstermBackend::new(io::stdout())).map_err(CliError::Io)?;
    let _ = terminal.clear();
    let environment = graphics::detect();
    theme::init(environment.depth);
    let mut graphics = Graphics::new(environment.protocol).with_tmux(environment.tmux);
    if graphics.protocol != Protocol::None {
        app.enable_images(cell_pixels());
    }
    let mut force_images = false;
    let mut origin_checked: Option<std::time::Instant> = None;
    let mut last_selection = (app.mode, app.selected.clone());

    let (tx, mut rx) = unbounded_channel::<NetEvent>();
    let (term_tx, mut term_rx) = unbounded_channel::<event::Event>();
    let stop = Arc::new(AtomicBool::new(false));
    spawn_terminal_reader(term_tx, stop.clone());
    spawn_prefs(&rest, &tx);
    let save_tx = spawn_settings(store.clone(), &rest, &tx);
    spawn_history(&rest, &tx, None, HistoryPurpose::Initial, PAGE_SIZE);

    let mut shutdown = std::pin::pin!(shutdown_signal());
    let mut pending_draft: Option<(Option<String>, Instant)> = None;
    let mut session_ended = false;

    let result = loop {
        // 画像: 配置が変わるなら、文字の描画の前に古い画像を消し、後に新しい画像を重ねる。
        // 選択の強調で文字が書き換わると、その下の画像が消えるので、描き直す。
        let selection = (app.mode, app.selected.clone());
        if selection != last_selection {
            force_images = true;
            last_selection = selection;
        }
        let mut image_out = Vec::new();
        // tmux: ペインの位置は、一定間隔（1 秒）で読み直し、変わったら描き直す
        // （ペインの入れ替えなど、同じ大きさのまま動く場合も拾う）。読めなければ画像は出さない。
        if environment.tmux
            && graphics.protocol != Protocol::None
            && origin_checked.is_none_or(|at| at.elapsed() >= Duration::from_secs(1))
        {
            origin_checked = Some(std::time::Instant::now());
            if graphics.set_origin(graphics::tmux_origin()) {
                force_images = true;
            }
        }
        let images_changed = match terminal.size() {
            Ok(size) if graphics.protocol != Protocol::None => {
                view::plan(Rect::new(0, 0, size.width, size.height), &mut app);
                graphics.begin(&app.placements, force_images, &mut image_out)
            }
            _ => false,
        };
        force_images = false;
        write_raw(&image_out);
        if let Err(e) = terminal.draw(|frame| view::draw(frame, &mut app)) {
            break Err(CliError::Io(e));
        }
        if images_changed {
            let mut out = Vec::new();
            let placements = app.placements.clone();
            graphics.finish(&placements, |key| app.ready_image(key), &mut out);
            write_raw(&out);
        }
        for key in app.take_image_requests() {
            spawn_image(&rest, &tx, key);
        }
        let draft_due = pending_draft.as_ref().map(|(_, at)| *at);
        let effects = tokio::select! {
            terminal_event = term_rx.recv() => match terminal_event {
                None => break Ok(()),
                Some(event::Event::Key(key)) if key.kind != KeyEventKind::Release => {
                    app.update(Event::Key(key))
                }
                Some(event::Event::Paste(text)) => app.update(Event::Paste(text)),
                Some(event::Event::Mouse(mouse)) => app.update(Event::Mouse(mouse)),
                Some(event::Event::Resize(..)) => {
                    // 画面を作り直すので、画像も描き直す。
                    force_images = true;
                    if graphics.protocol != Protocol::None {
                        app.enable_images(cell_pixels());
                    }
                    Vec::new()
                }
                Some(_) => Vec::new(),
            },
            item = session.next(), if !session_ended => {
                if matches!(item, WatchItem::Failed { .. }) {
                    session_ended = true;
                }
                match to_net_event(item) {
                    Some(event) => app.update(Event::Net(event)),
                    None => Vec::new(),
                }
            }
            Some(event) = rx.recv() => app.update(Event::Net(event)),
            () = &mut shutdown => {
                // 入力中の内容は下書きとして残して終える。
                pending_draft = Some((app.draft_value(), Instant::now()));
                break Ok(());
            }
            // tmux では、ペインの位置の変化を拾うため 1 秒ごとに起きる。
            () = tokio::time::sleep(Duration::from_secs(1)), if environment.tmux => Vec::new(),
            () = sleep_until(draft_due), if draft_due.is_some() => {
                let (value, _) = pending_draft.take().expect("checked");
                save_draft(&store, &key, value, &tx).await;
                Vec::new()
            }
        };
        let mut quit = false;
        for effect in effects {
            match effect {
                Effect::Send {
                    client_id,
                    body,
                    reply_to,
                    silent,
                } => {
                    spawn_send(
                        &session,
                        &tx,
                        client_id,
                        body,
                        reply_to,
                        silent,
                        ack_timeout,
                    );
                }
                Effect::React {
                    message_id,
                    emoji,
                    add,
                } => spawn_react(&session, &tx, message_id, emoji, add),
                Effect::LoadOlder { before } => {
                    spawn_history(&rest, &tx, Some(before), HistoryPurpose::Older, PAGE_SIZE);
                }
                Effect::Search { seq, query, before } => {
                    spawn_search(&rest, &tx, seq, query, before);
                }
                Effect::SaveSetting { device_id, save } => {
                    let _ = save_tx.send((device_id, save));
                }
                Effect::Bell => write_raw(b"\x07"),
                Effect::Refetch => {
                    spawn_history(&rest, &tx, None, HistoryPurpose::Refetch, REFETCH_SIZE);
                }
                Effect::SaveDraft(value) => {
                    let due = pending_draft
                        .as_ref()
                        .map_or_else(|| Instant::now() + DRAFT_DEBOUNCE, |(_, at)| *at);
                    pending_draft = Some((value, due));
                }
                Effect::SaveDraftNow(value) => {
                    pending_draft = None;
                    save_draft(&store, &key, value, &tx).await;
                }
                Effect::Quit => quit = true,
            }
        }
        if quit {
            break Ok(());
        }
    };

    stop.store(true, Ordering::Relaxed);
    if let Some((value, _)) = pending_draft.take() {
        save_draft(&store, &key, value, &tx).await;
    }
    let mut out = Vec::new();
    graphics.cleanup(&mut out);
    write_raw(&out);
    drop(terminal);
    drop(guard);
    if let Some(note) = app.exit_note() {
        eprintln!("{note}");
    }
    session.close().await;
    result
}

fn open_draft(
    server: &ServerUrl,
    user_id: &str,
) -> (
    Option<Arc<LocalStore>>,
    DraftKey,
    Option<String>,
    Option<String>,
) {
    let key = DraftKey {
        server: server.clone(),
        user_id: user_id.to_owned(),
        place: DraftPlace::Main,
    };
    match LocalStore::open_default() {
        Ok(store) => match store.load_draft_state(&key) {
            Ok(StoredValue::Value(body)) => (Some(Arc::new(store)), key, Some(body), None),
            Ok(_) => (Some(Arc::new(store)), key, None, None),
            // 壊れた下書きは入力と送信を妨げない。上書きもしない（保存は失敗として知らせる）。
            Err(e) => (
                Some(Arc::new(store)),
                key,
                None,
                Some(format!("下書きを読めませんでした: {e}")),
            ),
        },
        Err(e) => (None, key, None, Some(format!("下書きを使えません: {e}"))),
    }
}

async fn save_draft(
    store: &Option<Arc<LocalStore>>,
    key: &DraftKey,
    value: Option<String>,
    tx: &UnboundedSender<NetEvent>,
) {
    let Some(store) = store.clone() else { return };
    let key = key.clone();
    let result =
        tokio::task::spawn_blocking(move || store.save_draft(&key, value.as_deref())).await;
    let error = match result {
        Ok(Ok(())) => return,
        Ok(Err(e)) => e.to_string(),
        Err(e) => e.to_string(),
    };
    let _ = tx.send(NetEvent::DraftError(error));
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// ターミナルのイベントは専用スレッドで読む（終了時は `stop` で止める）。
fn spawn_terminal_reader(tx: UnboundedSender<event::Event>, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            match event::poll(Duration::from_millis(100)) {
                Ok(true) => match event::read() {
                    Ok(ev) => {
                        if tx.send(ev).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {}
                Err(_) => break,
            }
        }
    });
}

/// 1セルのピクセル数。取れないターミナル（Windows など）では一般的な 8x16 とみなす。
fn cell_pixels() -> (u16, u16) {
    match crossterm::terminal::window_size() {
        Ok(s) if s.columns > 0 && s.rows > 0 && s.width > 0 && s.height > 0 => {
            ((s.width / s.columns).max(1), (s.height / s.rows).max(1))
        }
        _ => (8, 16),
    }
}

fn write_raw(bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let mut stdout = io::stdout().lock();
    let _ = stdout.write_all(bytes);
    let _ = stdout.flush();
}

/// 画像を取得して縮小する（アバターは `/api/avatars/…`、サムネイルは `/api/files/…/thumb`）。
fn spawn_image(rest: &Arc<RestClient>, tx: &UnboundedSender<NetEvent>, key: String) {
    let (rest, tx) = (rest.clone(), tx.clone());
    tokio::spawn(async move {
        let kind = if key.starts_with("/api/avatars/") {
            picture::Kind::Avatar
        } else {
            picture::Kind::Thumb
        };
        let result = match fetch_bytes(&rest, &key).await {
            Ok(bytes) => tokio::task::spawn_blocking(move || picture::prepare(&bytes, kind))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
                .map(Box::new),
            Err(e) => Err(e),
        };
        let _ = tx.send(NetEvent::Image { key, result });
    });
}

const MAX_IMAGE_BYTES: usize = 10 << 20;

async fn fetch_bytes(rest: &RestClient, path: &str) -> Result<Vec<u8>, String> {
    if super::transcript::is_external_avatar(path) {
        return fetch_external(path).await;
    }
    if let Some(shared) = path.strip_prefix("shared:") {
        return fetch_shared(rest, shared).await;
    }
    rest.get_bytes(path, MAX_IMAGE_BYTES)
        .await
        .map_err(|e| e.to_string())
}

/// 共有フォルダの画像（本文の埋め込み）。`attachments/` の添付は軽いサムネイル、
/// それ以外は 5MB 以下のときだけ本体を取る。
async fn fetch_shared(rest: &RestClient, path: &str) -> Result<Vec<u8>, String> {
    const SHARED_MAX: u64 = 5 << 20;
    let entry = rest
        .shared_stat(path)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "共有フォルダに見つかりません".to_owned())?;
    if entry.kind != disnans_shared::SharedKind::File {
        return Err("ファイルではありません".to_owned());
    }
    if let Some(id) = entry.file_id.as_deref() {
        let thumb = format!(
            "/api/files/{}/thumb",
            disnans_client_core::encode_path_segment(id)
        );
        return rest
            .get_bytes(&thumb, MAX_IMAGE_BYTES)
            .await
            .map_err(|e| e.to_string());
    }
    if entry.size > SHARED_MAX {
        return Err("画像が大きすぎます".to_owned());
    }
    let mut download = rest.shared_get(path).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(chunk) = download.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > SHARED_MAX as usize {
            return Err("画像が大きすぎます".to_owned());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// サーバー外の https 画像（Tailscale のアイコン等）。認証情報は送らない。
async fn fetch_external(url: &str) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > MAX_IMAGE_BYTES {
            return Err("画像が大きすぎます".to_owned());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

fn spawn_prefs(rest: &Arc<RestClient>, tx: &UnboundedSender<NetEvent>) {
    let (rest, tx) = (rest.clone(), tx.clone());
    tokio::spawn(async move {
        // 取れなくても既定の割り当てのまま使える。
        if let Ok(prefs) = rest.prefs().await {
            let _ = tx.send(NetEvent::Prefs(EnterKeys::from_prefs(&prefs)));
        }
    });
}

/// 設定の読み込み（デバイスの登録を含む）と、保存の窓口。保存は送った順に 1 つずつ処理する
/// （「読む→変える→書く」が重ならないように）。失敗しても自動では再送しない。
fn spawn_settings(
    store: Option<Arc<LocalStore>>,
    rest: &Arc<RestClient>,
    tx: &UnboundedSender<NetEvent>,
) -> UnboundedSender<(String, Save)> {
    let (save_tx, mut save_rx) = unbounded_channel::<(String, Save)>();
    let (rest, tx) = (rest.clone(), tx.clone());
    tokio::spawn(async move {
        let Some(store) = store else {
            let _ = tx.send(NetEvent::Settings(Err(
                "設定の保存先（ローカルの領域）を開けませんでした".into(),
            )));
            return;
        };
        let loaded = device::load(&store, &rest).await;
        let _ = tx.send(NetEvent::Settings(loaded.map(Box::new)));
        while let Some((device_id, save)) = save_rx.recv().await {
            let result = match save {
                Save::Pref { scope, key, value } => {
                    device::save(&rest, &device_id, scope, &key, value)
                        .await
                        .map(|prefs| match scope {
                            Scope::User => SavedPrefs::User(prefs),
                            _ => SavedPrefs::Device(prefs),
                        })
                }
                Save::Rename(name) => device::rename(&rest, &device_id, &name)
                    .await
                    .map(|()| SavedPrefs::Renamed(name)),
            };
            let _ = tx.send(NetEvent::PrefSaved(result));
        }
    });
    save_tx
}

fn spawn_history(
    rest: &Arc<RestClient>,
    tx: &UnboundedSender<NetEvent>,
    before: Option<String>,
    purpose: HistoryPurpose,
    limit: u32,
) {
    let (rest, tx) = (rest.clone(), tx.clone());
    tokio::spawn(async move {
        let result = rest
            .messages(&MessagesQuery {
                before,
                limit: Some(limit),
            })
            .await
            .map_err(|e| e.to_string());
        let _ = tx.send(NetEvent::History { purpose, result });
    });
}

fn spawn_search(
    rest: &Arc<RestClient>,
    tx: &UnboundedSender<NetEvent>,
    seq: u64,
    query: String,
    before: Option<String>,
) {
    let (rest, tx) = (rest.clone(), tx.clone());
    tokio::spawn(async move {
        let append = before.is_some();
        let result = rest
            .search_messages(&disnans_client_core::MessageSearchQuery {
                q: Some(query),
                before,
                limit: Some(super::search::LIMIT),
            })
            .await
            .map_err(|e| e.to_string());
        let _ = tx.send(NetEvent::Search {
            seq,
            append,
            result,
        });
    });
}

fn spawn_send(
    session: &ChatSession,
    tx: &UnboundedSender<NetEvent>,
    client_id: String,
    body: String,
    reply_to: Option<String>,
    silent: bool,
    ack_timeout: Duration,
) {
    let (sender, tx) = (session.sender(), tx.clone());
    tokio::spawn(async move {
        let request = SendRequest {
            body,
            reply_to,
            silent,
            ..SendRequest::default()
        };
        let outcome = sender.send_request(&client_id, request, ack_timeout).await;
        let result = match outcome {
            SendOutcome::Confirmed { message, .. } => SendResult::Confirmed(Box::new(message)),
            SendOutcome::Rejected { code, message, .. } => SendResult::Rejected { code, message },
            SendOutcome::NotSent { reason } => SendResult::NotSent { reason },
            SendOutcome::Unknown { reason, .. } => SendResult::Unknown {
                detail: live::unknown_reason(&reason),
            },
        };
        let _ = tx.send(NetEvent::SendResult { client_id, result });
    });
}

/// リアクションの付け外し。確認の応答は無く、結果は `reaction.updated` で届く。書けなかったときだけ知らせる。
fn spawn_react(
    session: &ChatSession,
    tx: &UnboundedSender<NetEvent>,
    message_id: String,
    emoji: String,
    add: bool,
) {
    let (sender, tx) = (session.sender(), tx.clone());
    tokio::spawn(async move {
        let event = if add {
            ClientEvent::ReactionAdd { message_id, emoji }
        } else {
            ClientEvent::ReactionRemove { message_id, emoji }
        };
        if let Err(e) = sender.emit(event).await {
            let _ = tx.send(NetEvent::Notice(format!(
                "リアクションできませんでした: {e}"
            )));
        }
    });
}

fn to_net_event(item: WatchItem) -> Option<NetEvent> {
    Some(match item {
        WatchItem::Connecting { .. } => NetEvent::Connecting,
        WatchItem::Connected {
            generation,
            me,
            users,
        } => NetEvent::Connected {
            generation,
            me,
            users,
        },
        WatchItem::Gap { generation, reason } => NetEvent::Gap { generation, reason },
        WatchItem::Failed {
            reason,
            http_status,
        } => NetEvent::Failed {
            reason,
            http_status,
        },
        WatchItem::Event { event, .. } => match event {
            ServerEvent::MessageCreated { client_id, message } => NetEvent::Created {
                message: Box::new(message),
                client_id,
            },
            ServerEvent::MessageUpdated { message } => NetEvent::Updated(Box::new(message)),
            ServerEvent::MessageDeleted { message_id, .. } => NetEvent::Deleted { message_id },
            ServerEvent::ReactionUpdated {
                message_id,
                reactions,
            } => NetEvent::Reactions {
                message_id,
                reactions,
            },
            ServerEvent::UserUpdated { user } => NetEvent::UserUpdated(user),
            ServerEvent::Notify {
                title,
                body,
                message_id,
                ..
            } => NetEvent::Notify {
                title,
                body,
                message_id,
            },
            ServerEvent::Error {
                client_id: None,
                code,
                message,
            } => NetEvent::Notice(format!(
                "サーバーのエラー ({code}): {}",
                super::sanitize::inline(&message)
            )),
            ServerEvent::PrefsUpdated { prefs } => NetEvent::Prefs(EnterKeys::from_prefs(&prefs)),
            _ => return None,
        },
    })
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let (Ok(mut term), Ok(mut hup)) = (
        signal(SignalKind::terminate()),
        signal(SignalKind::hangup()),
    ) else {
        return std::future::pending().await;
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = hup.recv() => {}
    }
}

#[cfg(windows)]
async fn shutdown_signal() {
    let Ok(mut brk) = tokio::signal::windows::ctrl_break() else {
        return std::future::pending().await;
    };
    let _ = brk.recv().await;
}
