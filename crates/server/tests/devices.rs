//! 端末ごとの設定（`/api/me/devices`）の結合テスト。

mod common;

use common::TestServer;
use disnans_shared::{ApiError, DeviceInfo, DevicePrefs, PutDevice, PutDevicePrefs};
use serde_json::json;

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

async fn error_code(res: reqwest::Response) -> (u16, String) {
    let status = res.status().as_u16();
    (status, res.json::<ApiError>().await.unwrap().code)
}

async fn register(server: &TestServer, user: &str, device: &str, name: &str) -> DeviceInfo {
    let res = server
        .put_json(
            user,
            &format!("/api/me/devices/{device}"),
            &PutDevice { name: name.into() },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn save(
    server: &TestServer,
    user: &str,
    device: &str,
    prefs: serde_json::Value,
) -> reqwest::Response {
    server
        .put_json(
            user,
            &format!("/api/me/devices/{device}/prefs"),
            &PutDevicePrefs { prefs },
        )
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn register_list_rename_and_delete() {
    let server = TestServer::start().await;
    let first = register(&server, ALICE, "pc-1", "デスクトップ").await;
    assert_eq!(first.name, "デスクトップ");
    assert!(!first.has_prefs);
    register(&server, ALICE, "phone-1", "スマホ").await;

    // 名前の変更は登録し直しと同じ。作成日は変わらない
    let renamed = register(&server, ALICE, "pc-1", "  書斎  ").await;
    assert_eq!(renamed.name, "書斎");
    assert_eq!(renamed.created_at, first.created_at);

    let list: Vec<DeviceInfo> = server.get_json(ALICE, "/api/me/devices").await;
    assert_eq!(list.len(), 2);
    assert!(
        list.iter()
            .any(|d| d.device_id == "pc-1" && d.name == "書斎")
    );

    let res = server
        .delete(ALICE, "/api/me/devices/pc-1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let res = server
        .delete(ALICE, "/api/me/devices/pc-1")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));
    let list: Vec<DeviceInfo> = server.get_json(ALICE, "/api/me/devices").await;
    assert_eq!(list.len(), 1);
}

#[tokio::test]
async fn prefs_are_replaced_whole_and_track_last_seen() {
    let server = TestServer::start().await;
    register(&server, ALICE, "pc-1", "pc").await;

    // まだ保存していなければ 404（取得の側で空として扱う）
    let res = server
        .get(ALICE, "/api/me/devices/pc-1/prefs")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));

    let res = save(&server, ALICE, "pc-1", json!({ "shortcut": "ctrl+enter" })).await;
    assert_eq!(res.status(), 200);
    let saved: DevicePrefs = res.json().await.unwrap();
    assert_eq!(saved.prefs, json!({ "shortcut": "ctrl+enter" }));

    // まるごと置き換え（前の値は残らない）
    save(&server, ALICE, "pc-1", json!({ "devDir": "/tmp/x" })).await;
    let got: DevicePrefs = server.get_json(ALICE, "/api/me/devices/pc-1/prefs").await;
    assert_eq!(got.prefs, json!({ "devDir": "/tmp/x" }));
    assert!(got.updated_at >= saved.updated_at);

    // 一覧には has_prefs として出る
    let list: Vec<DeviceInfo> = server.get_json(ALICE, "/api/me/devices").await;
    assert!(list[0].has_prefs);
}

#[tokio::test]
async fn other_users_devices_are_invisible() {
    let server = TestServer::start().await;
    register(&server, ALICE, "pc-1", "alice の pc").await;
    save(&server, ALICE, "pc-1", json!({ "a": 1 })).await;

    // bob は alice の端末を一覧でも、設定でも、消すのでも見えない
    let list: Vec<DeviceInfo> = server.get_json(BOB, "/api/me/devices").await;
    assert!(list.is_empty());
    let res = server
        .get(BOB, "/api/me/devices/pc-1/prefs")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));
    let res = save(&server, BOB, "pc-1", json!({ "b": 2 })).await;
    assert_eq!(error_code(res).await, (404, "not_found".into()));
    let res = server
        .delete(BOB, "/api/me/devices/pc-1")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    // alice の設定は変わっていない
    let got: DevicePrefs = server.get_json(ALICE, "/api/me/devices/pc-1/prefs").await;
    assert_eq!(got.prefs, json!({ "a": 1 }));
}

#[tokio::test]
async fn deleting_a_device_removes_its_prefs_and_later_access_is_404() {
    let server = TestServer::start().await;
    register(&server, ALICE, "pc-1", "pc").await;
    save(&server, ALICE, "pc-1", json!({ "a": 1 })).await;
    server
        .delete(ALICE, "/api/me/devices/pc-1")
        .send()
        .await
        .unwrap();

    let res = save(&server, ALICE, "pc-1", json!({ "a": 2 })).await;
    assert_eq!(error_code(res).await, (404, "not_found".into()));
    let res = server
        .get(ALICE, "/api/me/devices/pc-1/prefs")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));

    // 同じ ID で登録し直すと、古い設定は残っていない
    register(&server, ALICE, "pc-1", "pc").await;
    let res = server
        .get(ALICE, "/api/me/devices/pc-1/prefs")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));
}

#[tokio::test]
async fn invalid_ids_names_and_prefs_are_refused() {
    let server = TestServer::start().await;

    // 端末 ID は 1〜64 文字の英数字とハイフン
    for bad in ["a_b", "%20x", &"x".repeat(65)] {
        let res = server
            .put_json(
                ALICE,
                &format!("/api/me/devices/{bad}"),
                &PutDevice { name: "n".into() },
            )
            .send()
            .await
            .unwrap();
        assert_eq!(
            error_code(res).await,
            (400, "invalid_device_id".into()),
            "{bad}"
        );
    }

    let res = server
        .put_json(
            "alice@test",
            "/api/me/devices/pc-1",
            &PutDevice { name: "   ".into() },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "invalid_device_name".into()));
    let res = server
        .put_json(
            ALICE,
            "/api/me/devices/pc-1",
            &PutDevice {
                name: "x".repeat(65),
            },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "device_name_too_long".into()));

    register(&server, ALICE, "pc-1", "pc").await;
    let res = save(&server, ALICE, "pc-1", json!([1, 2])).await;
    assert_eq!(error_code(res).await, (400, "invalid_prefs".into()));
    let big = json!({ "big": "x".repeat(96 * 1024) });
    let res = save(&server, ALICE, "pc-1", big).await;
    assert_eq!(error_code(res).await, (413, "prefs_too_large".into()));
}

#[tokio::test]
async fn a_user_has_at_most_fifty_devices() {
    let server = TestServer::start().await;
    for i in 0..50 {
        register(&server, ALICE, &format!("d{i}"), "d").await;
    }
    let res = server
        .put_json(
            ALICE,
            "/api/me/devices/d50",
            &PutDevice { name: "d".into() },
        )
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (409, "too_many_devices".into()));

    // 既にある端末の名前は変えられる。他人の上限は別
    register(&server, ALICE, "d0", "renamed").await;
    register(&server, BOB, "d50", "bob").await;

    // 消せば、また登録できる
    server
        .delete(ALICE, "/api/me/devices/d1")
        .send()
        .await
        .unwrap();
    register(&server, ALICE, "d50", "d").await;
}
