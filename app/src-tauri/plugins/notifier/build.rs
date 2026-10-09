// コマンドの実体は Kotlin（android/）にある。ここでは権限の生成だけをする
const COMMANDS: &[&str] = &[
    "start",
    "stop",
    "start_call",
    "stop_call",
    "status",
    "request_permission",
    "open_battery_settings",
    "take_launch_target",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
