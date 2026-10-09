//! ファイルのアップロード・配信・削除の結合テスト。

mod common;

use std::io::Cursor;

use common::TestServer;
use disnans_server::files;
use disnans_shared::{ApiError, Attachment, ClientEvent, ServerEvent};
use image::codecs::gif::GifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::{Delay, Frame, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";
/// EXIF に埋め込む目印。変換後のファイルに残っていてはいけない。
const SECRET: &[u8] = b"SECRET-GPS-35.6812N-139.7671E";

async fn upload(
    server: &TestServer,
    user: &str,
    name: &str,
    mime: &str,
    data: Vec<u8>,
) -> Attachment {
    let part = reqwest::multipart::Part::bytes(data)
        .file_name(name.to_owned())
        .mime_str(mime)
        .unwrap();
    let form = reqwest::multipart::Form::new().part("file", part);
    let res = server
        .http
        .post(server.url("/api/files"))
        .header("X-Dev-User", user)
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    res.json().await.unwrap()
}

/// 横長の JPEG を作り、「90° 回転して表示する」（Orientation = 6）EXIF を埋め込む。
fn jpeg_with_exif(width: u32, height: u32) -> Vec<u8> {
    let img = RgbImage::from_fn(width, height, |x, y| {
        Rgb([(x % 256) as u8, (y % 256) as u8, 128])
    });
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 90)
        .encode_image(&img)
        .unwrap();

    // APP1 (Exif): ビッグエンディアンの TIFF、IFD0 に Orientation = 6 だけ。後ろに目印を付ける
    let mut tiff = b"MM\x00\x2a\x00\x00\x00\x08".to_vec();
    tiff.extend_from_slice(&[0x00, 0x01]); // エントリー数
    tiff.extend_from_slice(&[
        0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00,
    ]);
    tiff.extend_from_slice(&[0x00, 0x00, 0x00, 0x00]); // 次の IFD なし
    tiff.extend_from_slice(SECRET);
    let mut payload = b"Exif\x00\x00".to_vec();
    payload.extend_from_slice(&tiff);
    let mut app1 = vec![0xFF, 0xE1];
    app1.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    app1.extend_from_slice(&payload);

    // SOI の直後に差し込む
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[tokio::test]
async fn still_image_becomes_rotated_lossy_webp_without_exif() {
    let server = TestServer::start().await;
    let jpeg = jpeg_with_exif(2800, 400);
    assert!(contains(&jpeg, SECRET));

    let att = upload(&server, ALICE, "IMG_0001.JPG", "image/jpeg", jpeg).await;
    assert_eq!(att.mime, "image/webp");
    assert_eq!(att.file_name, "IMG_0001.webp");
    assert!(att.has_thumb);
    // 回転（400x2800）してから、長辺を 2560 に縮小する
    assert_eq!((att.width, att.height), (Some(366), Some(2560)));

    let res = server
        .get(ALICE, &format!("/api/files/{}", att.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/webp");
    assert!(
        res.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("inline")
    );
    let body = res.bytes().await.unwrap();
    assert_eq!(body.len() as u64, att.size);
    assert_eq!(&body[..4], b"RIFF");
    assert_eq!(&body[8..12], b"WEBP");
    assert_eq!(&body[12..16], b"VP8 ", "非可逆（VP8）の WebP であること");
    assert!(!contains(&body, b"EXIF") && !contains(&body, b"Exif"));
    assert!(!contains(&body, SECRET));
    let decoded = image::load_from_memory_with_format(&body, ImageFormat::WebP).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (366, 2560));

    let res = server
        .get(ALICE, &format!("/api/files/{}/thumb", att.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/webp");
    let thumb = image::load_from_memory_with_format(&res.bytes().await.unwrap(), ImageFormat::WebP)
        .unwrap();
    assert_eq!(thumb.height(), 480);
    assert!(thumb.width() <= 480);
}

#[tokio::test]
async fn small_image_is_not_upscaled() {
    let server = TestServer::start().await;
    let png = {
        let img = RgbaImage::from_pixel(300, 200, Rgba([10, 20, 30, 128]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    };
    let att = upload(&server, ALICE, "small.png", "image/png", png).await;
    assert_eq!((att.width, att.height), (Some(300), Some(200)));
    assert_eq!(att.mime, "image/webp");
}

#[tokio::test]
async fn animated_gif_is_stored_as_is() {
    let server = TestServer::start().await;
    let gif = {
        let mut out = Vec::new();
        let mut encoder = GifEncoder::new(&mut out);
        let frames = [Rgba([255, 0, 0, 255]), Rgba([0, 0, 255, 255])].map(|color| {
            Frame::from_parts(
                RgbaImage::from_pixel(64, 32, color),
                0,
                0,
                Delay::from_numer_denom_ms(100, 1),
            )
        });
        encoder.encode_frames(frames).unwrap();
        drop(encoder);
        out
    };
    let att = upload(&server, ALICE, "anim.gif", "image/gif", gif.clone()).await;
    assert_eq!(att.mime, "image/gif");
    assert_eq!(att.file_name, "anim.gif");
    assert_eq!((att.width, att.height), (Some(64), Some(32)));
    assert!(att.has_thumb);

    let body = server
        .get(ALICE, &format!("/api/files/{}", att.id))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(body.as_ref(), gif.as_slice());
}

#[tokio::test]
async fn other_files_are_stored_as_is_and_downloaded() {
    let server = TestServer::start().await;
    let att = upload(&server, ALICE, "メモ.txt", "text/plain", b"hello".to_vec()).await;
    assert_eq!(att.mime, "text/plain");
    assert_eq!(att.file_name, "メモ.txt");
    assert_eq!(att.size, 5);
    assert!(!att.has_thumb);
    assert_eq!(att.width, None);

    let res = server
        .get(ALICE, &format!("/api/files/{}", att.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "text/plain");
    let disposition = res.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(disposition.starts_with("attachment;"), "{disposition}");
    assert!(disposition.contains("filename*=UTF-8''%E3%83%A1%E3%83%A2%2Etxt"));
    assert_eq!(res.bytes().await.unwrap().as_ref(), b"hello");

    let res = server
        .get(ALICE, &format!("/api/files/{}/thumb", att.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    let res = server.get(ALICE, "/api/files/NOPE").send().await.unwrap();
    assert_eq!(res.status(), 404);
    assert_eq!(res.json::<ApiError>().await.unwrap().code, "not_found");
}

#[tokio::test]
async fn attachments_follow_their_message() {
    let server = TestServer::start().await;
    let mut alice = server.ws(ALICE).await;
    let mut bob = server.ws(BOB).await;
    alice.recv().await;

    let a = upload(&server, ALICE, "a.txt", "text/plain", b"a".to_vec()).await;
    let b = upload(&server, ALICE, "b.txt", "text/plain", b"b".to_vec()).await;
    let bobs = upload(&server, BOB, "c.txt", "text/plain", b"c".to_vec()).await;

    // 他人のファイルは添付できない
    alice
        .send(ClientEvent::MessageSend {
            client_id: "x".into(),
            thread_id: None,
            body: String::new(),
            attachment_ids: vec![bobs.id.clone()],
            start_thread: false,
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "invalid_attachment");

    // 本文が空でも、添付ファイルがあれば送れる。並び順は指定した順
    let root = alice
        .post_with(ClientEvent::MessageSend {
            client_id: "root".into(),
            thread_id: None,
            body: String::new(),
            attachment_ids: vec![b.id.clone(), a.id.clone()],
            start_thread: true,
        })
        .await;
    assert_eq!(
        root.attachments
            .iter()
            .map(|x| x.id.as_str())
            .collect::<Vec<_>>(),
        [b.id.as_str(), a.id.as_str()]
    );

    // 一度添付したファイルは、もう添付できない
    alice
        .send(ClientEvent::MessageSend {
            client_id: "again".into(),
            thread_id: None,
            body: "again".into(),
            attachment_ids: vec![a.id.clone()],
            start_thread: false,
        })
        .await;
    assert_eq!(alice.expect_error().await.1, "invalid_attachment");

    // スレッドの返信に bob のファイルを付ける
    let reply = bob
        .post_with(ClientEvent::MessageSend {
            client_id: "reply".into(),
            thread_id: Some(root.id.clone()),
            body: "file".into(),
            attachment_ids: vec![bobs.id.clone()],
            start_thread: false,
        })
        .await;
    assert_eq!(reply.attachments.len(), 1);

    // 起点を消すと、返信の添付ファイルもディスクから消える
    alice
        .send(ClientEvent::MessageDelete {
            message_id: root.id.clone(),
        })
        .await;
    alice
        .recv_until(|e| matches!(e, ServerEvent::MessageDeleted { .. }))
        .await;
    for id in [&a.id, &b.id, &bobs.id] {
        let res = server
            .get(ALICE, &format!("/api/files/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 404);
        assert!(!files::file_path(&server.state.config, id).exists());
    }
}

#[tokio::test]
async fn orphan_uploads_are_cleaned_up() {
    let server = TestServer::start().await;
    let old = upload(&server, ALICE, "old.png", "image/png", {
        let mut out = Cursor::new(Vec::new());
        RgbImage::new(10, 10)
            .write_to(&mut out, ImageFormat::Png)
            .unwrap();
        out.into_inner()
    })
    .await;
    let fresh = upload(&server, ALICE, "fresh.txt", "text/plain", b"x".to_vec()).await;

    // 25時間前にアップロードされたことにする
    sqlx::query("UPDATE files SET created_at = created_at - ? WHERE id = ?")
        .bind(25 * 60 * 60 * 1000_i64)
        .bind(&old.id)
        .execute(&server.state.pool)
        .await
        .unwrap();

    let config = &server.state.config;
    assert!(files::thumb_path(config, &old.id).exists());
    assert_eq!(files::cleanup_orphans(&server.state).await.unwrap(), 1);
    assert!(!files::file_path(config, &old.id).exists());
    assert!(!files::thumb_path(config, &old.id).exists());
    assert!(files::file_path(config, &fresh.id).exists());
    let res = server
        .get(ALICE, &format!("/api/files/{}", old.id))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn upload_requires_file_field() {
    let server = TestServer::start().await;
    let form = reqwest::multipart::Form::new().text("other", "x");
    let res = server
        .http
        .post(server.url("/api/files"))
        .multipart(form)
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
    assert_eq!(res.json::<ApiError>().await.unwrap().code, "missing_file");
}
