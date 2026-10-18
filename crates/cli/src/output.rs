use disnans_shared::{Message, User};

/// サーバー由来の文字列を端末にそのまま渡さない。改行も1行内の可視表現にする。
/// JSON 出力には使わず、serde_json に元データを渡す。
pub fn escape_human(input: &str) -> String {
    let mut safe = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '\n' => safe.push_str("\\n"),
            '\r' => safe.push_str("\\r"),
            '\t' => safe.push_str("\\t"),
            '\\' => safe.push_str("\\\\"),
            // ESC、C0、DEL、C1 と双方向テキストの制御文字。
            '\u{0000}'..='\u{001f}'
            | '\u{007f}'..='\u{009f}'
            | '\u{200e}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}' => {
                safe.push_str(&format!("\\u{{{:X}}}", c as u32));
            }
            _ => safe.push(c),
        }
    }
    safe
}

pub fn human_user(user: &User) -> String {
    format!(
        "{} ({}) [{}]",
        escape_human(&user.display_name),
        escape_human(&user.login_name),
        escape_human(&user.id)
    )
}

pub fn human_messages(messages: &[Message], users: &[User]) -> String {
    if messages.is_empty() {
        return "メッセージはありません".to_owned();
    }
    let mut lines = Vec::with_capacity(messages.len());
    for message in messages {
        let author = users
            .iter()
            .find(|user| user.id == message.author_id)
            .map_or(message.author_id.as_str(), |user| {
                user.display_name.as_str()
            });
        let mut line = format!(
            "[{}] {} [{}]: {}",
            crate::timefmt::format_full(message.created_at),
            escape_human(author),
            escape_human(&message.id),
            escape_human(&message.body)
        );
        if let Some(bot) = &message.bot {
            line.push_str(&format!(" [bot: {}]", escape_human(&bot.name)));
        }
        if let Some(reply_id) = &message.reply_to {
            line.push_str(&format!(" [返信: {}]", escape_human(reply_id)));
        }
        if let Some(card) = &message.card {
            line.push_str(&format!(
                " [カード: {} — {}]",
                escape_human(&card.title),
                escape_human(&card.text)
            ));
        }
        if !message.attachments.is_empty() {
            let names = message
                .attachments
                .iter()
                .map(|attachment| escape_human(&attachment.file_name))
                .collect::<Vec<_>>()
                .join(", ");
            line.push_str(&format!(" [添付: {names}]"));
        }
        lines.push(line);
    }
    lines.join("\n")
}

pub fn json_value<T: serde::Serialize>(value: &T) -> Result<String, serde_json::Error> {
    let json = serde_json::to_string(value)?;
    // serde_json は C0 を逃がすが、C1 や双方向テキスト制御は UTF-8 のまま出す。
    // JSON の文字列内の生コードポイントだけを Unicode エスケープにして、復元後の値は変えない。
    let mut safe = String::with_capacity(json.len());
    for c in json.chars() {
        if c.is_control()
            || matches!(c, '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            safe.push_str(&format!("\\u{:04X}", c as u32));
        } else {
            safe.push(c);
        }
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use disnans_shared::{Attachment, MessageCard};

    fn message(body: &str) -> Message {
        Message {
            id: "01JXYZ".into(),
            author_id: "01AUTHOR".into(),
            reply_to: None,
            reply_preview: None,
            body: body.into(),
            attachments: vec![],
            reactions: vec![],
            created_at: 1_800_000_000_000,
            edited_at: None,
            card: None,
            bot: None,
        }
    }

    #[test]
    fn sanitizes_terminal_sequences_and_direction_changes_in_human_output() {
        let unsafe_text = "こんにちは\u{1b}[31m\r上書き\n次\t\u{85}\u{202e}etc\\a";
        let sanitized = escape_human(unsafe_text);
        assert_eq!(
            sanitized,
            "こんにちは\\u{1B}[31m\\r上書き\\n次\\t\\u{85}\\u{202E}etc\\\\a"
        );
        assert!(!sanitized.chars().any(|c| c.is_control()));
    }

    #[test]
    fn human_output_sanitizes_every_server_supplied_field() {
        let mut msg = message("本文\u{1b}!");
        msg.author_id = "作者\n変化".into();
        msg.id = "id\u{9b}0m".into();
        msg.reply_to = Some("返信\r先".into());
        msg.card = Some(MessageCard {
            session_id: "s".into(),
            plugin: "dice".into(),
            title: "題\u{1b}[2J".into(),
            text: "本文\n2".into(),
        });
        msg.attachments.push(Attachment {
            id: "f".into(),
            file_name: "写真\u{1b}[31m.png".into(),
            mime: "image/png".into(),
            size: 2,
            width: None,
            height: None,
            has_thumb: false,
        });
        let rendered = human_messages(&[msg], &[]);
        assert!(rendered.contains("[カード: 題\\u{1B}[2J — 本文\\n2]"));
        assert!(rendered.contains("[添付: 写真\\u{1B}[31m.png]"));
        assert!(!rendered.chars().any(|c| c.is_control()));
    }

    #[test]
    fn human_messages_shows_author_name_when_available() {
        let msg = message("こんにちは");
        let author = User {
            id: msg.author_id.clone(),
            login_name: "alice@example.test".into(),
            display_name: "Alice".into(),
            avatar_url: None,
            created_at: 0,
        };
        assert!(human_messages(&[msg], &[author]).contains("Alice [01JXYZ]: こんにちは"));
    }

    #[test]
    fn json_preserves_original_data_with_json_escapes() {
        let msg = message("生\u{1b}[2J\n続き\u{009b}\u{202e}");
        let json = json_value(&vec![msg]).unwrap();
        assert!(!json.contains('\u{1b}'));
        assert!(!json.contains('\u{009b}'));
        assert!(!json.contains('\u{202e}'));
        assert!(json.contains("\\u001b"));
        assert!(json.contains("\\u009B"));
        assert!(json.contains("\\u202E"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&json).unwrap()[0]["body"],
            "生\u{1b}[2J\n続き\u{009b}\u{202e}"
        );
    }
}
