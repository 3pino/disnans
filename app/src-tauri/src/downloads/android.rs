//! Android の保存と開く（MediaStore。Kotlin の apk-updater プラグインを呼ぶ）

use super::*;

#[cfg(target_os = "android")]
pub(super) async fn save(
    app: &AppHandle<Wry>,
    download: &mut SharedDownload,
    name: &str,
) -> Result<(Saved, String), ReadFailure> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|_| fail("io", "保存できませんでした"))?
        .join("downloads");
    fs::create_dir_all(&dir).map_err(|err| io_failure(&err))?;
    let (tmp, mut file) = reserve(&dir, "download.part")?;
    let streamed = stream_to(download, &mut file).await;
    drop(file);
    if let Err(err) = streamed {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    let mime = mime_for(name);
    let result = android_media::save(app, &tmp.to_string_lossy(), name, mime).await;
    let _ = fs::remove_file(&tmp);
    match result {
        Ok(saved) => Ok((
            Saved::Uri {
                uri: saved.uri,
                mime: mime.to_owned(),
            },
            saved.name,
        )),
        Err(code) => Err(save_failure(&code)),
    }
}

/// Kotlin（apk-updater プラグイン）の MediaStore 操作の呼び出し。JSON の形はここで決める。
/// 失敗は Kotlin が固定の code で返す（例外は投げない）。
#[cfg(target_os = "android")]
mod android_media {
    use serde::{Deserialize, Serialize};
    use tauri::{AppHandle, Manager, Wry};
    use tauri_plugin_apk_updater::MediaHandle;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SaveArgs<'a> {
        path: &'a str,
        name: &'a str,
        mime: &'a str,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SaveReply {
        uri: Option<String>,
        name: Option<String>,
        code: Option<String>,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct OpenArgs<'a> {
        uri: &'a str,
        mime: &'a str,
    }

    #[derive(Deserialize)]
    struct OpenReply {
        code: Option<String>,
    }

    /// 保存の結果（uri と、MediaStore が付けた名前）。失敗は code
    pub struct Saved {
        pub uri: String,
        pub name: String,
    }

    pub async fn save(
        app: &AppHandle<Wry>,
        path: &str,
        name: &str,
        mime: &str,
    ) -> Result<Saved, String> {
        let handle = app.state::<MediaHandle<Wry>>();
        let reply: SaveReply = handle
            .0
            .run_mobile_plugin_async("saveDownload", SaveArgs { path, name, mime })
            .await
            .map_err(|_| "io".to_owned())?;
        match (reply.uri, reply.name) {
            (Some(uri), Some(name)) => Ok(Saved { uri, name }),
            _ => Err(reply.code.unwrap_or_else(|| "io".to_owned())),
        }
    }

    pub async fn open(app: &AppHandle<Wry>, uri: &str, mime: &str) -> Result<(), String> {
        let handle = app.state::<MediaHandle<Wry>>();
        let reply: OpenReply = handle
            .0
            .run_mobile_plugin_async("openDownload", OpenArgs { uri, mime })
            .await
            .map_err(|_| "io".to_owned())?;
        match reply.code {
            None => Ok(()),
            Some(code) => Err(code),
        }
    }
}

/// Kotlin 側の失敗の code を、短い日本語にする
#[cfg(target_os = "android")]
fn save_failure(code: &str) -> ReadFailure {
    match code {
        "no_space" => fail("no_space", "保存先の空き容量が足りません"),
        "permission" => fail("permission", "保存先に書き込めませんでした"),
        "unsupported" => fail(
            "unsupported",
            "この Android では保存できません（Android 10 以降が必要です）",
        ),
        _ => fail("io", "保存できませんでした"),
    }
}

#[cfg(target_os = "android")]
pub(super) async fn open_saved(
    app: &AppHandle<Wry>,
    target: OpenTarget,
) -> Result<(), ReadFailure> {
    let OpenTarget::Uri { uri, mime } = target;
    android_media::open(app, &uri, &mime)
        .await
        .map_err(|_| fail("open_failed", "開けるアプリがありませんでした"))
}
