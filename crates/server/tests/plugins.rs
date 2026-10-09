//! プラグインの配布・更新・削除・ファイル配信の結合テスト。

mod common;

use common::TestServer;
use disnans_shared::{ApiError, PluginInfo, PluginKind, PluginVisibility, ServerEvent, User};

const ALICE: &str = "alice@test";
const BOB: &str = "bob@test";

const MAIN_JS: &[u8] = b"export default class extends disnans.Plugin {}";

fn manifest(id: &str, version: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "id": id,
        "name": "ダイス",
        "version": version,
        "description": "サイコロを振る",
        "author": "alice",
    }))
    .unwrap()
}

/// (ファイル名, 中身) の一覧。
type Files<'a> = Vec<(&'a str, Vec<u8>)>;

async fn error_code(res: reqwest::Response) -> (u16, String) {
    let status = res.status().as_u16();
    (status, res.json::<ApiError>().await.unwrap().code)
}

#[tokio::test]
async fn upload_update_and_delete_are_broadcast_without_chat_messages() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut bob = server.ws(BOB).await;

    // 配布
    let m1 = manifest("dice", "1.0.0");
    let res = server
        .upload_plugin(
            ALICE,
            &[
                ("manifest.json", &m1),
                ("main.js", MAIN_JS),
                ("dice/styles.css", b".dice{}"),
            ],
        )
        .await;
    assert_eq!(res.status(), 200);
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.id, "dice");
    assert_eq!(info.name, "ダイス");
    assert_eq!(info.version, "1.0.0");
    assert_eq!(info.description, "サイコロを振る");
    assert_eq!(info.min_api_version, 1);
    assert_eq!(info.files, ["manifest.json", "main.js", "styles.css"]);
    assert_eq!(info.hash.len(), 64);
    assert_eq!(info.updated_by, alice_user.id);

    assert_eq!(info.icon, None);
    assert!(!info.has_icon);

    let ServerEvent::PluginUpdated { plugin } = bob.recv().await else {
        panic!()
    };
    assert_eq!(plugin.hash, info.hash);

    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].hash, info.hash);

    // ファイルの取得
    let res = server
        .get(BOB, "/api/plugins/dice/files/main.js?v=x")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers()["content-type"],
        "application/javascript; charset=utf-8"
    );
    assert_eq!(res.headers()["cache-control"], "no-cache");
    assert_eq!(&res.bytes().await.unwrap()[..], MAIN_JS);
    let res = server
        .get(BOB, "/api/plugins/dice/files/styles.css")
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "text/css");
    let res = server
        .get(BOB, "/api/plugins/dice/files/manifest.json")
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "application/json");
    assert_eq!(&res.bytes().await.unwrap()[..], &m1[..]);
    for path in [
        "/api/plugins/dice/files/other.js",
        "/api/plugins/nope/files/main.js",
        "/api/plugins/..%2F..%2Fdisnans.db/files/main.js",
    ] {
        let res = server.get(BOB, path).send().await.unwrap();
        assert_eq!(res.status(), 404, "{path}");
    }

    // 同じ ID で上書き（styles.css をなくす）
    let m2 = manifest("dice", "1.1.0");
    let res = server
        .upload_plugin(BOB, &[("manifest.json", &m2), ("main.js", b"// v2")])
        .await;
    assert_eq!(res.status(), 200);
    let info2: PluginInfo = res.json().await.unwrap();
    assert_ne!(info2.hash, info.hash);
    assert_eq!(info2.files, ["manifest.json", "main.js"]);
    let ServerEvent::PluginUpdated { plugin } = bob.recv().await else {
        panic!()
    };
    assert_eq!(plugin.version, "1.1.0");

    let res = server
        .get(ALICE, "/api/plugins/dice/files/main.js")
        .send()
        .await
        .unwrap();
    assert_eq!(&res.bytes().await.unwrap()[..], b"// v2");
    let res = server
        .get(ALICE, "/api/plugins/dice/files/styles.css")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    assert!(!server.dir.path().join("plugins/dice/styles.css").exists());
    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert_eq!(list.len(), 1);

    // 削除
    let res = server
        .delete(ALICE, "/api/plugins/dice")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let ServerEvent::PluginRemoved { plugin_id } = bob.recv().await else {
        panic!()
    };
    assert_eq!(plugin_id, "dice");
    assert!(!server.dir.path().join("plugins/dice").exists());
    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert!(list.is_empty());
    let res = server
        .get(ALICE, "/api/plugins/dice/files/main.js")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    // もうないものは消せない
    let res = server
        .delete(ALICE, "/api/plugins/dice")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));

    // チャットにはお知らせを流さない
    bob.assert_silent(std::time::Duration::from_millis(200))
        .await;
    assert!(server.messages("").await.is_empty());
}

#[tokio::test]
async fn rejects_invalid_packages() {
    let server = TestServer::start().await;
    let ok = manifest("dice", "1.0.0");

    let cases: Vec<(Files, u16, &str)> = vec![
        // 知らないファイル名
        (
            vec![
                ("manifest.json", ok.clone()),
                ("main.js", MAIN_JS.to_vec()),
                ("evil.html", b"<script>".to_vec()),
            ],
            400,
            "invalid_file_name",
        ),
        // main.js がない
        (vec![("manifest.json", ok.clone())], 400, "missing_file"),
        // manifest.json がない
        (vec![("main.js", MAIN_JS.to_vec())], 400, "missing_file"),
        // 同じファイルが2つ
        (
            vec![
                ("manifest.json", ok.clone()),
                ("main.js", MAIN_JS.to_vec()),
                ("main.js", MAIN_JS.to_vec()),
            ],
            400,
            "duplicate_file",
        ),
        // 不正な ID
        (
            vec![
                ("manifest.json", manifest("Dice!", "1.0.0")),
                ("main.js", MAIN_JS.to_vec()),
            ],
            400,
            "invalid_plugin_id",
        ),
        (
            vec![
                ("manifest.json", manifest("../x", "1.0.0")),
                ("main.js", MAIN_JS.to_vec()),
            ],
            400,
            "invalid_plugin_id",
        ),
        // version がない
        (
            vec![
                ("manifest.json", br#"{"id":"dice","name":"x"}"#.to_vec()),
                ("main.js", MAIN_JS.to_vec()),
            ],
            400,
            "invalid_manifest",
        ),
        // JSON でない
        (
            vec![
                ("manifest.json", b"{".to_vec()),
                ("main.js", MAIN_JS.to_vec()),
            ],
            400,
            "invalid_manifest",
        ),
        // icon が Lucide のアイコン名の形式でない
        (
            vec![
                (
                    "manifest.json",
                    br#"{"id":"dice","name":"x","version":"1","icon":"Dice 5"}"#.to_vec(),
                ),
                ("main.js", MAIN_JS.to_vec()),
            ],
            400,
            "invalid_manifest",
        ),
        // icon.svg が SVG でない・大きすぎる
        (
            vec![
                ("manifest.json", ok.clone()),
                ("main.js", MAIN_JS.to_vec()),
                ("icon.svg", b"<html></html>".to_vec()),
            ],
            400,
            "invalid_icon",
        ),
        (
            vec![
                ("manifest.json", ok.clone()),
                ("main.js", MAIN_JS.to_vec()),
                ("icon.svg", {
                    let mut big = b"<svg>".to_vec();
                    big.resize(64 * 1024 + 1, b' ');
                    big
                }),
            ],
            400,
            "invalid_icon",
        ),
        // 合計 5 MB を超える
        (
            vec![
                ("manifest.json", ok.clone()),
                ("main.js", vec![b' '; 5 * 1024 * 1024]),
            ],
            413,
            "plugin_too_large",
        ),
    ];
    for (i, (files, status, code)) in cases.into_iter().enumerate() {
        let files: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (*n, d.as_slice())).collect();
        let res = server.upload_plugin(ALICE, &files).await;
        assert_eq!(error_code(res).await, (status, code.into()), "ケース {i}");
    }

    // 何も配布されていない
    let list: Vec<PluginInfo> = server.get_json(ALICE, "/api/plugins").await;
    assert!(list.is_empty());

    // minApiVersion を指定でき、description・author は省略できる
    let res = server
        .upload_plugin(
            ALICE,
            &[
                (
                    "manifest.json",
                    br#"{"id":"a1","name":"A","version":"0.1","minApiVersion":2}"#,
                ),
                ("main.js", MAIN_JS),
            ],
        )
        .await;
    assert_eq!(res.status(), 200);
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.min_api_version, 2);
    assert_eq!(info.description, "");
    assert_eq!(info.author, "");

    // 削除する ID の形式も確かめる
    let res = server
        .delete(ALICE, "/api/plugins/A_B")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (400, "invalid_plugin_id".into()));
}

#[tokio::test]
async fn plugin_icons() {
    let server = TestServer::start().await;
    const SVG: &[u8] = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"/>";

    // manifest の icon（Lucide のアイコン名）と icon.svg
    let res = server
        .upload_plugin(
            ALICE,
            &[
                (
                    "manifest.json",
                    br#"{"id":"dice","name":"D","version":"1","icon":"dice-5"}"#,
                ),
                ("main.js", MAIN_JS),
                ("dice/icon.svg", SVG),
            ],
        )
        .await;
    assert_eq!(res.status(), 200);
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.icon.as_deref(), Some("dice-5"));
    assert!(info.has_icon);
    assert_eq!(info.files, ["manifest.json", "main.js", "icon.svg"]);

    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert_eq!(list[0].icon.as_deref(), Some("dice-5"));
    assert!(list[0].has_icon);

    let res = server
        .get(BOB, "/api/plugins/dice/files/icon.svg")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "image/svg+xml");
    assert!(res.headers().contains_key("content-security-policy"));
    assert_eq!(&res.bytes().await.unwrap()[..], SVG);

    // icon.svg もハッシュに入る
    let res = server
        .upload_plugin(
            ALICE,
            &[
                (
                    "manifest.json",
                    br#"{"id":"dice","name":"D","version":"1","icon":"dice-5"}"#,
                ),
                ("main.js", MAIN_JS),
                ("icon.svg", b"<svg/>"),
            ],
        )
        .await;
    let info2: PluginInfo = res.json().await.unwrap();
    assert_ne!(info2.hash, info.hash);

    // なくすと has_icon も icon も消える
    let res = server
        .upload_plugin(
            ALICE,
            &[
                ("manifest.json", &manifest("dice", "2")),
                ("main.js", MAIN_JS),
            ],
        )
        .await;
    let info3: PluginInfo = res.json().await.unwrap();
    assert_eq!(info3.icon, None);
    assert!(!info3.has_icon);
    let res = server
        .get(BOB, "/api/plugins/dice/files/icon.svg")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn private_plugins_are_only_for_the_owner() {
    let server = TestServer::start().await;
    let alice_user: User = server.get_json(ALICE, "/api/me").await;
    let mut bob = server.ws(BOB).await;
    // bob のアカウントができたお知らせが先に届かないように、bob のあとにつなぐ
    let mut alice = server.ws(ALICE).await;

    // 自分だけに配布すると、持ち主にだけ届く
    let m1 = manifest("dice", "1.0.0");
    let res = server
        .upload_plugin_as(
            ALICE,
            "private",
            &[("manifest.json", &m1), ("main.js", MAIN_JS)],
        )
        .await;
    assert_eq!(res.status(), 200);
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.visibility, PluginVisibility::Private);
    assert_eq!(info.owner.as_deref(), Some(alice_user.id.as_str()));
    assert_eq!(info.kind, PluginKind::Plugin);
    let ServerEvent::PluginUpdated { plugin } = alice.recv().await else {
        panic!()
    };
    assert_eq!(plugin.visibility, PluginVisibility::Private);
    bob.assert_silent(std::time::Duration::from_millis(200))
        .await;

    // 一覧・ファイルも持ち主だけ
    let list: Vec<PluginInfo> = server.get_json(ALICE, "/api/plugins").await;
    assert_eq!(list.len(), 1);
    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert!(list.is_empty());
    let res = server
        .get(ALICE, "/api/plugins/dice/files/main.js")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let res = server
        .get(BOB, "/api/plugins/dice/files/main.js")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    // ほかの人は同じ ID で配布できず、消せない
    for visibility in ["public", "private"] {
        let res = server
            .upload_plugin_as(
                BOB,
                visibility,
                &[("manifest.json", &m1), ("main.js", b"// bob")],
            )
            .await;
        assert_eq!(
            error_code(res).await,
            (409, "plugin_id_taken".into()),
            "{visibility}"
        );
    }
    let res = server
        .delete(BOB, "/api/plugins/dice")
        .send()
        .await
        .unwrap();
    assert_eq!(error_code(res).await, (404, "not_found".into()));
    let res = server
        .get(ALICE, "/api/plugins/dice/files/main.js")
        .send()
        .await
        .unwrap();
    assert_eq!(&res.bytes().await.unwrap()[..], MAIN_JS);

    // 持ち主はみんなに配布し直せる（範囲を切り替える）
    let res = server
        .upload_plugin_as(
            ALICE,
            "public",
            &[("manifest.json", &m1), ("main.js", MAIN_JS)],
        )
        .await;
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.visibility, PluginVisibility::Public);
    assert_eq!(info.owner, None);
    let ServerEvent::PluginUpdated { plugin } = bob.recv().await else {
        panic!()
    };
    assert_eq!(plugin.visibility, PluginVisibility::Public);
    let _ = alice.recv().await;
    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert_eq!(list.len(), 1);

    // みんなのものを自分だけにすると、ほかの人には削除として届く
    let res = server
        .upload_plugin_as(
            BOB,
            "private",
            &[("manifest.json", &m1), ("main.js", b"// bob")],
        )
        .await;
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.visibility, PluginVisibility::Private);
    let ServerEvent::PluginUpdated { plugin } = bob.recv().await else {
        panic!()
    };
    assert_eq!(plugin.visibility, PluginVisibility::Private);
    let ServerEvent::PluginRemoved { plugin_id } = alice.recv().await else {
        panic!()
    };
    assert_eq!(plugin_id, "dice");
    let list: Vec<PluginInfo> = server.get_json(ALICE, "/api/plugins").await;
    assert!(list.is_empty());

    // 持ち主が消すと、持ち主にだけ届く
    let res = server
        .delete(BOB, "/api/plugins/dice")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let ServerEvent::PluginRemoved { plugin_id } = bob.recv().await else {
        panic!()
    };
    assert_eq!(plugin_id, "dice");
    alice
        .assert_silent(std::time::Duration::from_millis(200))
        .await;
    assert!(!server.dir.path().join("plugins/dice").exists());

    // 範囲の値が不正
    let res = server
        .upload_plugin_as(
            ALICE,
            "friends",
            &[("manifest.json", &m1), ("main.js", MAIN_JS)],
        )
        .await;
    assert_eq!(error_code(res).await, (400, "invalid_visibility".into()));
}

#[tokio::test]
async fn themes() {
    let server = TestServer::start().await;
    let theme_manifest: &[u8] =
        br#"{"id":"sakura","name":"Sakura","version":"1.0.0","type":"theme"}"#;
    const CSS: &[u8] = b":root { --accent: pink; }";

    let res = server
        .upload_plugin(
            ALICE,
            &[("manifest.json", theme_manifest), ("sakura/theme.css", CSS)],
        )
        .await;
    assert_eq!(res.status(), 200);
    let info: PluginInfo = res.json().await.unwrap();
    assert_eq!(info.kind, PluginKind::Theme);
    assert_eq!(info.visibility, PluginVisibility::Public);
    assert_eq!(info.files, ["manifest.json", "theme.css"]);

    let res = server
        .get(BOB, "/api/plugins/sakura/files/theme.css")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.headers()["content-type"], "text/css");
    assert_eq!(&res.bytes().await.unwrap()[..], CSS);

    // テーマに JS は置けない。theme.css は必須
    let cases: Vec<(Files, &str)> = vec![
        (
            vec![
                ("manifest.json", theme_manifest.to_vec()),
                ("theme.css", CSS.to_vec()),
                ("main.js", MAIN_JS.to_vec()),
            ],
            "invalid_file_name",
        ),
        (
            vec![
                ("manifest.json", theme_manifest.to_vec()),
                ("theme.css", CSS.to_vec()),
                ("styles.css", CSS.to_vec()),
            ],
            "invalid_file_name",
        ),
        (
            vec![("manifest.json", theme_manifest.to_vec())],
            "missing_file",
        ),
        // プラグインに theme.css は置けない
        (
            vec![
                ("manifest.json", manifest("dice", "1")),
                ("main.js", MAIN_JS.to_vec()),
                ("theme.css", CSS.to_vec()),
            ],
            "invalid_file_name",
        ),
        // type が不正
        (
            vec![
                (
                    "manifest.json",
                    br#"{"id":"x1","name":"x","version":"1","type":"skin"}"#.to_vec(),
                ),
                ("theme.css", CSS.to_vec()),
            ],
            "invalid_manifest",
        ),
    ];
    for (i, (files, code)) in cases.into_iter().enumerate() {
        let files: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (*n, d.as_slice())).collect();
        let res = server.upload_plugin(ALICE, &files).await;
        assert_eq!(error_code(res).await, (400, code.into()), "ケース {i}");
    }

    // 自分だけのテーマ
    let res = server
        .upload_plugin_as(
            BOB,
            "private",
            &[
                (
                    "manifest.json",
                    br#"{"id":"night","name":"Night","version":"1","type":"theme"}"#,
                ),
                ("theme.css", CSS),
            ],
        )
        .await;
    assert_eq!(res.status(), 200);
    let list: Vec<PluginInfo> = server.get_json(BOB, "/api/plugins").await;
    assert_eq!(
        list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["night", "sakura"]
    );
    let list: Vec<PluginInfo> = server.get_json(ALICE, "/api/plugins").await;
    assert_eq!(
        list.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["sakura"]
    );
}
