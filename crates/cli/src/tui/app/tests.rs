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
    let prepared = crate::tui::picture::prepare(&png, crate::tui::picture::Kind::Avatar).unwrap();
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
    assert_eq!(app.screen, Screen::Settings);
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
    assert_eq!(app.screen, Screen::Settings);
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

fn loaded_settings(app: &mut App) {
    net(
        app,
        NetEvent::Settings(Ok(Box::new(Loaded {
            device_id: "dev".into(),
            device_name: "n".into(),
            user: serde_json::json!({}),
            device: serde_json::json!({}),
        }))),
    );
}

#[test]
fn down_on_the_last_line_moves_to_the_nav_bar_and_enter_opens_settings() {
    let mut app = make();
    connect(&mut app, 1);
    loaded_settings(&mut app);
    type_text(&mut app, "a\nb");
    press(&mut app, KeyCode::Left, KeyModifiers::NONE);
    press(&mut app, KeyCode::Up, KeyModifiers::NONE);
    // 最下行ではない間の ↓ は入力欄の中の移動
    press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    assert_eq!(app.focus, Focus::Input);
    press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    assert_eq!(app.focus, Focus::Nav(0));
    press(&mut app, KeyCode::Right, KeyModifiers::NONE);
    assert_eq!(app.focus, Focus::Nav(1));
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    assert_eq!(app.screen, Screen::Settings);
    assert_eq!(app.focus, Focus::Input);
    // Esc でチャットへ戻る。入力欄はそのまま
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    assert_eq!((app.screen, app.input.as_str()), (Screen::Chat, "a\nb"));
}

#[test]
fn settings_screen_has_a_sub_page_for_keys_and_returns_with_esc() {
    let mut app = make();
    connect(&mut app, 1);
    loaded_settings(&mut app);
    type_text(&mut app, "/settings");
    send_key(&mut app);
    // 「キー割り当て ›」まで下げて開く
    let len = app.settings_rows().len();
    for _ in 0..len {
        if app.settings_rows()[app.settings_view.cursor].target == Target::Page("tuiKeys") {
            break;
        }
        press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    }
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    assert_eq!(app.settings_view.page, "tuiKeys");
    press(&mut app, KeyCode::Esc, KeyModifiers::NONE);
    // 一覧に戻り、開いた行にカーソルが戻る
    assert_eq!(
        (app.screen, app.settings_view.page),
        (Screen::Settings, SETTINGS_TOP)
    );
    assert_eq!(
        app.settings_rows()[app.settings_view.cursor].target,
        Target::Page("tuiKeys")
    );
    // 最後の行で ↓ は画面切替バーの Settings へ。Chat を選ぶと戻る
    for _ in 0..len {
        press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    }
    assert_eq!(app.focus, Focus::Nav(1));
    press(&mut app, KeyCode::Left, KeyModifiers::NONE);
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    assert_eq!((app.screen, app.focus), (Screen::Chat, Focus::Input));
}

#[test]
fn the_enter_keys_page_skips_the_note_and_saves_one_combo() {
    let mut app = make();
    connect(&mut app, 1);
    loaded_settings(&mut app);
    type_text(&mut app, "/settings");
    send_key(&mut app);
    let at = app
        .settings_rows()
        .iter()
        .position(|r| r.target == Target::Page("enterKeys"))
        .unwrap();
    app.edit_setting(at, &mut Vec::new());
    assert_eq!(app.settings_view.page, "enterKeys");
    // 4 つの組み合わせのあとの補足の文には止まらず、バーへ移る
    for _ in 0..3 {
        press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    }
    assert_eq!(app.settings_view.cursor, 3);
    press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    assert!(matches!(app.focus, Focus::Nav(_)));
    app.focus = Focus::Input;
    // Alt+Enter（既定は送信）を「改行」に
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    let effects = press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    assert!(matches!(
        &effects[..],
        [Effect::SaveSetting { save: Save::Pref { key, value, .. }, .. }]
            if key == "enterKeys" && value["alt"] == "newline" && value["enter"] == "newline"
    ));
}

#[test]
fn the_nav_bar_follows_the_gui_nav_items() {
    let mut app = make();
    connect(&mut app, 1);
    assert_eq!(app.nav_items().len(), 2, "読み込むまでは Chat と Settings");
    net(
        &mut app,
        NetEvent::Settings(Ok(Box::new(Loaded {
            device_id: "dev".into(),
            device_name: "n".into(),
            user: serde_json::json!({
                "navBarItems": ["app:search", "app:open-chat", "dice:roll", "app:open-settings"],
                "navBarLabels": {"app:open-chat": "会話"},
            }),
            device: serde_json::json!({}),
        }))),
    );
    let labels: Vec<String> = app.nav_items().into_iter().map(|(_, l)| l).collect();
    assert_eq!(labels, ["Search", "会話", "Settings"]);
    // 最下行の ↓ は、いまの画面（Chat）の項目へ
    press(&mut app, KeyCode::Down, KeyModifiers::NONE);
    assert_eq!(app.focus, Focus::Nav(1));
    press(&mut app, KeyCode::Left, KeyModifiers::NONE);
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    assert_eq!(app.mode, Mode::Search);
    assert_eq!(app.current_nav(), 0);
    // 右端の Settings はクリックでも開く
    app.navbar = Some((30, 90));
    app.on_mouse(
        MouseEvent {
            kind: MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: 89,
            row: 30,
            modifiers: KeyModifiers::NONE,
        },
        &mut Vec::new(),
    );
    assert_eq!(app.screen, Screen::Settings);
    assert_ne!(app.mode, Mode::Search);
    assert_eq!(app.current_nav(), 2);
}

#[test]
fn enter_runs_a_typed_slash_command_even_when_enter_is_newline() {
    let mut app = make();
    connect(&mut app, 1);
    loaded_settings(&mut app);
    type_text(&mut app, "/settings");
    press(&mut app, KeyCode::Enter, KeyModifiers::NONE);
    assert_eq!(app.screen, Screen::Settings);
    assert!(app.input.is_empty());
}
