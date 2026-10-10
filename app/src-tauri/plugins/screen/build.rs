// コマンドの実体は Kotlin（android/）にある。ここでは権限の生成だけをする
const COMMANDS: &[&str] = &[
    "start_capture",
    "update_capture",
    "stop_capture",
    "enter_pip",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
