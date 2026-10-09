//! 自分のアバターの設定・配信・削除の結合テスト。

mod common;

use std::io::Cursor;

use common::TestServer;
use disnans_server::store::users;
use disnans_shared::{ApiError, ServerEvent, User};
use image::{ImageFormat, Rgb, RgbImage};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

fn png(width: u32, height: u32) -> Vec<u8> {
    let img = RgbImage::from_fn(width, height, |x, _| Rgb([(x % 256) as u8, 0, 0]));
    let mut out = Vec::new();
    img.write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
        .unwrap();
    out
}

async fn put_avatar(server: &TestServer, user: &str, data: Vec<u8>) -> reqwest::Response {
    let part = reqwest::multipart::Part::bytes(data).file_name("me.png");
    let form = reqwest::multipart::Form::new().part("file", part);
    server
        .http
        .put(server.url("/api/me/avatar"))
        .header("X-Dev-User", user)
        .multipart(form)
        .send()
        .await
        .unwrap()
}

async fn error_code(res: reqwest::Response) -> (u16, String) {
    let status = res.status().as_u16();
    (status, res.json::<ApiError>().await.unwrap().code)
}

#[tokio::test]
async fn set_and_clear_avatar() {
    let server = TestServer::start().await;
    let me: User = server.get_json(ALICE, "/api/me").await;
    // Tailscale のプロフィール画像があることにする（開発モードでは whois を使わないので直接呼ぶ）
    let tailscale_url = "https://example.com/alice.png";
    let (user, changed) =
        users::get_or_create(&server.state.pool, ALICE, "alice", Some(tailscale_url))
            .await
            .unwrap();
    assert!(changed);
    assert_eq!(user.avatar_url.as_deref(), Some(tailscale_url));
    let mut bob = server.ws(BOB).await;

    // 横長の画像は、中央を正方形に切り抜いて 256px にする
    let res = put_avatar(&server, ALICE, png(800, 400)).await;
    assert_eq!(res.status(), 200);
    let user: User = res.json().await.unwrap();
    let url = user.avatar_url.clone().unwrap();
    assert!(url.starts_with("/api/avatars/"), "{url}");
    let ServerEvent::UserUpdated { user: updated } = bob.recv().await else {
        panic!()
    };
    assert_eq!(updated.id, me.id);
    assert_eq!(updated.avatar_url.as_deref(), Some(url.as_str()));

    let res = server.get(BOB, &url).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/webp");
    let body = res.bytes().await.unwrap();
    let decoded = image::load_from_memory_with_format(&body, ImageFormat::WebP).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (256, 256));

    // 一覧にも出る
    let list: Vec<User> = server.get_json(BOB, "/api/users").await;
    let alice = list.iter().find(|u| u.id == me.id).unwrap();
    assert_eq!(alice.avatar_url.as_deref(), Some(url.as_str()));

    // Tailscale のプロフィール画像が変わっても、自分で設定したものは上書きしない
    let (user, changed) = users::get_or_create(
        &server.state.pool,
        ALICE,
        "alice",
        Some("https://example.com/alice2.png"),
    )
    .await
    .unwrap();
    assert!(!changed);
    assert_eq!(user.avatar_url.as_deref(), Some(url.as_str()));

    // 設定し直すと URL が変わり、前のファイルは消える
    let res = put_avatar(&server, ALICE, png(100, 300)).await;
    let user: User = res.json().await.unwrap();
    let url2 = user.avatar_url.unwrap();
    assert_ne!(url2, url);
    bob.recv_until(|e| matches!(e, ServerEvent::UserUpdated { .. }))
        .await;
    let res = server.get(BOB, &url).send().await.unwrap();
    assert_eq!(res.status(), 404);
    let body = server
        .get(BOB, &url2)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let decoded = image::load_from_memory_with_format(&body, ImageFormat::WebP).unwrap();
    // 256px より小さければ拡大しない
    assert_eq!((decoded.width(), decoded.height()), (100, 100));

    // 消すと、最新の Tailscale のプロフィール画像に戻る
    let res = server.delete(ALICE, "/api/me/avatar").send().await.unwrap();
    assert_eq!(res.status(), 200);
    let user: User = res.json().await.unwrap();
    assert_eq!(
        user.avatar_url.as_deref(),
        Some("https://example.com/alice2.png")
    );
    let ServerEvent::UserUpdated { user: updated } = bob.recv().await else {
        panic!()
    };
    assert_eq!(
        updated.avatar_url.as_deref(),
        Some("https://example.com/alice2.png")
    );
    let res = server.get(BOB, &url2).send().await.unwrap();
    assert_eq!(res.status(), 404);

    // 設定していないときに消しても何も起きない
    let res = server.delete(ALICE, "/api/me/avatar").send().await.unwrap();
    assert_eq!(res.status(), 200);
    bob.assert_silent(std::time::Duration::from_millis(200))
        .await;
}

#[tokio::test]
async fn rejects_invalid_avatars() {
    let server = TestServer::start().await;

    let res = put_avatar(&server, ALICE, b"not an image".to_vec()).await;
    assert_eq!(error_code(res).await, (400, "invalid_image".into()));

    let form = reqwest::multipart::Form::new().text("other", "x");
    let res = server
        .http
        .put(server.url("/api/me/avatar"))
        .header("X-Dev-User", ALICE)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "missing_file".into()));

    let me: User = server.get_json(ALICE, "/api/me").await;
    assert_eq!(me.avatar_url, None);

    for path in [
        "/api/avatars/nope",
        "/api/avatars/..%2Fdisnans.db",
        "/api/avatars/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ] {
        let res = server.get(ALICE, path).send().await.unwrap();
        assert_eq!(res.status(), 404, "{path}");
    }
}
