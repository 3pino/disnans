//! 自分の設定（`/api/me/prefs`）の保存・配信の結合テスト。

mod common;

use std::time::Duration;

use common::TestServer;
use disnans_shared::{ApiError, ServerEvent};
use serde_json::{Value, json};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

async fn error_code(res: reqwest::Response) -> (u16, String) {
    let status = res.status().as_u16();
    (status, res.json::<ApiError>().await.unwrap().code)
}

#[tokio::test]
async fn prefs_are_saved_per_user_and_pushed_to_own_devices() {
    let server = TestServer::start().await;

    // まだ保存していなければ空のオブジェクト
    let prefs: Value = server.get_json(ALICE, "/api/me/prefs").await;
    assert_eq!(prefs, json!({}));

    // 自分の別の端末と、ほかの人（先に作っておき、ユーザーが増えた知らせを読み飛ばす）
    let _: Value = server.get_json(BOB, "/api/me/prefs").await;
    let mut alice_pc = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;

    let body = json!({
        "hotkeys": { "app:open-settings": "Mod+,", "dice:quick-roll": "" },
        "enterKeys": { "enter": "newline", "ctrl": "send" },
    });
    let res = server
        .put_json(ALICE, "/api/me/prefs", &body)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.json::<Value>().await.unwrap(), body);

    // 自分の接続にだけ届く
    let ServerEvent::PrefsUpdated { prefs } = alice_pc.recv().await else {
        panic!()
    };
    assert_eq!(prefs, body);
    bob.assert_silent(Duration::from_millis(200)).await;

    // 読み直しても同じ。ほかの人の設定は別
    let prefs: Value = server.get_json(ALICE, "/api/me/prefs").await;
    assert_eq!(prefs, body);
    let prefs: Value = server.get_json(BOB, "/api/me/prefs").await;
    assert_eq!(prefs, json!({}));

    // まるごと置き換える
    let body2 = json!({ "hotkeys": {} });
    let res = server
        .put_json(ALICE, "/api/me/prefs", &body2)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let prefs: Value = server.get_json(ALICE, "/api/me/prefs").await;
    assert_eq!(prefs, body2);
}

#[tokio::test]
async fn invalid_prefs_are_rejected() {
    let server = TestServer::start().await;

    // オブジェクトでないもの
    for body in [json!([1, 2]), json!("text"), json!(null), json!(1)] {
        let res = server
            .put_json(ALICE, "/api/me/prefs", &body)
            .send()
            .await
            .unwrap();
        assert_eq!(
            error_code(res).await,
            (400, "invalid_prefs".into()),
            "{body}"
        );
    }

    // JSON でないもの
    let res = server
        .http
        .put(server.url("/api/me/prefs"))
        .header("X-Dev-User", ALICE)
        .header("Content-Type", "application/json")
        .body("{")
        .send()
        .await
        .unwrap();
    assert!(res.status().is_client_error());

    // 大きすぎるもの
    let big = json!({ "x": "a".repeat(70 * 1024) });
    let res = server
        .put_json(ALICE, "/api/me/prefs", &big)
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (413, "prefs_too_large".into()));

    // 断ったものは保存されない
    let prefs: Value = server.get_json(ALICE, "/api/me/prefs").await;
    assert_eq!(prefs, json!({}));
}
