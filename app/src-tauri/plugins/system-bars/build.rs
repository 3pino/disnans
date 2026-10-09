// コマンドの実体は Kotlin（android/）にある。ここでは権限の生成だけをする
const COMMANDS: &[&str] = &["set_style", "set_navigation_bar_hidden"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
