//! 絵文字の表（`view::emoji::EMOJI_NAMES`）を、GUI 用の TypeScript（`app/src/lib/emojiNames.generated.ts`）に書き出す。
//! ts-rs（`app/src/lib/protocol/`）と同じく `cargo test` で書き出し、scripts/check-rust.sh が差分を見る。手で直さない。

use std::fmt::Write;

use disnans_client_core::view::emoji::EMOJI_NAMES;

fn ts_string(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

fn generated_source() -> String {
    let mut out = String::new();
    out.push_str(
        "// 自動生成（crates/client-core/src/view/emoji.rs の EMOJI_NAMES）。手で編集しない。\n",
    );
    out.push_str(
        "// 更新: cargo test -p disnans-client-core（scripts/check-rust.sh が差分を確かめる）\n\n",
    );
    out.push_str("/** 絵文字と、その英語名（`:名前` の補完に使う）。先頭の名前が代表の名前。 */\n");
    out.push_str("export const EMOJI_NAMES: Record<string, string[]> = {\n");
    for (emoji, names) in EMOJI_NAMES {
        let names: Vec<String> = names.iter().map(|n| ts_string(n)).collect();
        writeln!(out, "  {}: [{}],", ts_string(emoji), names.join(", ")).unwrap();
    }
    out.push_str("};\n");
    out
}

#[test]
fn writes_the_gui_emoji_names_file() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../app/src/lib/emojiNames.generated.ts"
    );
    std::fs::write(path, generated_source()).unwrap_or_else(|e| panic!("{path}: {e}"));
}
