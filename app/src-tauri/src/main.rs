// リリースビルドの Windows でコンソールを出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    disnans_app_lib::run()
}
