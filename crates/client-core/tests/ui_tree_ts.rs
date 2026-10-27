//! 画面の構造（`view::ui` の `SETTINGS_PAGES`・`NAV_ITEMS`）を、GUI 用の TypeScript（`app/src/lib/uiTree.generated.ts`）に書き出す。
//! 絵文字の表（emoji_names_ts.rs）と同じく `cargo test` で書き出し、scripts/check-rust.sh と CI が差分を見る。手で直さない。

use disnans_client_core::view::ui::{NAV_ITEMS, SETTINGS_PAGES};

fn generated_source() -> String {
    let pages = serde_json::to_string_pretty(SETTINGS_PAGES).expect("pages serialize");
    let nav = serde_json::to_string_pretty(NAV_ITEMS).expect("nav serializes");
    format!(
        "// 自動生成（crates/client-core/src/view/ui.rs の SETTINGS_PAGES・NAV_ITEMS）。手で編集しない。\n\
         // 更新: cargo test -p disnans-client-core（scripts/check-rust.sh が差分を確かめる）。説明は docs/design/ui-tree.md\n\n\
         import type {{ UiNavItem, UiPage }} from './uiTree';\n\n\
         /** 設定のページ（先頭がトップ）。値は持たない（GUI は lib/settingsBindings.svelte.ts で差し込む） */\n\
         export const SETTINGS_PAGES: readonly UiPage[] = {pages};\n\n\
         /** ナビゲーションバーに出せる本体の項目 */\n\
         export const NAV_ITEMS: readonly UiNavItem[] = {nav};\n"
    )
}

#[test]
fn writes_the_gui_ui_tree_file() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../app/src/lib/uiTree.generated.ts"
    );
    std::fs::write(path, generated_source()).unwrap_or_else(|e| panic!("{path}: {e}"));
}
