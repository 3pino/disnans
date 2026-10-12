//! `watch` の出力整形。メインチャットの投稿・編集・削除と、接続の区切りだけを扱う。

use disnans_shared::ServerEvent;
use serde_json::{Value, json};

use crate::output;

/// 標準出力へ出す行。主チャット以外・通話・プラグイン等は `None`。
/// 保存済みの履歴を復元する出力ではなく、接続中に届いたものだけ。
pub fn event_line(generation: u64, event: &ServerEvent, json_mode: bool) -> Option<String> {
    match event {
        ServerEvent::MessageCreated { message, .. } if message.thread_id.is_none() => {
            Some(if json_mode {
                json_line(
                    json!({"type": "message.created", "generation": generation, "message": message}),
                )
            } else {
                format!(
                    "新着 {}",
                    output::human_messages(std::slice::from_ref(message), &[])
                )
            })
        }
        ServerEvent::MessageUpdated { message } if message.thread_id.is_none() => {
            Some(if json_mode {
                json_line(
                    json!({"type": "message.updated", "generation": generation, "message": message}),
                )
            } else {
                format!(
                    "更新 {}",
                    output::human_messages(std::slice::from_ref(message), &[])
                )
            })
        }
        ServerEvent::MessageDeleted {
            message_id,
            thread_id: None,
        } => Some(if json_mode {
            json_line(
                json!({"type": "message.deleted", "generation": generation, "message_id": message_id}),
            )
        } else {
            format!("削除 [{}]", output::escape_human(message_id))
        }),
        _ => None,
    }
}

pub fn connected_line(generation: u64, json_mode: bool) -> String {
    if json_mode {
        json_line(json!({"type": "stream.connected", "generation": generation}))
    } else {
        format!("-- 接続しました (世代 {generation})")
    }
}

/// `reason` が `lagged` のときは購読が生きたまま取りこぼしたので、すぐ再取得できる。
/// それ以外は切断の通知で、次の `stream.connected`（世代 2 以降）までのイベントは失われうる。
pub fn gap_line(generation: u64, reason: &str, json_mode: bool) -> String {
    if json_mode {
        json_line(json!({"type": "stream.gap", "generation": generation, "reason": reason}))
    } else if reason == "lagged" {
        format!(
            "-- 取りこぼしの可能性あり (世代 {generation}): 今すぐ `disnans messages` で再取得してください"
        )
    } else {
        format!(
            "-- 切断 (世代 {generation}): {}。次の接続通知の後に `disnans messages` で再取得してください",
            output::escape_human(reason)
        )
    }
}

fn json_line(value: Value) -> String {
    // serde_json の Value 化は失敗しない。1行に収め、C1/bidi は \u エスケープする。
    output::json_value(&value).unwrap_or_else(|_| "{}".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use disnans_shared::Message;

    fn message(thread: Option<&str>, body: &str) -> Message {
        Message {
            id: "m1".into(),
            author_id: "u1".into(),
            thread_id: thread.map(str::to_owned),
            reply_to: None,
            reply_preview: None,
            body: body.into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 1,
            edited_at: None,
            thread: None,
            card: None,
            bot: None,
        }
    }

    #[test]
    fn only_main_chat_message_events_are_emitted_as_one_json_line() {
        let created = ServerEvent::MessageCreated {
            client_id: None,
            message: message(None, "a\nb\u{1b}\u{202e}"),
        };
        let line = event_line(3, &created, true).unwrap();
        assert!(!line.contains('\n') && !line.contains('\u{1b}') && !line.contains('\u{202e}'));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "message.created");
        assert_eq!(value["generation"], 3);
        assert_eq!(value["message"]["body"], "a\nb\u{1b}\u{202e}");

        let thread = ServerEvent::MessageCreated {
            client_id: None,
            message: message(Some("t"), "x"),
        };
        assert!(event_line(1, &thread, true).is_none());
        assert!(event_line(1, &ServerEvent::Pong, true).is_none());
        let deleted = ServerEvent::MessageDeleted {
            message_id: "m1".into(),
            thread_id: None,
        };
        let value: Value = serde_json::from_str(&event_line(1, &deleted, true).unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"type": "message.deleted", "generation": 1, "message_id": "m1"})
        );
        let thread_deleted = ServerEvent::MessageDeleted {
            message_id: "m1".into(),
            thread_id: Some("t".into()),
        };
        assert!(event_line(1, &thread_deleted, true).is_none());
    }

    #[test]
    fn human_lines_are_single_line_and_escape_controls() {
        let line = event_line(
            1,
            &ServerEvent::MessageUpdated {
                message: message(None, "a\n\u{1b}[2J"),
            },
            false,
        )
        .unwrap();
        assert!(line.starts_with("更新 "));
        assert!(!line.chars().any(char::is_control));
        let gap = gap_line(2, "切断\n中", false);
        assert!(!gap.chars().any(char::is_control));
    }

    #[test]
    fn connection_boundaries_are_json_values() {
        assert_eq!(
            connected_line(1, true),
            r#"{"generation":1,"type":"stream.connected"}"#
        );
        let value: Value = serde_json::from_str(&gap_line(2, "lagged", true)).unwrap();
        assert_eq!(
            value,
            json!({"type": "stream.gap", "generation": 2, "reason": "lagged"})
        );
    }
}
